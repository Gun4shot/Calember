// Small, allocation-free helpers. Everything in the film is a pure function of the
// playhead t, so these must be deterministic (no Date.now, no accumulated state).

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const invLerp = (a: number, b: number, x: number) => clamp((x - a) / (b - a));
export const smooth = (x: number) => {
  const k = clamp(x);
  return k * k * (3 - 2 * k);
};
export const smoother = (x: number) => {
  const k = clamp(x);
  return k * k * k * (k * (k * 6 - 15) + 10);
};
/** 0→1 between a and b with smoothstep easing. */
export const ramp = (a: number, b: number, x: number) => smooth(invLerp(a, b, x));
/** fades in over [a,b], holds, fades out over [c,d]. */
export const window4 = (a: number, b: number, c: number, d: number, x: number) =>
  Math.min(ramp(a, b, x), 1 - ramp(c, d, x));

/**
 * Analytic under-damped spring step response: 0 at tau<=0, overshoots, settles at 1.
 * Reversible because it only depends on tau (time since trigger), never on history.
 */
export function spring(tau: number, omega = 18, zeta = 0.38): number {
  if (tau <= 0) return 0;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * tau) * (Math.cos(wd * tau) + ((zeta * omega) / wd) * Math.sin(wd * tau));
}

export const deg = Math.PI / 180;

/** lat/lon (deg) → unit vector, three.js convention (y up, lon 0 at +z, east toward +x). */
export function latLonToVec(lat: number, lon: number, out: [number, number, number] = [0, 0, 0]) {
  const la = lat * deg;
  const lo = lon * deg;
  out[0] = Math.cos(la) * Math.sin(lo);
  out[1] = Math.sin(la);
  out[2] = Math.cos(la) * Math.cos(lo);
  return out;
}

/** Deterministic hash → [0,1). */
export function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
