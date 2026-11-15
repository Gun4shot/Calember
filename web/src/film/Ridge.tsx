// The Ridge of Time: one glass block per month, 2000-11 → last complete month (story_ridge.json), for the hero region
// (front row) and four context regions behind it. Raw sensors summed make the 2012 cliff;
// the scroll then morphs every VIIRS-era block to the harmonized value (the collapse).
// A white line traces what MODIS actually observed after 2012 (the independent check).

import { Line, Text } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Line2 } from "three-stdlib";
import type { StoryData } from "./data";
import { INFERNO, SPRING } from "./glsl";
import { clamp, lerp, ramp } from "./math";
import { film, useUI } from "./store";
import { T, inActsAt, LENS } from "./timeline";
import { MONTH_W, RIDGE_H, ROW_GAP } from "./world";
import monoFont from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff?url";

export const LENS_MONTHS = 12;

export function ridgeVisibility(t: number) {
  const base = clamp(ramp(0.41, 0.44, t) * (1 - ramp(0.935, 0.965, t)));
  if (!inActsAt(film.s)) return base;
  // the scorecard is filmed over the ridge: step it out of the frame while the charts are up
  const hide = Math.min(ramp(0.27, 0.3, film.u), 1 - ramp(0.9, 0.95, film.u)); // off-stage until the camera returns
  return base * (1 - hide);
}
export function harmonizeK(t: number) {
  return ramp(T.harmonize[0], T.harmonize[1], t);
}
/** After the collapse the axis rescales so the selected region's harmonized record fills the frame. */
export function ridgeYScale(t: number, final: number) {
  return lerp(1, final, ramp(0.655, 0.7, t));
}
const TARGET_H = 5.2;
/** tallest bar allowed while the lens shows raw (keeps spikes inside the frame) */
const FIT_H = 6.2;

/** Shared with the gridlines: current vertical scale and the selected region's raw max. */
export const ridgeAxis = { yS: 1, mx: 1, a: 0 };

function smoothstepJS(a: number, b: number, x: number) {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}
function normOf(reg: { raw_sum: number[] }) {
  let mx = 1;
  for (const v of reg.raw_sum) mx = Math.max(mx, v);
  return mx;
}
function niceStep(x: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, x))));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
const fmtK = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k` : `${Math.round(v)}`);

/** Labelled horizontal gridlines that follow the elastic axis, so a squash is legible as a scale change. */
function Gridlines({ x0, x1 }: { x0: number; x1: number }) {
  const lines = useRef<(THREE.Mesh | null)[]>([]);
  const labels = useRef<(THREE.Object3D | null)[]>([]);
  const [step, setStep] = useState(0);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#8fa3c8", transparent: true, opacity: 0, depthWrite: false }), []);
  useFrame(() => {
    const { yS, mx, a } = ridgeAxis;
    const unitsPerValue = (RIDGE_H * yS) / mx; // world units per hotspot
    const st = niceStep(6.2 / unitsPerValue / 3.2);
    if (Math.abs(st - step) > 1e-6) setStep(st);
    for (let i = 0; i < 4; i++) {
      const y = (i + 1) * (step || st) * unitsPerValue;
      const show = y < 7.0 ? a : 0;
      const ln = lines.current[i];
      if (ln) {
        ln.position.y = y;
        ln.visible = show > 0.01;
      }
      const lb = labels.current[i] as (THREE.Object3D & { fillOpacity?: number }) | null;
      if (lb) {
        lb.position.y = y + 0.04;
        lb.visible = show > 0.01;
        lb.fillOpacity = show * 0.9;
      }
    }
    mat.opacity = a * 0.32;
    const unit = labels.current[4] as (THREE.Object3D & { fillOpacity?: number }) | null;
    if (unit) {
      unit.visible = a > 0.01;
      unit.fillOpacity = a * 0.8;
    }
  });
  return (
    <group position={[0, 0, -0.45]}>
      {[0, 1, 2, 3].map((i) => (
        <group key={i}>
          <mesh ref={(m) => (lines.current[i] = m)} material={mat} position={[(x0 + x1) / 2, 0, 0]} visible={false}>
            <boxGeometry args={[x1 - x0, 0.012, 0.01]} />
          </mesh>
          <Text
            ref={(m: THREE.Object3D | null) => (labels.current[i] = m)}
            font={monoFont}
            fontSize={0.22}
            position={[x0 + 0.5, 0, 0]}
            anchorX="left"
            anchorY="bottom"
            color="#a9b6d0"
            visible={false}
          >
            {step ? fmtK((i + 1) * step) : ""}
          </Text>
        </group>
      ))}
      <Text ref={(m: THREE.Object3D | null) => (labels.current[4] = m)} font={monoFont} fontSize={0.2} position={[x0 + 0.5, 6.9, 0]} anchorX="left" anchorY="bottom" color="#7c869c" visible={false}>
        hotspots / month
      </Text>
    </group>
  );
}
export function playK(t: number) {
  if (!LENS) return 0;
  return ramp(T.play[0] - 0.01, T.play[0] + 0.01, t) * (1 - ramp(T.play[1], T.play[1] + 0.012, t));
}

const VS = /* glsl */ `
  ${SPRING}
  attribute float aIdx; attribute float aRow;
  attribute float aModis; attribute float aRaw; attribute float aHarm;
  attribute float aModisB; attribute float aRawB; attribute float aHarmB; attribute float aLens;
  uniform float uRise; uniform float uHarm; uniform float uSwitch; uniform float uN;
  uniform float uLens; uniform float uLensOn; uniform float uSwap; uniform vec4 uRowA; uniform float uRowA4;
  varying float vV; varying float vIce; varying float vTop; varying float vRowA; varying float vEra;
  void main() {
    float row = aRow;
    float era = step(uSwitch - 0.5, aIdx);              // 1 = VIIRS era (2012+)
    float m = mix(aModis, aModisB, row < 0.5 ? uSwap : 0.0);
    float r = mix(aRaw, aRawB, row < 0.5 ? uSwap : 0.0);
    float h = mix(aHarm, aHarmB, row < 0.5 ? uSwap : 0.0);
    // rise: blocks spring up from the ground left → right, rows staggered
    float rise = springK(uRise * 9.0 - aIdx / uN * 4.0 - row * 0.6, 14.0, 0.42);
    // harmonize: a wave that starts at the 2012 seam and runs to the present
    float w = (aIdx - uSwitch) / max(1.0, uN - uSwitch);
    float hk = springK(uHarm * 4.3 - w * 3.2 - row * 0.25, 12.0, 0.3);
    // the lens shows the raw record underneath (front row only)
    float lens = clamp(aLens, -0.3, 1.4) * step(row, 0.5);
    hk = mix(hk, 0.0, lens);
    float v = era > 0.5 ? mix(r, h, hk) : m;
    float height = max(0.004, v * rise);
    vec3 p = position;
    vTop = p.y;
    p.y *= height;
    vV = v;
    vIce = era * clamp(1.0 - hk, 0.0, 1.0);
    vEra = era;
    vRowA = row < 0.5 ? uRowA.x : row < 1.5 ? uRowA.y : row < 2.5 ? uRowA.z : row < 3.5 ? uRowA.w : uRowA4;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;
const FS = /* glsl */ `
  ${INFERNO}
  uniform float uGlobalA; uniform float uDim;
  varying float vV; varying float vIce; varying float vTop; varying float vRowA; varying float vEra;
  void main() {
    vec3 warm = inferno(0.46 + 0.4 * clamp(vV * 3.2, 0.0, 1.0));
    vec3 ice = mix(vec3(0.25, 0.45, 0.75), vec3(0.85, 0.95, 1.0), clamp(vV * 1.6, 0.0, 1.0));
    vec3 c = mix(warm, ice, vIce);
    float cap = smoothstep(0.86, 1.0, vTop);
    c *= (0.35 + 0.65 * vTop + cap * 1.6) * uDim;
    gl_FragColor = vec4(c, vRowA * uGlobalA);
  }
`;

interface Props {
  data: StoryData;
}

export function Ridge({ data }: Props) {
  const { ridge, derived } = data;
  const n = ridge.months.length;
  const sw = derived.switchIndex;
  const regionIdx = useUI((s) => s.regionIdx);
  const regions = ridge.regions;
  // rows: 0 = selected region, 1..4 = the others (context)
  const ctx = useMemo(() => regions.map((_, i) => i).filter((i) => i !== derived.heroIndex), [regions, derived.heroIndex]);

  const scaled = useRef<THREE.Group>(null);
  const lens = useRef<THREE.Group>(null);
  const catcher = useRef<THREE.Mesh>(null);
  const line = useRef<Line2>(null);
  const swapStart = useRef(-10);
  const lastRegion = useRef(derived.heroIndex);
  const lensTouched = useRef(false);
  const lensPos = useRef(new Float32Array(n));
  const lensVel = useRef(new Float32Array(n));
  const yS = useRef(1);
  const yV = useRef(0);
  const lastLensMonth = useRef(-1);

  const norm = (reg: (typeof regions)[number]) => {
    let mx = 1;
    for (const v of reg.raw_sum) mx = Math.max(mx, v);
    return mx;
  };

  const { mesh, mat, attr, lensAttr } = useMemo(() => {
    const geo = new THREE.BoxGeometry(MONTH_W * 0.72, 1, 0.7);
    geo.translate(0, 0.5, 0);
    const rows = 1 + ctx.length;
    const count = rows * n;
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, count);
    const m4 = new THREE.Matrix4();
    const idx = new Float32Array(count);
    const row = new Float32Array(count);
    const fl = () => new Float32Array(count);
    const attr = { aModis: fl(), aRaw: fl(), aHarm: fl(), aModisB: fl(), aRawB: fl(), aHarmB: fl() };
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const reg = r === 0 ? regions[derived.heroIndex] : regions[ctx[r - 1]];
      const mx = norm(reg);
      const hs = r === 0 ? RIDGE_H : RIDGE_H * 0.75;
      for (let i = 0; i < n; i++) {
        m4.makeTranslation((i - n / 2) * MONTH_W, 0, -r * ROW_GAP);
        mesh.setMatrixAt(k, m4);
        idx[k] = i;
        row[k] = r;
        attr.aModis[k] = attr.aModisB[k] = (reg.modis[i] / mx) * hs;
        attr.aRaw[k] = attr.aRawB[k] = (reg.raw_sum[i] / mx) * hs;
        attr.aHarm[k] = attr.aHarmB[k] = (reg.harmonized[i] / mx) * hs;
        k++;
      }
    }
    geo.setAttribute("aIdx", new THREE.InstancedBufferAttribute(idx, 1));
    geo.setAttribute("aRow", new THREE.InstancedBufferAttribute(row, 1));
    const lensAttr = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aLens", lensAttr);
    const ba: Record<string, THREE.InstancedBufferAttribute> = {};
    for (const [key, arr] of Object.entries(attr)) {
      ba[key] = new THREE.InstancedBufferAttribute(arr, 1);
      geo.setAttribute(key, ba[key]);
    }
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: {
        uRise: { value: 0 },
        uHarm: { value: 0 },
        uSwitch: { value: sw },
        uN: { value: n },
        uLens: { value: -100 },
        uLensOn: { value: 0 },
        uSwap: { value: 1 },
        uRowA: { value: new THREE.Vector4(1, 0.5, 0.4, 0.3) },
        uRowA4: { value: 0.22 },
        uGlobalA: { value: 1 },
        uDim: { value: 1 },
      },
      transparent: true,
    });
    mesh.material = mat;
    mesh.frustumCulled = false;
    return { mesh, mat, attr: ba, lensAttr };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, sw]);

  // MODIS-observed check line (front row, 2012+)
  const linePoints = useMemo(() => {
    const reg = regions[regionIdx];
    const mx = norm(reg);
    const pts: [number, number, number][] = [];
    // the check runs 2012–2019: after that MODIS itself is biased by orbit drift
    const end = Math.max(sw + 2, ridge.months.indexOf("2019-12"));
    for (let i = sw; i <= end; i++) pts.push([(i - n / 2) * MONTH_W, (reg.modis[i] / mx) * RIDGE_H + 0.01, 0.42]);
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionIdx, regions, sw, n]);

  // final y-scale: tallest of the region's harmonized and MODIS months reaches TARGET_H
  const yTarget = useMemo(() => {
    const reg = regions[regionIdx];
    const mx = norm(reg);
    let h = 0;
    for (let i = 0; i < n; i++) h = Math.max(h, reg.harmonized[i], reg.modis[i]);
    return TARGET_H / Math.max(0.05, (h / mx) * RIDGE_H);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionIdx, regions, n]);
  const yFinal = useRef(yTarget);

  // region switch: front row morphs A → B with a spring (time-based; only in the playground)
  useEffect(() => {
    if (regionIdx === lastRegion.current) return;
    const reg = regions[regionIdx];
    const mx = norm(reg);
    const A = { m: attr.aModis.array as Float32Array, r: attr.aRaw.array as Float32Array, h: attr.aHarm.array as Float32Array };
    const B = { m: attr.aModisB.array as Float32Array, r: attr.aRawB.array as Float32Array, h: attr.aHarmB.array as Float32Array };
    const s = clamp(mat.uniforms.uSwap.value);
    for (let i = 0; i < n; i++) {
      A.m[i] = lerp(A.m[i], B.m[i], s);
      A.r[i] = lerp(A.r[i], B.r[i], s);
      A.h[i] = lerp(A.h[i], B.h[i], s);
      B.m[i] = (reg.modis[i] / mx) * RIDGE_H;
      B.r[i] = (reg.raw_sum[i] / mx) * RIDGE_H;
      B.h[i] = (reg.harmonized[i] / mx) * RIDGE_H;
    }
    for (const a of Object.values(attr)) a.needsUpdate = true;
    mat.uniforms.uSwap.value = 0;
    swapStart.current = performance.now() / 1000;
    lastRegion.current = regionIdx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionIdx]);

  useFrame((state, dt) => {
    const t = film.t;
    const vis = ridgeVisibility(t);
    mesh.visible = vis > 0.002;
    if (!mesh.visible) {
      if (line.current) line.current.visible = false;
      if (lens.current) lens.current.visible = false;
      if (catcher.current) catcher.current.visible = false;
      film.lensActive = false;
      return;
    }
    if (catcher.current) catcher.current.visible = true;
    const u = mat.uniforms;
    u.uGlobalA.value = vis;
    u.uRise.value = ramp(T.ridgeRise[0], T.ridgeRise[1], t) * 1.6;
    u.uHarm.value = harmonizeK(t);
    // dim the bars while the MODIS line is the subject, so the line reads
    u.uDim.value = 1 - 0.55 * ramp(T.checkLine[0] - 0.01, T.checkLine[0] + 0.01, t) * (1 - ramp(T.play[0] - 0.01, T.play[0] + 0.01, t));
    const play = playK(t);
    // context rows fade away once the cliff is down: the check is about one region
    const ctxA = 1 - ramp(0.655, 0.69, t);
    u.uRowA.value.set(1, 0.55 * ctxA, 0.42 * ctxA, 0.32 * ctxA);
    u.uRowA4.value = 0.24 * ctxA;
    const ss = performance.now() / 1000 - swapStart.current;
    u.uSwap.value = ss > 3 ? 1 : 1 - Math.exp(-ss * 7) * Math.cos(ss * 13);
    // lens: follows the pointer; idles in a slow sweep until touched
    if (play > 0.01) {
      if (!lensTouched.current) {
        const s = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 0.35 - 1.2);
        film.lensMonth = lerp(sw - 18, n - 8, s);
      }
      film.lensActive = true;
    } else {
      film.lensActive = false;
    }
    if (lens.current) {
      lens.current.visible = play > 0.01;
      lens.current.position.x = (film.lensMonth - n / 2) * MONTH_W;
      for (const o of lens.current.children) {
        const m = (o as THREE.Mesh).material as (THREE.Material & { uniforms?: Record<string, { value: number }> }) | undefined;
        if (m?.uniforms?.uA) m.uniforms.uA.value = play;
        const txt = o as THREE.Object3D & { fillOpacity?: number };
        if ("fillOpacity" in txt) txt.fillOpacity = play;
      }
    }
    // lens speed (months / s), for the whoosh
    const h = Math.min(dt, 1 / 30);
    if (lastLensMonth.current >= 0 && h > 0) film.lensSpeed = Math.min(1, Math.abs(film.lensMonth - lastLensMonth.current) / h / 90);
    lastLensMonth.current = film.lensMonth;
    // per-bar springs: bars under the lens jump up to the raw value with a bounce
    const P = lensPos.current;
    const Vv = lensVel.current;
    const la = lensAttr.array as Float32Array;
    let moving = false;
    let maxUnder = 0;
    const rawB = attr.aRawB.array as Float32Array;
    const rawA = attr.aRaw.array as Float32Array;
    const sw2 = clamp(u.uSwap.value);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(i - film.lensMonth);
      const target = play * (1 - smoothstepJS(LENS_MONTHS / 2 - 1, LENS_MONTHS / 2 + 0.5, d));
      if (film.reducedMotion) {
        P[i] = target;
        Vv[i] = 0;
      } else {
        for (let k = 0; k < 2; k++) {
          const acc = 240 * (target - P[i]) - 15 * Vv[i];
          Vv[i] += acc * (h / 2);
          P[i] += Vv[i] * (h / 2);
        }
      }
      if (Math.abs(P[i] - la[i]) > 1e-4) moving = true;
      la[i] = P[i];
      if (target > 0.5) maxUnder = Math.max(maxUnder, lerp(rawA[i], rawB[i], sw2));
    }
    if (moving) lensAttr.needsUpdate = true;
    // elastic axis: when raw spikes enter the lens, the whole chart squashes so they still fit
    yFinal.current += (yTarget - yFinal.current) * (1 - Math.exp(-dt * 4));
    const base = ridgeYScale(t, yFinal.current);
    const fit = maxUnder > 0 ? FIT_H / maxUnder : base;
    const want = lerp(base, Math.min(base, fit), play);
    if (film.reducedMotion || play < 0.01) {
      yS.current = want;
      yV.current = 0;
    } else {
      const acc = 70 * (want - yS.current) - 12 * yV.current;
      yV.current += acc * h;
      yS.current += yV.current * h;
    }
    if (scaled.current) scaled.current.scale.y = yS.current;
    ridgeAxis.yS = yS.current;
    ridgeAxis.mx = normOf(regions[useUI.getState().regionIdx]);
    ridgeAxis.a = vis * ramp(T.checkLine[0], T.checkLine[0] + 0.02, t) * (1 - ramp(T.play[1], T.play[1] + 0.012, t));
    if (line.current) {
      const k = ramp(T.checkLine[0], T.checkLine[1], t);
      const g = line.current.geometry as THREE.InstancedBufferGeometry;
      const segs = linePoints.length - 1;
      g.instanceCount = Math.max(0, Math.floor(k * segs));
      line.current.visible = k > 0.001 && vis > 0.05;
      (line.current.material as THREE.Material & { opacity: number }).opacity = 0.9 * vis * (1 - 0.6 * play);
    }
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (!film.lensActive) return;
    lensTouched.current = true;
    const mi = e.point.x / MONTH_W + n / 2;
    film.lensMonth = clamp(mi, LENS_MONTHS / 2, n - 1 - LENS_MONTHS / 2);
  };

  const lensMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `varying vec3 vL; void main(){ vL = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);}`,
        fragmentShader: /* glsl */ `
          uniform float uA; varying vec3 vL;
          void main(){
            float ex = smoothstep(0.42, 0.5, abs(vL.x));
            float ey = smoothstep(0.47, 0.5, abs(vL.y));
            float a = (0.035 + 0.25 * ex + 0.1 * ey) * uA;
            gl_FragColor = vec4(vec3(0.7, 0.86, 1.0), a);
          }`,
        uniforms: { uA: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  const edgeMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);}`,
        fragmentShader: /* glsl */ `uniform float uA; void main(){ gl_FragColor = vec4(vec3(0.8, 0.92, 1.0) * 1.6, uA); }`,
        uniforms: { uA: { value: 0 } },
        transparent: true,
        depthWrite: false,
      }),
    [],
  );

  const years = [2001, 2005, 2010, 2012, 2015, 2020, 2025];
  const xOf = (ym: string) => (ridge.months.indexOf(ym) - n / 2) * MONTH_W;

  return (
    <group>
      <group ref={scaled}>
        <primitive object={mesh} />
        <Line ref={line} points={linePoints} color="#ffffff" lineWidth={3.2} transparent opacity={0.9} depthTest={false} renderOrder={5} />
      </group>
      <group ref={lens} visible={false}>
        <mesh material={lensMat} position={[0, 3.6, 0]} renderOrder={6}>
          <boxGeometry args={[LENS_MONTHS * MONTH_W, 7.2, 1.1]} />
        </mesh>
        <mesh material={edgeMat} position={[(-LENS_MONTHS * MONTH_W) / 2, 3.6, 0.56]} renderOrder={7}>
          <boxGeometry args={[0.035, 7.2, 0.02]} />
        </mesh>
        <mesh material={edgeMat} position={[(LENS_MONTHS * MONTH_W) / 2, 3.6, 0.56]} renderOrder={7}>
          <boxGeometry args={[0.035, 7.2, 0.02]} />
        </mesh>
        <mesh material={edgeMat} position={[0, -0.12, 0.56]} renderOrder={7}>
          <boxGeometry args={[LENS_MONTHS * MONTH_W * 0.5, 0.05, 0.02]} />
        </mesh>
        <Text font={monoFont} fontSize={0.24} position={[0, 7.45, 0.56]} anchorX="center" anchorY="bottom" color="#cfe4ff" letterSpacing={0.12}>
          RAW UNDER THE LENS
        </Text>
      </group>
      {/* pointer catcher for the lens (transparent, never visible) */}
      <mesh ref={catcher} position={[0, 3, 0.36]} onPointerMove={onMove} onPointerDown={onMove} visible={false}>
        <planeGeometry args={[n * MONTH_W + 2, 10]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <RidgeLabels xs={years.map((y) => ({ y, x: xOf(`${y}-01`) }))} seamX={xOf(ridge.switch_month)} />
      <Gridlines x0={(-n / 2) * MONTH_W - 0.3} x1={(n / 2) * MONTH_W} />
    </group>
  );
}

function RidgeLabels({ xs, seamX }: { xs: { y: number; x: number }[]; seamX: number }) {
  const group = useRef<THREE.Group>(null);
  const seam = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const t = film.t;
    const a = ridgeVisibility(t) * ramp(0.44, 0.47, t);
    if (group.current) {
      group.current.visible = a > 0.01;
      for (const o of group.current.children) {
        const txt = o as THREE.Object3D & { fillOpacity?: number };
        if ("fillOpacity" in txt) txt.fillOpacity = a * ((o.userData.base as number) ?? 1);
      }
    }
    if (seam.current) {
      const mat = seam.current.material as THREE.MeshBasicMaterial;
      mat.opacity = a * 0.7 * (1 - harmonizeK(t));
    }
  });
  return (
    <group ref={group}>
      {xs.map(({ y, x }) => (
        <Text
          key={y}
          font={monoFont}
          fontSize={y === 2012 ? 0.46 : 0.38}
          position={[x, -0.18, 1.25]}
          rotation-x={-Math.PI / 9}
          anchorX="center"
          anchorY="top"
          color={y === 2012 ? "#bcd8ff" : "#c3cad9"}
          outlineWidth={0.03}
          outlineColor="#05070d"
          userData={{ base: 1 }}
        >
          {String(y)}
        </Text>
      ))}
      <mesh ref={seam} position={[seamX - MONTH_W / 2, 3.5, 0]}>
        <boxGeometry args={[0.012, 7, 0.012]} />
        <meshBasicMaterial color="#a8ccff" transparent opacity={0.5} depthWrite={false} />
      </mesh>
    </group>
  );
}
