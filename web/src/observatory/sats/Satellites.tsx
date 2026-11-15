// The fire constellation: Terra, Aqua, S-NPP, NOAA-20 and NOAA-21 on sun-synchronous orbits whose planes are
// placed by the overpass times measured from the fire data (drift.json). Each satellite paints its swath on the
// planet (MODIS 2,330 km with gaps near the equator; VIIRS 3,060 km without), appears when its fire record
// starts on the timeline, and turns into a ghost after it retires.
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Drift } from "../../app/types";
import { loadDrift } from "../data";
import { KM, R, latLonToVec } from "../geo";
import { fx, useObs } from "../store";
import { ORBIT } from "../world/shaders";
import { orbitPos } from "./orbit";
import { INCL, PERIOD_MIN, SATS, SAT_COLOR, SIM_DAY_S, type Sat, type SatId, hhmm, measuredHours, raanFor } from "./satData";

const ALT_X = 2; // altitude exaggeration so orbits read on screen
export const orbitR = (s: Sat) => R + s.altKm * KM * ALT_X;
export const periodS = (s: Sat) => (PERIOD_MIN[s.instrument] / 1440) * SIM_DAY_S;

const SWATH_VS = /* glsl */ `
  ${ORBIT}
  attribute vec2 aSC;
  uniform float uNow; uniform float uPeriod; uniform float uDay; uniform float uRaan; uniform float uIncl; uniform float uPhase;
  uniform float uHalfW; uniform float uTrail;
  varying float vAge; varying float vC; varying float vAlong;
  void main() {
    float t = uNow - aSC.x * uTrail;
    vec3 p = orbitPos(t, uRaan, uIncl, uPhase, uPeriod, uDay);
    vec3 p2 = orbitPos(t + uPeriod * 0.002, uRaan, uIncl, uPhase, uPeriod, uDay);
    vec3 side = normalize(cross(p, p2 - p));
    float w = aSC.y * uHalfW;
    vec3 q = normalize(p * cos(w) + side * sin(w));
    vAge = aSC.x; vC = aSC.y; vAlong = t / uPeriod;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(q * ${(R * 1.0025).toFixed(4)}, 1.0);
  }
`;
const SWATH_FS = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha;
  varying float vAge; varying float vC; varying float vAlong;
  void main() {
    float fade = pow(clamp(1.0 - vAge, 0.0, 1.0), 1.6);
    float edge = smoothstep(1.0, 0.82, abs(vC));
    float rim = smoothstep(0.75, 0.98, abs(vC)) * edge;
    float scan = 0.75 + 0.25 * step(0.5, fract(vAlong * 260.0));  // scan lines across the track
    float head = smoothstep(0.008, 0.0, vAge);                        // the freshly painted edge glows
    float a = uAlpha * fade * edge * (0.05 * scan + 0.12 * rim + head * 0.3);
    gl_FragColor = vec4(uColor, a);
  }
`;

function swathGeometry(along = 420, across = 7) {
  const g = new THREE.BufferGeometry();
  const sc = new Float32Array((along + 1) * (across + 1) * 2);
  const idx: number[] = [];
  for (let i = 0; i <= along; i++)
    for (let j = 0; j <= across; j++) {
      const k = i * (across + 1) + j;
      sc[k * 2] = i / along;
      sc[k * 2 + 1] = (j / across) * 2 - 1;
      if (i < along && j < across) idx.push(k, k + across + 1, k + 1, k + 1, k + across + 1, k + across + 2);
    }
  g.setAttribute("aSC", new THREE.BufferAttribute(sc, 2));
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((along + 1) * (across + 1) * 3), 3));
  g.setIndex(idx);
  return g;
}

const monthStr = (idx: number) => {
  const y = 2000 + Math.floor((idx + 10) / 12);
  const m = ((idx + 10) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
};

/** 0..1 visibility and ghost state of a satellite for a timeline month. */
export function satState(s: Sat, idx: number) {
  const m = monthStr(Math.floor(idx));
  const alive = m >= s.start && (!s.end || m < s.end);
  const retired = !!s.retire && m >= `${s.retire}-${s.id === "TERRA" ? "02" : "09"}`;
  return { alive: alive && !retired, ghost: retired, month: m };
}

export function Satellites() {
  const [drift, setDrift] = useState<Drift | null>(null);
  useEffect(() => {
    loadDrift().then(setDrift, () => undefined);
  }, []);
  const hourAt = useMemo(() => (drift ? measuredHours(drift) : null), [drift]);
  return (
    <>
      {SATS.map((s) => (
        <SatelliteRig key={s.id} sat={s} hourAt={hourAt} />
      ))}
      <SightLines hourAt={hourAt} />
    </>
  );
}

/** Acquisition: every satellite active in the current month draws a sight-line to the area (illustration). */
function SightLines({ hourAt }: { hourAt: ((id: SatId, y: number) => number | null) | null }) {
  const { lines, mat } = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SATS.length * 6), 3));
    g.setAttribute("aT", new THREE.BufferAttribute(new Float32Array(SATS.flatMap(() => [0, 1])), 1));
    g.setAttribute("aC", new THREE.BufferAttribute(new Float32Array(SATS.flatMap((s) => [...SAT_COLOR[s.instrument], ...SAT_COLOR[s.instrument]])), 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `attribute float aT; attribute vec3 aC; varying float vT; varying vec3 vC;
        void main(){ vT = aT; vC = aC; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform float uA; uniform float uProg; varying float vT; varying vec3 vC;
        void main(){ if (vT > uProg) discard; gl_FragColor = vec4(vC * 1.6, uA * (0.35 + 0.65 * vT)); }`,
      uniforms: { uA: { value: 0 }, uProg: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(g, mat);
    lines.frustumCulled = false;
    return { lines, mat };
  }, []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const target = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const st = useObs.getState();
    const k = (performance.now() - fx.acquireT0) / 1000;
    const on = st.shape && k > 0.25 && k < 2.6 && !st.reduced;
    lines.visible = !!on;
    if (!on || !st.shape) return;
    latLonToVec(st.shape.center[1], st.shape.center[0], R * 1.002, target);
    const pos = lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    SATS.forEach((s, i) => {
      const alive = satState(s, fx.monthF).alive;
      satWorldPos(s, hourAt, p);
      if (!alive) p.copy(target);
      pos.setXYZ(i * 2, p.x, p.y, p.z);
      pos.setXYZ(i * 2 + 1, target.x, target.y, target.z);
    });
    pos.needsUpdate = true;
    mat.uniforms.uProg.value = Math.min(1, (k - 0.25) / 0.5);
    mat.uniforms.uA.value = Math.min(1, (k - 0.25) * 4) * Math.max(0, Math.min(1, (2.6 - k) * 2));
  });
  return <primitive object={lines} renderOrder={12} />;
}

function SatelliteRig({ sat, hourAt }: { sat: Sat; hourAt: ((id: SatId, y: number) => number | null) | null }) {
  const color = SAT_COLOR[sat.instrument];
  const col = useMemo(() => new THREE.Color(color[0], color[1], color[2]), [color]);
  const r = orbitR(sat);
  const P = periodS(sat);
  const group = useRef<THREE.Group>(null);
  const ghostGroup = useRef<THREE.Group>(null);
  const model = useRef<THREE.Group>(null);
  const label = useRef<HTMLButtonElement>(null);
  const vis = useRef(0);
  const raanS = useRef(raanFor(sat, sat.nominalHour));
  const setCard = useObs((s) => s.set);

  const ring = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= 256; i++) {
      const u = (i / 256) * Math.PI * 2;
      pts.push(Math.sin(u) * Math.cos(INCL) * r, Math.sin(u) * Math.sin(INCL) * r, Math.cos(u) * r);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [r]);
  const ringMat = useMemo(() => new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.35, depthWrite: false }), [col]);
  const ghostMat = useMemo(() => new THREE.LineDashedMaterial({ color: col, transparent: true, opacity: 0.25, dashSize: 0.18, gapSize: 0.14, depthWrite: false }), [col]);
  const ghostLine = useMemo(() => {
    const l = new THREE.Line(ring, ghostMat);
    l.computeLineDistances();
    return l;
  }, [ring, ghostMat]);
  const ringLine = useMemo(() => new THREE.Line(ring, ringMat), [ring, ringMat]);

  const { swath, swMat } = useMemo(() => {
    const swMat = new THREE.ShaderMaterial({
      vertexShader: SWATH_VS,
      fragmentShader: SWATH_FS,
      uniforms: {
        uNow: { value: 0 }, uPeriod: { value: P }, uDay: { value: SIM_DAY_S }, uRaan: { value: 0 }, uIncl: { value: INCL },
        uPhase: { value: sat.phase }, uHalfW: { value: (sat.swathKm / 2) / 6371 }, uTrail: { value: P * 1.7 },
        uColor: { value: col }, uAlpha: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const swath = new THREE.Mesh(swathGeometry(), swMat);
    swath.frustumCulled = false;
    return { swath, swMat };
  }, [P, sat, col]);

  const p0 = useMemo(() => new THREE.Vector3(), []);
  useFrame((state, dt) => {
    const idx = fx.monthF;
    const st = satState(sat, idx);
    const target = st.alive ? 1 : st.ghost ? 0.35 : 0;
    vis.current += (target - vis.current) * (1 - Math.exp(-dt * 3));
    const year = 2000 + (idx + 10) / 12;
    const h = hourAt?.(sat.id, year) ?? sat.nominalHour;
    const raan = raanFor(sat, h);
    raanS.current += (raan - raanS.current) * (1 - Math.exp(-dt * 4));
    const th = (2 * Math.PI * fx.simT) / SIM_DAY_S;
    if (group.current) {
      group.current.rotation.y = raanS.current - th;
      group.current.visible = vis.current > 0.01;
    }
    if (ghostGroup.current) {
      ghostGroup.current.rotation.y = raanFor(sat, sat.nominalHour) - th;
      // the original plane appears once the orbit has drifted by more than ~10 minutes
      ghostGroup.current.visible = st.alive && Math.abs(h - sat.nominalHour) > 0.17;
    }
    const dim = 1 - 0.95 * fx.globeDim;
    if (model.current) model.current.visible = fx.globeDim < 0.6;
    ringMat.opacity = 0.32 * vis.current * dim * (st.ghost ? 0.5 : 1);
    ghostMat.opacity = 0.22 * dim;
    // the satellite inside the rotating group: orbit with raan 0, no Earth rotation
    const u = sat.phase + (2 * Math.PI * fx.simT) / P;
    p0.set(Math.sin(u) * Math.cos(INCL) * r, Math.sin(u) * Math.sin(INCL) * r, Math.cos(u) * r);
    if (model.current) {
      model.current.position.copy(p0);
      model.current.lookAt(0, 0, 0);
      model.current.scale.setScalar(st.ghost ? 0.9 : 1);
    }
    swMat.uniforms.uNow.value = fx.simT;
    swMat.uniforms.uRaan.value = raanS.current;
    swMat.uniforms.uAlpha.value = (st.alive ? 1 : 0) * vis.current * dim;
    if (label.current) {
      const looking = performance.now() - fx.acquireT0 < 2600 && st.alive;
      label.current.dataset.look = looking ? "1" : "0";
      const onStage = !looking && useObs.getState().view !== "globe" && useObs.getState().station !== "twins";
      label.current.style.opacity = onStage ? "0" : String(vis.current * (cam_labels(state.camera, p0, group.current) ? 1 : 0.15));
      label.current.style.pointerEvents = onStage ? "none" : "auto";
      label.current.dataset.ghost = st.ghost ? "1" : "0";
      label.current.title = `${sat.name} (${sat.instrument}) · crosses the equator ${hhmm(h)} local time`;
    }
  });

  return (
    <>
      <primitive object={swath} renderOrder={3} />
      <group ref={ghostGroup}>
        <primitive object={ghostLine} />
      </group>
      <group ref={group}>
        <primitive object={ringLine} renderOrder={4} />
        <group ref={model}>
          <SatModel color={col} instrument={sat.instrument} />
          <Html center zIndexRange={[20, 10]} position={[0, 0.32, 0]} style={{ pointerEvents: "auto" }}>
            <button ref={label} type="button" className={`sat-tag sat-${sat.instrument.toLowerCase()}`} onClick={() => setCard({ satCard: sat.id })}>
              <i aria-hidden="true" />
              {sat.name}
            </button>
          </Html>
        </group>
      </group>
    </>
  );
}

const _w = new THREE.Vector3();
/** Is this satellite on the near side of the planet (so its label should be bright)? */
function cam_labels(camera: THREE.Camera, local: THREE.Vector3, g: THREE.Group | null) {
  if (!g) return true;
  _w.copy(local).applyMatrix4(g.matrixWorld);
  const toCam = camera.position.clone().sub(_w);
  // occluded if the segment to the camera passes through the sphere
  const d = toCam.clone().normalize();
  const b = _w.dot(d);
  const c = _w.lengthSq() - R * R;
  const disc = b * b - c;
  if (disc < 0) return true;
  const tHit = -b - Math.sqrt(disc);
  return tHit < 0;
}

function SatModel({ color, instrument }: { color: THREE.Color; instrument: "MODIS" | "VIIRS" }) {
  const s = 0.075;
  return (
    <group scale={s}>
      {/* body faces the Earth along +z (after lookAt) */}
      <mesh>
        <boxGeometry args={[1, 1, 1.5]} />
        <meshStandardMaterial color="#c9ccd4" metalness={0.7} roughness={0.35} emissive="#2a2f3a" />
      </mesh>
      <mesh position={[0, 0, 0.85]}>
        <cylinderGeometry args={[0.28, 0.36, 0.3, 16]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      {[-1, 1].map((k) => (
        <mesh key={k} position={[k * 2.1, 0, -0.1]}>
          <boxGeometry args={[2.8, 0.05, 1.1]} />
          <meshStandardMaterial color={instrument === "MODIS" ? "#3a2a14" : "#142a3a"} emissive={color} emissiveIntensity={0.25} metalness={0.4} roughness={0.5} />
        </mesh>
      ))}
      <mesh>
        <sphereGeometry args={[0.9, 12, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** World position of a satellite now (for sight-lines). */
export function satWorldPos(sat: Sat, hourAt: ((id: SatId, y: number) => number | null) | null, out = new THREE.Vector3()) {
  const year = 2000 + (fx.monthF + 10) / 12;
  const h = hourAt?.(sat.id, year) ?? sat.nominalHour;
  orbitPos(fx.simT, raanFor(sat, h), INCL, sat.phase, periodS(sat), SIM_DAY_S, out);
  return out.multiplyScalar(orbitR(sat));
}

export { latLonToVec };
