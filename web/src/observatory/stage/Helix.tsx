// Station 5 · The Fire Helix (Guideline §6.4): one turn per year (oldest at the bottom), angle = month with January
// at the top, thickness ∝ √hotspots, colour = vs normal. It grows upward as a spiral; during sonification a light
// travels up it and each month flares as its note plays. Season drift shows as a twist of the hot band.
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { MONTHS_SHORT } from "../../app/format";
import { useObs } from "../store";
import { CATEGORY_GLSL, INFERNO } from "../world/shaders";
import { gridOf } from "./model";
import { presence } from "./state";

const RAD = 5.0, PITCH = 0.36, Y0 = 0.6;

const VS = /* glsl */ `
  attribute float aW; attribute float aOrder; attribute float aCat; attribute float aCount; attribute float aProv; attribute float aSeed;
  uniform float uT; uniform float uPres; uniform float uPlay; uniform float uTime; uniform float uPinRow;
  varying float vCat; varying float vCount; varying float vProv; varying float vFlare; varying float vY; varying float vPin;
  void main() {
    float id = float(gl_InstanceID);
    float grow = clamp((uT * 140.0 - aOrder) / 12.0, 0.0, 1.0);
    float flare = exp(-abs(id - uPlay) * 0.7) * step(0.0, uPlay);
    vec3 p = position;
    vY = p.y + 0.5;
    float shimmer = 1.0 + aProv * 0.15 * sin(uTime * 6.0 + aSeed * 20.0);
    float k = grow * uPres * shimmer * (1.0 + flare * 0.8);
    p.y *= min(0.07 + aW * 0.28, 0.27) * k;   // a ribbon, so the turns stay apart
    p.z *= (0.12 + aW * 1.25) * k;            // radial width = how much burned
    vCat = aCat; vCount = aCount; vProv = aProv; vFlare = flare;
    vPin = step(abs(floor(aOrder / 12.0) - uPinRow), 0.1);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    if (grow <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const FS = /* glsl */ `
  ${INFERNO}
  ${CATEGORY_GLSL}
  uniform float uPres; uniform float uMode;
  varying float vCat; varying float vCount; varying float vProv; varying float vFlare; varying float vY; varying float vPin;
  void main() {
    vec3 c = vCat < 0.5 ? inferno(0.15 + 0.8 * vCount) : mix(inferno(0.15 + 0.8 * vCount), catColor(vCat), uMode);
    c *= (0.55 + 0.7 * vY) * (0.45 + 0.9 * vCount);
    c += vec3(1.0, 0.85, 0.5) * vFlare * 2.0;
    c += vec3(0.35, 0.4, 0.5) * vPin * 0.35;
    float quiet = 0.22 + 0.78 * smoothstep(0.02, 0.4, vCount); // quiet months recede, the season band glows
    gl_FragColor = vec4(c, uPres * quiet * (1.0 - 0.55 * vProv));
  }
`;

export function Helix() {
  const cal = useObs((s) => s.calendar);
  const station = useObs((s) => s.station);
  const colorMode = useObs((s) => s.colorMode);
  const group = useRef<THREE.Group>(null);
  const t0 = useRef(-1);

  const built = useMemo(() => {
    if (!cal) return null;
    const g = gridOf(cal);
    const y0 = g.years[0];
    const n = g.cells.length;
    const segLen = ((2 * Math.PI * RAD) / 12) * 0.94;
    const geo = new THREE.BoxGeometry(segLen, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, n);
    const A = { aW: new Float32Array(n), aOrder: new Float32Array(n), aCat: new Float32Array(n), aCount: new Float32Array(n), aProv: new Float32Array(n), aSeed: new Float32Array(n) };
    const CAT = { much_below: 1, below: 2, normal: 3, above: 4, much_above: 5, record: 6 } as const;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    g.cells.forEach(({ m }, i) => {
      const y = Number(m.month.slice(0, 4)) - y0;
      const mo = Number(m.month.slice(5, 7)) - 1;
      const a = ((mo + 0.5) / 12) * Math.PI * 2;
      pos.set(Math.sin(a) * RAD, Y0 + (y + (mo + 0.5) / 12) * PITCH, -Math.cos(a) * RAD);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
      m4.compose(pos, q, s);
      mesh.setMatrixAt(i, m4);
      A.aW[i] = m.h_count > 0 ? 0.1 + 0.62 * Math.sqrt(m.h_count / g.vmaxH) : 0.05;
      A.aOrder[i] = y * 12 + mo;
      A.aCat[i] = m.category ? CAT[m.category] : 0;
      A.aCount[i] = Math.sqrt(m.h_count / g.vmaxH);
      A.aProv[i] = m.provisional ? 1 : 0;
      A.aSeed[i] = (i * 0.618) % 1;
    });
    for (const [k, v] of Object.entries(A)) geo.setAttribute(k, new THREE.InstancedBufferAttribute(v, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: { uT: { value: 0 }, uPres: { value: 0 }, uPlay: { value: -1 }, uTime: { value: 0 }, uMode: { value: 1 }, uPinRow: { value: -1 } },
      transparent: true,
    });
    mesh.material = mat;
    mesh.frustumCulled = false;
    return { mesh, mat, g, y0, top: Y0 + g.years.length * PITCH };
  }, [cal]);

  // the playhead light (sonification) and the year ring
  const light = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  useFrame((st, dt) => {
    const p = presence.helix;
    if (group.current) {
      group.current.visible = p > 0.002;
      if (!useObs.getState().reduced) group.current.rotation.y += dt * 0.05 * p;
    }
    if (!built) return;
    const s = useObs.getState();
    if (p > 0.01 && t0.current < 0) t0.current = st.clock.elapsedTime;
    if (p < 0.01) t0.current = -1;
    const u = built.mat.uniforms;
    u.uT.value = t0.current < 0 ? 0 : st.clock.elapsedTime - t0.current;
    u.uPres.value = p;
    u.uTime.value = st.clock.elapsedTime;
    u.uPlay.value = s.playIdx ?? -1;
    u.uMode.value += ((s.colorMode === "anomaly" ? 1 : 0) - u.uMode.value) * 0.1;
    const pinY = s.pinned ? Number(s.pinned.slice(0, 4)) - built.y0 : -1;
    u.uPinRow.value = pinY;
    if (light.current) {
      const idx = s.playIdx;
      light.current.visible = idx !== null && p > 0.5;
      if (idx !== null) {
        const c = built.g.cells[Math.min(idx, built.g.cells.length - 1)];
        const y = Number(c.m.month.slice(0, 4)) - built.y0;
        const mo = Number(c.m.month.slice(5, 7)) - 1;
        const a = ((mo + 0.5) / 12) * Math.PI * 2;
        light.current.position.set(Math.sin(a) * RAD, Y0 + (y + (mo + 0.5) / 12) * PITCH, -Math.cos(a) * RAD);
      }
    }
    if (ring.current) {
      ring.current.visible = pinY >= 0 && p > 0.3;
      ring.current.position.y += (Y0 + (pinY + 0.5) * PITCH - ring.current.position.y) * 0.15;
    }
  });

  if (!built) return null;
  const show = station === "helix";
  void colorMode;
  return (
    <group ref={group}>
      <primitive object={built.mesh} renderOrder={2} />
      <mesh ref={light} visible={false}>
        <sphereGeometry args={[0.32, 16, 16]} />
        <meshBasicMaterial color="#fff1c2" toneMapped={false} />
      </mesh>
      <mesh ref={ring} rotation={[Math.PI / 2, 0, 0]} renderOrder={3}>
        <torusGeometry args={[RAD + 0.9, 0.025, 6, 96]} />
        <meshBasicMaterial color="#ffd08a" toneMapped={false} transparent opacity={0.8} />
      </mesh>
      {/* the axis and the January marker */}
      <mesh position={[0, built.top / 2, 0]} renderOrder={3}>
        <cylinderGeometry args={[0.03, 0.03, built.top, 6]} />
        <meshBasicMaterial color="#6f7a8c" transparent opacity={0.5} />
      </mesh>
      {show && (
        <>
          {MONTHS_SHORT.map((m, k) => {
            const a = ((k + 0.5) / 12) * Math.PI * 2;
            return (
              <Html key={m} position={[Math.sin(a) * (RAD + 1.4), 0.2, -Math.cos(a) * (RAD + 1.4)]} center zIndexRange={[12, 4]}>
                <span className={`cal-lbl ${k === 0 ? "major" : ""}`}>{m}</span>
              </Html>
            );
          })}
          {built.g.years
            .filter((y) => y % 5 === 0)
            .map((y) => (
              <Html key={y} position={[0, Y0 + (y - built.y0) * PITCH, 0]} center zIndexRange={[12, 4]}>
                <span className="cal-lbl yr">{y}</span>
              </Html>
            ))}
        </>
      )}
    </group>
  );
}
