// World layout. The globe sits below the origin with Punjab at its top (+Y), so the
// camera can descend from orbit straight onto the field at the origin without a cut.

import * as THREE from "three";
import { latLonToVec } from "./math";

export const R = 40; // globe radius (world units; on the ground 1 unit ≈ 1 km)
export const GLOBE_CENTER = new THREE.Vector3(0, -R, 0);
export const PUNJAB = { lat: 30.6, lon: 75.6 };

const v = latLonToVec(PUNJAB.lat, PUNJAB.lon);
/** Rotation that carries Punjab's surface normal to +Y. */
export const GLOBE_Q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(v[0], v[1], v[2]), new THREE.Vector3(0, 1, 0));

/** World-space unit direction of a lat/lon after the globe rotation. */
export function dirOf(lat: number, lon: number): THREE.Vector3 {
  const p = latLonToVec(lat, lon);
  return new THREE.Vector3(p[0], p[1], p[2]).applyQuaternion(GLOBE_Q);
}
/** The globe's north axis in world space (camera "up" while in orbit). */
export const NORTH = new THREE.Vector3(0, 1, 0).applyQuaternion(GLOBE_Q);

// Ridge layout
export const MONTH_W = 0.1; // world units per month along x
export const RIDGE_H = 6; // height of the tallest raw month (before y-rescale)
export const ROW_GAP = 1.5;

// Ground pixel beat layout (1 unit = 1 km)
export const FIRE_RECT = { x0: 0.1, x1: 0.85, z0: 0.15, z1: 0.6 };
