// The area stage: the selected place is cut out of the planet as a glowing tile, lifted into low orbit and
// becomes the floor on which its fire history is built, one station at a time.
import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { R, latLonToVec, vecToLatLon } from "../geo";
import { type Station, fx, useObs } from "../store";
import { cam, flyTo, setMode } from "../world/camera";
import { CalendarLand } from "./CalendarLand";
import { type StageFrame, S, STATION_POSE, easeInOut, makeFrame } from "./frame";
import { Helix } from "./Helix";
import { Lineup } from "./Lineup";
import { SeasonRings } from "./SeasonRings";
import { Terrain } from "./Terrain";
import { Twins } from "./Twins";
import { presence, stageClock } from "./state";
import { sfx } from "../sfx";
import { STATIONS } from "../store";


export function Stage() {
  const shape = useObs((s) => s.shape);
  const view = useObs((s) => s.view);
  const area = useObs((s) => s.area);
  const fr = useMemo(() => (shape ? makeFrame(shape.center, shape.polys) : null), [shape]);
  if (!fr || view !== "area" || !area) return <StageExit />;
  return <StageLive fr={fr} key={area.area_id} />;
}

/** When leaving the area, pull the camera back out to orbit. */
function StageExit() {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (cam.mode === "stage") {
      setMode("globe", camera, 1.2);
      flyTo(cam.lat, cam.lon, R * 3.2, 1.6);
    }
  }, [camera]);
  return null;
}

function StageLive({ fr }: { fr: StageFrame }) {
  const camera = useThree((s) => s.camera);
  const group = useRef<THREE.Group>(null);
  const station = useObs((s) => s.station);
  const flat = useObs((s) => s.flat);
  const t0 = useRef(performance.now() / 1000);
  const local = useRef({ pos: new THREE.Vector3(0, 30, 40), target: new THREE.Vector3(0, 0, 0), up: new THREE.Vector3(0, 1, 0) });
  const first = useRef(true);

  // arrival: fly over the area, then hand the camera to the stage
  useEffect(() => {
    fx.stageT0 = performance.now();
    t0.current = performance.now() / 1000;
    flyTo(fr.lat, fr.lon, R * 1.75, cam.reduced ? 0.01 : 1.0);
    // (unless the twins were chosen meanwhile, e.g. a deep link: they stay on the globe)
    const id = window.setTimeout(() => useObs.getState().station !== "twins" && setMode("stage", camera, cam.reduced ? 0.01 : 1.9), cam.reduced ? 0 : 650);
    return () => window.clearTimeout(id);
  }, [fr, camera]);

  // station changes: twins happen on the globe
  useEffect(() => {
    fx.stationT0 = performance.now();
    cam.sAz = cam.sEl = 0;
    cam.sZoom = 1;
    if (first.current) {
      first.current = false;
      if (station !== "twins") return; // a deep link straight to the twins still needs the globe
    }
    if (station === "twins") sfx.twins(useObs.getState().twins?.twins.length ?? 5);
    else sfx.station(STATIONS.findIndex((s) => s.id === station));
    if (station === "twins") {
      setMode("globe", camera, 1.4);
      // frame the area and its twins together: aim at the mean direction of all of them
      const tw = useObs.getState().twins?.twins ?? [];
      const v = latLonToVec(fr.lat, fr.lon).multiplyScalar(2);
      for (const t of tw) v.add(latLonToVec(t.lat, t.lon));
      const [la, lo] = v.lengthSq() > 0.05 ? vecToLatLon(v) : [fr.lat - 8, fr.lon];
      flyTo(THREE.MathUtils.clamp(la, -50, 55), lo, R * 3.9, 1.8);
    } else if (cam.mode === "globe") {
      flyTo(fr.lat, fr.lon, R * 1.75, 0.8);
      window.setTimeout(() => setMode("stage", camera, 1.6), 400);
    }
  }, [station, camera, fr]);

  const tmp = useMemo(() => ({ p: new THREE.Vector3(), t: new THREE.Vector3(), q: new THREE.Quaternion() }), []);
  useFrame((state, dtRaw) => {
    const dt = Math.min(0.2, dtRaw);
    const now = performance.now() / 1000;
    const st = useObs.getState();
    stageClock.t = now - t0.current;
    // lift: surface → low orbit, scale from true geographic size to stage size
    const lift = cam.reduced ? 1 : easeInOut((now - t0.current - 0.55) / 1.6);
    stageClock.lift = lift;
    if (group.current) {
      group.current.position.copy(fr.surface).lerp(fr.origin, lift);
      group.current.quaternion.copy(fr.q);
      const sc = fr.geoScale * Math.pow(S / fr.geoScale, lift);
      group.current.scale.setScalar(sc);
    }
    // presence of each station (rises after the lift)
    const ready = lift > 0.85;
    for (const k of Object.keys(presence) as Station[]) {
      const on = ready && (k === st.station || (k === "calendar" && st.station === "take"));
      const target = on ? 1 : 0;
      const rate = on ? 3.2 : 9;
      presence[k] += (target - presence[k]) * (1 - Math.exp(-dt * rate));
      if (Math.abs(presence[k] - target) < 0.001) presence[k] = target;
    }
    // camera pose on the stage (local space, eased → world)
    const key = st.station === "calendar" && st.flat ? "calendarFlat" : st.station === "calendar" && st.valueMode === "raw" ? "calendarRaw" : st.station === "twins" ? "verdict" : st.station;
    const pose = STATION_POSE[key] ?? STATION_POSE.verdict;
    tmp.p.set(...pose.pos);
    tmp.t.set(...pose.target);
    // user orbit offsets + a slow idle drift
    const off = tmp.p.clone().sub(tmp.t);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += cam.sAz + (cam.reduced || pose.topDown ? 0 : Math.sin(now * 0.13) * 0.05);
    sph.phi = THREE.MathUtils.clamp(sph.phi - cam.sEl, 0.02, 1.5);
    // portrait screens see less width: step back so the station fits
    const aspect = state.size.width / state.size.height;
    sph.radius *= cam.sZoom * (aspect < 1 ? Math.min(2.2, Math.pow(1 / aspect, 0.85)) : 1);
    // the flat heatmap must fit between the answer strip and the timeline at any window height
    if (pose.topDown) {
      const H = state.size.height;
      const need = (14.8 * H) / Math.max(200, H - 250) / (2 * Math.tan((19 * Math.PI) / 180));
      sph.radius = Math.max(sph.radius, need);
    }
    off.setFromSpherical(sph);
    tmp.p.copy(tmp.t).add(off);
    const k = 1 - Math.exp(-dt * 2.4);
    const L = local.current;
    L.pos.lerp(tmp.p, k);
    L.target.lerp(tmp.t, k);
    L.up.lerp(pose.topDown ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0), k).normalize();
    // compose for the HUD: the station panel (right) is wider than the rail (left), so shift the view so the
    // stage sits in the middle of the free space between them
    const W = state.size.width;
    const free = W > 900 ? (392 - 190) / 2 / W : 0;
    const dist = L.pos.distanceTo(L.target);
    const visW = 2 * dist * Math.tan((19 * Math.PI) / 180) * (W / state.size.height);
    const right = L.target.clone().sub(L.pos).cross(L.up).normalize().multiplyScalar(free * visW);
    // world pose relative to the *final* stage placement
    cam.stage.pos.copy(L.pos).add(right).multiplyScalar(S).applyQuaternion(fr.q).add(fr.origin);
    cam.stage.target.copy(L.target).add(right).multiplyScalar(S).applyQuaternion(fr.q).add(fr.origin);
    cam.stage.up.copy(L.up).applyQuaternion(fr.q);
    void flat;
  });

  return (
    <>
      <group ref={group}>
        <Tile fr={fr} />
        <Lineup fr={fr} />
        <Terrain fr={fr} />
        <CalendarLand />
        <SeasonRings />
        <Helix />
      </group>
      <Twins fr={fr} />
    </>
  );
}

// ---------------- the floor tile ----------------
const CAP_VS = /* glsl */ `
  varying vec3 vP; varying vec3 vN;
  void main() { vP = position; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const CAP_FS = /* glsl */ `
  uniform float uT; uniform float uLift; uniform float uDepth;
  varying vec3 vP; varying vec3 vN;
  void main() {
    if (vN.y > 0.5) {
      // top: dark glass with a fine survey grid and a scan line that sweeps once after the lift
      vec2 g = abs(fract(vP.xz * 1.0) - 0.5);
      float grid = smoothstep(0.48, 0.5, max(g.x, g.y));
      vec2 g2 = abs(fract(vP.xz * 0.2) - 0.5);
      float grid2 = smoothstep(0.485, 0.5, max(g2.x, g2.y));
      vec3 c = vec3(0.025, 0.035, 0.06) + vec3(0.25, 0.35, 0.55) * (grid * 0.06 + grid2 * 0.12);
      float scan = exp(-pow(abs((vP.z - mix(-12.0, 12.0, clamp((uT - 2.0) / 1.4, 0.0, 1.0))) / 0.35), 2.0)) * step(uT, 3.6) * step(2.0, uT);
      c += vec3(1.0, 0.7, 0.35) * scan * 0.8;
      gl_FragColor = vec4(c, 0.92);
    } else if (vN.y < -0.5) {
      gl_FragColor = vec4(0.01, 0.012, 0.02, 0.9);
    } else {
      // sides: molten rim, hottest at the top edge
      float k = clamp((vP.y + uDepth) / uDepth, 0.0, 1.0);
      vec3 c = mix(vec3(0.35, 0.08, 0.02), vec3(1.0, 0.62, 0.25), k * k);
      gl_FragColor = vec4(c * (0.7 + 0.6 * uLift), 0.95);
    }
  }
`;

function simplify(r: Array<[number, number]>, maxN: number) {
  if (r.length <= maxN) return r;
  const step = r.length / maxN;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < r.length; i += step) out.push(r[Math.floor(i)]);
  return out;
}

function Tile({ fr }: { fr: StageFrame }) {
  const DEPTH = 0.55;
  const { geo, mat, edges } = useMemo(() => {
    const shapes: THREE.Shape[] = [];
    const edges: THREE.Vector3[][] = [];
    const rings = fr.shapes.length ? fr.shapes : [Array.from({ length: 65 }, (_, i) => [Math.cos((i / 64) * Math.PI * 2) * 7, Math.sin((i / 64) * Math.PI * 2) * 7] as [number, number])];
    for (const r0 of rings) {
      const r = simplify(r0, 700);
      if (r.length < 3) continue;
      shapes.push(new THREE.Shape(r.map(([x, z]) => new THREE.Vector2(x, -z))));
      edges.push(r.map(([x, z]) => new THREE.Vector3(x, 0.03, z)));
    }
    const geo = new THREE.ExtrudeGeometry(shapes, { depth: DEPTH, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -DEPTH, 0);
    geo.computeVertexNormals();
    // the floor draws first and never hides what stands on it (flat rings sit a hair above it)
    const mat = new THREE.ShaderMaterial({ vertexShader: CAP_VS, fragmentShader: CAP_FS, uniforms: { uT: { value: 0 }, uLift: { value: 0 }, uDepth: { value: DEPTH } }, transparent: true, depthWrite: false });
    return { geo, mat, edges };
  }, [fr]);
  const beam = useRef<THREE.Mesh>(null);
  const beamMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `uniform float uA; uniform float uT; varying vec2 vUv;
          void main(){ float stripes = 0.6 + 0.4 * sin(vUv.y * 60.0 - uT * 6.0);
            gl_FragColor = vec4(vec3(1.0, 0.6, 0.25), uA * pow(clamp(1.0 - vUv.y, 0.0, 1.0), 0.6) * 0.16 * stripes * (0.6 + 0.4 * pow(abs(vUv.x - 0.5) * 2.0, 2.0))); }`,
        uniforms: { uA: { value: 0 }, uT: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    [],
  );
  useFrame(() => {
    mat.uniforms.uT.value = stageClock.t;
    mat.uniforms.uLift.value = stageClock.lift;
    if (beam.current) {
      // the light column back down to the area on the planet
      const L = (stageClock.lift * (1.55 / S)) / 1;
      beam.current.scale.set(1, Math.max(0.001, L), 1);
      beam.current.position.set(0, -0.55 - L / 2, 0);
      beamMat.uniforms.uA.value = Math.min(1, stageClock.lift * 1.5);
      beamMat.uniforms.uT.value = stageClock.t;
    }
  });
  return (
    <group>
      <mesh geometry={geo} material={mat} renderOrder={-1} />
      {edges.map((e, i) => (
        <Line renderOrder={1} key={i} points={[...e, e[0]]} color="#ffb347" lineWidth={1.6} transparent opacity={0.9} />
      ))}
      <mesh ref={beam} material={beamMat} renderOrder={1}>
        <cylinderGeometry args={[5.5, 1.2, 1, 48, 1, true]} />
      </mesh>
    </group>
  );
}
