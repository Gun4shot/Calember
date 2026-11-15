// Act 4 · real-data evidence in 3D (replaces the flat v3 figure panels).
//   Outage: every MODIS detection on Earth, day by day, Jul–Sep 2020. A cursor sweeps the days; Terra (ice) and
//           Aqua (amber) columns spring up. On Aqua's outage days the amber first rises to a normal day, then
//           crumbles, leaving a red ghost of what was lost. A glowing Calember line (daily, from VIIRS) bridges the hole.
//   Seam:   the planet's monthly fire count 2009–2015, raw sensors summed. The bars leap when VIIRS joins in 2012,
//           then the same collapse wave as the Punjab ridge brings them down to the Calember record.
// Data: story_extras.json (aqua_outage) and globe_meta.json (monthly totals). Pure function of u (reversible).

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import type { StoryData } from "./data";
import { SPRING } from "./glsl";
import { fmt, ramp } from "./math";
import { film } from "./store";
import { U, inActsAt } from "./timeline";

export const EVIDENCE_POS = new THREE.Vector3(0, 2, -11);
const SEAM = true;
const X0 = -8.4;
const X1 = 8.4;
const H = 7.2; // tallest column

export function evidenceVisibility(u: number, inActs: boolean) {
  return inActs ? Math.min(ramp(U.outage[0] - 0.004, U.outage[0] + 0.004, u), 1 - ramp(0.587, 0.6, u)) : 0;
}

const BAR_VS = /* glsl */ `
  ${SPRING}
  attribute float aX; attribute float aA; attribute float aB; attribute float aC; attribute float aFlag;
  uniform float uKind; uniform float uCursor; uniform float uWave; uniform float uSink; uniform float uScale;
  varying float vY; varying float vK; varying float vFlag;
  void main() {
    // reveal: each column springs up as the cursor passes it
    float g = springK(max(0.0, uCursor - aX) * 18.0, 15.0, 0.45);
    // collapse after the cursor has passed (outage: Aqua crumbles; seam: raw → Calember wave)
    float k = uKind < 2.5 ? clamp((uCursor - aX - 0.05) * 9.0, 0.0, 1.0) : clamp((uWave - aX) * 7.0, 0.0, 1.0);
    k = k * k * (3.0 - 2.0 * k);
    float y0 = 0.0; float h = 0.0;
    if (uKind < 0.5) { h = aA; }                                   // Terra
    else if (uKind < 1.5) { y0 = aA; h = mix(aC, aB, k * aFlag); } // Aqua (outage days: a normal day → what was recorded)
    else if (uKind < 2.5) { y0 = aA + aB; h = (aC - aB) * aFlag * k; }  // lost
    else { h = mix(aA, aB, k); }                                   // seam: raw → Calember
    vec3 p = position; // unit box, y in [0,1]
    vY = p.y; vK = k; vFlag = aFlag;
    p.y = (y0 + p.y * max(0.0005, h)) * g * (1.0 - uSink) * uScale;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;
const BAR_FS = /* glsl */ `
  uniform float uKind; uniform float uA; uniform vec3 uC; uniform vec3 uC2; uniform float uTime;
  varying float vY; varying float vK; varying float vFlag;
  void main() {
    vec3 c = uC;
    float a = uA;
    if (uKind > 1.5 && uKind < 2.5) {
      // lost detections: a hollow, flickering red ghost
      float scan = 0.55 + 0.45 * sin(vY * 40.0 - uTime * 6.0);
      c = uC * (0.5 + 0.9 * scan);
      a *= 0.55 * vK;
    } else if (uKind > 2.5) {
      c = mix(uC, uC2, vK);
    }
    c *= 0.35 + 0.75 * vY;
    gl_FragColor = vec4(c, a);
  }
`;
const TUBE_FS = /* glsl */ `
  uniform float uA; uniform float uCursor; uniform float uTime;
  varying vec2 vUv;
  void main() {
    float on = smoothstep(vUv.x - 0.004, vUv.x + 0.004, uCursor);
    float pulse = 0.8 + 0.2 * sin(vUv.x * 60.0 - uTime * 3.0);
    gl_FragColor = vec4(vec3(1.0, 0.9, 0.62) * 1.7 * pulse, uA * on);
  }
`;
const TUBE_VS = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

type Reg = (g: string) => (el: HTMLElement | null) => void;
function Lbl({ p, g, reg, cls = "", children }: { p: [number, number, number]; g: string; reg: Reg; cls?: string; children: ReactNode }) {
  return (
    <Html position={p} zIndexRange={[3, 0]} style={{ pointerEvents: "none" }}>
      <div ref={reg(g)} className={`l3d ${cls}`} style={{ opacity: 0, visibility: "hidden" }}>
        {children}
      </div>
    </Html>
  );
}

function barMesh(n: number, w: number, attrs: Record<string, Float32Array>, xs: number[], kind: number, c: string, c2 = c) {
  const geo = new THREE.BoxGeometry(w, 1, w * 0.9).translate(0, 0.5, 0);
  for (const [k, a] of Object.entries(attrs)) geo.setAttribute(k, new THREE.InstancedBufferAttribute(a, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: BAR_VS,
    fragmentShader: BAR_FS,
    uniforms: {
      uKind: { value: kind },
      uCursor: { value: 0 },
      uWave: { value: 0 },
      uSink: { value: 0 },
      uScale: { value: 1 },
      uA: { value: 0 },
      uC: { value: new THREE.Color(c) },
      uC2: { value: new THREE.Color(c2) },
      uTime: { value: 0 },
    },
    transparent: true,
    depthWrite: kind !== 2,
    blending: kind === 2 ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < n; i++) mesh.setMatrixAt(i, m4.makeTranslation(xs[i], 0, 0));
  mesh.frustumCulled = false;
  return { mesh, mat };
}

export function Evidence({ data }: { data: StoryData }) {
  const group = useRef<THREE.Group>(null);
  const outGrp = useRef<THREE.Group>(null);
  const seamGrp = useRef<THREE.Group>(null);
  const labels = useRef(new Map<string, Set<HTMLElement>>());
  const cursorLbl = useRef<HTMLElement | null>(null);
  const cursorMesh = useRef<THREE.Mesh>(null);
  const cursorGrp = useRef<THREE.Group>(null);
  const reg: Reg = useCallback(
    (g) => (el) => {
      if (!el) return;
      let s = labels.current.get(g);
      if (!s) labels.current.set(g, (s = new Set()));
      s.add(el);
    },
    [],
  );
  const setGroup = (g: string, a: number) => {
    const s = labels.current.get(g);
    if (!s) return;
    const op = a.toFixed(3);
    const vis = a > 0.002 ? "visible" : "hidden";
    for (const el of s) {
      if (el.style.opacity !== op) el.style.opacity = op;
      if (el.style.visibility !== vis) el.style.visibility = vis;
    }
  };

  // ---- outage: days ----
  const ao = data.extras.aqua_outage;
  const out = useMemo(() => {
    const n = ao.days.length;
    const i0 = ao.days.indexOf(ao.outage[0]);
    const i1 = ao.days.indexOf(ao.outage[1]);
    const ymax = Math.max(...ao.days.map((_, i) => ao.terra[i] + Math.max(ao.aqua[i], ao.aqua_normal[i])), ...ao.ember);
    const sc = H / ymax;
    const xs = ao.days.map((_, i) => X0 + (i / (n - 1)) * (X1 - X0));
    const ax = new Float32Array(n);
    const aA = new Float32Array(n);
    const aB = new Float32Array(n);
    const aC = new Float32Array(n);
    const aF = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ax[i] = i / (n - 1);
      aA[i] = ao.terra[i] * sc;
      aB[i] = ao.aqua[i] * sc;
      const flag = i >= i0 && i <= i1 ? 1 : 0;
      aF[i] = flag;
      aC[i] = (flag ? Math.max(ao.aqua_normal[i], ao.aqua[i]) : ao.aqua[i]) * sc;
    }
    const attrs = { aX: ax, aA, aB, aC, aFlag: aF };
    const w = ((X1 - X0) / (n - 1)) * 0.72;
    const terra = barMesh(n, w, attrs, xs, 0, "#8fb8ff");
    const aqua = barMesh(n, w, attrs, xs, 1, "#c9642a");
    const lost = barMesh(n, w * 1.04, attrs, xs, 2, "#ff3a3a");
    // Calember daily line as a glowing tube along the tops
    const pts = ao.ember.map((v, i) => new THREE.Vector3(xs[i], v * sc, 0.55));
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.2);
    const tubeGeo = new THREE.TubeGeometry(curve, 420, 0.085, 10, false);
    const tubeMat = new THREE.ShaderMaterial({
      vertexShader: TUBE_VS,
      fragmentShader: TUBE_FS,
      uniforms: { uA: { value: 0 }, uCursor: { value: 0 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
    });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.frustumCulled = false;
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    const kept = mean(ao.aqua.slice(i0, i1 + 1)) / mean(ao.aqua.slice(Math.max(0, i0 - 14), i0));
    const ticks = niceTicks(ymax).map((v) => ({ v, y: v * sc }));
    const months = ao.days.map((d, i) => ({ d, i })).filter(({ d }) => d.endsWith("-01") || d.endsWith("-15"));
    return { n, xs, i0, i1, terra, aqua, lost, tube, tubeMat, kept, ticks, months, sc, emberEnd: ao.ember[n - 1] * sc };
  }, [ao]);

  // ---- seam: months 2009–2015, planet-wide ----
  const g = data.globe;
  const seam = useMemo(() => {
    const a = g.months.indexOf("2009-01");
    const b = g.months.indexOf("2015-12");
    const sw = g.months.indexOf("2012-01") - a;
    const raw = g.meta.monthly_total_raw.slice(a, b + 1);
    const harm = g.meta.monthly_total_harm.slice(a, b + 1);
    const n = raw.length;
    const sc = H / Math.max(...raw);
    const xs = raw.map((_, i) => X0 + (i / (n - 1)) * (X1 - X0));
    const ax = new Float32Array(n);
    const aA = new Float32Array(n);
    const aB = new Float32Array(n);
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ax[i] = i / (n - 1);
      aA[i] = raw[i] * sc;
      aB[i] = harm[i] * sc;
    }
    const w = ((X1 - X0) / (n - 1)) * 0.72;
    const bars = barMesh(n, w, { aX: ax, aA, aB, aC: z, aFlag: z }, xs, 3, "#9ec9ff", "#ff9a4d");
    const mean = (arr: number[], i0: number, i1: number) => arr.slice(i0, i1).reduce((s, v) => s + v, 0) / (i1 - i0);
    return {
      n,
      xs,
      sw,
      bars,
      rawJump: mean(raw, sw, n) / mean(raw, 0, sw),
      harmJump: mean(harm, sw, n) / mean(harm, 0, sw),
      ticks: niceTicks(Math.max(...raw)).map((v) => ({ v, y: v * sc })),
      years: [2009, 2010, 2011, 2012, 2013, 2014, 2015].map((yy) => ({ yy, x: xs[(yy - 2009) * 12] })),
      seamX: xs[sw] - (xs[1] - xs[0]) / 2,
      rawPeak: Math.max(...raw.slice(sw)) * sc,
      rescale: (0.75 * Math.max(...raw)) / Math.max(...harm),
      harmPeak: Math.max(...harm) * sc,
    };
  }, [g]);

  useFrame((state) => {
    const u = film.u;
    const inActs = inActsAt(film.s);
    const vis = evidenceVisibility(u, inActs);
    if (group.current) group.current.visible = vis > 0.002;
    if (vis <= 0.002) {
      for (const k of labels.current.keys()) setGroup(k, 0);
      return;
    }
    const time = state.clock.elapsedTime;
    // outage beat
    const [o0, o1] = U.outage;
    const cur = ramp(o0 + 0.004, o1 - 0.012, u) * 1.08; // a little past the end so every column settles
    const sink = ramp(o1 - 0.004, o1 + 0.006, u);
    const outA = vis * (1 - sink);
    for (const m of [out.terra.mat, out.aqua.mat, out.lost.mat]) {
      m.uniforms.uCursor.value = cur;
      m.uniforms.uSink.value = sink;
      m.uniforms.uA.value = outA * (m === out.lost.mat ? 1 : 0.92);
      m.uniforms.uTime.value = time;
    }
    out.tubeMat.uniforms.uCursor.value = cur;
    out.tubeMat.uniforms.uA.value = outA;
    out.tubeMat.uniforms.uTime.value = time;
    if (outGrp.current) outGrp.current.visible = outA > 0.002;
    const curX = X0 + Math.min(1, cur) * (X1 - X0);
    if (cursorGrp.current) cursorGrp.current.position.x = curX;
    if (cursorMesh.current) {
      cursorMesh.current.position.x = curX;
      (cursorMesh.current.material as THREE.MeshBasicMaterial).opacity = outA * 0.55 * (1 - ramp(0.98, 1.05, cur));
    }
    if (cursorLbl.current) {
      const di = Math.min(out.n - 1, Math.max(0, Math.round(Math.min(1, cur) * (out.n - 1))));
      const txt = dayLabel(ao.days[di]);
      if (cursorLbl.current.textContent !== txt) cursorLbl.current.textContent = txt;
    }
    setGroup("o-axis", outA * ramp(o0, o0 + 0.008, u));
    setGroup("o-cursor", outA * (1 - ramp(0.98, 1.05, cur)));
    setGroup("o-out", outA * ramp((out.i1 + 2) / (out.n - 1), (out.i1 + 6) / (out.n - 1), cur));
    setGroup("o-ember", outA * ramp(1.0, 1.06, cur));

    // seam beat
    const [s0, s1] = U.seam;
    const sCur = ramp(s0 + 0.002, s0 + 0.016, u) * 1.08;
    const wave = ramp(s0 + 0.018, s1 - 0.006, u) * 1.25 - 0.05;
    const seamA = SEAM ? vis * ramp(s0 - 0.002, s0 + 0.004, u) : 0;
    const resc = ramp(s1 - 0.012, s1 - 0.002, u);
    const sm = seam.bars.mat;
    sm.uniforms.uCursor.value = sCur;
    sm.uniforms.uWave.value = wave;
    sm.uniforms.uSink.value = 0;
    sm.uniforms.uScale.value = 1 + (seam.rescale - 1) * resc;
    sm.uniforms.uA.value = seamA * 0.92;
    if (seamGrp.current) seamGrp.current.visible = seamA > 0.002;
    setGroup("s-axis", seamA);
    setGroup("s-ticks", seamA * (1 - resc)); // the y scale changes when the Calember record is re-scaled
    setGroup("s-jump", seamA * ramp(0.62, 0.8, sCur) * (1 - ramp(0.15, 0.35, wave)));
    setGroup("s-ember", seamA * ramp(0.75, 0.95, wave));
  });

  const day0 = out.xs[out.i0];
  const day1 = out.xs[out.i1];
  return (
    <group ref={group} position={EVIDENCE_POS} visible={false}>
      {/* ---- outage ---- */}
      <group ref={outGrp}>
        <primitive object={out.terra.mesh} />
        <primitive object={out.aqua.mesh} />
        <primitive object={out.lost.mesh} />
        <primitive object={out.tube} />
        <mesh ref={cursorMesh} position={[X0, H / 2 + 0.3, 0.7]}>
          <planeGeometry args={[0.05, H + 0.8]} />
          <meshBasicMaterial color="#cfe4ff" transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <Lbl p={[0, H + 2.0, 0.6]} g="o-axis" reg={reg} cls="a-b bars-title">
        Every MODIS fire detection on Earth, day by day
        <small>summer 2020 · raw FIRMS · each column is one day</small>
      </Lbl>
      <Lbl p={[0, -1.25, 0.6]} g="o-axis" reg={reg} cls="a-t bars-legend">
        <span className="lg lg-t">
          <i />
          Terra (morning)
        </span>
        <span className="lg lg-aq">
          <i />
          Aqua (afternoon)
        </span>
        <span className="lg lg-lost">
          <i />
          lost by Aqua
        </span>
        <span className="lg lg-ember">
          <i />
          Calember (from VIIRS)
        </span>
      </Lbl>
      {out.ticks.map((t) => (
        <Lbl key={t.v} p={[X0 - 0.4, t.y, 0.6]} g="o-axis" reg={reg} cls="a-r tick">
          {kfmt(t.v)}
        </Lbl>
      ))}
      {out.months.map(({ d, i }) => (
        <Lbl key={d} p={[out.xs[i], -0.3, 0.6]} g="o-axis" reg={reg} cls="a-t tick">
          {dayLabel(d)}
        </Lbl>
      ))}
      <group ref={cursorGrp} position={[X0, 0, 0]}>
        <Lbl p={[0, H + 0.95, 0.7]} g="o-cursor" reg={reg} cls="a-b ev-cursor">
          <span ref={(el) => (cursorLbl.current = el)}>–</span>
        </Lbl>
      </group>
      <Lbl p={[(day0 + day1) / 2, H + 0.75, 0.7]} g="o-out" reg={reg} cls="a-b ev-out">
        Aqua outage · {dayLabel(ao.outage[0])} – {dayLabel(ao.outage[1])}
        <small>
          {out.i1 - out.i0 + 1} days at {Math.round(out.kept * 100)} % of a normal day
        </small>
      </Lbl>
      <Lbl p={[X1, H + 0.75, 0.7]} g="o-ember" reg={reg} cls="a-br ev-ember">
        Calember keeps counting
        <small>its VIIRS input never stopped</small>
      </Lbl>

      {/* ---- seam ---- */}
      <group ref={seamGrp}>
        <primitive object={seam.bars.mesh} />
      </group>
      <Lbl p={[0, H + 2.0, 0.6]} g="s-axis" reg={reg} cls="a-b bars-title">
        The whole planet, month by month, 2009–2015
        <small>every fire cell on Earth · hotspots per month</small>
      </Lbl>
      {seam.years.map(({ yy, x }) => (
        <Lbl key={yy} p={[x, -0.3, 0.6]} g="s-axis" reg={reg} cls={`a-t tick ${yy === 2012 ? "exact" : ""}`}>
          {yy}
        </Lbl>
      ))}
      {seam.ticks.map((t) => (
        <Lbl key={t.v} p={[X1 + 0.4, t.y, 0.6]} g="s-ticks" reg={reg} cls="a-l tick">
          {kfmt(t.v)}
        </Lbl>
      ))}
      <Lbl p={[seam.seamX, -1.0, 0.6]} g="s-axis" reg={reg} cls="a-t ev-seam">
        ▲ VIIRS joins
      </Lbl>
      <Lbl p={[seam.xs[Math.round(seam.n * 0.72)], seam.rawPeak + 0.5, 0.7]} g="s-jump" reg={reg} cls="a-b ev-jump">
        raw: ×{seam.rawJump.toFixed(1)} overnight
        <small>more satellites, not more fire</small>
      </Lbl>
      <Lbl p={[seam.xs[Math.round(seam.n * 0.72)], H * 0.75 + 1.0, 0.7]} g="s-ember" reg={reg} cls="a-b ev-ember">
        Calember: ×{seam.harmJump.toFixed(2)}
        <small>the record carries straight on</small>
      </Lbl>
    </group>
  );
}

function niceTicks(max: number, n = 3) {
  const raw = max / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}
const kfmt = (v: number) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)} M` : v >= 1000 ? `${Math.round(v / 1000)}k` : fmt(v));
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
