// Station 2 · Terrain: where in the area it burns. One hex prism per r5 cell (≈253 km², /cells), height = mean
// hotspots per year, colour = amount or peak month; scrub a year to regrow it. Live detections of the last 7 days
// fall from orbit onto the floor (LiveSparks, also on the verdict station).
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { geoContains } from "d3";
import { interpolateInferno, interpolateRgbBasis } from "d3";
import { api } from "../../app/api";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MONTHS_LONG, fmt, monthLabel as monthLabelOf } from "../../app/format";
import { type GlobeData, decode, loadGlobe } from "../data";
import { type Station, useObs } from "../store";
import { type StageFrame } from "./frame";
import { presence } from "./state";

export const MONTH_HUES = ["#4cc9f0", "#4895ef", "#4361ee", "#7209b7", "#b5179e", "#f72585", "#ff5d5d", "#ff8c42", "#ffbe0b", "#c5e063", "#06d6a0", "#2ec4b6"];

const VS = /* glsl */ `
  attribute float aH; attribute float aDelay; attribute vec3 aCol;
  uniform float uT; uniform float uPres; uniform float uHover;
  varying vec3 vCol; varying float vY; varying float vHov;
  float spring(float t){ if (t <= 0.0) return 0.0; return 1.0 - exp(-5.5 * t) * cos(9.0 * t); }
  void main() {
    float k = spring(uT - aDelay) * uPres;
    vec3 p = position; vY = p.y;
    p.y *= max(0.01, k); // height is in the instance matrix so hover hits the whole prism
    vHov = step(abs(float(gl_InstanceID) - uHover), 0.1);
    vCol = aCol;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    if (aH <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const FS = /* glsl */ `
  uniform float uPres;
  varying vec3 vCol; varying float vY; varying float vHov;
  void main() {
    vec3 c = vCol * (0.3 + 0.95 * vY) + vCol * smoothstep(0.95, 1.0, vY) * 0.9;
    c += vec3(0.5) * vHov;
    gl_FragColor = vec4(c, uPres);
  }
`;

interface TCell { x: number; z: number; mean: number; peak: number | null; byYear?: number[]; adm1?: string | null; gi?: number }

/** A cell against its own normal: blue below, grey as usual, orange to red above (log2 of the ratio, ±2). */
const ANOM = interpolateRgbBasis(["#3a7bd5", "#7fc4ff", "#8d96a8", "#ffb347", "#ff4d2e"]);
export const anomColor = (v: number, typ: number) => ANOM((Math.max(-2, Math.min(2, Math.log2((v + 0.5) / (typ + 0.5)))) + 2) / 4);

export function Terrain({ fr }: { fr: StageFrame }) {
  const cells = useObs((s) => s.cells);
  const cellsError = useObs((s) => s.cellsError);
  const shape = useObs((s) => s.shape);
  const colorBy = useObs((s) => s.terrainColor);
  const year = useObs((s) => s.terrainYear);
  const station = useObs((s) => s.station);
  const focus = useObs((s) => s.placeFocus);
  const places = useObs((s) => s.places);
  const mode = useObs((s) => s.terrainMode);
  const pinned = useObs((s) => s.pinned);
  const area = useObs((s) => s.area);
  const cm = useObs((s) => s.cellsMonth);
  const [g, setG] = useState<GlobeData | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const group = useRef<THREE.Group>(null);
  const t0 = useRef(-1);

  useEffect(() => {
    if (cellsError) loadGlobe().then(setG, () => undefined);
  }, [cellsError]);

  // r5 cells from the API, or r3 globe cells inside the outline for very large areas
  const tc = useMemo((): { list: TCell[]; rKm: number; years?: number[]; coarse: boolean } | null => {
    if (cells) {
      const list = cells.cells.map((_, i) => {
        const [x, z] = fr.toLocal(cells.lon[i], cells.lat[i]);
        return { x, z, mean: cells.mean_annual[i], peak: cells.peak_month[i], byYear: cells.by_year?.[i], adm1: cells.adm1?.[i] ?? null };
      });
      return { list, rKm: 9.87, years: cells.years, coarse: false };
    }
    if (g && shape && cellsError) {
      const feat: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: shape.polys } };
      const list: TCell[] = [];
      const months = g.nMonths;
      for (let i = 0; i < g.nCells; i++) {
        const lon = g.lon[i], lat = g.lat[i];
        if (shape.polys.length && !geoContains(feat, [lon, lat])) continue;
        if (!shape.polys.length) continue;
        let sum = 0;
        const byM = new Float32Array(12);
        for (let m = 0; m < months; m++) {
          const v = decode(g.bytes[m * g.nCells + i], g.hMax);
          sum += v;
          byM[(m + 10) % 12] += v;
        }
        let pk = 0;
        for (let k = 1; k < 12; k++) if (byM[k] > byM[pk]) pk = k;
        const [x, z] = fr.toLocal(lon, lat);
        list.push({ x, z, mean: (sum / months) * 12, peak: sum > 0 ? pk + 1 : null, gi: i });
      }
      return { list, rKm: 69, coarse: true };
    }
    return null;
  }, [cells, g, shape, cellsError, fr]);

  const mesh = useMemo(() => {
    if (!tc || !tc.list.length) return null;
    const n = tc.list.length;
    const r = (tc.rKm / fr.kmPerUnit) * 0.9;
    const geo = new THREE.CylinderGeometry(r, r, 1, 6, 1);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, n);
    const m4 = new THREE.Matrix4();
    let maxD = 1;
    for (const c of tc.list) maxD = Math.max(maxD, Math.hypot(c.x, c.z));
    const aDelay = new Float32Array(n);
    tc.list.forEach((c, i) => {
      m4.makeRotationY(Math.PI / 6).setPosition(c.x, 0.01, c.z);
      mesh.setMatrixAt(i, m4);
      aDelay[i] = 0.15 + (Math.hypot(c.x, c.z) / maxD) * 0.9;
    });
    geo.setAttribute("aH", new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
    geo.setAttribute("aCol", new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute("aDelay", new THREE.InstancedBufferAttribute(aDelay, 1));
    mesh.material = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: { uT: { value: 0 }, uPres: { value: 0 }, uHover: { value: -1 } },
      transparent: true,
    });
    mesh.frustumCulled = false;
    return mesh;
  }, [tc, fr]);

  // month mode: the timeline month in every cell (fine cells from /cells_month; coarse cells from the globe record)
  useEffect(() => {
    if (mode !== "month" || !pinned || !tc) return;
    if (tc.coarse) {
      if (!g) return;
      const mi = g.months.indexOf(pinned);
      const mm = Number(pinned.slice(5, 7));
      const values: number[] = [], typical: number[] = [];
      for (const c of tc.list) {
        const i = c.gi ?? 0;
        values.push(mi >= 0 ? decode(g.bytes[mi * g.nCells + i], g.hMax) : 0);
        let t = 0, n = 0;
        g.months.forEach((m, k) => {
          const yy = Number(m.slice(0, 4));
          if (Number(m.slice(5, 7)) === mm && yy >= 2003 && yy <= 2025 && m !== pinned) {
            t += decode(g.bytes[k * g.nCells + i], g.hMax);
            n++;
          }
        });
        typical.push(n ? t / n : 0);
      }
      useObs.setState({ cellsMonth: { month: pinned, values, typical } });
      return;
    }
    if (!area) return;
    let alive = true;
    api.cellsMonth(area.area_id, pinned).then(
      (r) => alive && useObs.setState({ cellsMonth: { month: r.month, values: r.values, typical: r.typical } }),
      (e) => console.warn("terrain month:", e),
    );
    return () => {
      alive = false;
    };
  }, [mode, pinned, tc, g, area]);
  const monthOn = mode === "month" && !!cm && !!tc && cm.values.length === tc.list.length;

  // heights and colours (amount or peak month; one year or the mean)
  const yIdx = tc?.years && year !== null ? tc.years.indexOf(year) : -1;
  useEffect(() => {
    if (!mesh || !tc) return;
    const geo = mesh.geometry;
    const aH = geo.getAttribute("aH") as THREE.InstancedBufferAttribute;
    const aCol = geo.getAttribute("aCol") as THREE.InstancedBufferAttribute;
    const val = (c: TCell, i: number) => (monthOn ? cm!.values[i] : yIdx >= 0 && c.byYear ? c.byYear[yIdx] : c.mean);
    // month mode keeps one scale for every month of this area (≈ a busy month in its busiest cell), so scrubbing
    // through an off-season shows a flat floor instead of magnifying noise
    // loops, not Math.max(...list): the largest countries have up to ~65,000 cells (Safari caps call arguments at 65,536)
    let max = 1e-6;
    if (monthOn) {
      let meanMax = 0;
      for (const c of tc.list) meanMax = Math.max(meanMax, c.mean);
      max = Math.max(max, 0.6 * meanMax);
      for (const t of cm!.typical) max = Math.max(max, t);
    } else {
      for (const c of tc.list) max = Math.max(max, yIdx >= 0 && c.byYear ? Math.max(...c.byYear) : c.mean);
    }
    const col = new THREE.Color();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    tc.list.forEach((c, i) => {
      const v = val(c, i);
      const h = v > 0 ? 0.06 + 4.2 * Math.min(1.15, Math.sqrt(v / max)) : 0;
      (aH.array as Float32Array)[i] = h;
      mesh.setMatrixAt(i, m4.compose(pos.set(c.x, 0.01, c.z), q, sc.set(1, Math.max(0.001, h), 1)));
      if (monthOn && colorBy === "anom") col.set(anomColor(v, cm!.typical[i]));
      else if (colorBy === "peak" && c.peak) col.set(MONTH_HUES[c.peak - 1]);
      else col.set(interpolateInferno(0.15 + 0.85 * Math.sqrt(Math.min(1, v / max))));
      // a province picked in the panel stays lit; the rest of the area steps back
      if (focus && c.adm1 !== focus) col.multiplyScalar(0.18);
      (aCol.array as Float32Array).set([col.r, col.g, col.b], i * 3);
    });
    aH.needsUpdate = aCol.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [mesh, tc, colorBy, yIdx, focus, monthOn, cm]);

  useFrame((state) => {
    const p = presence.terrain;
    if (group.current) group.current.visible = p > 0.002;
    if (!mesh) return;
    const mat = mesh.material as THREE.ShaderMaterial;
    if (p > 0.01 && t0.current < 0) t0.current = state.clock.elapsedTime;
    if (p < 0.01) t0.current = -1;
    mat.uniforms.uT.value = t0.current < 0 ? 0 : state.clock.elapsedTime - t0.current;
    mat.uniforms.uPres.value = p;
    mat.uniforms.uHover.value = hover ?? -1;
  });

  const hc = hover !== null && tc ? tc.list[hover] : null;
  return (
    <group ref={group}>
      {mesh && (
        <primitive
          object={mesh}
          renderOrder={2}
          onPointerMove={(e: { instanceId?: number; stopPropagation: () => void }) => {
            if (presence.terrain < 0.5) return; // hidden stations never swallow the pointer
          e.stopPropagation();
            if (e.instanceId !== undefined) setHover(e.instanceId);
          }}
          onPointerOut={() => setHover(null)}
        />
      )}
      {station === "terrain" && hc && (
        <Html position={[hc.x, 2.5, hc.z]} center zIndexRange={[30, 20]}>
          <div className="tip3d">
            {monthOn ? (
              <>
                <b>{monthLabelOf(cm!.month)}</b>
                <span>{fmt(cm!.values[hover!], 1)} hotspots in this cell</span>
                <span className="muted">typical for {MONTHS_LONG[Number(cm!.month.slice(5, 7)) - 1]}: {fmt(cm!.typical[hover!], 1)}</span>
              </>
            ) : (
              <>
                <b>{yIdx >= 0 ? `${year}` : `Mean ${cells?.first_year ?? 2001}–${cells?.last_year ?? 2025}`}</b>
                <span>{fmt(yIdx >= 0 && hc.byYear ? hc.byYear[yIdx] : hc.mean, 1)} hotspots / yr in this cell</span>
              </>
            )}
            {hc.peak && <span className="muted">usually peaks in {MONTHS_LONG[hc.peak - 1]}</span>}
            <span className="muted">{tc?.coarse ? "≈12,400 km² cell (coarse view)" : "≈253 km² cell"}</span>
          </div>
        </Html>
      )}
      {station === "terrain" && places?.hottest && !hc && (
        <Html position={[...((([x, z]) => [x, 0.2 + 4.3, z])(fr.toLocal(places.hottest.lon, places.hottest.lat)) as [number, number, number])]} center zIndexRange={[16, 6]}>
          <div className="hot-pin">
            <b>hottest cell</b>
            <span>{places.hottest.times_average}× the area average</span>
          </div>
        </Html>
      )}
      <LiveSparks fr={fr} station="terrain" />
    </group>
  );
}

// ---------------- live detections falling from orbit ----------------
const SPARK_VS = /* glsl */ `
  attribute float aDelay; attribute float aSize; attribute float aSat;
  uniform float uT; uniform float uPres; uniform float uPx; uniform float uTime;
  varying float vFall; varying float vSat; varying float vTw;
  void main() {
    float k = clamp((uT - aDelay) / 0.9, 0.0, 1.0);
    float e = k * k;
    vec3 p = position;
    p.y = mix(16.0, 0.12, e);
    vFall = k; vSat = aSat;
    vTw = 0.7 + 0.3 * sin(uTime * 5.0 + aDelay * 40.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uPx * aSize * (k < 1.0 ? 0.7 : 1.0) * (1.6 / -mv.z); // view space is in world units (stage scale 0.06)
    gl_Position = projectionMatrix * mv;
    if (uT < aDelay || uPres < 0.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const SPARK_FS = /* glsl */ `
  uniform float uPres;
  varying float vFall; varying float vSat; varying float vTw;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d);
    float a = smoothstep(0.25, 0.0, r);
    vec3 c = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.7, 0.3), vSat);
    float land = step(1.0, vFall);
    c *= mix(1.0, 0.6 * vTw, land);
    gl_FragColor = vec4(c, a * uPres * mix(0.55, 0.22, land));
  }
`;

export function LiveSparks({ fr, station }: { fr: StageFrame; station: Station }) {
  const now = useObs((s) => s.now);
  const t0 = useRef(-1);
  const pts = useMemo(() => {
    const feats = now?.last7d?.features ?? [];
    if (!feats.length) return null;
    const n = Math.min(feats.length, 6000);
    const pos = new Float32Array(n * 3), delay = new Float32Array(n), size = new Float32Array(n), sat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = feats[i];
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const [x, z] = fr.toLocal(lon, lat);
      pos.set([x, 0.12, z], i * 3);
      delay[i] = 0.4 + ((i * 0.618) % 1) * 1.8;
      const frp = Number((f.properties as Record<string, unknown>)?.frp ?? 1);
      size[i] = 0.7 + Math.min(2.2, Math.sqrt(Math.max(0, frp)) * 0.3);
      sat[i] = String((f.properties as Record<string, unknown>)?.satellite ?? "") === "NOAA21" ? 1 : 0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aDelay", new THREE.BufferAttribute(delay, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aSat", new THREE.BufferAttribute(sat, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: SPARK_VS,
      fragmentShader: SPARK_FS,
      uniforms: { uT: { value: 0 }, uPres: { value: 0 }, uPx: { value: 1 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }, [now, fr]);
  useFrame((state) => {
    if (!pts) return;
    const p = presence[station];
    const m = pts.material as THREE.ShaderMaterial;
    if (p > 0.01 && t0.current < 0) t0.current = state.clock.elapsedTime;
    if (p < 0.01) t0.current = -1;
    m.uniforms.uT.value = t0.current < 0 ? 0 : state.clock.elapsedTime - t0.current;
    m.uniforms.uPres.value = p;
    m.uniforms.uTime.value = state.clock.elapsedTime;
    m.uniforms.uPx.value = Math.min(2, state.viewport.dpr) * 1.3;
  });
  return pts ? <primitive object={pts} renderOrder={8} /> : null;
}
