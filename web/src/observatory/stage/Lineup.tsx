// Station 1 · The Line-Up: the same month in every year as a curved row of pillars, sorted low → high, with the
// p25–p75 "normal" band as glass and the median as a light line. The chosen year rises last and lands at its rank.
import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { CATEGORY_LABEL, MONTHS_LONG } from "../../app/format";
import type { CalendarMonth } from "../../app/types";
import { CAT_GLYPH, CAT_HEX, fmtS, ordinal } from "../hud/glyphs";
import { useObs } from "../store";
import { type StageFrame } from "./frame";
import { latestJudged, sameMonth } from "./model";
import { presence, stageClock } from "./state";
import { LiveSparks } from "./Terrain";

const RAD = 9.6, CZ = 3, SPAN = (64 * Math.PI) / 180, HMAX = 8.2;
const arcPos = (k: number, n: number): [number, number] => {
  const a = n <= 1 ? 0 : -SPAN + (2 * SPAN * k) / (n - 1);
  return [RAD * Math.sin(a), CZ - RAD * Math.cos(a)];
};

const VS = /* glsl */ `
  attribute float aH; attribute float aDelay; attribute vec3 aCol; attribute float aSel;
  uniform float uT; uniform float uPres; uniform float uHover;
  varying vec3 vCol; varying float vY; varying float vSel; varying float vHov; varying float vFlash;
  float spring(float t){ if (t <= 0.0) return 0.0; return 1.0 - exp(-6.0 * t) * cos(11.0 * t); }
  void main() {
    float k = spring(uT - aDelay) * uPres;
    vec3 p = position;
    vY = p.y;
    p.y *= max(0.01, k); // the pillar's height is in the instance matrix, so raycasting (hover/click) matches what you see
    float hov = step(abs(float(gl_InstanceID) - uHover), 0.1);
    p.xz *= 1.0 + 0.25 * hov + 0.25 * aSel;
    vCol = aCol; vSel = aSel; vHov = hov;
    vFlash = aSel * exp(-3.0 * max(0.0, uT - aDelay - 0.25)) * step(aDelay + 0.25, uT);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;
const FS = /* glsl */ `
  uniform float uPres; uniform float uTime;
  varying vec3 vCol; varying float vY; varying float vSel; varying float vHov; varying float vFlash;
  void main() {
    vec3 c = vCol * (0.45 + 0.8 * vY);
    c += vCol * vSel * (0.5 + 0.2 * sin(uTime * 3.0));
    c += vec3(1.0, 0.95, 0.85) * vFlash * 2.5;
    c += vec3(0.3, 0.35, 0.45) * vHov;
    float edge = smoothstep(0.96, 1.0, vY);
    c += vCol * edge * 0.9 + vec3(0.25, 0.12, 0.04) * edge;
    gl_FragColor = vec4(c, uPres);
  }
`;

export function Lineup({ fr }: { fr: StageFrame }) {
  const cal = useObs((s) => s.calendar);
  const pinned = useObs((s) => s.pinned);
  const set = useObs((s) => s.set);
  const showLabels = useObs((s) => s.station === "verdict" && s.view === "area");
  const [hover, setHover] = useState<number | null>(null);
  const group = useRef<THREE.Group>(null);
  const t0 = useRef(0);
  const lastMnum = useRef("");

  const data = useMemo(() => {
    if (!cal) return null;
    const sel = (pinned && cal.months.find((m) => m.month === pinned)) || latestJudged(cal);
    if (!sel) return null;
    const list = sameMonth(cal, sel.month).filter((m) => m.h_count > 0 || m.month === sel.month);
    const sorted = [...list].sort((a, b) => a.h_count - b.h_count);
    // scale against the area's busy months too, so an off-season month never looks like a fire season
    const allMax = Math.max(...cal.months.map((m) => m.h_count));
    const max = Math.max(1, ...sorted.map((m) => Math.max(m.h_count, m.hi90)), allMax * 0.35);
    const h = (v: number) => HMAX * Math.sqrt(Math.max(0, v) / max);
    const clim = cal.climatology.find((c) => c.month_num === Number(sel.month.slice(5, 7)));
    return { sel, sorted, h, clim, max };
  }, [cal, pinned]);

  const mesh = useMemo(() => {
    if (!data) return null;
    const n = data.sorted.length;
    const geo = new THREE.BoxGeometry(0.62, 1, 0.62);
    geo.translate(0, 0.5, 0);
    const aH = new Float32Array(n), aDelay = new Float32Array(n), aCol = new Float32Array(n * 3), aSel = new Float32Array(n);
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, n);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    data.sorted.forEach((m, k) => {
      const [x, z] = arcPos(k, n);
      const a = Math.atan2(x, -(z - CZ));
      aH[k] = Math.max(0.04, data.h(m.h_count));
      m4.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a), new THREE.Vector3(1, aH[k], 1));
      mesh.setMatrixAt(k, m4);
      const isSel = m.month === data.sel.month;
      aSel[k] = isSel ? 1 : 0;
      aDelay[k] = isSel ? 0.35 + n * 0.035 + 0.25 : 0.25 + k * 0.035;
      if (isSel) col.set(CAT_HEX[m.category ?? "normal"]);
      else col.setHSL(0.06 + 0.04 * Math.sqrt(m.h_count / data.max), 0.75, 0.1 + 0.2 * Math.sqrt(m.h_count / data.max));
      aCol.set([col.r, col.g, col.b], k * 3);
    });
    geo.setAttribute("aH", new THREE.InstancedBufferAttribute(aH, 1));
    geo.setAttribute("aDelay", new THREE.InstancedBufferAttribute(aDelay, 1));
    geo.setAttribute("aCol", new THREE.InstancedBufferAttribute(aCol, 3));
    geo.setAttribute("aSel", new THREE.InstancedBufferAttribute(aSel, 1));
    mesh.material = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: { uT: { value: 0 }, uPres: { value: 0 }, uHover: { value: -1 }, uTime: { value: 0 } },
      transparent: true,
    });
    mesh.frustumCulled = false;
    const mnum = data.sel.month.slice(5, 7);
    if (lastMnum.current !== mnum) t0.current = -1;
    lastMnum.current = mnum;
    return mesh;
  }, [data]);

  // the p25–p75 glass band and the median line
  const band = useMemo(() => {
    if (!data?.clim || data.clim.p25 === null || data.clim.p75 === null) return null;
    const y0 = data.h(data.clim.p25), y1 = data.h(data.clim.p75);
    const ym = data.h(data.sel.median_m ?? data.clim.median ?? 0);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = -SPAN * 1.08 + (2 * SPAN * 1.08 * i) / 64;
      pts.push(new THREE.Vector3(RAD * Math.sin(a), ym, CZ - RAD * Math.cos(a)));
    }
    return { y0, y1, ym, pts };
  }, [data]);
  const bandMat = useRef<THREE.MeshBasicMaterial>(null);

  useFrame((state) => {
    const p = presence.verdict;
    if (group.current) group.current.visible = p > 0.002;
    if (!mesh) return;
    const mat = mesh.material as THREE.ShaderMaterial;
    if (p > 0.01 && t0.current < 0) t0.current = state.clock.elapsedTime;
    if (p < 0.01) t0.current = -1;
    mat.uniforms.uT.value = t0.current < 0 ? 0 : state.clock.elapsedTime - t0.current;
    mat.uniforms.uPres.value = p;
    mat.uniforms.uTime.value = state.clock.elapsedTime;
    mat.uniforms.uHover.value = hover ?? -1;
    if (bandMat.current) bandMat.current.opacity = 0.08 * p;
    void stageClock;
  });

  if (!data || !mesh) return null;
  const n = data.sorted.length;
  const selIdx = data.sorted.findIndex((m) => m.month === data.sel.month);
  const monthName = MONTHS_LONG[Number(data.sel.month.slice(5, 7)) - 1];
  const hov: CalendarMonth | undefined = hover !== null ? data.sorted[hover] : undefined;

  return (
    <group ref={group}>
      <primitive
        object={mesh}
        renderOrder={2}
        onPointerMove={(e: { instanceId?: number; stopPropagation: () => void }) => {
          if (presence.verdict < 0.5) return; // hidden stations never swallow the pointer
          e.stopPropagation();
          if (e.instanceId !== undefined) setHover(e.instanceId);
        }}
        onPointerOut={() => setHover(null)}
        onClick={(e: { instanceId?: number; stopPropagation: () => void }) => {
          if (presence.verdict < 0.5) return; // hidden stations never swallow the pointer
          e.stopPropagation();
          if (e.instanceId !== undefined) set({ pinned: data.sorted[e.instanceId].month });
        }}
      />
      {band && showLabels && (
        <>
          <mesh position={[0, (band.y0 + band.y1) / 2, CZ]} renderOrder={3}>
            <cylinderGeometry args={[RAD, RAD, Math.max(0.05, band.y1 - band.y0), 64, 1, true, Math.PI - SPAN * 1.08, SPAN * 2.16]} />
            <meshBasicMaterial ref={bandMat} color="#9fc6ff" transparent opacity={0.08} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <Line renderOrder={4} points={band.pts} color="#e8f1ff" lineWidth={1.4} transparent opacity={0.85} dashed dashSize={0.25} gapSize={0.15} />
          <Html position={band.pts[0].toArray()} className="stage-note" center={false} zIndexRange={[15, 5]}>
            <span className="note-chip">median</span>
          </Html>
        </>
      )}
      {showLabels &&
        data.sorted.map((m, k) => {
          const [x, z] = arcPos(k, n);
          const sel = k === selIdx;

          return (
            <Html key={m.month} position={[x, Math.max(0.04, data.h(m.h_count)) + (sel ? 0.6 : 0.32), z]} center zIndexRange={[14, 4]} className="stage-lbl-wrap">
              {sel ? (
                <div className={`sel-flag cat-${m.category ?? "normal"}`}>
                  <span className="sel-year">{m.month.slice(0, 4)}</span>
                  <span className="sel-val">{fmtS(m.h_count)}</span>
                  {m.pct_rank !== null && <span className="sel-pct">{ordinal(m.pct_rank)} pct</span>}
                </div>
              ) : (
                <button
                  type="button"
                  className={`yr-lbl ${k === 0 ? "end lo" : k === n - 1 ? "end hi" : ""}`}
                  onClick={() => set({ pinned: m.month })}
                  onPointerEnter={() => setHover(k)}
                  onPointerLeave={() => setHover(null)}
                  aria-label={`${m.month}: ${Math.round(m.h_count)} hotspots. Judge this month.`}
                >
                  {k === 0 && <i>quietest</i>}
                  {k === n - 1 && <i>busiest</i>}’{m.month.slice(2, 4)}
                </button>
              )}
            </Html>
          );
        })}
      {showLabels && hov && hover !== null && (
        <Html position={[arcPos(hover, n)[0], data.h(hov.h_count) + 1.2, arcPos(hover, n)[1]]} center zIndexRange={[30, 20]}>
          <div className="tip3d">
            <b>
              {monthName} {hov.month.slice(0, 4)}
            </b>
            <span>{fmtS(hov.h_count)} hotspots</span>
            <span className="muted">
              90 % range {fmtS(hov.lo90)}–{fmtS(hov.hi90)}
            </span>
            {hov.category && (
              <span className={`cat-${hov.category}`}>
                {CAT_GLYPH[hov.category]} {CATEGORY_LABEL[hov.category]}
              </span>
            )}
            <span className="muted">click to judge this month</span>
          </div>
        </Html>
      )}
      <LiveSparks fr={fr} station="verdict" />
    </group>
  );
}
