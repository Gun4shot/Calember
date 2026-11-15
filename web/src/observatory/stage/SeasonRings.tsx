// Station 4 · Fire tree rings: a clock face of the fire year. Each fire year is a ring (oldest inside), drawn from
// season onset to end with a bead at the peak; rings grow outward like a tree. Trend arcs on the rim show how far
// onset, peak and end moved over the record (Sen's slope; faint when not significant).
import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { MONTHS_SHORT } from "../../app/format";
import { useObs } from "../store";
import { INFERNO } from "../world/shaders";
import { presence } from "./state";

const R0 = 2.2, DR = 0.22;
const ang = (doy: number) => (doy / 365) * Math.PI * 2; // clockwise from the top (local -z)
const at = (doy: number, r: number, y = 0) => new THREE.Vector3(Math.sin(ang(doy)) * r, y, -Math.cos(ang(doy)) * r);

const VS = /* glsl */ `
  attribute float aT; attribute float aRing; attribute float aHeat;
  varying float vT; varying float vRing; varying float vHeat;
  void main() { vT = aT; vRing = aRing; vHeat = aHeat; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const FS = /* glsl */ `
  ${INFERNO}
  uniform float uT; uniform float uPres; uniform float uN;
  varying float vT; varying float vRing; varying float vHeat;
  void main() {
    float start = 0.25 + vRing * 0.07;
    float prog = clamp((uT - start) / 0.55, 0.0, 1.0);
    if (vT > prog) discard;
    float head = smoothstep(0.06, 0.0, prog - vT) * step(prog, 0.999);
    float age = vRing / max(1.0, uN - 1.0);
    vec3 c = inferno(0.18 + 0.72 * age) * (0.6 + 0.5 * vHeat);
    c += vec3(1.0, 0.9, 0.7) * head * 1.5;
    gl_FragColor = vec4(c, uPres);
  }
`;

export function SeasonRings() {
  const season = useObs((s) => s.season);
  const station = useObs((s) => s.station);
  const group = useRef<THREE.Group>(null);
  const t0 = useRef(-1);

  const built = useMemo(() => {
    if (!season) return null;
    const ys = season.years.filter((y) => !y.insufficient && y.onset_doy !== null && y.end_doy !== null);
    if (!ys.length) return { ys, mesh: null, beads: [] as THREE.Vector3[], rMax: R0, mat: null };
    const tMax = Math.max(...ys.map((y) => y.total));
    const pos: number[] = [], aT: number[] = [], aRing: number[] = [], aHeat: number[] = [], idx: number[] = [];
    const beads: THREE.Vector3[] = [];
    ys.forEach((y, i) => {
      const r = R0 + i * DR;
      const w = 0.03 + 0.065 * Math.sqrt(y.total / tMax);
      const a0 = y.onset_doy!, a1 = Math.max(a0 + 1, y.end_doy!);
      const N = 96;
      const base = pos.length / 3;
      for (let k = 0; k <= N; k++) {
        const d = a0 + ((a1 - a0) * k) / N;
        const pIn = at(d, r - w), pOut = at(d, r + w);
        pos.push(pIn.x, 0.14, pIn.z, pOut.x, 0.14, pOut.z);
        aT.push(k / N, k / N);
        aRing.push(i, i);
        aHeat.push(Math.sqrt(y.total / tMax), Math.sqrt(y.total / tMax));
        if (k < N) idx.push(base + k * 2, base + k * 2 + 1, base + k * 2 + 2, base + k * 2 + 1, base + k * 2 + 3, base + k * 2 + 2);
      }
      if (y.peak_doy !== null) beads.push(at(y.peak_doy, r, 0.2));
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aT", new THREE.Float32BufferAttribute(aT, 1));
    g.setAttribute("aRing", new THREE.Float32BufferAttribute(aRing, 1));
    g.setAttribute("aHeat", new THREE.Float32BufferAttribute(aHeat, 1));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: { uT: { value: 0 }, uPres: { value: 0 }, uN: { value: ys.length } }, transparent: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, mat);
    return { ys, mesh, beads, rMax: R0 + ys.length * DR, mat };
  }, [season]);

  // rim: month ticks (fire-year months starting at fire_year_start_month)
  const rim = useMemo(() => {
    if (!season || !built) return null;
    const r = built.rMax + 0.45;
    const circle: THREE.Vector3[] = [];
    for (let k = 0; k <= 128; k++) circle.push(at((k / 128) * 365, r, 0.14));
    const ticks = Array.from({ length: 12 }, (_, k) => ({ label: MONTHS_SHORT[(season.fire_year_start_month - 1 + k) % 12], p: at(k * 30.42, r + 0.65), a: at(k * 30.42, r, 0.14), b: at(k * 30.42, r - 0.3, 0.14) }));
    // trend arcs: mean position, moved by Sen's slope over the record span
    const span = built.ys.length > 1 ? (built.ys[built.ys.length - 1].fire_year - built.ys[0].fire_year) / 10 : 0;
    type SY = NonNullable<typeof season>["years"][number];
    const keys: Array<{ k: "onset" | "peak" | "end"; doy: (y: SY) => number | null; label: string }> = [
      { k: "onset", doy: (y) => y.onset_doy, label: "onset" },
      { k: "peak", doy: (y) => y.peak_doy, label: "peak" },
      { k: "end", doy: (y) => y.end_doy, label: "end" },
    ];
    const arcs = keys.map(({ k, doy, label }, j) => {
      const vals = built.ys.map(doy).filter((v): v is number => v !== null);
      const mean = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
      const tr = season.trends[k];
      const slope = tr?.sen_days_per_decade ?? 0;
      const moved = slope * span;
      const rr = r + 1.6 + j * 0.42;
      const pts: THREE.Vector3[] = [];
      const from = mean - moved / 2, to = mean + moved / 2;
      for (let s = 0; s <= 24; s++) pts.push(at(from + ((to - from) * s) / 24, rr, 0.16));
      return { k, label, pts, sig: tr?.p !== null && tr?.p !== undefined && tr.p < 0.05, moved, head: at(to, rr, 0.16), slope, p: tr?.p ?? null };
    });
    return { circle, ticks, arcs };
  }, [season, built]);

  useFrame((st) => {
    const p = presence.season;
    if (group.current) group.current.visible = p > 0.002;
    if (!built?.mat) return;
    if (p > 0.01 && t0.current < 0) t0.current = st.clock.elapsedTime;
    if (p < 0.01) t0.current = -1;
    built.mat.uniforms.uT.value = t0.current < 0 ? 0 : (st.clock.elapsedTime - t0.current) / 1.6;
    built.mat.uniforms.uPres.value = p;
  });

  if (!built) return null;
  const show = station === "season";
  return (
    <group ref={group}>
      {built.mesh && <primitive object={built.mesh} renderOrder={2} />}
      {built.beads.map((b, i) => (
        <mesh key={i} position={b}>
          <sphereGeometry args={[0.06, 10, 10]} />
          <meshBasicMaterial color="#fff2c8" toneMapped={false} />
        </mesh>
      ))}
      {rim && (
        <>
          <Line renderOrder={4} points={rim.circle} color="#8fa6cf" lineWidth={1} transparent opacity={0.5} />
          {rim.ticks.map((t, i) => (
            <Line renderOrder={4} key={i} points={[t.a, t.b]} color="#8fa6cf" lineWidth={1} transparent opacity={0.6} />
          ))}
          {rim.arcs.map((a) =>
            Math.abs(a.moved) >= 1 ? <Line renderOrder={4} key={a.k} points={a.pts} color={a.sig ? "#ffb347" : "#6f7a8c"} lineWidth={a.sig ? 3 : 1.6} transparent opacity={a.sig ? 1 : 0.6} /> : null,
          )}
          {show &&
            rim.ticks.map((t) => (
              <Html key={t.label} position={t.p} center zIndexRange={[12, 4]}>
                <span className="cal-lbl">{t.label}</span>
              </Html>
            ))}
          {show &&
            rim.arcs.map((a) => (
              <Html key={a.k} position={a.head} center zIndexRange={[12, 4]}>
                <span className={`trend-chip ${a.sig ? "sig" : ""}`}>
                  {a.label} {Math.abs(a.slope) < 0.5 ? "steady" : `${a.slope > 0 ? "+" : "−"}${Math.abs(a.slope).toFixed(0)} d/decade`}
                  {a.p !== null && <i> p {a.p < 0.01 ? "< 0.01" : `= ${a.p.toFixed(2)}`}</i>}
                </span>
              </Html>
            ))}
          {show && built.ys.length > 0 && (
            <>
              <Html position={at(0, R0 - 0.35, 0.1)} center zIndexRange={[12, 4]}>
                <span className="cal-lbl muted">{built.ys[0].fire_year}</span>
              </Html>
              <Html position={at(0, built.rMax - 0.1, 0.1)} center zIndexRange={[12, 4]}>
                <span className="cal-lbl">{built.ys[built.ys.length - 1].fire_year}</span>
              </Html>
            </>
          )}
        </>
      )}
    </group>
  );
}
