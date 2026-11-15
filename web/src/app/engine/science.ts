// The API's area statistics (science/ember_science, api/ember_api/main.py), ported to the browser for drawn areas.
// Every function mirrors its Python counterpart; the comments name it.
import type { Calendar, CalendarMonth, CalendarYear, Category, Climatology, Season, SeasonYear, Trend } from "../types";
import { argmax, kendallP, mean, median, percentile, pyComma0, pyFixed, pyRepr, pyRound, r, std, theilSlope } from "./stats";

export const Z90 = 1.645;
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MONTHS3 = MONTH_NAMES.map((m) => m.slice(0, 3));

export interface Bounds {
  much_below: number;
  below: number;
  above: number;
  much_above: number;
}

/** One month of an area (ember_science.area_monthly output). */
export interface MonthRow {
  month: string;
  regime: string;
  h: number;
  sd: number;
  raw: [number, number, number, number];
  provisional: boolean;
  outage: boolean;
  fill: number;
}

export function monthList(a: string, b: string): string[] {
  const out: string[] = [];
  let y = +a.slice(0, 4), m = +a.slice(5, 7);
  while (`${y}-${String(m).padStart(2, "0")}` <= b) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) (m = 1), y++;
  }
  return out;
}
export const regimeOf = (m: string) => (m <= "2002-06" ? "T" : m <= "2011-12" ? "M" : m <= "2019-12" ? "B" : m <= "2026-07" ? "V" : "N");

/** ember_science._category */
export function category(pct: number | null, x: number, smax: number | null, b: Bounds): Category | null {
  if (pct === null) return null;
  if (smax !== null && x > smax && x > 0) return "record";
  if (pct < b.much_below) return "much_below";
  if (pct < b.below) return "below";
  if (pct > b.much_above) return "much_above";
  if (pct > b.above) return "above";
  return "normal";
}

interface Anom {
  median_m: number | null;
  ratio_to_median: number | null;
  pct_rank: number | null;
  robust_z: number | null;
  category: Category | null;
}
/** ember_science.anomalies: the baseline excludes the row's own year. */
export function anomalies(rows: { month: string; h: number }[], baseline: [number, number], bounds: Bounds): Anom[] {
  const pools: { y: number; v: number }[][] = Array.from({ length: 13 }, () => []);
  for (const x of rows) {
    const y = +x.month.slice(0, 4);
    if (y >= baseline[0] && y <= baseline[1]) pools[+x.month.slice(5, 7)].push({ y, v: x.h });
  }
  return rows.map((x) => {
    const y = +x.month.slice(0, 4);
    const s = pools[+x.month.slice(5, 7)].filter((p) => p.y !== y).map((p) => p.v);
    if (!s.length) return { median_m: null, ratio_to_median: null, pct_rank: null, robust_z: null, category: null };
    const med = median(s);
    const pct = (100 * (s.filter((v) => v < x.h).length + 0.5 * s.filter((v) => v === x.h).length)) / s.length;
    const ls = s.map(Math.log1p);
    const ml = median(ls);
    const mad = median(ls.map((v) => Math.abs(v - ml)));
    return {
      median_m: med,
      ratio_to_median: med > 0 ? x.h / med : null,
      pct_rank: pct,
      robust_z: mad > 0 ? (Math.log1p(x.h) - ml) / (1.4826 * mad) : null,
      category: category(pct, x.h, Math.max(...s), bounds),
    };
  });
}

/** ember_science.climatology (unrounded) */
export function climatology(rows: { month: string; h: number }[], baseline: [number, number]) {
  return Array.from({ length: 12 }, (_, i) => {
    const v = rows.filter((x) => +x.month.slice(5, 7) === i + 1 && +x.month.slice(0, 4) >= baseline[0] && +x.month.slice(0, 4) <= baseline[1]).map((x) => x.h);
    if (!v.length) return { month_num: i + 1, median: null, p10: null, p25: null, p75: null, p90: null, mean: null, n_years: 0 };
    return { month_num: i + 1, median: percentile(v, 50), p10: percentile(v, 10), p25: percentile(v, 25), p75: percentile(v, 75), p90: percentile(v, 90), mean: mean(v), n_years: v.length };
  });
}

/** ember_science.year_totals */
export function yearTotals(rows: MonthRow[], completeThrough: string) {
  const by = new Map<number, { total: number; v: number; n: number; last: string }>();
  for (const x of rows) {
    const y = +x.month.slice(0, 4);
    const o = by.get(y) ?? { total: 0, v: 0, n: 0, last: x.month };
    o.total += x.h;
    o.v += x.sd ** 2;
    o.n++;
    if (x.month > o.last) o.last = x.month;
    by.set(y, o);
  }
  const ys = [...by.keys()].sort((a, b) => a - b);
  const comp = ys.filter((y) => by.get(y)!.n === 12 && by.get(y)!.last <= completeThrough);
  const order = [...comp].sort((a, b) => by.get(b)!.total - by.get(a)!.total);
  const rank = new Map(order.map((y, i) => [y, i + 1]));
  return ys.map((y) => {
    const o = by.get(y)!, sd = Math.sqrt(o.v);
    return { year: y, total: o.total, lo90: Math.max(0, o.total - Z90 * sd), hi90: o.total + Z90 * sd, rank: rank.get(y) ?? null, n_years: order.length, complete: rank.has(y) };
  });
}

/** ember_science.calendar_summary */
function calendarSummary(clim: ReturnType<typeof climatology>, years: ReturnType<typeof yearTotals>): string {
  const parts: string[] = [];
  const c = clim.filter((x) => x.median !== null);
  const mx = c.length ? Math.max(...c.map((x) => x.median as number)) : 0;
  if (c.length && mx > 0) parts.push(`${MONTH_NAMES[c.find((x) => x.median === mx)!.month_num - 1]} is the peak burning month.`);
  else parts.push("Very few hotspots are recorded in this area.");
  const comp = years.filter((y) => y.complete);
  if (comp.length && Math.max(...comp.map((y) => y.total)) > 0) {
    const top = [...comp].sort((a, b) => b.total - a.total)[0];
    const low = [...comp].sort((a, b) => a.total - b.total)[0];
    parts.push(`${top.year} was the most active year on record (${pyComma0(top.total)} hotspots, MODIS-equivalent); ${low.year} was the quietest (${pyComma0(low.total)}).`);
  }
  return parts.join(" ");
}

/** /api/areas/{id}/calendar from the monthly rows (2000-11 .. end) */
export function calendarResponse(areaId: string, rows: MonthRow[], baseline: [number, number], bounds: Bounds, completeThrough: string): Calendar {
  const an = anomalies(rows.map((x) => ({ month: x.month, h: x.h })), baseline, bounds);
  const clim = climatology(rows.map((x) => ({ month: x.month, h: x.h })), baseline);
  const yt = yearTotals(rows, completeThrough);
  const months: CalendarMonth[] = rows.map((x, i) => ({
    month: x.month,
    regime: x.regime as CalendarMonth["regime"],
    h_count: r(x.h) as number,
    lo90: r(Math.max(0, x.h - Z90 * x.sd)) as number,
    hi90: r(x.h + Z90 * x.sd) as number,
    raw: { modis: x.raw[0], snpp: x.raw[1], noaa20: x.raw[2], noaa21: x.raw[3] },
    median_m: r(an[i].median_m),
    ratio_to_median: r(an[i].ratio_to_median),
    pct_rank: r(an[i].pct_rank, 1),
    robust_z: r(an[i].robust_z),
    category: an[i].category,
    provisional: x.provisional,
    modis_outage: x.outage,
    fill_frac: r(x.fill || 0, 4) as number,
  }));
  const years: CalendarYear[] = yt.map((y) => ({ year: y.year, total: r(y.total) as number, lo90: r(y.lo90) as number, hi90: r(y.hi90) as number, rank: y.rank, n_years: y.n_years, complete: y.complete }));
  const climatologyOut: Climatology[] = clim.map((c) => ({
    month_num: c.month_num, median: r(c.median), p10: r(c.p10), p25: r(c.p25), p75: r(c.p75), p90: r(c.p90), mean: r(c.mean), n_years: c.n_years,
  }));
  return { area_id: areaId, unit: "MEH", baseline, months, years, climatology: climatologyOut, summary: calendarSummary(clim, yt) };
}

/** the calendar.csv export (main.py _calendar_csv) */
export function calendarCsv(rows: MonthRow[], baseline: [number, number], bounds: Bounds): string {
  const an = anomalies(rows.map((x) => ({ month: x.month, h: x.h })), baseline, bounds);
  const f = (v: number | null, nd = 3) => (v === null ? "" : pyRepr(pyRound(v, nd)));
  const head = "year,month,month_num,regime,h_count,lo90,hi90,raw_modis,raw_snpp,raw_noaa20,raw_noaa21,median_m,ratio_to_median,pct_rank,robust_z,category,provisional";
  const lines = rows.map((x, i) =>
    [x.month.slice(0, 4), x.month, +x.month.slice(5, 7), x.regime, f(x.h), f(Math.max(0, x.h - Z90 * x.sd)), f(x.h + Z90 * x.sd), ...x.raw,
      f(an[i].median_m), f(an[i].ratio_to_median), f(an[i].pct_rank, 1), f(an[i].robust_z), an[i].category ?? "", String(x.provisional)].join(","),
  );
  return [head, ...lines].join("\n") + "\n";
}


// ---------------- season (ember_science.season_metrics + main.py _season) ----------------
export interface SeasonCfg {
  smooth_days: number;
  onset_frac: number;
  end_frac: number;
  min_hotspots: number;
}
const DAY = 864e5;
const toT = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);

function senMk(x: number[], y: number[]): [number | null, number | null] {
  const ok = y.map((v) => Number.isFinite(v));
  const xs = x.filter((_, i) => ok[i]), ys = y.filter((_, i) => ok[i]);
  if (ys.length < 5) return [null, null];
  if (ys.every((v) => v === ys[0])) return [0, 1];
  return [theilSlope(ys, xs), kendallP(xs, ys)];
}

/** daily: h per day from `first` (every day; missing = 0) */
export function seasonMetrics(first: string, h: Float64Array, cfg: SeasonCfg): { years: SeasonYear[]; trends: Record<string, unknown> } {
  const n = h.length;
  if (!n) return { years: [], trends: {} };
  const t0 = toT(first);
  const monthOf = (i: number) => new Date(t0 + i * DAY).getUTCMonth() + 1;
  const sums = new Float64Array(13), cnt = new Float64Array(13);
  for (let i = 0; i < n; i++) {
    const m = monthOf(i);
    sums[m] += h[i];
    cnt[m]++;
  }
  // month with the lowest mean daily value (polars sort on v: first of ties in month order)
  let minMonth = 1;
  for (let m = 2; m <= 12; m++) if (sums[m] / cnt[m] < sums[minMonth] / cnt[minMonth]) minMonth = m;
  const startMonth = (minMonth % 12) + 1;
  // np.convolve(vals, ones(k)/k, mode="same")
  const k = cfg.smooth_days, w = 1 / k, half = Math.floor((k - 1) / 2);
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i - (k - 1 - half); j <= i + half; j++) if (j >= 0 && j < n) s += h[j] * w;
    sm[i] = s;
  }
  const firstD = new Date(t0), lastT = t0 + (n - 1) * DAY;
  const fy = firstD.getUTCFullYear(), fm = firstD.getUTCMonth() + 1;
  const y0 = fm <= startMonth ? fy : fy + 1;
  let y = Date.UTC(y0, startMonth - 1, 1) >= t0 ? y0 : y0 + 1;
  const years: SeasonYear[] = [];
  for (;;) {
    const s = Date.UTC(y, startMonth - 1, 1), e = Date.UTC(y + 1, startMonth - 1, 1) - DAY;
    if (e > lastT) break;
    const i0 = Math.round((s - t0) / DAY), i1 = Math.round((e - t0) / DAY);
    let tot = 0;
    for (let i = i0; i <= i1; i++) tot += h[i];
    const row: SeasonYear = { fire_year: new Date(e).getUTCFullYear(), start_date: isoOf(s), onset: null, peak: null, end: null, onset_doy: null, peak_doy: null, end_doy: null, length_days: null, total: tot, insufficient: tot < cfg.min_hotspots };
    if (tot >= cfg.min_hotspots) {
      let cs = 0, on = -1, en = -1, pk = 0;
      for (let i = i0; i <= i1; i++) {
        cs += h[i];
        const c = cs / tot;
        if (on < 0 && c >= cfg.onset_frac) on = i - i0;
        if (en < 0 && c >= cfg.end_frac) en = i - i0;
        if (sm[i] > sm[i0 + pk]) pk = i - i0;
      }
      on = Math.max(0, on);
      en = Math.max(0, en);
      Object.assign(row, { onset: isoOf(s + on * DAY), peak: isoOf(s + pk * DAY), end: isoOf(s + en * DAY), onset_doy: on, peak_doy: pk, end_doy: en, length_days: en - on });
    }
    years.push(row);
    y++;
  }
  const trends: Record<string, unknown> = { fire_year_start_month: startMonth };
  if (years.length) {
    const ok = years.filter((x) => !x.insufficient);
    const x = ok.map((v) => v.fire_year);
    for (const key of ["onset", "peak", "end", "length"] as const) {
      const col = key === "length" ? "length_days" : (`${key}_doy` as const);
      const [sl, p] = senMk(x, ok.map((v) => v[col] as number));
      trends[key] = { sen_days_per_decade: sl === null ? null : sl * 10, p, n: ok.length };
    }
    const xt = years.map((v) => v.fire_year), tt = years.map((v) => v.total);
    const [sl, p] = senMk(xt, tt);
    const mn = tt.length ? mean(tt) : 0;
    trends.total = { sen_pct_per_decade: sl === null || mn === 0 ? null : (100 * sl * 10) / mn, p, n: tt.length };
  }
  return { years, trends };
}

const pText = (p: number) => (p < 0.01 ? "p < 0.01" : `p = ${pyFixed(p, 2)}`);

/** ember_science.season_summary */
export function seasonSummary(years: SeasonYear[], trends: Record<string, Trend | number | null>, two: [string, string] | null): string {
  const ok = years.filter((x) => !x.insufficient);
  if (ok.length < 5) return "Too few fires in most years to measure the fire season reliably.";
  const startM = trends.fire_year_start_month as number;
  const typical = (col: "onset_doy" | "peak_doy" | "end_doy") => {
    const d = median(ok.map((x) => x[col] as number));
    const t = Date.UTC(2001, startM - 1, 1) + pyRound(d) * DAY;
    const dt = new Date(t);
    return `${MONTH_NAMES[dt.getUTCMonth()].slice(0, 3)} ${dt.getUTCDate()}`;
  };
  const parts = two
    ? [`This area has two fire seasons, around ${two[0]} and around ${two[1]}. Counting both, the fire year typically starts around ${typical("onset_doy")}, peaks around ${typical("peak_doy")} and ends around ${typical("end_doy")}.`]
    : [`In a typical year the fire season starts around ${typical("onset_doy")}, peaks around ${typical("peak_doy")} and ends around ${typical("end_doy")}.`];
  const words: Record<string, string> = { onset: "starts", peak: "peaks", end: "ends" };
  const sig: string[] = [];
  for (const k of ["onset", "peak", "end"]) {
    const t = (trends[k] ?? {}) as Trend;
    if (t.p !== null && t.p !== undefined && t.p < 0.05 && t.sen_days_per_decade) {
      const v = t.sen_days_per_decade;
      sig.push(`it ${words[k]} ${pyFixed(Math.abs(v), 0)} days ${v < 0 ? "earlier" : "later"} per decade (${pText(t.p)})`);
    }
  }
  let t = (trends.length ?? {}) as Trend;
  if (t.p !== null && t.p !== undefined && t.p < 0.05 && t.sen_days_per_decade) {
    const v = t.sen_days_per_decade;
    sig.push(`the season got ${pyFixed(Math.abs(v), 0)} days ${v > 0 ? "longer" : "shorter"} per decade (${pText(t.p)})`);
  }
  t = (trends.total ?? {}) as Trend;
  if (t.p !== null && t.p !== undefined && t.p < 0.05 && t.sen_pct_per_decade !== null && t.sen_pct_per_decade !== undefined) {
    const v = t.sen_pct_per_decade;
    sig.push(`yearly fire counts ${v > 0 ? "rose" : "fell"} ${pyFixed(Math.abs(v), 0)} % per decade (${pText(t.p)})`);
  }
  parts.push(sig.length ? "Since 2001, " + sig.join("; ") + "." : "There is no clear trend in when the season starts, peaks or ends (p ≥ 0.05).");
  return parts.join(" ");
}

// ---------------- two seasons (ember_science.twins) ----------------
const cd = (a: number, b: number) => Math.min(Math.abs(a - b), 12 - Math.abs(a - b));
function secondPeak(shape: number[], k1: number) {
  let k2 = -1;
  for (let i = 0; i < 12; i++) if (cd(i, k1) >= 3 && (k2 < 0 || shape[i] > shape[k2])) k2 = i;
  return k2;
}
export function isBimodal(shape: number[]): boolean {
  const k1 = argmax(shape);
  const k2 = secondPeak(shape, k1);
  if (shape[k2] < 0.2 * shape[k1]) return false;
  const mod = (a: number) => ((a % 12) + 12) % 12;
  const fwd: number[] = [], bwd: number[] = [];
  for (let t = 1; t < mod(k2 - k1); t++) fwd.push(mod(k1 + t));
  for (let t = 1; t < mod(k1 - k2); t++) bwd.push(mod(k2 + t));
  const arc = fwd.length <= bwd.length ? fwd : bwd;
  const trough = arc.length ? Math.min(...arc.map((i) => shape[i])) : shape[k2];
  let mass2 = 0;
  for (const t of [-1, 0, 1]) if (cd(mod(k2 + t), k1) >= 2) mass2 += shape[mod(k2 + t)];
  return trough < 0.5 * shape[k2] && mass2 >= 0.1;
}
export function twoPeaks(shape: number[]): [string, string] {
  const k1 = argmax(shape);
  const k2 = secondPeak(shape, k1);
  const mod = (a: number) => ((a % 12) + 12) % 12;
  const rng = (k: number, other: number) => {
    let a = k, b = k;
    for (let i = 0; i < 2; i++) {
      let n = mod(a - 1);
      if (shape[n] >= 0.6 * shape[k] && cd(n, other) >= 2) a = n;
      n = mod(b + 1);
      if (shape[n] >= 0.6 * shape[k] && cd(n, other) >= 2) b = n;
    }
    return a === b ? MONTHS3[a] : `${MONTHS3[a]}-${MONTHS3[b]}`;
  };
  return [rng(k1, k2), rng(k2, k1)];
}

/** main.py _season: the /season response from a daily series (first day 2000-11-01, through the last stored day) */
export function seasonResponse(areaId: string, first: string, h: Float64Array, cfg: SeasonCfg, baseline: [number, number]): Season {
  const { years, trends } = seasonMetrics(first, h, cfg);
  const t0 = toT(first);
  const clim = new Float64Array(12);
  for (let i = 0; i < h.length; i++) {
    const d = new Date(t0 + i * DAY);
    const y = d.getUTCFullYear();
    if (y >= baseline[0] && y <= baseline[1]) clim[d.getUTCMonth()] += h[i];
  }
  let two: [string, string] | null = null;
  const tot = clim.reduce((a, b) => a + b, 0);
  if (tot > 0) {
    const shp = Array.from(clim, (v) => v / tot);
    if (isBimodal(shp)) two = twoPeaks(shp);
  }
  const tr: Record<string, Trend | null> = {};
  for (const k of ["onset", "peak", "end", "length", "total"]) {
    const v = (trends[k] as Record<string, number | null> | undefined) ?? null;
    if (v) for (const kk of ["sen_days_per_decade", "sen_pct_per_decade", "p"]) if (v[kk] !== null && v[kk] !== undefined) v[kk] = pyRound(v[kk] as number, 3);
    tr[k] = v as unknown as Trend | null;
  }
  const rows = years.map((y) => ({ ...y, total: pyRound(y.total, 3) }));
  return {
    area_id: areaId,
    years: rows,
    fire_year_start_month: trends.fire_year_start_month as number,
    trends: tr as Season["trends"],
    two_seasons: two,
    summary: years.length ? seasonSummary(years, { ...trends, ...tr } as Record<string, Trend | number | null>, two) : "No fire seasons to measure here.",
  };
}

// ---------------- twins features (ember_science.twins.features) ----------------
const ANG = Array.from({ length: 12 }, (_, i) => (2 * Math.PI * (i + 0.5)) / 12);
export interface Features {
  shape12: number[];
  peak_month: number;
  R: number;
  density: number;
  cv: number;
  trend: number;
  bimodal: boolean;
  mean_annual: number;
}
export function features(byYear: Map<number, number[]>, areaKm2: number): Features | null {
  if (!byYear.size) return null;
  const m = [...byYear.values()];
  const clim = Array.from({ length: 12 }, (_, k) => mean(m.map((row) => row[k])));
  const tot = clim.reduce((a, b) => a + b, 0);
  if (tot <= 0) return null;
  const shape = clim.map((v) => v / tot);
  let vx = 0, vy = 0;
  for (let k = 0; k < 12; k++) {
    vx += shape[k] * Math.cos(ANG[k]);
    vy += shape[k] * Math.sin(ANG[k]);
  }
  const R = Math.hypot(vx, vy);
  const a = Math.atan2(vy, vx);
  const pk = ((((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * 12 + 0.5;
  const annual = m.map((row) => row.reduce((s, v) => s + v, 0));
  const am = mean(annual);
  const cv = am > 0 ? std(annual) / am : 0;
  const yrs = [...byYear.keys()];
  const slope = yrs.length >= 5 && std(annual) > 0 ? theilSlope(annual, yrs) : 0;
  const trend = am > 0 ? (100 * slope * 10) / am : 0;
  return { shape12: shape, peak_month: pk, R, density: Math.log10(Math.max(am, 1e-6) / Math.max(areaKm2, 1e-6)), cv, trend, bimodal: isBimodal(shape), mean_annual: am };
}

export function why(q: Features, t: Features, shift: number, mode: string): string {
  const parts: string[] = [];
  const pmod = (a: number, b: number) => ((a % b) + b) % b;
  const dp = Math.trunc(pyRound(pmod(t.peak_month - q.peak_month + shift + 6, 12) - 6));
  if (mode === "season" && shift) parts.push(`same season shape, shifted ${Math.abs(shift)} month${Math.abs(shift) > 1 ? "s" : ""} (peak in ${MONTHS3[pmod(Math.trunc(t.peak_month - 0.5), 12)]})`);
  else if (dp === 0) parts.push(`same peak month (${MONTHS3[pmod(Math.trunc(q.peak_month - 0.5), 12)]})`);
  else parts.push(`peak ${Math.abs(dp)} month${Math.abs(dp) > 1 ? "s" : ""} ${dp > 0 ? "later" : "earlier"}`);
  if (q.bimodal && t.bimodal) parts.push("both have two fire seasons");
  const dd = t.density - q.density;
  parts.push(Math.abs(dd) < 0.15 ? "similar density" : `${pyFixed(10 ** Math.abs(dd), 1)}x ${dd > 0 ? "denser" : "sparser"}`);
  const tr = (v: number) => (v > 15 ? "rising" : v < -15 ? "falling" : "stable");
  parts.push(tr(q.trend) === tr(t.trend) ? `both ${tr(q.trend)}` : `${tr(t.trend)} (yours ${tr(q.trend)})`);
  const s = parts.join("; ");
  return s[0].toUpperCase() + s.slice(1) + ".";
}
