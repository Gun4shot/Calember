// Act 3 · the data and the method. Detections rain from three sensor orbits, pass a filter
// ring (static flares are thrown out), land on a hexagon grid, and the grid stacks into a
// 27-layer tower of years (2000 → 2026) wrapped in its regime colours (from results.json). Then the overlap
// years glow, the tower splits into spatial folds, and the 2020 layer is sealed.
// Everything is a pure function of the new-act clock u (reversible on scroll).

import { methodPresence } from "./MethodFlow";
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { StoryData } from "./data";
import { SPRING } from "./glsl";
import { hash01, ramp } from "./math";
import { film } from "./store";
import { U, inActsAt } from "./timeline";
import monoFont from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff?url";

export const TOWER_POS = new THREE.Vector3(-34, 0, -4);
const N_PART = 9000;
const LAYERS = 27; // 2000 … 2026
const LAYER_H = 0.42;
const HEX_R = 0.98;

const REGIME_CODES = ["T", "M", "B", "V", "N"];
const REGIME_HEX: Record<string, string> = { T: "#d9744a", M: "#ff8c33", B: "#ffc761", V: "#ff6b24", N: "#eadbcc" };

/**
 * Regime of a year layer, from the product's regime spans (results.json): the regime of the
 * layer's last month (Dec, or the product's last month), so a regime starting mid-year
 * (M 2002-07, N 2026-08) still gets its own layer. Returns the index into `regimes`.
 */
function layerRegime(year: number, regimes: { code: string; from: string; to: string }[], last: string) {
  const end = `${year}-12` < last ? `${year}-12` : last;
  const i = regimes.findIndex((r) => r.from <= end && end <= r.to);
  return i >= 0 ? i : regimes.length - 1;
}

/** axial hex coordinates within radius 3 (37 cells), pointy layout on xz */
function hexCells() {
  const out: { x: number; z: number; q: number; r: number }[] = [];
  for (let q = -3; q <= 3; q++)
    for (let r = Math.max(-3, -q - 3); r <= Math.min(3, -q + 3); r++)
      out.push({ q, r, x: Math.sqrt(3) * (q + r / 2) * HEX_R, z: 1.5 * r * HEX_R });
  return out;
}

export function towerVisibility(u: number, inActs: boolean) {
  return inActs ? Math.min(ramp(0.0, 0.05, u), 1 - ramp(0.3, 0.34, u)) : 0;
}

const PART_VS = /* glsl */ `
  attribute float aSeed; attribute float aSensor; attribute float aFlare; attribute vec2 aTarget; attribute float aEject;
  uniform float uStream; uniform float uPx;
  varying vec3 vCol; varying float vA;
  vec3 bez(vec3 a, vec3 b, vec3 c, float t) { return mix(mix(a, b, t), mix(b, c, t), t); }
  void main() {
    float k = clamp((uStream - aSeed * 0.85) / 0.5, 0.0, 1.0);
    float ang = aSensor * 1.9 + aSeed * 2.2;
    vec3 p0 = vec3(cos(ang) * 13.0, 19.0 + aSensor * 1.2, sin(ang) * 13.0);
    vec3 p1 = vec3(sin(aSeed * 91.0) * 0.5, 9.0, cos(aSeed * 57.0) * 0.5);
    vec3 pos;
    if (k < 0.6) {
      float q = k / 0.6;
      pos = bez(p0, vec3(p0.x * 0.25, 14.0, p0.z * 0.25), p1, q * q * (3.0 - 2.0 * q));
    } else {
      float q = (k - 0.6) / 0.4;
      if (aFlare > 0.5) {
        pos = p1 + vec3(cos(aEject), -0.25, sin(aEject)) * q * 9.0;
      } else {
        vec3 p2 = vec3(aTarget.x, 0.25, aTarget.y);
        pos = mix(p1, p2, q * q);
      }
    }
    vec3 c = aSensor < 0.5 ? vec3(1.0, 0.58, 0.24) : aSensor < 1.5 ? vec3(0.55, 0.78, 1.0) : aSensor < 2.5 ? vec3(0.72, 0.86, 1.0) : vec3(0.86, 0.93, 1.0);
    vCol = mix(c, vec3(1.0, 0.18, 0.15), aFlare * smoothstep(0.5, 0.62, k)) * 1.1;
    vA = step(0.0001, k) * (1.0 - step(0.999, k)) * (aFlare > 0.5 ? 1.0 - smoothstep(0.75, 1.0, k) : 1.0);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = clamp(uPx * 60.0 / -mv.z, 1.5, 9.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const PART_FS = /* glsl */ `
  uniform float uA;
  varying vec3 vCol; varying float vA;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.25, 0.0, dot(d, d)) * vA * uA;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vCol, a);
  }
`;

const HEX_VS = /* glsl */ `
  ${SPRING}
  attribute float aLayer; attribute float aFold; attribute float aGlow; attribute float aYear;
  uniform float uGrid; uniform float uStack; uniform float uOverlap; uniform float uFolds; uniform float uSeal;
  varying vec3 vCol; varying float vA; varying float vTop; varying float vEdge;
  // aYear holds the layer's regime index (0 T, 1 M, 2 B, 3 V, 4 N), set from results.json
  vec3 regime(float r) {
    if (r < 0.5) return vec3(0.85, 0.42, 0.28);  // T: Terra, scaled
    if (r < 1.5) return vec3(1.0, 0.55, 0.2);    // M: MODIS observed
    if (r < 2.5) return vec3(1.0, 0.78, 0.38);   // B: blend
    if (r < 3.5) return vec3(1.0, 0.42, 0.14);   // V: Calember from VIIRS
    return vec3(0.92, 0.86, 0.8);                // N: provisional
  }
  void main() {
    vec3 p = position;
    vTop = step(0.0, p.y);
    vEdge = length(p.xz);
    // layer 0 appears with the grid beat; the rest drop onto the stack one by one
    float k = aLayer < 0.5 ? springK(uGrid * 3.0, 14.0, 0.5) : springK((uStack - aLayer) * 2.5, 14.0, 0.45);
    float y = aLayer * ${LAYER_H.toFixed(2)} + (1.0 - clamp(k, 0.0, 1.0)) * 2.5;
    // sealed 2020 layer lifts out of the tower
    float sealed = step(19.5, aLayer) * step(aLayer, 20.5);
    y += sealed * uSeal * 1.1;
    vec3 c = regime(aYear) * (0.45 + 0.7 * aGlow);
    float overlap = step(11.5, aLayer) * step(aLayer, 19.5);
    c = mix(c, c * (overlap > 0.5 ? 1.7 : 0.35), uOverlap * (1.0 - uFolds));
    vec3 fold = aFold < 0.5 ? vec3(1.0, 0.6, 0.3) : aFold < 1.5 ? vec3(0.6, 0.8, 1.0) : aFold < 2.5 ? vec3(0.78, 0.57, 0.92) : aFold < 3.5 ? vec3(0.5, 0.82, 0.73) : vec3(0.95, 0.83, 0.42);
    c = mix(c, fold * 0.9, uFolds * (1.0 - sealed));
    c = mix(c, vec3(0.85, 0.93, 1.0) * 2.4, sealed * uSeal);
    vCol = c;
    vA = clamp(k, 0.0, 1.0) * (1.0 - sealed * uSeal * 0.4);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p.x, p.y + y, p.z, 1.0);
  }
`;
const HEX_FS = /* glsl */ `
  uniform float uA;
  varying vec3 vCol; varying float vA; varying float vTop; varying float vEdge;
  void main() {
    float rim = smoothstep(0.78, 0.97, vEdge);
    vec3 c = vCol * (0.22 + 0.38 * vTop) + vCol * rim * 0.75 * vTop;
    gl_FragColor = vec4(c, vA * uA);
  }
`;

export function DataTower({ data }: { data: StoryData }) {
  const group = useRef<THREE.Group>(null);
  const labels = useRef<THREE.Group>(null);
  const cells = useMemo(hexCells, []);

  const { points, pMat } = useMemo(() => {
    const D = data.results.data.raw_rows_by_sensor;
    const tot = D.MODIS + D.SNPP + D.NOAA20 + D.NOAA21;
    const cum = [D.MODIS / tot, (D.MODIS + D.SNPP) / tot, (D.MODIS + D.SNPP + D.NOAA20) / tot];
    const seed = new Float32Array(N_PART);
    const sensor = new Float32Array(N_PART);
    const flare = new Float32Array(N_PART);
    const target = new Float32Array(N_PART * 2);
    const eject = new Float32Array(N_PART);
    for (let i = 0; i < N_PART; i++) {
      seed[i] = hash01(i * 1.13);
      const h = hash01(i * 7.31);
      sensor[i] = h < cum[0] ? 0 : h < cum[1] ? 1 : h < cum[2] ? 2 : 3;
      flare[i] = hash01(i * 3.77) < 0.045 ? 1 : 0;
      const c = cells[Math.floor(hash01(i * 5.9) * cells.length)];
      target[2 * i] = c.x + (hash01(i * 2.1) - 0.5) * 1.1;
      target[2 * i + 1] = c.z + (hash01(i * 4.3) - 0.5) * 1.1;
      eject[i] = hash01(i * 8.8) * Math.PI * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N_PART * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    g.setAttribute("aSensor", new THREE.BufferAttribute(sensor, 1));
    g.setAttribute("aFlare", new THREE.BufferAttribute(flare, 1));
    g.setAttribute("aTarget", new THREE.BufferAttribute(target, 2));
    g.setAttribute("aEject", new THREE.BufferAttribute(eject, 1));
    const pMat = new THREE.ShaderMaterial({
      vertexShader: PART_VS,
      fragmentShader: PART_FS,
      uniforms: { uStream: { value: 0 }, uA: { value: 0 }, uPx: { value: 1.5 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(g, pMat);
    points.frustumCulled = false;
    return { points, pMat };
  }, [data, cells]);

  const { hexes, hMat } = useMemo(() => {
    // per-year brightness from the real global harmonized totals, as a monthly mean so the
    // partial first (2000: 2 months) and last years don't read as quiet years
    const months = data.globe.months;
    const tot = data.globe.meta.monthly_total_harm;
    const year = new Map<number, number>();
    const nm = new Map<number, number>();
    months.forEach((m, i) => {
      const y = +m.slice(0, 4);
      year.set(y, (year.get(y) ?? 0) + tot[i]);
      nm.set(y, (nm.get(y) ?? 0) + 1);
    });
    for (const [y, v] of year) year.set(y, v / (nm.get(y) ?? 1));
    const mx = Math.max(...year.values());
    const regimes = data.results.data.regimes;
    const lastMonth = data.results.data.product_last;
    const geo = new THREE.CylinderGeometry(HEX_R * 0.86, HEX_R * 0.86, LAYER_H * 0.5, 6);
    geo.rotateY(Math.PI / 6);
    const count = LAYERS * cells.length;
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, count);
    const aLayer = new Float32Array(count);
    const aFold = new Float32Array(count);
    const aGlow = new Float32Array(count);
    const aYear = new Float32Array(count);
    const m4 = new THREE.Matrix4();
    let k = 0;
    for (let L = 0; L < LAYERS; L++) {
      const y = 2000 + L;
      const amt = (year.get(y) ?? 0) / mx;
      const rIdx = Math.max(0, REGIME_CODES.indexOf(regimes[layerRegime(y, regimes, lastMonth)]?.code ?? "N"));
      cells.forEach((c, j) => {
        m4.makeTranslation(c.x, 0, c.z);
        mesh.setMatrixAt(k, m4);
        aLayer[k] = L;
        aYear[k] = rIdx;
        aFold[k] = Math.floor(hash01(j * 13.7 + 1) * 5);
        aGlow[k] = Math.min(1, 0.35 + 0.65 * amt * (0.55 + 0.45 * hash01(j * 3.3 + L * 0.71)));
        k++;
      });
    }
    geo.setAttribute("aLayer", new THREE.InstancedBufferAttribute(aLayer, 1));
    geo.setAttribute("aFold", new THREE.InstancedBufferAttribute(aFold, 1));
    geo.setAttribute("aGlow", new THREE.InstancedBufferAttribute(aGlow, 1));
    geo.setAttribute("aYear", new THREE.InstancedBufferAttribute(aYear, 1));
    const hMat = new THREE.ShaderMaterial({
      vertexShader: HEX_VS,
      fragmentShader: HEX_FS,
      uniforms: {
        uGrid: { value: 0 },
        uStack: { value: 0 },
        uOverlap: { value: 0 },
        uFolds: { value: 0 },
        uSeal: { value: 0 },
        uA: { value: 0 },
      },
      transparent: true,
    });
    mesh.material = hMat;
    mesh.frustumCulled = false;
    return { hexes: mesh, hMat };
  }, [data, cells]);

  useFrame((state) => {
    const u = film.u;
    const inActs = inActsAt(film.s);
    const vis = towerVisibility(u, inActs) * (1 - methodPresence());
    if (group.current) group.current.visible = vis > 0.002;
    if (vis <= 0.002) return;
    pMat.uniforms.uStream.value = ramp(U.stream[0], U.stream[1], u) * 1.38;
    pMat.uniforms.uA.value = vis * (1 - ramp(U.stack[0] + 0.02, U.stack[1], u));
    pMat.uniforms.uPx.value = 1.5 * Math.min(2, state.viewport.dpr);
    const h = hMat.uniforms;
    h.uA.value = vis;
    h.uGrid.value = ramp(U.grid[0], U.grid[1], u);
    h.uStack.value = 1 + ramp(U.stack[0], U.stack[1], u) * (LAYERS - 1);
    h.uOverlap.value = ramp(U.overlap[0], U.overlap[0] + 0.012, u);
    h.uFolds.value = ramp(U.folds[0], U.folds[0] + 0.012, u);
    h.uSeal.value = ramp(U.folds[0] + 0.008, U.folds[0] + 0.02, u);
    if (labels.current) {
      const a = vis * ramp(U.stack[0] + 0.02, U.stack[1], u);
      labels.current.visible = a > 0.01;
      for (const o of labels.current.children) (o as THREE.Object3D & { fillOpacity?: number }).fillOpacity = a;
    }
  });

  // one label per regime, on the first layer drawn in its colour; the text carries the exact start month
  const regimeLabels = useMemo(() => {
    const { regimes, product_last } = data.results.data;
    const out: [string, number, string][] = [];
    for (let L = 0; L < LAYERS; L++) {
      const r = regimes[layerRegime(2000 + L, regimes, product_last)];
      if (r && !out.some(([t]) => t.includes(` ${r.code} · `)))
        out.push([`${r.from}  ${r.code} · ${r.label}`, 2000 + L, REGIME_HEX[r.code] ?? "#eadbcc"]);
    }
    return out;
  }, [data]);
  return (
    <group ref={group} position={TOWER_POS} visible={false}>
      <primitive object={points} />
      <primitive object={hexes} />
      <mesh position={[0, -0.06, 0]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[6.6, 64]} />
        <meshBasicMaterial color="#0b0f1a" transparent opacity={0.85} />
      </mesh>
      <group ref={labels}>
        {regimeLabels.map(([t, y, c]) => (
          <Text key={t} font={monoFont} fontSize={0.34} position={[6.3, (y - 2000) * LAYER_H + 0.1, 0]} anchorX="left" anchorY="middle" color={c}>
            {t}
          </Text>
        ))}
      </group>
    </group>
  );
}
