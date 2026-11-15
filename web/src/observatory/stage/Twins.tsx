// Station 6 · Fire Twins on the globe: arcs of light launch from the area to the places that burn the same way
// (/twins). Arc thickness = similarity; pulses travel along them; each twin lands with a pulse ring and a label.
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { R, latLonToVec } from "../geo";
import { useObs } from "../store";
import type { StageFrame } from "./frame";
import { presence } from "./state";

const ARC_VS = /* glsl */ `
  varying float vU; varying float vV;
  void main() { vU = uv.x; vV = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const ARC_FS = /* glsl */ `
  uniform float uProg; uniform float uTime; uniform float uA; uniform vec3 uColor;
  varying float vU; varying float vV;
  void main() {
    if (vU > uProg) discard;
    float pulse = pow(max(0.5 + 0.5 * sin((vU * 6.0 - uTime * 1.6) * 6.2831), 0.0), 8.0);
    float head = smoothstep(0.05, 0.0, uProg - vU) * step(uProg, 0.999);
    float core = 0.55 + 0.45 * pow(abs(sin(vV * 3.14159)), 0.5);
    vec3 c = uColor * (0.7 + 1.4 * pulse + 2.0 * head) * core;
    gl_FragColor = vec4(c, uA * (0.55 + 0.45 * pulse));
  }
`;

function arcCurve(lat0: number, lon0: number, lat1: number, lon1: number) {
  const a = latLonToVec(lat0, lon0), b = latLonToVec(lat1, lon1);
  const ang = a.angleTo(b);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    const p = new THREE.Vector3().copy(a).multiplyScalar(Math.sin((1 - t) * ang)).addScaledVector(b, Math.sin(t * ang)).divideScalar(Math.sin(ang) || 1);
    p.normalize().multiplyScalar(R * (1.004 + Math.sin(Math.PI * t) * (0.08 + ang * 0.22)));
    pts.push(p);
  }
  return new THREE.CatmullRomCurve3(pts);
}

export function Twins({ fr }: { fr: StageFrame }) {
  const twins = useObs((s) => s.twins);
  const station = useObs((s) => s.station);
  const group = useRef<THREE.Group>(null);
  const t0 = useRef(-1);

  const built = useMemo(() => {
    if (!twins) return null;
    return twins.twins.map((t, i) => {
      const curve = arcCurve(fr.lat, fr.lon, t.lat, t.lon);
      const geo = new THREE.TubeGeometry(curve, 96, 0.02 + 0.05 * (t.similarity / 100), 8, false);
      const mat = new THREE.ShaderMaterial({
        vertexShader: ARC_VS,
        fragmentShader: ARC_FS,
        uniforms: { uProg: { value: 0 }, uTime: { value: 0 }, uA: { value: 0 }, uColor: { value: new THREE.Color(i === 0 ? "#ffd08a" : "#ffb347") } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const end = latLonToVec(t.lat, t.lon, R * 1.003);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), end.clone().normalize());
      return { t, geo, mat, end, q, delay: 0.3 + i * 0.28 };
    });
  }, [twins, fr]);

  const rings = useRef<Array<THREE.Mesh | null>>([]);
  const home = useMemo(() => latLonToVec(fr.lat, fr.lon, R * 1.003), [fr]);
  const homeQ = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), home.clone().normalize()), [home]);
  const homeRing = useRef<THREE.Mesh>(null);
  const pins = useRef<Array<HTMLButtonElement | null>>([]);

  useFrame((st) => {
    const p = presence.twins;
    if (group.current) group.current.visible = p > 0.002;
    if (!built) return;
    const now = st.clock.elapsedTime;
    if (p > 0.01 && t0.current < 0) t0.current = now;
    if (p < 0.01) t0.current = -1;
    const T = t0.current < 0 ? 0 : now - t0.current;
    built.forEach((b, i) => {
      const k = Math.min(1, Math.max(0, (T - b.delay) / 1.3));
      b.mat.uniforms.uProg.value = 1 - Math.pow(1 - k, 3);
      b.mat.uniforms.uTime.value = now;
      b.mat.uniforms.uA.value = p;
      const r = rings.current[i];
      if (r) {
        const land = T - b.delay - 1.3;
        r.visible = land > 0;
        const s = land > 0 ? 0.15 + ((land * 0.8) % 1) * 0.9 : 0.01;
        r.scale.setScalar(s);
        (r.material as THREE.MeshBasicMaterial).opacity = (1 - ((land * 0.8) % 1)) * p;
      }
    });
    // labels of twins on the far side of the planet fade out (the globe can be dragged around in this station)
    const cp = st.camera.position;
    built.forEach((b, i) => {
      const el = pins.current[i];
      if (!el) return;
      const facing = b.end.dot(cp) / (b.end.length() * R) - 1; // > 0 when the point is in front of the limb
      const o = Math.max(0, Math.min(1, facing * 6 + 0.15));
      el.style.opacity = o.toFixed(2);
      el.style.pointerEvents = o < 0.3 ? "none" : "";
    });
    // twins close together (two in one country) would print their labels on top of each other: in rank order,
    // each label steps down until it clears the labels already placed
    const W = st.size.width, H = st.size.height;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    built.forEach((b, i) => {
      const el = pins.current[i];
      if (!el || el.style.opacity === "0.00") return;
      const v = b.end.clone().multiplyScalar(1.03).project(st.camera);
      const w = el.offsetWidth || 120, h = (el.offsetHeight || 22) + 4;
      const x = (v.x * 0.5 + 0.5) * W, y0 = (-v.y * 0.5 + 0.5) * H;
      let dy = 0;
      for (let k = 0; k < 6 && placed.some((r) => Math.abs(r.x - x) < (r.w + w) / 2 && Math.abs(r.y - (y0 + dy)) < (r.h + h) / 2); k++) dy += h;
      placed.push({ x, y: y0 + dy, w, h });
      el.style.top = `${dy}px`;
    });
    if (homeRing.current) {
      const s = 0.2 + ((now * 0.6) % 1) * 1.1;
      homeRing.current.scale.setScalar(s);
      (homeRing.current.material as THREE.MeshBasicMaterial).opacity = (1 - ((now * 0.6) % 1)) * p;
    }
  });

  if (!built) return null;
  const show = station === "twins";
  return (
    <group ref={group}>
      <mesh ref={homeRing} position={home} quaternion={homeQ}>
        <ringGeometry args={[0.55, 0.62, 48]} />
        <meshBasicMaterial color="#ffe2a8" transparent toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {built.map((b, i) => (
        <group key={b.t.h3_r3}>
          <mesh geometry={b.geo} material={b.mat} renderOrder={9} />
          <mesh ref={(m) => (rings.current[i] = m)} position={b.end} quaternion={b.q} visible={false}>
            <ringGeometry args={[0.5, 0.6, 48]} />
            <meshBasicMaterial color="#ffb347" transparent toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <mesh position={b.end}>
            <sphereGeometry args={[0.07, 12, 12]} />
            <meshBasicMaterial color="#fff2c8" toneMapped={false} />
          </mesh>
          {show && (
            <Html position={b.end.clone().multiplyScalar(1.03)} center zIndexRange={[16, 6]} className="twin-pin-wrap">
              <button ref={(el) => (pins.current[i] = el)} type="button" className="twin-pin" style={{ animationDelay: `${(b.delay + 1.2) * 1000}ms` }} onClick={() => useObs.setState({ twinFocus: i })}>
                <b>{i + 1}</b> {b.t.name.split(",")[0]} <i>{b.t.similarity}</i>
              </button>
            </Html>
          )}
        </group>
      ))}
    </group>
  );
}
