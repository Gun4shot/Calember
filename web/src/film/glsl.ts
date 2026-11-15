// Shared GLSL snippets.

/** Polynomial fit of matplotlib's inferno (mattz, CC0). Input clipped to [0.08, 0.98] by callers. */
export const INFERNO = /* glsl */ `
vec3 inferno(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
  const vec3 c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
  const vec3 c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
  const vec3 c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
  const vec3 c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
  const vec3 c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
  const vec3 c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}
`;

/** Analytic spring (same as math.ts) so GPU animation is reversible with the scroll. */
export const SPRING = /* glsl */ `
float springK(float tau, float omega, float zeta) {
  if (tau <= 0.0) return 0.0;
  float wd = omega * sqrt(1.0 - zeta * zeta);
  return 1.0 - exp(-zeta * omega * tau) * (cos(wd * tau) + (zeta * omega / wd) * sin(wd * tau));
}
`;

export const HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`;

/** Semantic colours (linear-ish sRGB values used in shaders). */
export const COLORS = {
  ice: [0.62, 0.8, 1.0] as const, // VIIRS
  amber: [1.0, 0.56, 0.24] as const, // MODIS / MEH
  night: [0.02, 0.027, 0.05] as const,
};
