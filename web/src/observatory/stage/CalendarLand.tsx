// Station 3 · The Burning Calendar as a landscape: 12 months × 27 years of blocks, height ∝ √hotspots.
// Signature moves: Harmonized ⇄ Raw (a sweep passes and the post-2012 blocks tower up in icy VIIRS-cyan, then
// collapse back), Count ⇄ vs normal (a diagonal colour wave), and Flatten (the camera goes top-down and the
// blocks sink into an exact heatmap). Year totals stand as a wall on the right, the median as a ridge in front.
import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { MONTHS_SHORT, fmt } from "../../app/format";
import { type Station, useObs } from "../store";
import { CATEGORY_GLSL, INFERNO } from "../world/shaders";
import { gridOf, rawTotal } from "./model";
import { presence } from "./state";
import { sfx } from "../sfx";

export const COL_W = 0.92, ROW_D = 0.44, HSCALE = 3.6;
export const colX = (c: number) => (c - 5.5) * COL_W;

const VS = /* glsl */ `
  attribute float aH; attribute float aR; attribute float aCount; attribute float aCat; attribute float aProv; attribute float aRowF; attribute float aColF; attribute float aFlag;
  uniform float uPres; uniform float uT;
  uniform float uRawFrom; uniform float uRawTo; uniform float uRawT;
  uniform float uAnomFrom; uniform float uAnomTo; uniform float uAnomT;
  uniform float uFlatFrom; uniform float uFlatTo; uniform float uFlatT;
  uniform float uHover; uniform float uPin; uniform float uPlay;
  varying vec3 vN; varying float vY; varying float vYW; varying float vHarmTop; varying float vRaw; varying float vAnom; varying float vCount; varying float vCat;
  varying float vProv; varying float vHi; varying vec3 vP; varying float vFlag; varying float vPlay; varying float vFlat;
  float spring(float t){ if (t <= 0.0) return 0.0; return 1.0 - exp(-6.0 * t) * cos(10.0 * t); }
  float elasticOut(float x){ x = clamp(x, 0.0, 1.0); if (x <= 0.0 || x >= 1.0) return x; return pow(2.0, -10.0 * x) * sin((x * 10.0 - 0.75) * 2.0943951) + 1.0; }
  float ease(float x){ x = clamp(x, 0.0, 1.0); return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
  void main() {
    float id = float(gl_InstanceID);
    float rise = spring(uT - 0.15 - aRowF * 1.1 - aColF * 0.18);
    float rawK = mix(uRawFrom, uRawTo, elasticOut((uRawT - aRowF * 0.55) / 0.85));
    float flatK = mix(uFlatFrom, uFlatTo, ease((uFlatT - aColF * 0.25) / 0.6));
    float anomK = mix(uAnomFrom, uAnomTo, ease((uAnomT - (aRowF + aColF) * 0.4) / 0.45));
    float h = mix(aH, aR, max(rawK, 0.0) + min(rawK, 0.0));
    float height = max(0.04, mix(h, 0.05, flatK)) * rise * uPres;
    vec3 p = position;
    vY = p.y;
    float hov = step(abs(id - uHover), 0.1);
    float pin = step(abs(id - uPin), 0.1);
    float play = step(abs(id - uPlay), 0.1);
    // the instance matrix already holds the harmonized height (so hover/click hit the whole block); scale relative to it
    float sc = max(aH, 0.04);
    float hw = height + 0.25 * (hov + pin) * (1.0 - flatK) + play * 0.6;
    p.y *= hw / sc;
    vYW = p.y * sc; vHarmTop = aH * (1.0 - flatK) * rise;
    vRaw = clamp(rawK, 0.0, 1.0); vAnom = anomK; vCount = aCount; vCat = aCat; vProv = aProv; vFlag = aFlag;
    vHi = max(hov, pin); vPlay = play; vFlat = flatK;
    vN = normal;
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    vP = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;
const FS = /* glsl */ `
  ${INFERNO}
  ${CATEGORY_GLSL}
  uniform float uPres; uniform float uClay; uniform float uTime;
  varying vec3 vN; varying float vY; varying float vYW; varying float vHarmTop; varying float vRaw; varying float vAnom; varying float vCount; varying float vCat;
  varying float vProv; varying float vHi; varying vec3 vP; varying float vFlag; varying float vPlay; varying float vFlat;
  void main() {
    vec3 cc = vCount <= 0.0 ? vec3(0.06, 0.06, 0.09) : inferno(0.14 + 0.84 * vCount);
    vec3 ca = vCat < 0.5 ? vec3(0.08, 0.09, 0.12) : catColor(vCat);
    vec3 c = mix(cc, ca, vAnom);
    // the raw excess above the harmonized height glows icy VIIRS-cyan
    float excess = step(vHarmTop + 0.03, vYW) * vRaw * (1.0 - vFlat); // flat raw view: plain count colours
    c = mix(c, vec3(0.55, 0.86, 1.0) * 1.15, excess);
    float light = 0.5 + 0.5 * max(dot(vN, normalize(vec3(0.35, 1.0, 0.55))), 0.0);
    c *= light;
    c += c * smoothstep(0.93, 1.0, vY) * 0.8 * step(0.5, vN.y);
    // provisional months: diagonal hatch
    float hatch = step(0.5, fract((vP.x + vP.z + vP.y) * 7.0));
    c = mix(c, c * (0.45 + 0.55 * hatch), vProv);
    // record months wear a white star cap in anomaly mode
    c += vec3(1.0, 0.95, 0.75) * step(5.5, vCat) * vAnom * step(0.5, vN.y) * (0.55 + 0.25 * sin(uTime * 4.0));
    c += vec3(0.6, 0.7, 0.9) * vHi * 0.45;
    c += vec3(1.0, 0.85, 0.5) * vPlay * 1.5;
    // clay preview for the 3D-print station
    vec3 clay = vec3(0.7, 0.68, 0.64) * (0.22 + 0.62 * light);
    c = mix(c, clay, uClay);
    gl_FragColor = vec4(c, uPres);
  }
`;

const flipT = { raw: 0, anom: 0, flat: 0 };

export function CalendarLand() {
  const cal = useObs((s) => s.calendar);
  const station = useObs((s) => s.station);
  const valueMode = useObs((s) => s.valueMode);
  const set = useObs((s) => s.set);
  const group = useRef<THREE.Group>(null);
  const t0 = useRef(-1);
  const state = useRef({ raw: 0, anom: 0, flat: 0, rawT: 99, anomT: 99, flatT: 99, rawFrom: 0, anomFrom: 0, flatFrom: 0, clay: 0, last: { raw: 0, anom: 0, flat: 0 } });
  const sweep = useRef<THREE.Mesh>(null);

  const built = useMemo(() => {
    if (!cal) return null;
    const g = gridOf(cal);
    const nRows = g.years.length;
    const rowZ = (r: number) => (r - (nRows - 1) / 2) * ROW_D;
    const n = g.cells.length;
    const geo = new THREE.BoxGeometry(COL_W * 0.86, 1, ROW_D * 0.8);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, n);
    const f = (k: number) => new Float32Array(k);
    const A = { aH: f(n), aR: f(n), aCount: f(n), aCat: f(n), aProv: f(n), aRowF: f(n), aColF: f(n), aFlag: f(n) };
    const CAT = { much_below: 1, below: 2, normal: 3, above: 4, much_above: 5, record: 6 } as const;
    const m4 = new THREE.Matrix4();
    g.cells.forEach(({ m, row, col }, i) => {
      A.aH[i] = HSCALE * Math.sqrt(m.h_count / g.vmaxH);
      m4.makeScale(1, Math.max(0.04, A.aH[i]), 1).setPosition(colX(col), 0, rowZ(row));
      mesh.setMatrixAt(i, m4);
      A.aR[i] = HSCALE * Math.sqrt(rawTotal(m) / g.vmaxH);
      A.aCount[i] = m.h_count > 0 ? Math.sqrt(m.h_count / g.vmaxH) : 0;
      A.aCat[i] = m.category ? CAT[m.category] : 0;
      A.aProv[i] = m.provisional ? 1 : 0;
      A.aRowF[i] = row / Math.max(1, nRows - 1);
      A.aColF[i] = col / 11;
      A.aFlag[i] = (m.fill_frac ?? 0) >= 0.1 || m.modis_outage ? 1 : 0;
    });
    for (const [k, v] of Object.entries(A)) geo.setAttribute(k, new THREE.InstancedBufferAttribute(v, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: {
        uPres: { value: 0 }, uT: { value: 0 }, uTime: { value: 0 }, uClay: { value: 0 },
        uRawFrom: { value: 0 }, uRawTo: { value: 0 }, uRawT: { value: 99 },
        uAnomFrom: { value: 0 }, uAnomTo: { value: 0 }, uAnomT: { value: 99 },
        uFlatFrom: { value: 0 }, uFlatTo: { value: 0 }, uFlatT: { value: 99 },
        uHover: { value: -1 }, uPin: { value: -1 }, uPlay: { value: -1 },
      },
      transparent: true,
    });
    mesh.material = mat;
    mesh.frustumCulled = false;

    // year totals wall (right) — harmonized and raw sums from the same months
    const totals = g.years.map((y) => {
      const ms = cal.months.filter((m) => m.month.startsWith(`${y}-`));
      return { y, h: ms.reduce((s, m) => s + m.h_count, 0), r: ms.reduce((s, m) => s + rawTotal(m), 0), info: cal.years.find((v) => v.year === y) };
    });
    const tMax = Math.max(1, ...totals.map((t) => t.h));
    const top3 = [...cal.years].filter((y) => y.complete && y.rank !== null).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).slice(0, 3).map((y) => y.year);
    // climatology ridge (front)
    const zFront = rowZ(nRows - 1) + 0.85;
    const med: THREE.Vector3[] = [];
    const bandPos: number[] = [];
    const bandIdx: number[] = [];
    cal.climatology.forEach((c, k) => {
      const x = colX(c.month_num - 1);
      med.push(new THREE.Vector3(x, HSCALE * Math.sqrt((c.median ?? 0) / g.vmaxH), zFront));
      bandPos.push(x, HSCALE * Math.sqrt((c.p25 ?? 0) / g.vmaxH), zFront, x, HSCALE * Math.sqrt((c.p75 ?? 0) / g.vmaxH), zFront);
      if (k < cal.climatology.length - 1) bandIdx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
    });
    const bandGeo = new THREE.BufferGeometry();
    bandGeo.setAttribute("position", new THREE.Float32BufferAttribute(bandPos, 3));
    bandGeo.setIndex(bandIdx);
    return { g, mesh, mat, rowZ, nRows, totals, tMax, top3, zFront, med, bandGeo };
  }, [cal]);

  const wallMesh = useMemo(() => {
    if (!built) return null;
    const n = built.totals.length;
    const geo = new THREE.BoxGeometry(0.9, 1, ROW_D * 0.78);
    geo.translate(0.45, 0.5, 0);
    const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: "#c58b4a", emissive: "#3a1d08", metalness: 0.2, roughness: 0.6, transparent: true }), n);
    const col = new THREE.Color();
    built.totals.forEach((t, i) => {
      col.set(built.top3.includes(t.y) ? "#ffd166" : t.info?.complete === false ? "#5d6470" : "#b9773d");
      m.setColorAt(i, col);
    });
    m.frustumCulled = false;
    return m;
  }, [built]);

  const tmpM = useMemo(() => new THREE.Matrix4(), []);
  useFrame((st, dtRaw) => {
    const dt = Math.min(0.2, dtRaw);
    const p = presence.calendar;
    if (group.current) group.current.visible = p > 0.002;
    if (!built) return;
    const now = st.clock.elapsedTime;
    const s = useObs.getState();
    if (p > 0.01 && t0.current < 0) t0.current = now;
    if (p < 0.01) t0.current = -1;
    const S = state.current;
    const inCal = s.station === "calendar";
    const want = { raw: inCal && s.valueMode === "raw" ? 1 : 0, anom: inCal && s.colorMode === "anomaly" && s.valueMode !== "raw" ? 1 : 0, flat: s.flat && inCal ? 1 : 0 };
    (["raw", "anom", "flat"] as const).forEach((k) => {
      if (want[k] !== S.last[k]) {
        // restart the wave from wherever the blocks are now
        const tk = k === "raw" ? "rawT" : k === "anom" ? "anomT" : "flatT";
        const fk = k === "raw" ? "rawFrom" : k === "anom" ? "anomFrom" : "flatFrom";
        S[fk] = S.last[k];
        S[tk] = 0;
        S.last[k] = want[k];
        flipT[k] = now;
        if (k === "raw") sfx.cliff(want.raw === 1);
        else sfx.sweep();
      }
    });
    S.rawT += dt;
    S.anomT += dt;
    S.flatT += dt;
    const u = built.mat.uniforms;
    u.uPres.value = p;
    u.uT.value = t0.current < 0 ? 0 : now - t0.current;
    u.uTime.value = now;
    u.uRawFrom.value = S.rawFrom;
    u.uRawTo.value = S.last.raw;
    u.uRawT.value = S.rawT;
    u.uAnomFrom.value = S.anomFrom;
    u.uAnomTo.value = S.last.anom;
    u.uAnomT.value = S.anomT;
    u.uFlatFrom.value = S.flatFrom;
    u.uFlatTo.value = S.last.flat;
    u.uFlatT.value = S.flatT;
    S.clay += ((s.station === "take" ? 1 : 0) - S.clay) * (1 - Math.exp(-dt * 3));
    if (group.current) group.current.rotation.y = s.station === "take" && !s.reduced ? group.current.rotation.y + dt * 0.12 : group.current.rotation.y * (1 - Math.min(1, dt * 4));
    u.uClay.value = S.clay;
    u.uHover.value = s.hoverMonth ? (built.g.byMonth.get(s.hoverMonth)?.i ?? -1) : -1;
    u.uPin.value = s.station === "calendar" && s.pinned ? (built.g.byMonth.get(s.pinned)?.i ?? -1) : -1;
    u.uPlay.value = s.playIdx ?? -1;
    // the sweep bar crosses the rows when the values switch
    if (sweep.current) {
      const k = S.rawT / 1.1;
      sweep.current.visible = k < 1 && p > 0.5;
      sweep.current.position.z = built.rowZ(0) - 0.4 + k * (built.rowZ(built.nRows - 1) - built.rowZ(0) + 0.8);
    }
    // the totals wall follows the same raw/harmonized state (simple ease)
    if (wallMesh) {
      const rawK = Math.min(1, S.rawT / 1.2) * S.last.raw + (1 - Math.min(1, S.rawT / 1.2)) * S.rawFrom;
      const flatK = S.last.flat;
      built.totals.forEach((t, i) => {
        const v = t.h + (t.r - t.h) * rawK;
        // in raw mode the wall steps aside: the towering blocks carry the message
        const h = Math.max(0.03, 4.2 * (v / built.tMax) * (1 - 0.95 * flatK) * (1 - 0.97 * rawK) * (1 - S.clay)) * p;
        tmpM.makeScale(1, h, 1).setPosition(colX(11) + 0.95, 0, built.rowZ(i));
        wallMesh.setMatrixAt(i, tmpM);
      });
      wallMesh.instanceMatrix.needsUpdate = true;
      (wallMesh.material as THREE.MeshStandardMaterial).opacity = p;
    }
  });

  if (!built) return null;
  const labels = station === "calendar" || (station === "take" as Station);
  const { g } = built;
  return (
    <group ref={group}>
      <primitive
        object={built.mesh}
        renderOrder={2}
        onPointerMove={(e: { instanceId?: number; stopPropagation: () => void }) => {
          if (presence.calendar < 0.5) return; // hidden stations never swallow the pointer
          e.stopPropagation();
          if (e.instanceId === undefined || station !== "calendar") return;
          const m = g.cells[e.instanceId]?.m.month ?? null;
          if (m !== useObs.getState().hoverMonth) set({ hoverMonth: m });
        }}
        onPointerOut={() => set({ hoverMonth: null })}
        onClick={(e: { instanceId?: number; stopPropagation: () => void }) => {
          if (presence.calendar < 0.5) return; // hidden stations never swallow the pointer
          e.stopPropagation();
          if (e.instanceId !== undefined && station === "calendar") set({ pinned: g.cells[e.instanceId].m.month });
        }}
      />
      {wallMesh && <primitive object={wallMesh} renderOrder={2} />}
      <mesh ref={sweep} visible={false}>
        <boxGeometry args={[COL_W * 12 + 1.2, 0.05, 0.08]} />
        <meshBasicMaterial color={valueMode === "raw" ? "#bfeeff" : "#ffd08a"} toneMapped={false} />
      </mesh>
      {valueMode === "harmonized" && station === "calendar" && (
        <>
          <Line renderOrder={4} points={built.med} color="#e8f1ff" lineWidth={1.6} transparent opacity={0.9} />
          <mesh geometry={built.bandGeo} renderOrder={3}>
            <meshBasicMaterial color="#9fc6ff" transparent opacity={0.16} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        </>
      )}
      {labels && station === "calendar" && (
        <>
          {MONTHS_SHORT.map((m, c) => (
            <Html key={m} position={[colX(c), 0, built.zFront + 0.55]} center zIndexRange={[12, 4]}>
              <span className="cal-lbl">{m[0]}{m.slice(1, 3)}</span>
            </Html>
          ))}
          {g.years.map((y, r) => (y % 5 === 0 || r === 0 || r === g.years.length - 1) && (
            <Html key={y} position={[colX(0) - 0.85, 0, built.rowZ(r)]} center zIndexRange={[12, 4]}>
              <span className={`cal-lbl yr ${y % 5 === 0 ? "major" : ""}`}>{y}</span>
            </Html>
          ))}
          {valueMode === "harmonized" && built.top3.map((y) => {
            const r = g.years.indexOf(y);
            const t = built.totals[r];
            return (
              <Html key={`t${y}`} position={[colX(11) + 2.1, 0.3, built.rowZ(r)]} center zIndexRange={[12, 4]}>
                <span className="rank-chip">
                  #{t.info?.rank} · {fmt(t.h)}
                </span>
              </Html>
            );
          })}

        </>
      )}
    </group>
  );
}
