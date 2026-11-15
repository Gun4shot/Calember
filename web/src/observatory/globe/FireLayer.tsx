// 26 years of fire on the globe: one glowing hex column per H3 r3 cell (12,662 cells × 313 months, from
// globe_r3_monthly.u8), with embers rising from the hottest cells. Layers: activity, vs normal, fire regimes.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { type GlobeData, REGIME_COLORS, globeAnomaly, loadRegimes } from "../data";
import { R, latLonToVec } from "../geo";
import { fx, useObs } from "../store";
import { CATEGORY_GLSL, HASH, INFERNO } from "../world/shaders";

const COL_VS = /* glsl */ `
  attribute float aH0; attribute float aH1; attribute float aA0; attribute float aA1; attribute vec3 aReg; attribute float aSeed; attribute float aIn;
  uniform float uFrac; uniform float uGrow; uniform float uTime; uniform float uAnom; uniform float uReg; uniform float uFocus;
  varying float vV; varying float vTop; varying float vA; varying vec3 vRegC; varying float vIn; varying float vSeed;
  void main() {
    float v = mix(aH0, aH1, uFrac);
    float a = uFrac < 0.5 ? aA0 : aA1;
    vV = v; vA = a; vRegC = aReg; vIn = aIn; vSeed = aSeed;
    float grow = clamp(uGrow * 1.6 - aSeed * 0.6, 0.0, 1.0);
    grow = 1.0 - pow(clamp(1.0 - grow, 0.0, 1.0), 3.0);
    float hv = mix(v, 0.55 * step(0.5, length(aReg)), uReg);
    float height = (pow(max(hv, 0.0), 2.1) * ${(R * 0.09).toFixed(3)} + 0.002) * grow;
    vec3 p = position;
    vTop = p.y;
    p.y *= height;
    p.xz *= mix(0.35, 1.0, smoothstep(0.05, 0.6, v));
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    if (hv < 0.025 || (uAnom > 0.5 && a < 0.5)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const COL_FS = /* glsl */ `
  ${INFERNO}
  ${CATEGORY_GLSL}
  uniform float uAnom; uniform float uReg; uniform float uDim; uniform float uGhost; uniform float uFocus; uniform float uTime;
  varying float vV; varying float vTop; varying float vA; varying vec3 vRegC; varying float vIn; varying float vSeed;
  void main() {
    vec3 c = inferno(0.18 + 0.78 * vV);
    vec3 ca = catColor(vA) * (0.55 + 0.9 * vV);
    c = mix(c, ca, uAnom);
    c = mix(c, vRegC * 0.9, uReg);
    c *= 0.22 + 1.0 * vTop;           // glowing tops
    c *= 0.35 + 0.95 * vV * vV;
    float rec = step(5.5, vA) * uAnom;  // record months flicker white-hot
    c += vec3(1.0, 0.9, 0.6) * rec * vTop * (0.6 + 0.4 * sin(uTime * 6.0 + vSeed * 30.0));
    float g = dot(c, vec3(0.333));
    c = mix(c, vec3(g) * vec3(0.8, 0.85, 1.0), uGhost * 0.6);
    // area focus: the selected area stays lit, the rest of the planet steps back
    float dim = mix(uDim, uDim * (1.0 - vIn), uFocus);
    c *= 1.0 - 0.82 * dim;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const EMBER_VS = /* glsl */ `
  attribute vec3 aBase; attribute float aSeed; attribute float aHeat;
  uniform float uTime; uniform float uPx; uniform float uAlpha;
  varying float vLife; varying float vHeat;
  ${HASH}
  void main() {
    float life = fract(uTime * (0.10 + 0.12 * aSeed) + aSeed * 7.13);
    vLife = life; vHeat = aHeat;
    vec3 n = normalize(aBase);
    vec3 t1 = normalize(cross(n, vec3(0.0, 1.0, 0.0001)));
    vec3 t2 = cross(n, t1);
    float sway = sin(life * 9.0 + aSeed * 50.0) * 0.06 * life;
    vec3 p = aBase + n * (pow(max(aHeat, 0.0), 1.55) * ${(R * 0.13).toFixed(3)} + life * ${(R * 0.07).toFixed(3)}) + (t1 * sway + t2 * sway * 0.6);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uPx * (0.5 + 1.0 * aHeat) * (1.0 - life * 0.6) * (20.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
    if (aHeat <= 0.0 || uAlpha < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const EMBER_FS = /* glsl */ `
  uniform float uAlpha;
  varying float vLife; varying float vHeat;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.25, 0.0, dot(d, d));
    vec3 c = mix(vec3(1.0, 0.85, 0.45), vec3(1.0, 0.32, 0.08), vLife);
    gl_FragColor = vec4(c * 1.2, 0.55 * a * (1.0 - vLife) * smoothstep(0.0, 0.08, vLife) * uAlpha);
  }
`;

const N_EMBERS = 1400;

export function FireLayer({ g, inArea }: { g: GlobeData; inArea: Uint8Array | null }) {
  const lastM = useRef(-1);
  const grow0 = useRef(-1);
  const layer = useObs((s) => s.layer);
  const mix = useRef({ anom: 0, reg: 0 });

  const { mesh, mat, at } = useMemo(() => {
    const geo = new THREE.CylinderGeometry(0.075, 0.075, 1, 6, 1, false);
    geo.translate(0, 0.5, 0);
    const n = g.nCells;
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3(), nv = new THREE.Vector3();
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      latLonToVec(g.lat[i], g.lon[i], 1, nv);
      p.copy(nv).multiplyScalar(R * 1.001);
      q.setFromUnitVectors(up, nv);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      seed[i] = (i * 0.6180339) % 1;
    }
    const f1 = () => new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    const at = { aH0: f1(), aH1: f1(), aA0: f1(), aA1: f1(), aIn: f1(), aReg: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3) };
    for (const [k, a] of Object.entries(at)) geo.setAttribute(k, a);
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: COL_VS,
      fragmentShader: COL_FS,
      uniforms: {
        uFrac: { value: 0 }, uGrow: { value: 0 }, uTime: { value: 0 }, uAnom: { value: 0 }, uReg: { value: 0 },
        uDim: { value: 0 }, uGhost: { value: 0 }, uFocus: { value: 0 },
      },
    });
    mesh.material = mat;
    mesh.frustumCulled = false;
    mesh.name = "fire";
    return { mesh, mat, at };
  }, [g]);

  const { embers, emat, eat } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const base = new Float32Array(N_EMBERS * 3);
    const seed = new Float32Array(N_EMBERS);
    const heat = new Float32Array(N_EMBERS);
    for (let i = 0; i < N_EMBERS; i++) seed[i] = (i * 0.754877666) % 1;
    const eat = { aBase: new THREE.BufferAttribute(base, 3).setUsage(THREE.DynamicDrawUsage), aHeat: new THREE.BufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage) };
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N_EMBERS * 3), 3));
    geo.setAttribute("aBase", eat.aBase);
    geo.setAttribute("aHeat", eat.aHeat);
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const emat = new THREE.ShaderMaterial({
      vertexShader: EMBER_VS,
      fragmentShader: EMBER_FS,
      uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uAlpha: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const embers = new THREE.Points(geo, emat);
    embers.frustumCulled = false;
    return { embers, emat, eat };
  }, []);

  // regime colours per cell (once)
  useEffect(() => {
    let alive = true;
    loadRegimes().then(({ byCell }) => {
      if (!alive) return;
      const arr = at.aReg.array as Float32Array;
      const c = new THREE.Color();
      g.cells.forEach((cell, i) => {
        const r = byCell.get(cell);
        if (r === undefined) return;
        c.set(REGIME_COLORS[(r - 1) % REGIME_COLORS.length]);
        arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
      });
      at.aReg.needsUpdate = true;
    }, () => undefined);
    return () => { alive = false; };
  }, [g, at]);

  useEffect(() => {
    const arr = at.aIn.array as Float32Array;
    arr.fill(0);
    if (inArea) for (let i = 0; i < arr.length; i++) arr[i] = inArea[i];
    at.aIn.needsUpdate = true;
  }, [inArea, at]);

  const anomRef = useRef<Uint8Array | null>(null);
  useEffect(() => {
    if (layer === "anomaly" && !anomRef.current) {
      // computed once, off the critical path
      const id = window.setTimeout(() => {
        anomRef.current = globeAnomaly(g);
        lastM.current = -1;
      }, 30);
      return () => window.clearTimeout(id);
    }
  }, [layer, g]);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    if (grow0.current < 0) grow0.current = t;
    const grow = Math.min(1, (t - grow0.current) / 2.8);
    mat.uniforms.uGrow.value = grow;
    const nM = g.nMonths;
    const mf = Math.min(fx.monthF, nM - 1);
    const m0 = Math.max(0, Math.min(nM - 1, Math.floor(mf)));
    const m1 = Math.min(nM - 1, m0 + 1);
    const anom = anomRef.current;
    if (m0 !== lastM.current) {
      lastM.current = m0;
      const n = g.nCells, o0 = m0 * n, o1 = m1 * n;
      const h0 = at.aH0.array as Float32Array, h1 = at.aH1.array as Float32Array;
      const a0 = at.aA0.array as Float32Array, a1 = at.aA1.array as Float32Array;
      for (let i = 0; i < n; i++) {
        h0[i] = g.bytes[o0 + i] / 255;
        h1[i] = g.bytes[o1 + i] / 255;
        a0[i] = anom ? anom[o0 + i] : 0;
        a1[i] = anom ? anom[o1 + i] : 0;
      }
      at.aH0.needsUpdate = at.aH1.needsUpdate = at.aA0.needsUpdate = at.aA1.needsUpdate = true;
      // embers: re-seed onto hot cells, weighted by heat²
      const base = eat.aBase.array as Float32Array, heat = eat.aHeat.array as Float32Array;
      const hot: number[] = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const v = h0[i];
        if (v > 0.56) { hot.push(i); total += v * v * v; }
      }
      const v3 = new THREE.Vector3();
      let k = 0;
      if (hot.length) {
        for (const i of hot) {
          const share = Math.round(((h0[i] ** 3) / total) * N_EMBERS);
          for (let j = 0; j < share && k < N_EMBERS; j++, k++) {
            latLonToVec(g.lat[i] + (((k * 0.37) % 1) - 0.5) * 0.9, g.lon[i] + (((k * 0.71) % 1) - 0.5) * 0.9, R * 1.001, v3);
            base.set([v3.x, v3.y, v3.z], k * 3);
            heat[k] = h0[i];
          }
        }
      }
      for (; k < N_EMBERS; k++) heat[k] = 0;
      eat.aBase.needsUpdate = eat.aHeat.needsUpdate = true;
    }
    mat.uniforms.uFrac.value = mf - m0;
    mat.uniforms.uTime.value = t;
    const ease = 1 - Math.exp(-dt * 4);
    mix.current.anom += ((layer === "anomaly" && anom ? 1 : 0) - mix.current.anom) * ease;
    mix.current.reg += ((layer === "regimes" ? 1 : 0) - mix.current.reg) * ease;
    mat.uniforms.uAnom.value = mix.current.anom;
    mat.uniforms.uReg.value = mix.current.reg;
    mat.uniforms.uDim.value = fx.globeDim;
    mesh.visible = fx.globeDim < 0.9; // under the stage the planet's columns step out entirely
    mat.uniforms.uFocus.value = inArea ? 1 - fx.globeDim : 0; // the area stays lit on the globe, but not under the stage
    mat.uniforms.uGhost.value = THREE.MathUtils.clamp(fx.monthF - (nM - 1), 0, 6) / 6;
    emat.uniforms.uTime.value = t;
    emat.uniforms.uPx.value = Math.min(2, state.viewport.dpr) * 1.2;
    emat.uniforms.uAlpha.value = (1 - mix.current.reg) * (1 - fx.globeDim) * grow;
  });

  return (
    <>
      <primitive object={mesh} renderOrder={1} />
      <primitive object={embers} renderOrder={6} />
    </>
  );
}
