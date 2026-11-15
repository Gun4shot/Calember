// GLSL shared by the Observatory scene.
export { INFERNO, HASH } from "../../film/glsl";

/** Orbit model, identical to sats/orbit.ts (Earth-fixed frame, y = north, lon 0 at +z). */
export const ORBIT = /* glsl */ `
vec3 orbitPos(float t, float raan, float incl, float phase, float period, float day) {
  float u = phase + 6.2831853 * t / period;
  vec3 n = vec3(sin(raan), 0.0, cos(raan));
  vec3 e = vec3(cos(raan), 0.0, -sin(raan));
  vec3 p = cos(u) * n + sin(u) * (cos(incl) * e + sin(incl) * vec3(0.0, 1.0, 0.0));
  float th = 6.2831853 * t / day;
  float c = cos(th), s = sin(th);
  return vec3(p.x * c - p.z * s, p.y, p.z * c + p.x * s);
}
`;

/** Category colours (anomaly classes 1..6) as a GLSL lookup. Mirrors format.ts CATEGORY_COLOR, brightened for 3D. */
export const CATEGORY_GLSL = /* glsl */ `
vec3 catColor(float k) {
  if (k < 1.5) return vec3(0.18, 0.43, 0.85);   // much below
  if (k < 2.5) return vec3(0.42, 0.64, 0.86);   // below
  if (k < 3.5) return vec3(0.45, 0.47, 0.52);   // normal
  if (k < 4.5) return vec3(0.98, 0.64, 0.37);   // above
  if (k < 5.5) return vec3(0.95, 0.35, 0.18);   // much above
  return vec3(1.0, 0.92, 0.55);                 // record
}
`;
