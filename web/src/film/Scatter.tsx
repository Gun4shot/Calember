// Act 4 · the scorecard. Every province-month of the sealed 2020 test as a point:
// x = what MODIS actually saw, y = the prediction (log scale).
//   1. the dots land on the chart floor at their MODIS value (the prediction is still unknown)
//   2. they rise to the one-global-ratio guess; a 2× band and a live stats strip show how far off
//   3. the cloud morphs to the SOTA-style look-up method, then snaps onto the diagonal with Calember
//   4. the camera moves to a grouped bar chart: skill on three tests × three methods
// A stats panel and an error histogram follow the morph. All chart text is crisp DOM (drei Html),
// not SDF text inside the bloom pass.

import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import type { StoryData } from "./data";
import { SPRING } from "./glsl";
import { clamp, hash01, ramp, spring } from "./math";
import { film } from "./store";
import { U, inActsAt } from "./timeline";

export const SCATTER_POS = new THREE.Vector3(0, 6, -16); // raised so the histogram below clears the ground
const L = 13; // plot size (world units)
const V_MIN = 5; // log axis starts here (the chart shows province-months with ≥ 10 MODIS hotspots)
const HIST_Y = -5.6; // histogram baseline (local, below the chart)
const HIST_H = 2.6;
const BARS_Z = 5; // grouped bars sit in front of the chart (world z −11)
const BARS_Y = -4; // …standing on the ground (world y 2)
const BAR_H = 8; // bar height for KGE 1.00 (axis starts at 0.90)
const METHODS = ["one global ratio", "state-of-the-art style", "Calember"] as const;
const M_COL = ["#8b93a7", "#9ec9ff", "#ff9a4d"] as const;

export function scatterVisibility(u: number, inActs: boolean) {
  return inActs ? Math.min(ramp(U.fly[0] - 0.01, U.fly[0] + 0.02, u), 1 - ramp(0.548, 0.566, u)) : 0;
}

const PRED = /* glsl */ `
  float ease(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
  float stageOf(float seed) { return clamp(uStage * 1.12 - seed * 0.12, 0.0, 2.0); }
  float predOf(float st) { return st < 1.0 ? mix(aH0, aH0b, ease(st)) : mix(aH0b, aOurs, ease(st - 1.0)); }
  float riseOf(float seed) { return ease(uRise * 1.35 - seed * 0.35); }
  vec3 errCol(float err) { return mix(vec3(1.0, 0.55, 0.2), vec3(0.55, 0.75, 1.0), smoothstep(0.03, 0.35, err)); }
`;

const VS = /* glsl */ `
  attribute float aObs; attribute float aH0; attribute float aH0b; attribute float aOurs; attribute float aSeed; attribute vec2 aStart;
  uniform float uStage; uniform float uFly; uniform float uRise; uniform float uPx; uniform float uPulse; uniform float uTime; uniform float uLocked;
  varying vec3 vCol; varying float vA;
  ${PRED}
  void main() {
    float st = stageOf(aSeed);
    float y = predOf(st);
    float rk = riseOf(aSeed);
    // while a point moves (rising, or between methods) it lifts out of the wall into depth, then lands
    float lift = (st > 0.0 && st < 2.0) ? sin(3.14159 * fract(st)) : 0.0;
    lift = max(lift, sin(3.14159 * rk) * 0.7);
    vec3 target = vec3(aObs * ${L.toFixed(1)}, mix(0.0, y, rk) * ${L.toFixed(1)}, lift * (aSeed - 0.35) * 4.5);
    // fly in from the ridge (in front of the wall, near the ground)
    float kf = ease(uFly * 1.5 - aSeed * 0.5);
    vec3 start = vec3(aStart.x, aStart.y, 16.0);
    vec3 mid = vec3(mix(aStart.x, target.x, 0.5), 9.0 + aSeed * 3.0, 8.0);
    vec3 pos = mix(mix(start, mid, kf), mix(mid, target, kf), kf);
    // colour by error once a prediction exists: on the diagonal = ember, far = ice
    float err = abs(y - aObs) * 4.4;
    vCol = mix(vec3(0.72, 0.76, 0.86), errCol(err), rk) * 0.95;
    // ignition: a band of light races up the diagonal when Calember locks on, then keeps sweeping slowly
    float onLine = 1.0 - smoothstep(0.02, 0.12, err);
    float sweep = exp(-pow(abs((aObs - uPulse) * 9.0), 2.0));
    float idle = exp(-pow(abs((aObs - fract(uTime * 0.12)) * 14.0), 2.0)) * uLocked;
    vCol += vec3(1.0, 0.92, 0.75) * onLine * (sweep * 2.2 + idle * 1.1) * rk;
    vA = smoothstep(0.0, 0.2, kf);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = clamp(uPx * 30.0 / -mv.z, 1.5, 4.5);
    gl_Position = projectionMatrix * mv;
  }
`;
const FS = /* glsl */ `
  uniform float uA;
  varying vec3 vCol; varying float vA;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.25, 0.08, dot(d, d)) * vA * uA * 0.62;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vCol, a);
  }
`;

const BAR_VS = /* glsl */ `
  ${SPRING}
  uniform float uK; uniform float uH;
  varying vec3 vP;
  void main() {
    vec3 p = position; // unit box, y in [0,1]
    vP = p;
    p.y *= max(0.001, springK(uK, 11.0, 0.42)) * uH;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const BAR_FS = /* glsl */ `
  uniform vec3 uC; uniform float uA; uniform float uHot;
  varying vec3 vP;
  void main() {
    vec3 q = abs(vP - vec3(0.0, 0.5, 0.0));
    float edge = max(smoothstep(0.44, 0.5, max(q.x, q.z)), smoothstep(0.485, 0.5, q.y));
    vec3 c = uC * (0.16 + 0.3 * vP.y) + uC * edge * (0.55 + uHot);
    gl_FragColor = vec4(c, (0.62 + 0.38 * edge) * uA);
  }
`;

// ---- crisp labels: DOM elements anchored in 3D, faded per group from useFrame ----------------
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

function makeBarMat(color: string, h: number) {
  return new THREE.ShaderMaterial({
    vertexShader: BAR_VS,
    fragmentShader: BAR_FS,
    uniforms: { uK: { value: 0 }, uH: { value: h }, uC: { value: new THREE.Color(color) }, uA: { value: 0 }, uHot: { value: 0 } },
    transparent: true,
    depthWrite: false,
  });
}

type V3 = [number, number, number];

export function Scatter({ data }: { data: StoryData }) {
  const group = useRef<THREE.Group>(null);
  const bandGrp = useRef<THREE.Group>(null);
  const chrome = useRef<THREE.Group>(null);
  const histChrome = useRef<THREE.Group>(null);
  const ghostGrp = useRef<THREE.Group>(null);
  const barsGrp = useRef<THREE.Group>(null);
  const labels = useRef(new Map<string, Set<HTMLElement>>());
  const tagRef = useRef<HTMLElement | null>(null);
  const statRefs = useRef<(HTMLElement | null)[]>([]);
  const histNow = useRef<HTMLElement | null>(null);
  const barVal = useRef<(HTMLElement | null)[]>([]);
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
      if (!el.isConnected) {
        s.delete(el);
        continue;
      }
      if (el.style.opacity !== op) el.style.opacity = op;
      if (el.style.visibility !== vis) el.style.visibility = vis;
    }
  };

  const r = data.results;
  const st = data.scatterStats;

  // ---- points: province-months where MODIS saw ≥ minObs hotspots (the same set the stats panel uses) ----
  const minObs = st.minObs;
  const { points, mat, vmax } = useMemo(() => {
    const src = data.scatter;
    const n = src.length / 4;
    let vmax = 1;
    const keep: number[] = [];
    for (let i = 0; i < n; i++) {
      if (src[4 * i] < minObs) continue;
      keep.push(i);
      vmax = Math.max(vmax, src[4 * i], src[4 * i + 1], src[4 * i + 2], src[4 * i + 3]);
    }
    const lv = Math.log10(vmax / V_MIN);
    const f = (v: number) => Math.min(1, Math.max(0, Math.log10(Math.max(v, V_MIN) / V_MIN) / lv));
    const k = keep.length;
    const obs = new Float32Array(k);
    const h0 = new Float32Array(k);
    const h0b = new Float32Array(k);
    const ours = new Float32Array(k);
    const seed = new Float32Array(k);
    const start = new Float32Array(k * 2);
    keep.forEach((i, j) => {
      obs[j] = f(src[4 * i]);
      h0[j] = f(src[4 * i + 1]);
      h0b[j] = f(src[4 * i + 2]);
      ours[j] = f(src[4 * i + 3]);
      seed[j] = hash01(j * 1.7);
      start[2 * j] = (hash01(j * 3.1) - 0.5) * 30;
      start[2 * j + 1] = -2 + hash01(j * 5.3) * 3;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(k * 3), 3));
    for (const [name, arr] of [
      ["aObs", obs],
      ["aH0", h0],
      ["aH0b", h0b],
      ["aOurs", ours],
      ["aSeed", seed],
    ] as const)
      g.setAttribute(name, new THREE.BufferAttribute(arr, 1));
    g.setAttribute("aStart", new THREE.BufferAttribute(start, 2));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: {
        uStage: { value: 0 },
        uFly: { value: 0 },
        uRise: { value: 0 },
        uA: { value: 0 },
        uPx: { value: 1.5 },
        uPulse: { value: -1 },
        uTime: { value: 0 },
        uLocked: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(g, mat);
    points.frustumCulled = false;
    return { points, mat, vmax };
  }, [data, minObs]);

  const lv = Math.log10(vmax / V_MIN);
  const fpos = useCallback((v: number) => Math.min(1, Math.max(0, Math.log10(Math.max(v, V_MIN) / V_MIN) / lv)) * L, [lv]);

  // ---- 2× band (curves in log1p space) ---------------------------------------------------
  const band = useMemo(() => {
    const hi: V3[] = [];
    const lo: V3[] = [];
    for (let e = 0; e <= 60; e++) {
      const v = V_MIN * Math.pow(vmax / V_MIN, e / 60);
      if (fpos(v * 2) <= L) hi.push([fpos(v), fpos(v * 2), 0.02]);
      lo.push([fpos(v), fpos(v / 2), 0.02]);
    }
    return { hi, lo };
  }, [vmax, fpos]);

  // ---- error histogram: log10((pred+1)/(obs+1)), 41 bins over ÷16 … ×16 ---------------------
  const NB = 41;
  const H_LO = -1.2;
  const H_HI = 1.2;
  const { hist, histMat, ghost } = useMemo(() => {
    const src = data.scatter;
    const n = src.length / 4;
    const cnt = [new Float32Array(NB), new Float32Array(NB), new Float32Array(NB)];
    for (let i = 0; i < n; i++) {
      const o = src[4 * i];
      if (o < minObs) continue;
      for (let m = 0; m < 3; m++) {
        const e = Math.log10((src[4 * i + 1 + m] + 1) / (o + 1));
        const b = Math.min(NB - 1, Math.max(0, Math.floor(((e - H_LO) / (H_HI - H_LO)) * NB)));
        cnt[m][b]++;
      }
    }
    let mx = 1;
    for (const c of cnt) for (const v of c) mx = Math.max(mx, v);
    const geo = new THREE.BoxGeometry(1, 1, 0.5).translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, NB);
    const m4 = new THREE.Matrix4();
    const w = L / NB;
    const a0 = new Float32Array(NB);
    const a1 = new Float32Array(NB);
    const a2 = new Float32Array(NB);
    const ctr = new Float32Array(NB);
    const ghost: V3[] = [[0, 0, 0.32]];
    for (let b = 0; b < NB; b++) {
      m4.makeScale(w * 0.78, 1, 1).setPosition((b + 0.5) * w, 0, 0);
      mesh.setMatrixAt(b, m4);
      a0[b] = cnt[0][b] / mx;
      a1[b] = cnt[1][b] / mx;
      a2[b] = cnt[2][b] / mx;
      ctr[b] = Math.abs((b + 0.5) / NB - 0.5) * 2;
      ghost.push([b * w, a0[b] * HIST_H, 0.32], [(b + 1) * w, a0[b] * HIST_H, 0.32]);
    }
    ghost.push([L, 0, 0.32]);
    geo.setAttribute("aH0", new THREE.InstancedBufferAttribute(a0, 1));
    geo.setAttribute("aH1", new THREE.InstancedBufferAttribute(a1, 1));
    geo.setAttribute("aH2", new THREE.InstancedBufferAttribute(a2, 1));
    geo.setAttribute("aCtr", new THREE.InstancedBufferAttribute(ctr, 1));
    const histMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float aH0; attribute float aH1; attribute float aH2; attribute float aCtr;
        uniform float uStage; uniform float uRise;
        varying float vY; varying float vC;
        void main() {
          float s1 = clamp(uStage, 0.0, 1.0), s2 = clamp(uStage - 1.0, 0.0, 1.0);
          float h = mix(mix(aH0, aH1, s1 * s1 * (3.0 - 2.0 * s1)), aH2, s2 * s2 * (3.0 - 2.0 * s2));
          vec3 p = position;
          vY = p.y; vC = aCtr;
          p.y *= max(0.002, h * uRise) * ${HIST_H.toFixed(1)};
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uA;
        varying float vY; varying float vC;
        void main() {
          vec3 c = mix(vec3(1.0, 0.55, 0.2), vec3(0.55, 0.75, 1.0), smoothstep(0.05, 0.4, vC));
          c *= 0.35 + 0.8 * vY;
          gl_FragColor = vec4(c, uA * (0.35 + 0.65 * vY));
        }`,
      uniforms: { uStage: { value: 0 }, uA: { value: 0 }, uRise: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mesh.material = histMat;
    mesh.frustumCulled = false;
    return { hist: mesh, histMat, ghost };
  }, [data, minObs]);

  // ---- grouped bars: three tests × three methods ---------------------------------------------
  const tests = useMemo(
    () => [
      { name: "Unseen regions & years", sub: "2018–2019", v: [r.b2.models.global_ratio.primary, r.b2.models.sota_style.primary, r.b2.models.ember.primary] },
      { name: "Sealed year 2020", sub: "pre-registered, opened once", v: [r.b3.models.global_ratio.primary, r.b3.models.sota_style.primary, r.b3.models.ember.primary] },
      { name: "2020 minus the Aqua outage", sub: "post hoc · Aug–Sep removed", v: [r.b3.excl_aqua_outage.global_ratio, r.b3.excl_aqua_outage.sota_style, r.b3.excl_aqua_outage.ember] },
    ],
    [r],
  );
  const barH = (v: number) => clamp((v - 0.9) / 0.1) * BAR_H;
  const gx = (g: number) => (g - 1) * 4.9;
  const bx = (g: number, m: number) => gx(g) + (m - 1) * 1.22;
  const barMats = useMemo(() => tests.map((t) => t.v.map((v, m) => makeBarMat(M_COL[m], clamp((v - 0.9) / 0.1) * BAR_H))), [tests]);
  const barGeo = useMemo(() => new THREE.BoxGeometry(1.0, 1, 1.0).translate(0, 0.5, 0), []);

  const ticks = useMemo(() => [10, 100, 1000, 10000].filter((v) => v <= vmax).map((v) => ({ v, p: fpos(v) })), [vmax, fpos]);
  const tickLabel = (v: number) => (v >= 1000 ? `${v / 1000}k` : String(v));

  const pctS = (x: number) => `${Math.round(x * 100)} %`;
  const lerpStat = (k: "within25" | "off2x" | "medMiss", s: number) => {
    const [a, b, c] = st.m.map((m) => m[k]);
    return s < 1 ? a + (b - a) * s : b + (c - b) * Math.min(1, s - 1);
  };

  useFrame((state) => {
    const u = film.u;
    const inActs = inActsAt(film.s);
    const vis = scatterVisibility(u, inActs);
    if (group.current) group.current.visible = vis > 0.002;
    if (vis <= 0.002) {
      for (const g of labels.current.keys()) setGroup(g, 0);
      return;
    }
    const showK = ramp(U.show[0], U.show[1], u); // bar chart takes the stage
    const figK = ramp(U.outage[0] - 0.006, U.outage[0] + 0.004, u); // the 3D evidence scene takes the stage
    const chartA = vis * (1 - 0.96 * showK);
    const rise = ramp(U.rise[0], U.rise[1], u);
    const stage = ramp(U.stageSota[0], U.stageSota[1], u) + ramp(U.stageEmber[0], U.stageEmber[1], u);

    mat.uniforms.uA.value = chartA;
    mat.uniforms.uFly.value = ramp(U.fly[0], U.fly[1], u);
    mat.uniforms.uRise.value = rise;
    mat.uniforms.uStage.value = stage;
    mat.uniforms.uPx.value = 1.5 * Math.min(2, state.viewport.dpr);
    const ign = ramp(U.stageEmber[0] + 0.012, U.stageEmber[1] + 0.03, u);
    mat.uniforms.uPulse.value = ign > 0 && ign < 1 ? ign * 1.3 - 0.15 : -1;
    mat.uniforms.uLocked.value = ramp(U.stageEmber[1] + 0.03, U.stageEmber[1] + 0.05, u);
    mat.uniforms.uTime.value = state.clock.elapsedTime;

    // histogram follows the stage; grows with the rise
    histMat.uniforms.uStage.value = stage;
    histMat.uniforms.uRise.value = rise;
    histMat.uniforms.uA.value = chartA;

    // line opacities (drei Line materials)
    const lineA = (grp: THREE.Group | null, a: number) =>
      grp?.traverse((o) => {
        const mm = (o as THREE.Mesh).material as (THREE.Material & { opacity: number }) | undefined;
        if (mm && "opacity" in mm) mm.opacity = a * (o.userData.op ?? 0.5);
      });
    const chromeA = vis * ramp(U.fly[0] + 0.015, U.fly[1], u) * (1 - 0.96 * showK);
    lineA(chrome.current, chromeA);
    const bandA = chartA * ramp(U.rise[0] + 0.006, U.rise[1], u);
    lineA(bandGrp.current, bandA);
    lineA(histChrome.current, chartA * rise);
    const ghostA = chartA * ramp(U.stageSota[0], U.stageSota[0] + 0.01, u);
    lineA(ghostGrp.current, ghostA);

    // chart text leaves completely when the bar chart arrives (dim dots may stay as a backdrop)
    const lblK = 1 - ramp(U.show[0], U.show[0] + 0.014, u);
    setGroup("axis", chromeA * lblK);
    setGroup("band", bandA * lblK);
    const statA = chartA * ramp(U.rise[0] + 0.008, U.rise[1], u) * lblK;
    setGroup("stats", statA);
    setGroup("hist", chartA * rise * lblK);
    setGroup("ghost", ghostA * lblK);

    // method tag + live stats
    const mIdx = stage < 0.5 ? 0 : stage < 1.5 ? 1 : 2;
    const label = METHODS[mIdx];
    if (tagRef.current && tagRef.current.textContent !== label) {
      tagRef.current.textContent = label;
      tagRef.current.dataset.m = String(mIdx);
    }
    if (histNow.current && histNow.current.textContent !== label) histNow.current.textContent = label;
    if (statA > 0.002) {
      const vals = [pctS(lerpStat("within25", stage)), `${(lerpStat("off2x", stage) * 100).toFixed(1)} %`, `± ${pctS(lerpStat("medMiss", stage))}`];
      statRefs.current.forEach((el, i) => {
        if (el && el.textContent !== vals[i]) el.textContent = vals[i];
      });
    }

    // grouped bars
    const kb = ramp(U.bars[0], U.bars[1], u);
    const barsA = vis * showK * (1 - figK);
    if (barsGrp.current) barsGrp.current.visible = barsA > 0.002;
    const pulse = ramp(U.bars[1] - 0.01, U.bars[1] + 0.01, u) * (0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 2.4));
    barMats.forEach((row, g) =>
      row.forEach((m, mi) => {
        m.uniforms.uK.value = Math.max(0, kb * 3.2 - g * 0.75 - mi * 0.16);
        // the value label counts up with its bar (same spring as the shader)
        const el = barVal.current[g * 3 + mi];
        if (el) {
          const v = tests[g].v[mi];
          const txt = (0.9 + (v - 0.9) * Math.min(1, spring(m.uniforms.uK.value, 11, 0.42))).toFixed(4);
          if (el.textContent !== txt) el.textContent = txt;
        }
        m.uniforms.uA.value = barsA;
        m.uniforms.uHot.value = mi === 2 ? 0.3 + 0.7 * pulse : 0;
      }),
    );
    setGroup("barsAxis", barsA * ramp(U.show[0] + 0.01, U.show[1], u));
    tests.forEach((_, g) => setGroup(`bar${g}`, barsA * clamp((kb * 3.2 - g * 0.75 - 0.55) * 2.5)));
    setGroup("gap", barsA * ramp(U.bars[1] - 0.004, U.bars[1] + 0.01, u));
  });

  const frame: V3[] = [
    [0, 0, 0],
    [L, 0, 0],
    [L, L, 0],
    [0, L, 0],
    [0, 0, 0],
  ];
  const hx = (e: number) => ((e - H_LO) / (H_HI - H_LO)) * L;

  return (
    <group ref={group} position={SCATTER_POS} visible={false}>
      <group position={[-L / 2, 0, 0]}>
        <primitive object={points} />

        {/* chart frame, diagonal, ticks */}
        <group ref={chrome}>
          <Line points={frame} color="#3a4256" lineWidth={1} transparent opacity={0} userData={{ op: 0.6 }} />
          <Line points={[[0, 0, 0.01], [L, L, 0.01]]} color="#ffffff" lineWidth={1.8} transparent opacity={0} userData={{ op: 0.85 }} />
        </group>
        {ticks.map((t) => (
          <group key={t.v}>
            <Lbl p={[t.p, -0.3, 0]} g="axis" reg={reg} cls="a-t tick">
              {tickLabel(t.v)}
            </Lbl>
            <Lbl p={[-0.3, t.p, 0]} g="axis" reg={reg} cls="a-r tick">
              {tickLabel(t.v)}
            </Lbl>
          </group>
        ))}
        <Lbl p={[L / 2, -1.0, 0]} g="axis" reg={reg} cls="a-t axis-title">
          what MODIS actually counted →<small>hotspots in one province, one month of 2020</small>
        </Lbl>
        <Lbl p={[-1.35, L / 2, 0]} g="axis" reg={reg} cls="a-c axis-title vert">
          prediction from VIIRS →
        </Lbl>

        {/* 2× band */}
        <group ref={bandGrp}>
          <Line points={band.hi} color="#9ec9ff" lineWidth={1.2} dashed dashSize={0.22} gapSize={0.16} transparent opacity={0} userData={{ op: 0.55 }} />
          <Line points={band.lo} color="#9ec9ff" lineWidth={1.2} dashed dashSize={0.22} gapSize={0.16} transparent opacity={0} userData={{ op: 0.55 }} />
        </group>
        <Lbl p={[fpos(vmax / 2.2) - 0.15, L - 0.25, 0]} g="band" reg={reg} cls="a-tr band-l">
          2× too high
        </Lbl>
        <Lbl p={[L - 0.15, fpos(vmax / 2.2) - 0.2, 0]} g="band" reg={reg} cls="a-tr band-l">
          2× too low
        </Lbl>

        {/* method tag + live stats (empty upper-left corner of the chart) */}
        <Lbl p={[0.3, L - 0.3, 0.1]} g="stats" reg={reg} cls="a-tl">
          <div className="statpanel">
            <span className="sp-tag" ref={(el) => (tagRef.current = el)} data-m="0">
              {METHODS[0]}
            </span>
            {(["within ±25 % of MODIS", "off by more than 2×", "typical miss"] as const).map((k, i) => (
              <div className="sp-row" key={k}>
                <b ref={(el) => (statRefs.current[i] = el)}>–</b>
                <span>{k}</span>
              </div>
            ))}
            <span className="sp-note">
              {st.n.toLocaleString("en-US")} province-months, MODIS ≥ {st.minObs} hotspots. White line = a perfect guess.
            </span>
          </div>
        </Lbl>

        {/* error histogram */}
        <group position={[0, HIST_Y, 0.8]}>
          <primitive object={hist} />
          <group ref={histChrome}>
            <Line points={[[0, 0, 0.3], [L, 0, 0.3]]} color="#4a5368" lineWidth={1} transparent opacity={0} userData={{ op: 0.9 }} />
            <Line points={[[hx(0), 0, 0.31], [hx(0), HIST_H + 0.2, 0.31]]} color="#ffb27a" lineWidth={1} dashed dashSize={0.1} gapSize={0.08} transparent opacity={0} userData={{ op: 0.7 }} />
          </group>
          <group ref={ghostGrp}>
            <Line points={ghost} color="#e6e9f0" lineWidth={1.2} dashed dashSize={0.12} gapSize={0.09} transparent opacity={0} userData={{ op: 0.75 }} />
          </group>
          <Lbl p={[0, HIST_H + 0.45, 0.3]} g="hist" reg={reg} cls="a-bl hist-title">
            How far off is each guess?
          </Lbl>
          {(
            [
              [-1, "10× too low"],
              [-0.477, "3× too low"],
              [0, "exact"],
              [0.477, "3× too high"],
              [1, "10× too high"],
            ] as const
          ).map(([e, t]) => (
            <Lbl key={t} p={[hx(e), -0.18, 0.3]} g="hist" reg={reg} cls={`a-t tick ${e === 0 ? "exact" : Math.abs(e) < 0.9 ? "minor" : ""}`}>
              {t}
            </Lbl>
          ))}
          <Lbl p={[L, HIST_H + 0.45, 0.3]} g="hist" reg={reg} cls="a-br hist-legend">
            <span className="hl-now">
              <i className="sw" /> now: <em ref={(el) => (histNow.current = el)}>{METHODS[0]}</em>
            </span>
          </Lbl>
          <Lbl p={[L, HIST_H + 0.02, 0.3]} g="ghost" reg={reg} cls="a-br hist-legend">
            <span className="hl-ghost">┄ outline: one global ratio</span>
          </Lbl>
        </group>
      </group>

      {/* grouped bars: skill (KGE) on three tests */}
      <group ref={barsGrp} position={[0, BARS_Y, BARS_Z]} visible={false}>
        {tests.map((t, g) =>
          t.v.map((_, m) => <mesh key={`${g}-${m}`} geometry={barGeo} material={barMats[g][m]} position={[bx(g, m), 0, 0]} />),
        )}
        <Line points={[[-7.6, 0, 0.6], [7.6, 0, 0.6]]} color="#5a6378" lineWidth={1.4} />
        <Line points={[[-7.6, BAR_H / 2, -0.6], [7.6, BAR_H / 2, -0.6]]} color="#2e3546" lineWidth={1} dashed dashSize={0.25} gapSize={0.2} />
        <Line points={[[-7.6, BAR_H, -0.6], [7.6, BAR_H, -0.6]]} color="#3d4659" lineWidth={1} dashed dashSize={0.25} gapSize={0.2} />
      </group>
      {/* bar labels live outside the bar group (which is hidden when faded) */}
      <group position={[0, BARS_Y, BARS_Z]}>
        <Lbl p={[0, BAR_H + 2.5, 0.6]} g="barsAxis" reg={reg} cls="a-b bars-title">
          Skill against what MODIS saw
          <small>KGE · 1.00 = perfect match · higher is better</small>
        </Lbl>
        <Lbl p={[0, -2.1, 0.6]} g="barsAxis" reg={reg} cls="a-t bars-legend">
          {METHODS.map((m, i) => (
            <span key={m} className={`lg lg-${i}`}>
              <i />
              {m}
            </span>
          ))}
        </Lbl>
        <Lbl p={[7.9, BAR_H, 0.6]} g="barsAxis" reg={reg} cls="a-l tick">
          1.00
        </Lbl>
        <Lbl p={[7.9, BAR_H / 2, 0.6]} g="barsAxis" reg={reg} cls="a-l tick">
          0.95
        </Lbl>
        <Lbl p={[7.9, 0, 0.6]} g="barsAxis" reg={reg} cls="a-l tick cut">
          0.90 <span>⫽ axis cut</span>
        </Lbl>
        {tests.map((t, g) => (
          <group key={t.name}>
            {t.v.map((v, m) => (
              <Lbl key={m} p={[bx(g, m), barH(v) + 0.25, 0.6]} g={`bar${g}`} reg={reg} cls={`a-b bar-v bv-${m}`}>
                <span ref={(el) => (barVal.current[g * 3 + m] = el)}>{v.toFixed(4)}</span>
              </Lbl>
            ))}
            <Lbl p={[gx(g), -0.4, 0.6]} g={`bar${g}`} reg={reg} cls="a-t bar-g">
              <b>{t.name}</b>
              <small>{t.sub}</small>
            </Lbl>
            <Lbl p={[bx(g, 2), barH(t.v[2]) + 1.15, 0.6]} g="gap" reg={reg} cls="a-b bar-gap">
              +{(t.v[2] - t.v[1]).toFixed(3)}
              <small>vs SOTA-style</small>
            </Lbl>
          </group>
        ))}
      </group>
    </group>
  );
}
