// Pointer input on the 3D world: orbit the globe, hover/click countries and provinces, lasso and circle tools,
// and orbiting the area stage.
import { Line } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ApiFailure, api } from "../../app/api";
import { loadAdmin0, loadAdmin1 } from "../data";
import { type Indexed, R, type Ring, centerOf, circleRing, haversineKm, latLonToVec, pick, polysOf, thinRing, vecToLatLon } from "../geo";
import { type Candidate, useObs } from "../store";
import { MAX_DIST, MIN_DIST, cam, flyTo } from "../world/camera";

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** Ray–sphere hit in world space (the globe sits at the origin, unrotated). */
function hitGlobe(camera: THREE.Camera, x: number, y: number, el: HTMLElement): THREE.Vector3 | null {
  const r = el.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  const b = o.dot(d), c = o.lengthSq() - R * R, disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? o.clone().addScaledVector(d, t) : null;
}

export function candidateFromAdmin(it: Indexed, kind: string): Candidate {
  const polys = polysOf(it.f.geometry);
  return { name: it.name, kind, polys, center: centerOf(polys), request: () => api.areaByAdmin(it.id), linkId: it.id };
}

export function Pickers() {
  const { camera, gl } = useThree();
  const [lasso, setLasso] = useState<THREE.Vector3[]>([]);
  const [circle, setCircle] = useState<{ lat: number; lon: number; km: number } | null>(null);
  const a0 = useRef<Indexed[] | null>(null);
  const a1 = useRef<Indexed[] | null>(null);
  useEffect(() => {
    loadAdmin0().then((l) => (a0.current = l), () => undefined);
    const id = window.setTimeout(() => loadAdmin1().then((l) => (a1.current = l), () => undefined), 1500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number; t: number; moved: boolean } | null = null;
    let last = { x: 0, y: 0, t: 0 };
    let ring: Ring = [];
    let circ: { lat: number; lon: number; km: number } | null = null;
    let hoverId: string | null = null;
    let lastHover = 0;

    const pickAt = (x: number, y: number): { it: Indexed; kind: string } | null => {
      const p = hitGlobe(camera, x, y, el);
      if (!p) return null;
      const [lat, lon] = vecToLatLon(p);
      const close = cam.dist < R * 2.05;
      if (close && a1.current) {
        const it = pick(a1.current, lon, lat);
        if (it) return { it, kind: "Province" };
      }
      if (a0.current) {
        const it = pick(a0.current, lon, lat);
        if (it) return { it, kind: "Country" };
      }
      return null;
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const st = useObs.getState();
      if (st.mapMode !== "off") return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      last = { x: e.clientX, y: e.clientY, t: performance.now() };
      cam.lastInteract = performance.now() / 1000;
      cam.fly = null;
      if (st.view === "globe" && st.tool !== "none") {
        const p = hitGlobe(camera, e.clientX, e.clientY, el);
        if (!p) return;
        el.setPointerCapture(e.pointerId);
        const [lat, lon] = vecToLatLon(p);
        if (st.tool === "lasso") {
          ring = [[lon, lat]];
          setLasso([p.clone().setLength(R * 1.004)]);
        } else {
          circ = { lat, lon, km: 0 };
          setCircle(circ);
        }
        st.set({ candidate: null, error: null });
        return;
      }
      el.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const st = useObs.getState();
      if (down) {
        const dx = e.clientX - last.x, dy = e.clientY - last.y;
        const now = performance.now();
        const dtm = Math.max(1, now - last.t) / 1000;
        last = { x: e.clientX, y: e.clientY, t: now };
        if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
        if (st.view === "globe" && st.tool === "lasso" && ring.length) {
          const p = hitGlobe(camera, e.clientX, e.clientY, el);
          if (p) {
            const [lat, lon] = vecToLatLon(p);
            const q = ring[ring.length - 1];
            if (Math.hypot(lon - q[0], lat - q[1]) > 0.08 * (cam.dist / R)) {
              ring.push([lon, lat]);
              setLasso((prev) => [...prev, p.clone().setLength(R * 1.004)]);
            }
          }
          return;
        }
        if (st.view === "globe" && st.tool === "circle" && circ) {
          const p = hitGlobe(camera, e.clientX, e.clientY, el);
          if (p) {
            const [lat, lon] = vecToLatLon(p);
            circ = { ...circ, km: haversineKm(circ.lat, circ.lon, lat, lon) };
            setCircle(circ);
          }
          return;
        }
        const globeLike = st.view === "globe" || (st.view === "area" && st.station === "twins" && cam.mode === "globe");
        if (globeLike) {
          const k = ((cam.dist - R) / R) * 0.16;
          cam.lon -= dx * k;
          cam.lat = THREE.MathUtils.clamp(cam.lat + dy * k, -75, 80);
          // fling speed, capped so a fast flick (or a stalled frame) can't spin the planet away
          const vmax = 40 * (cam.dist / R);
          cam.vLon = THREE.MathUtils.clamp((-dx * k) / dtm, -vmax, vmax);
          cam.vLat = THREE.MathUtils.clamp((dy * k) / dtm, -vmax * 0.6, vmax * 0.6);
          cam.lastInteract = now / 1000;
        } else if (st.view === "area") {
          cam.sAz = THREE.MathUtils.clamp(cam.sAz - dx * 0.006, -1.6, 1.6);
          cam.sEl = THREE.MathUtils.clamp(cam.sEl + dy * 0.004, -0.35, 0.9);
        }
        return;
      }
      // hover (throttled)
      if (st.view !== "globe" || st.tool !== "none") return;
      const now = performance.now();
      if (now - lastHover < 50) return;
      lastHover = now;
      const hit = pickAt(e.clientX, e.clientY);
      const id = hit?.it.id ?? null;
      el.style.cursor = hit ? "pointer" : "grab";
      if (id !== hoverId) {
        hoverId = id;
        st.set({ hoverName: hit ? hit.it.name : null, hoverPolys: hit ? polysOf(hit.it.f.geometry) : null });
      }
    };

    const onUp = (e: PointerEvent) => {
      const st = useObs.getState();
      const d = down;
      down = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (!d) return;
      if (st.view === "globe" && st.tool === "lasso" && ring.length) {
        const r = thinRing(ring, 0.05);
        ring = [];
        if (r.length < 4) {
          setLasso([]);
          return;
        }
        const closed: Ring = [...r, r[0]];
        const c: Candidate = {
          name: "Drawn area",
          kind: "Drawn area",
          polys: [[closed]],
          center: centerOf([[closed]]),
          request: () => api.areaByPolygon(r),
        };
        resolveEarly(c);
        setLasso([]);
        return;
      }
      if (st.view === "globe" && st.tool === "circle" && circ) {
        const cc = circ;
        circ = null;
        setCircle(null);
        const km = Math.max(15, Math.round(cc.km));
        const ringC = circleRing(cc.lat, cc.lon, km);
        const c: Candidate = {
          name: `${km} km around ${cc.lat.toFixed(2)}°, ${cc.lon.toFixed(2)}°`,
          kind: "Circle",
          polys: [[ringC]],
          center: [cc.lon, cc.lat],
          request: () => api.areaByCircle(cc.lat, cc.lon, km),
        };
        resolveEarly(c);
        return;
      }
      if (!d.moved && st.view === "globe" && st.tool === "none") {
        const hit = pickAt(e.clientX, e.clientY);
        if (hit) {
          const c = candidateFromAdmin(hit.it, hit.kind);
          st.set({ candidate: c, error: null });
          flyTo(c.center[1], c.center[0], Math.min(cam.dist, hit.kind === "Province" ? R * 2.0 : R * 2.7), 1.2);
        } else st.set({ candidate: null });
      }
    };

    const onWheel = (e: WheelEvent) => {
      const st = useObs.getState();
      if (st.view === "globe" || (st.view === "area" && st.station === "twins" && cam.mode === "globe")) {
        e.preventDefault();
        cam.fly = null;
        cam.dist = THREE.MathUtils.clamp(cam.dist * Math.exp(e.deltaY * 0.0011), MIN_DIST, MAX_DIST);
        cam.lastInteract = performance.now() / 1000;
      } else if (st.view === "area" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        cam.sZoom = THREE.MathUtils.clamp(cam.sZoom * Math.exp(e.deltaY * 0.0012), 0.55, 1.8);
      }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.style.cursor = "grab";
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [camera, gl]);

  const circlePts = useMemo(() => (circle && circle.km > 1 ? circleRing(circle.lat, circle.lon, circle.km, 128).map(([lo, la]) => latLonToVec(la, lo, R * 1.004)) : null), [circle]);

  return (
    <>
      {lasso.length > 1 && <Line points={lasso} color="#ffd37a" lineWidth={2.6} transparent opacity={0.95} depthWrite={false} renderOrder={9} />}
      {lasso.length > 1 && <Line points={lasso} color="#ff8a3d" lineWidth={9} transparent opacity={0.18} depthWrite={false} renderOrder={9} />}
      {circlePts && <Line points={circlePts} color="#ffd37a" lineWidth={2.4} transparent opacity={0.95} depthWrite={false} renderOrder={9} />}
      {circlePts && <Line points={circlePts} color="#ff8a3d" lineWidth={10} transparent opacity={0.16} depthWrite={false} renderOrder={9} />}
    </>
  );
}

/** Drawn shapes are resolved right away, so the chip can show their size and errors before acquiring. */
export function resolveEarly(c: Candidate) {
  const st = useObs.getState();
  st.set({ candidate: { ...c, name: c.name }, tool: "none", error: null });
  // a drawn shape is named after the province (or country) at its centre, not just its coordinates
  void placeAt(c.center[0], c.center[1]).then((where) => {
    const cur = useObs.getState().candidate;
    if (!where || !cur || cur.polys !== c.polys) return;
    const km = /^(\d[\d,.]*) km around/.exec(c.name)?.[1];
    const name = c.kind === "Circle" && km ? `${km} km circle in ${where}` : `Drawn area in ${where}`;
    useObs.setState({ candidate: { ...cur, name } });
  });
  c.request().then(
    (area) => {
      const cur = useObs.getState().candidate;
      if (cur && cur.polys === c.polys) useObs.setState({ candidate: { ...cur, area } });
    },
    (e) => {
      const cur = useObs.getState().candidate;
      if (cur && cur.polys === c.polys) useObs.setState({ candidate: null, error: e instanceof ApiFailure ? e.message : String(e) });
    },
  );
}

/** "Bagmati, Nepal" for a point on land (province first, then country), or null over the sea. */
async function placeAt(lon: number, lat: number): Promise<string | null> {
  try {
    const p = pick(await loadAdmin1(), lon, lat);
    if (p) return p.name;
    const c = pick(await loadAdmin0(), lon, lat);
    return c ? c.name : null;
  } catch {
    return null;
  }
}
