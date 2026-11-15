// Country hairlines (and province lines when close), plus glowing outlines for the hovered place, the
// candidate and the acquired area.
import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { type Indexed, type Poly, R, polysOf, ringsToSphere } from "../geo";
import { loadAdmin0, loadAdmin1 } from "../data";
import { cam } from "../world/camera";
import { useObs } from "../store";

function segmentsOf(list: Indexed[], r: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const it of list)
    for (const ring of ringsToSphere(polysOf(it.f.geometry), r, 3))
      for (let i = 1; i < ring.length; i++) pos.push(ring[i - 1].x, ring[i - 1].y, ring[i - 1].z, ring[i].x, ring[i].y, ring[i].z);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** Flat list of segment endpoints for drei <Line segments>. */
export function outlinePoints(polys: Poly[], r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (const ring of ringsToSphere(polys, r, 3)) for (let i = 1; i < ring.length; i++) pts.push(ring[i - 1], ring[i]);
  return pts;
}

export function Borders() {
  const [a0, setA0] = useState<THREE.BufferGeometry | null>(null);
  const [a1, setA1] = useState<THREE.BufferGeometry | null>(null);
  const m1 = useRef<THREE.LineBasicMaterial>(null);
  const m0 = useRef<THREE.LineBasicMaterial>(null);
  useEffect(() => {
    let alive = true;
    loadAdmin0().then((l) => alive && setA0(segmentsOf(l, R * 1.0012)), () => undefined);
    // provinces load in the background (4 MB)
    const id = window.setTimeout(() => loadAdmin1().then((l) => alive && setA1(segmentsOf(l, R * 1.001)), () => undefined), 1500);
    return () => { alive = false; window.clearTimeout(id); };
  }, []);
  useFrame(() => {
    const close = THREE.MathUtils.clamp((R * 2.3 - cam.dist) / (R * 0.8), 0, 1);
    if (m1.current) m1.current.opacity = cam.mode === "globe" ? 0.16 * close : 0.05;
    if (m0.current) m0.current.opacity = cam.mode === "globe" ? 0.2 : 0.07;
  });
  return (
    <>
      {a0 && (
        <lineSegments geometry={a0} renderOrder={2}>
          <lineBasicMaterial ref={m0} color="#6f8fc8" transparent opacity={0.2} depthWrite={false} />
        </lineSegments>
      )}
      {a1 && (
        <lineSegments geometry={a1} renderOrder={2}>
          <lineBasicMaterial ref={m1} color="#5d77a6" transparent opacity={0} depthWrite={false} />
        </lineSegments>
      )}
      <Highlights />
    </>
  );
}

function Glow({ polys, color, width, pulse = false }: { polys: Poly[]; color: string; width: number; pulse?: boolean }) {
  const pts = useMemo(() => outlinePoints(polys, R * 1.003), [polys]);
  const ref = useRef<{ material: { opacity: number; linewidth: number } } | null>(null);
  useFrame((st) => {
    if (!ref.current) return;
    if (pulse) ref.current.material.opacity = 0.65 + 0.35 * Math.sin(st.clock.elapsedTime * 4);
  });
  if (pts.length < 2) return null;
  return (
    <>
      <Line ref={ref as never} points={pts} segments color={color} lineWidth={width} transparent opacity={0.95} depthWrite={false} renderOrder={7} />
      <Line points={pts} segments color={color} lineWidth={width * 4} transparent opacity={0.12} depthWrite={false} renderOrder={7} />
    </>
  );
}

function Highlights() {
  const hoverPolys = useObs((s) => s.hoverPolys);
  const cand = useObs((s) => s.candidate);
  const shape = useObs((s) => s.shape);
  const view = useObs((s) => s.view);
  return (
    <>
      {hoverPolys && view === "globe" && <Glow polys={hoverPolys} color="#9fc6ff" width={1.2} />}
      {cand && cand.polys.length > 0 && <Glow polys={cand.polys} color="#ffd37a" width={2} pulse />}
      {shape && shape.polys.length > 0 && view !== "globe" && <Glow polys={shape.polys} color="#ffb347" width={1.6} />}
    </>
  );
}
