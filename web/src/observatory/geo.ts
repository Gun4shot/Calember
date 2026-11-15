// Geometry shared by the globe, the satellites and the area stage.
// Convention (same as the film): y = north, lon 0 at +z, east toward +x. The globe is never rotated;
// the Earth's spin is expressed by rotating the sun and the orbital planes around it instead.

import { geoArea, geoBounds, geoContains } from "d3";
import * as THREE from "three";

export const R = 10; // globe radius in world units
export const KM = R / 6371; // world units per km
export const deg = Math.PI / 180;

export function latLonToVec(lat: number, lon: number, r = 1, out = new THREE.Vector3()) {
  const la = lat * deg;
  const lo = lon * deg;
  return out.set(Math.cos(la) * Math.sin(lo) * r, Math.sin(la) * r, Math.cos(la) * Math.cos(lo) * r);
}

export function vecToLatLon(v: THREE.Vector3): [number, number] {
  const n = v.clone().normalize();
  return [Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)) / deg, Math.atan2(n.x, n.z) / deg];
}

export const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(((lat2 - lat1) * deg) / 2) ** 2 + Math.cos(lat1 * deg) * Math.cos(lat2 * deg) * Math.sin(((lon2 - lon1) * deg) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Local frame at a point: x = east, y = up (surface normal), z = south (so a camera at +z looks north). */
export function localFrame(lat: number, lon: number) {
  const up = latLonToVec(lat, lon);
  let east = new THREE.Vector3(0, 1, 0).cross(up);
  if (east.lengthSq() < 1e-6) east = new THREE.Vector3(1, 0, 0);
  east.normalize();
  const north = up.clone().cross(east).normalize();
  const south = north.clone().negate();
  const m = new THREE.Matrix4().makeBasis(east, up, south);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return { up, east, north, q };
}

// ---------------- GeoJSON helpers ----------------
export type Ring = [number, number][];
export type Poly = Ring[]; // exterior + holes
export type Feature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, Record<string, unknown>>;

export function polysOf(g: GeoJSON.Geometry | null | undefined): Poly[] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates as Poly];
  if (g.type === "MultiPolygon") return g.coordinates as Poly[];
  return [];
}

/**
 * d3-geo needs spherical winding (exterior clockwise). GeoJSON files are often counter-clockwise, which d3
 * reads as "the whole Earth minus the polygon". Flip any polygon whose spherical area exceeds a hemisphere.
 */
export function fixWinding<T extends Feature>(f: T): T {
  const fix = (p: Poly): Poly => (geoArea({ type: "Polygon", coordinates: p }) > 2 * Math.PI ? p.map((r) => [...r].reverse()) : p);
  const g = f.geometry;
  if (g.type === "Polygon") g.coordinates = fix(g.coordinates as Poly);
  else g.coordinates = (g.coordinates as Poly[]).map(fix);
  return f;
}

export interface Indexed {
  f: Feature;
  bbox: [number, number, number, number];
  id: string;
  name: string;
}

export function indexFeatures(fc: GeoJSON.FeatureCollection, idOf: (p: Record<string, unknown>) => string, nameOf: (p: Record<string, unknown>) => string): Indexed[] {
  return (fc.features as Feature[])
    .filter((f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"))
    .map((f) => {
      fixWinding(f);
      const b = geoBounds(f);
      return { f, bbox: [b[0][0], b[0][1], b[1][0], b[1][1]] as [number, number, number, number], id: idOf(f.properties ?? {}), name: nameOf(f.properties ?? {}) };
    });
}

export function pick(list: Indexed[], lon: number, lat: number): Indexed | null {
  for (const it of list) {
    const [x0, y0, x1, y1] = it.bbox;
    if (lat < y0 - 0.01 || lat > y1 + 0.01) continue;
    // bounds that cross the antimeridian have x0 > x1
    const inLon = x0 <= x1 ? lon >= x0 - 0.01 && lon <= x1 + 0.01 : lon >= x0 || lon <= x1;
    if (!inLon) continue;
    if (geoContains(it.f, [lon, lat])) return it;
  }
  return null;
}

/** Outline rings of a geometry as arrays of 3D points just above the surface. */
export function ringsToSphere(polys: Poly[], r: number, minPts = 4): THREE.Vector3[][] {
  const out: THREE.Vector3[][] = [];
  for (const p of polys)
    for (const ring of p) {
      if (ring.length < minPts) continue;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        if (i > 0) {
          // subdivide long edges so the line hugs the sphere
          const [plon, plat] = ring[i - 1];
          const d = Math.hypot(lon - plon, lat - plat);
          const n = Math.min(24, Math.floor(d / 1.5));
          for (let k = 1; k <= n; k++) {
            const t = k / (n + 1);
            pts.push(latLonToVec(plat + (lat - plat) * t, plon + (wrapLon(lon - plon) * t), r));
          }
        }
        pts.push(latLonToVec(lat, lon, r));
      }
      out.push(pts);
    }
  return out;
}

/** Centroid-ish centre (bbox centre) of polygons, handling the antimeridian. */
export function centerOf(polys: Poly[]): [number, number] {
  const f: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: polys } };
  const b = geoBounds(f);
  let x0 = b[0][0];
  const x1 = b[1][0];
  if (x0 > x1) x0 -= 360;
  return [wrapLon((x0 + x1) / 2), (b[0][1] + b[1][1]) / 2];
}

/** Geodesic circle as a lon/lat ring. */
export function circleRing(lat: number, lon: number, radiusKm: number, n = 96): Ring {
  const out: Ring = [];
  const d = radiusKm / 6371;
  const la = lat * deg, lo = lon * deg;
  for (let i = 0; i <= n; i++) {
    const brg = (i / n) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(brg));
    const lon2 = lo + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat2));
    out.push([wrapLon(lon2 / deg), lat2 / deg]);
  }
  return out;
}

/**
 * Project lon/lat onto the local tangent plane at (lat0, lon0), in km (x east, z south).
 * Azimuthal equidistant: accurate enough for a stage floor, and continuous across the antimeridian.
 */
export function projectKm(lat0: number, lon0: number) {
  const la0 = lat0 * deg, lo0 = lon0 * deg;
  const s0 = Math.sin(la0), c0 = Math.cos(la0);
  return (lon: number, lat: number): [number, number] => {
    const la = lat * deg, lo = lon * deg;
    const cosc = s0 * Math.sin(la) + c0 * Math.cos(la) * Math.cos(lo - lo0);
    const c = Math.acos(THREE.MathUtils.clamp(cosc, -1, 1));
    const k = c < 1e-9 ? 1 : c / Math.sin(c);
    const x = k * Math.cos(la) * Math.sin(lo - lo0);
    const y = k * (c0 * Math.sin(la) - s0 * Math.cos(la) * Math.cos(lo - lo0));
    return [x * 6371, -y * 6371];
  };
}

/** Simplify a ring by dropping points closer than `minDeg` (cheap, keeps shape for lasso strokes). */
export function thinRing(ring: Ring, minDeg: number): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(wrapLon(p[0] - q[0]), p[1] - q[1]) >= minDeg) out.push(p);
  }
  return out;
}
