// Numerical helpers that match numpy / scipy / Python behaviour, so the browser engine gives the API's numbers.

/** numpy.percentile (linear interpolation) */
export function percentile(xs: ArrayLike<number>, q: number): number {
  const n = xs.length;
  if (!n) return NaN;
  const s = Array.from(xs).sort((a, b) => a - b);
  const k = ((n - 1) * q) / 100;
  const f = Math.floor(k), c = Math.min(n - 1, f + 1);
  return s[f] + (s[c] - s[f]) * (k - f);
}
export const median = (xs: ArrayLike<number>) => percentile(xs, 50);
export const mean = (xs: ArrayLike<number>) => {
  let t = 0;
  for (let i = 0; i < xs.length; i++) t += xs[i];
  return t / xs.length;
};
/** numpy std (population) */
export function std(xs: ArrayLike<number>): number {
  const m = mean(xs);
  let t = 0;
  for (let i = 0; i < xs.length; i++) t += (xs[i] - m) ** 2;
  return Math.sqrt(t / xs.length);
}
/** first index of the maximum (numpy argmax) */
export function argmax(xs: ArrayLike<number>): number {
  let k = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[k]) k = i;
  return k;
}

// ---------------- Python rounding and formatting ----------------
/** Exact decimal expansion of a double with `digits` fraction digits (no rounding beyond the exact value's digits). */
function exactDigits(x: number): string {
  return Math.abs(x).toFixed(100).replace(/0+$/, "");
}
/** Python's round(x, nd): correctly rounded, ties to even on the exact binary value. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  const s = pyFixed(x, nd);
  return Number(s);
}
/** Python's f"{x:.{nd}f}" */
export function pyFixed(x: number, nd: number): string {
  if (!Number.isFinite(x)) return String(x);
  const ex = exactDigits(x);
  const dot = ex.indexOf(".");
  const ip = dot < 0 ? ex : ex.slice(0, dot);
  const fp = dot < 0 ? "" : ex.slice(dot + 1);
  const keep = (fp + "0".repeat(nd)).slice(0, nd);
  const rest = fp.slice(nd);
  let digits = (ip + keep).split("").map(Number);
  let up = false;
  if (rest.length) {
    if (rest[0] > "5") up = true;
    else if (rest[0] === "5") {
      up = /[1-9]/.test(rest.slice(1)) ? true : digits[digits.length - 1] % 2 === 1; // exact tie -> even
    }
  }
  if (up) {
    let i = digits.length - 1;
    while (i >= 0) {
      if (digits[i] === 9) {
        digits[i] = 0;
        i--;
      } else {
        digits[i]++;
        break;
      }
    }
    if (i < 0) digits = [1, ...digits];
  }
  const all = digits.join("");
  const intPart = all.slice(0, all.length - nd) || "0";
  const frac = nd ? "." + all.slice(all.length - nd) : "";
  const neg = x < 0 && /[1-9]/.test(all);
  return (neg ? "-" : "") + intPart.replace(/^0+(?=\d)/, "") + frac;
}
/** Python's repr() of a float (shortest round-trip form: "1.0", "0.25", "1e-05"). */
export function pyRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const a = Math.abs(x);
  if (a >= 1e16 || a < 1e-4) {
    // Python switches to exponent form outside [1e-4, 1e16)
    const [m, e] = x.toExponential().split("e");
    const ev = Number(e);
    return `${m}e${ev < 0 ? "-" : "+"}${String(Math.abs(ev)).padStart(2, "0")}`;
  }
  const s = String(x);
  if (s.includes("e")) return x.toFixed(20).replace(/0+$/, "");
  return Number.isInteger(x) ? `${s}.0` : s;
}
/** Python's f"{x:,.0f}" */
export function pyComma0(x: number): string {
  const s = pyFixed(x, 0);
  const neg = s.startsWith("-");
  const d = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + d.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** round(float(v), nd) or null (the API's _r) */
export const r = (v: number | null | undefined, nd = 3): number | null => (v === null || v === undefined || Number.isNaN(v) ? null : pyRound(v, nd));

// ---------------- trend statistics (scipy.stats) ----------------
/** scipy.stats.theilslopes(y, x)[0] */
export function theilSlope(y: ArrayLike<number>, x: ArrayLike<number>): number {
  const s: number[] = [];
  for (let i = 0; i < x.length; i++)
    for (let j = 0; j < x.length; j++) {
      const dx = x[i] - x[j];
      if (dx > 0) s.push((y[i] - y[j]) / dx);
    }
  return median(s);
}

function erfc(x: number): number {
  // Numerical Recipes erfcc (Chebyshev fit, fractional error < 1.2e-7 everywhere): ample for p-values shown to 3 decimals
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}
const normSf = (z: number) => 0.5 * erfc(z / Math.SQRT2);

function factorial(n: number) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
/** scipy.stats._mstats_basic._kendall_p_exact, two-sided */
function kendallPExact(n: number, cIn: number): number {
  const tot = Math.floor((n * (n - 1)) / 2);
  const c = Math.min(cIn, tot - cIn);
  let prob: number;
  if (n <= 2) prob = 1;
  else if (c === 0) prob = n < 171 ? 2 / factorial(n) : 0;
  else if (c === 1) prob = n < 172 ? 2 / factorial(n - 1) : 0;
  else if (4 * c === n * (n - 1)) prob = 1;
  else {
    let cur = new Float64Array(c + 1);
    cur[0] = 1;
    cur[1] = 1;
    for (let j = 3; j <= n; j++) {
      const cs = new Float64Array(c + 1);
      let run = 0;
      for (let i = 0; i <= c; i++) cs[i] = run += cur[i];
      if (j <= c) for (let i = c; i >= j; i--) cs[i] -= cs[i - j];
      cur = cs;
    }
    let s = 0;
    for (let i = 0; i <= c; i++) s += cur[i];
    prob = (2 * s) / factorial(n);
  }
  return Math.min(1, Math.max(0, prob));
}

/** scipy.stats.kendalltau(x, y).pvalue (method 'auto', two-sided, tau-b) */
export function kendallP(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = x.length;
  let dis = 0, ntie = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = Math.sign(x[i] - x[j]), b = Math.sign(y[i] - y[j]);
      if (a * b < 0) dis++;
      if (a === 0 && b === 0) ntie++;
    }
  const ties = (v: ArrayLike<number>) => {
    const cnt = new Map<number, number>();
    for (let i = 0; i < v.length; i++) cnt.set(v[i], (cnt.get(v[i]) ?? 0) + 1);
    let t = 0, t0 = 0, t1 = 0;
    for (const c of cnt.values())
      if (c > 1) {
        t += (c * (c - 1)) / 2;
        t0 += c * (c - 1) * (c - 2);
        t1 += c * (c - 1) * (2 * c + 5);
      }
    return [t, t0, t1];
  };
  const [xtie, x0, x1] = ties(x), [ytie, y0, y1] = ties(y);
  const tot = (n * (n - 1)) / 2;
  if (xtie === tot || ytie === tot) return NaN;
  const conMinusDis = tot - xtie - ytie + ntie - 2 * dis;
  if (xtie === 0 && ytie === 0 && (n <= 33 || Math.min(dis, tot - dis) <= 1)) return kendallPExact(n, tot - dis);
  const m = n * (n - 1);
  const v = (m * (2 * n + 5) - x1 - y1) / 18 + (2 * xtie * ytie) / m + (x0 * y0) / (9 * m * (n - 2));
  const z = conMinusDis / Math.sqrt(v);
  return Math.min(1, 2 * normSf(Math.abs(z)));
}

/** fetch with two retries on a dropped connection or a 5xx (slow mobile data, a CDN hiccup); a 404 is returned as is */
export async function fetchRetry(url: string, tries = 3): Promise<Response> {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url);
      if (r.status < 500 || k >= tries) return r;
    } catch (e) {
      if (k >= tries) throw e;
    }
    await new Promise((ok) => setTimeout(ok, 400 * k));
  }
}
