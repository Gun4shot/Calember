// The area stage's coordinate frame. The stage floats above the area in low orbit (x = east, y = up, z = south),
// so the planet's limb curves away beneath it. Local units: the floor tile spans ~14 units.
import * as THREE from "three";
import { KM, type Poly, R, localFrame, projectKm } from "../geo";

export const ALT = 1.55; // stage height above the surface (world units)
export const S = 0.06; // world units per local unit
export const TILE = 14; // local width of the floor tile

export interface StageFrame {
  lat: number;
  lon: number;
  q: THREE.Quaternion;
  up: THREE.Vector3;
  origin: THREE.Vector3; // final stage position (world)
  surface: THREE.Vector3; // the area on the surface (world)
  kmPerUnit: number; // km per local unit on the floor
  geoScale: number; // group scale that makes the tile overlay the real area on the globe
  toLocal: (lon: number, lat: number) => [number, number]; // lon/lat → local x, z
  shapes: Array<Array<[number, number]>>; // exterior rings in local x, z
}

export function makeFrame(center: [number, number], polys: Poly[]): StageFrame {
  const [lon, lat] = center;
  const f = localFrame(lat, lon);
  const proj = projectKm(lat, lon);
  // extent of the outline in km
  let maxKm = 0;
  const kmRings: Array<Array<[number, number]>> = [];
  for (const p of polys) {
    const ext = p[0];
    if (!ext || ext.length < 4) continue;
    const r = ext.map(([lo, la]) => proj(lo, la));
    kmRings.push(r);
  }
  // drop tiny islands far away (keeps the tile readable for big countries)
  let bigArea = 0;
  const areas = kmRings.map((r) => Math.abs(ringArea(r)));
  for (const a of areas) bigArea = Math.max(bigArea, a);
  const kept = kmRings.filter((_, i) => areas[i] > bigArea * 0.004);
  let cx = 0, cz = 0, n = 0;
  for (const r of kept) for (const [x, z] of r) { cx += x; cz += z; n++; }
  // centre the tile on the outline's bbox centre
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of kept) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  if (!n) { x0 = -300; x1 = 300; z0 = -300; z1 = 300; }
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  maxKm = Math.max(x1 - x0, z1 - z0, 30);
  const kmPerUnit = maxKm / TILE;
  const shapes = kept.map((r) => r.map(([x, z]) => [(x - mx) / kmPerUnit, (z - mz) / kmPerUnit] as [number, number]));
  const toLocal = (lo: number, la: number): [number, number] => {
    const [x, z] = proj(lo, la);
    return [(x - mx) / kmPerUnit, (z - mz) / kmPerUnit];
  };
  const up = f.up.clone();
  // the stage hovers over the outline's centre, not the bbox centre of lon/lat
  const surface = up.clone().multiplyScalar(R * 1.001);
  const east = f.east.clone(), south = f.north.clone().negate();
  surface.addScaledVector(east, mx * KM).addScaledVector(south, mz * KM);
  const origin = up.clone().multiplyScalar(R + ALT).addScaledVector(east, mx * KM).addScaledVector(south, mz * KM);
  return { lat, lon, q: f.q, up, origin, surface, kmPerUnit, geoScale: kmPerUnit * KM, toLocal, shapes };
}

function ringArea(r: Array<[number, number]>) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return a / 2;
}

/** Local stage point → world. */
export function toWorld(fr: StageFrame, local: THREE.Vector3, out = new THREE.Vector3()) {
  return out.copy(local).multiplyScalar(S).applyQuaternion(fr.q).add(fr.origin);
}

/** Camera pose for a station, in local coordinates. */
export interface LocalPose {
  pos: [number, number, number];
  target: [number, number, number];
  topDown?: boolean;
}
export const STATION_POSE: Record<string, LocalPose> = {
  verdict: { pos: [0, 8.5, 25], target: [0, 3.2, -1.5] },
  terrain: { pos: [0, 19, 19], target: [0, 0.4, 0.5] },
  calendar: { pos: [-4, 13.5, 18], target: [0.8, 0.6, 0.6] },
  calendarRaw: { pos: [-7, 21, 30], target: [0.8, 3.4, 0.2] },
  calendarFlat: { pos: [0.9, 27.5, 0.75], target: [0.9, 0, 0.75], topDown: true },
  season: { pos: [0, 30, 15], target: [0, 0, 1.2] },
  helix: { pos: [0, 12, 30], target: [0, 5.2, 0] },
  take: { pos: [10, 15, 22], target: [0.4, 0.8, 0] },
};

export const easeOutCubic = (k: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
export const easeInOut = (k: number) => {
  const x = Math.min(1, Math.max(0, k));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export function elastic(k: number) {
  const x = Math.min(1, Math.max(0, k));
  if (x === 0 || x === 1) return x;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}
