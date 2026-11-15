// Static mode (VITE_STATIC=1): the site runs from a precomputed snapshot of the API (pipeline/build_snapshot.py) on a
// static host, with one small serverless function for live FIRMS detections (web/functions/api/firms.ts).
// Named places (world, biomes, countries, provinces) answer from files; the day-by-day view, "right now", the Terrain
// month mode and the downloads are computed here, with the same rules as the API.
import { latLngToCell } from "h3-js";
import { fetchRetry, pyRound } from "./engine/stats";
import { withVersion } from "./snapVersion";
import { meta as engineMeta } from "./engine/region";
import type { Area, AreaCells, AreaCellsMonth, AreaDaily, AreaPlaces, Calendar, Category, Health, Now, Rankings, Season, Twins } from "./types";

export const STATIC_MODE = import.meta.env.VITE_STATIC === "1";
const SNAP = ((import.meta.env.VITE_SNAP_BASE as string | undefined) ?? `${import.meta.env.BASE_URL}snap`).replace(/\/$/, "");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CAT_WORDS: Record<Category, string> = {
  much_below: "much below normal",
  below: "below normal",
  normal: "normal",
  above: "above normal",
  much_above: "much above normal",
  record: "a record",
};

export class SnapMissing extends Error {}

const cache = new Map<string, Promise<unknown>>();
function j<T>(path: string): Promise<T> {
  let p = cache.get(path) as Promise<T> | undefined;
  if (!p) {
    p = fetchRetry(withVersion(`${SNAP}/${path}`)).then((r) => {
      if (!r.ok) throw new SnapMissing(`${path}: ${r.status}`);
      return r.json() as Promise<T>;
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

interface Bundle {
  area: Area;
  calendar: Calendar;
  season: Season | null;
  twins_season: Twins | null;
  twins_calendar: Twins | null;
  places: AreaPlaces | null;
  now_inputs: { nrt_factor: number; rel_sd: number; bbox: [number, number, number, number]; unit: string | null; pct_bounds: Record<string, number> };
}
type CellsFile = AreaCells & { month_grid?: { months: [string, string]; scale: number; v: number[] } };
export interface DailyFile {
  first: string;
  last: string;
  h: ArrayLike<number>;
}
export type NowBundle = Pick<Bundle, "area" | "calendar" | "now_inputs">;

// a few Natural Earth codes contain "?", which the data files spell "~" (pipeline/build_snapshot.py fname)
const enc = (id: string) => encodeURIComponent(id.replaceAll("?", "~"));
export const bundle = (id: string) => j<Bundle>(`p/${enc(id)}.json`);
const cellsFile = (id: string) => j<CellsFile>(`c/${enc(id)}.json`);
// the stored record is complete through the engine's last day everywhere: days after an area's last fire are 0, not missing
const dailyFile = async (id: string): Promise<DailyFile> => {
  const [d, m] = await Promise.all([j<DailyFile>(`d/${enc(id)}.json`), engineMeta()]);
  return d.last < m.last_day ? { ...d, last: m.last_day } : d;
};

// ---- dates (UTC, day resolution)
const DAY = 864e5;
const toT = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthList = (a: string, b: string) => {
  const out: string[] = [];
  let y = +a.slice(0, 4), m = +a.slice(5, 7);
  while (`${y}-${String(m).padStart(2, "0")}` <= b) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) (m = 1), y++;
  }
  return out;
};
/** numpy's default (linear) percentile */
function pctl(xs: number[], q: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = ((s.length - 1) * q) / 100, f = Math.floor(k), c = Math.min(s.length - 1, f + 1);
  return s[f] + (s[c] - s[f]) * (k - f);
}
const r = (v: number, nd: number) => pyRound(v, nd);

export function category(pct: number | null, x: number, smax: number | null, b: Record<string, number>): Category | null {
  if (pct === null) return null;
  if (smax !== null && x > smax && x > 0) return "record";
  if (pct < b.much_below) return "much_below";
  if (pct < b.below) return "below";
  if (pct > b.much_above) return "much_above";
  if (pct > b.above) return "above";
  return "normal";
}

function dayValue(d: DailyFile, t: number) {
  const i = Math.round((t - toT(d.first)) / DAY);
  return i >= 0 && i < d.h.length ? d.h[i] : 0;
}

// ---------------- the API, from the snapshot ----------------
export const snap = {
  health: async (): Promise<Health> => ((await j<{ health: Health }>("meta.json")).health),
  area: async (id: string) => (await bundle(id)).area,
  calendar: async (id: string) => (await bundle(id)).calendar,
  season: async (id: string) => {
    const s = (await bundle(id)).season;
    if (!s) throw new SnapMissing("No fire seasons to measure here.");
    return s;
  },
  twins: async (id: string, mode: "calendar" | "season") => {
    const b = await bundle(id);
    const t = mode === "season" ? b.twins_season : b.twins_calendar;
    if (!t) throw new SnapMissing("Too few fires in this area to find twins.");
    return t;
  },
  places: async (id: string) => {
    const p = (await bundle(id)).places;
    if (!p) throw new SnapMissing("No fire recorded in this area.");
    return p;
  },
  cells: async (id: string): Promise<AreaCells> => {
    const c = await cellsFile(id);
    const { month_grid: _g, ...rest } = c;
    return rest;
  },
  cellsMonth: async (id: string, month: string, b0 = 2003, b1 = 2025): Promise<AreaCellsMonth> => {
    const c = await cellsFile(id);
    const g = c.month_grid;
    if (!g) throw new SnapMissing("Month-by-month terrain is available for areas up to 4,000 cells (provinces).");
    const ms = monthList(g.months[0], g.months[1]);
    const nm = ms.length, n = c.cells.length;
    const mi = ms.indexOf(month);
    const y = +month.slice(0, 4), mm = month.slice(5, 7);
    const base = ms.map((m, k) => [m, k] as const).filter(([m]) => m.slice(5, 7) === mm && +m.slice(0, 4) >= b0 && +m.slice(0, 4) <= b1 && +m.slice(0, 4) !== y).map(([, k]) => k);
    const values: number[] = [], typical: number[] = [];
    for (let i = 0; i < n; i++) {
      values.push(mi >= 0 ? r(g.v[i * nm + mi] * g.scale, 3) : 0);
      let t = 0;
      for (const k of base) t += g.v[i * nm + k] * g.scale;
      typical.push(r(t / Math.max(1, base.length), 3));
    }
    return { area_id: id, unit: "MEH", month, baseline: [b0, b1], values, typical };
  },
  daily: async (id: string, month: string, b0 = 2003, b1 = 2025): Promise<AreaDaily> => dailyFrom(await dailyFile(id), id, month, b0, b1),
  now: async (id: string): Promise<Now> => {
    const [b, d] = await Promise.all([bundle(id), dailyFile(id)]);
    return nowFrom(b, d);
  },
  rankings: (month?: string) => j<Rankings>(`r/${month ?? "latest"}.json`),
};

/** /daily from a harmonized daily series (snapshot file or the drawn-area engine) */
export function dailyFrom(d: DailyFile, id: string, month: string, b0 = 2003, b1 = 2025): AreaDaily {
  {
    const y = +month.slice(0, 4), mm = +month.slice(5, 7), n = daysIn(y, mm);
    const years: number[] = [];
    for (let yy = b0; yy <= b1; yy++) if (yy !== y) years.push(yy);
    const grid = years.map((yy) => Array.from({ length: n }, (_, k) => (k + 1 <= daysIn(yy, mm) ? dayValue(d, Date.UTC(yy, mm - 1, k + 1)) : 0)));
    const cum = grid.map((row) => row.reduce<number[]>((acc, v, k) => (acc.push((acc[k - 1] ?? 0) + v), acc), []));
    let run = 0;
    const days = Array.from({ length: n }, (_, k) => {
      const t = Date.UTC(y, mm - 1, k + 1);
      const date = iso(t);
      const h = date > d.last ? null : dayValue(d, t);
      run += h ?? 0;
      const col = grid.map((row) => row[k]), ccol = cum.map((row) => row[k]);
      return {
        day: k + 1,
        date,
        h: h === null ? null : r(h, 2),
        typical: r(pctl(col, 50), 2),
        p25: r(pctl(col, 25), 2),
        p75: r(pctl(col, 75), 2),
        cum: r(run, 1),
        cum_typical: r(pctl(ccol, 50), 1),
        cum_p25: r(pctl(ccol, 25), 1),
        cum_p75: r(pctl(ccol, 75), 1),
      };
    });
    return {
      area_id: id,
      unit: "MEH",
      month,
      baseline: [b0, b1],
      data_through: d.last,
      note: "Harmonized daily counts: each day's detections of the month's reference sensor × the cell-month harmonization factor.",
      days,
    } as AreaDaily;
  }
}

/** /now from the stored daily record plus live detections (Cloudflare function) */
export async function nowFrom(b: NowBundle, d: DailyFile): Promise<Now> {
  {
    const today = new Date();
    const Y = today.getUTCFullYear(), M = today.getUTCMonth() + 1, D = today.getUTCDate();
    const dim = daysIn(Y, M);
    const month = `${Y}-${String(M).padStart(2, "0")}`;
    const m0 = Date.UTC(Y, M - 1, 1);
    // stored daily record for this month
    let storedMtd = 0;
    let lastStored = iso(m0 - DAY);
    for (let t = m0; t <= Date.UTC(Y, M - 1, D) && iso(t) <= d.last; t += DAY) {
      storedMtd += dayValue(d, t);
      lastStored = iso(t);
    }
    // live NRT detections after the stored record (Cloudflare function), converted with the area's factor
    const fac = b.now_inputs.nrt_factor;
    const live = await liveDetections(b.area, b.now_inputs);
    const after = live.dets.filter((x) => x.date > lastStored);
    const liveAfter = after.length * fac;
    const mtd = storedMtd + liveAfter;
    // the same first days of this calendar month in 2003-2025
    const S: number[] = [];
    for (let yy = 2003; yy <= 2025; yy++) {
      let s = 0;
      for (let k = 1; k <= Math.min(D, daysIn(yy, M)); k++) s += dayValue(d, Date.UTC(yy, M - 1, k));
      S.push(s);
    }
    const pct = (100 * (S.filter((v) => v < mtd).length + 0.5 * S.filter((v) => v === mtd).length)) / S.length;
    const cat = category(pct, mtd, Math.max(...S), b.now_inputs.pct_bounds);
    const clim = b.calendar.climatology;
    const medM = clim.find((c) => c.month_num === M)?.median ?? 0;
    const expected = (medM * D) / dim;
    const peak = [...clim].sort((a, c) => (c.median ?? -1) - (a.median ?? -1))[0]?.month_num ?? M;
    const next = Date.UTC(Y + (peak < M ? 1 : 0), peak - 1, 15);
    const toPeak = peak === M ? 0 : Math.round((next - Date.UTC(Y, M - 1, D)) / DAY);
    const sd = mtd * b.now_inputs.rel_sd;
    const fmt0 = (v: number) => Math.round(v).toLocaleString("en-US");
    const summary =
      `So far in ${MONTHS[M - 1]} (${D} of ${dim} days), ${b.area.name} has about ${fmt0(mtd)} hotspots (MODIS-equivalent); ` +
      `a typical year has ${fmt0(expected)} by this date, so this is ${cat ? CAT_WORDS[cat] : "not comparable"}. The typical peak is in ${MONTHS[peak - 1]}` +
      (toPeak === 0 ? "." : `, ${toPeak} days away.`);
    const feats = live.dets.slice(0, 5000).map((x) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [r(x.lon, 4), r(x.lat, 4)] },
      properties: { satellite: x.sat, acq_datetime: `${x.date}T${x.time.slice(0, 2)}:${x.time.slice(2)}:00Z`, frp: x.frp, confidence: x.conf, meh_weight: r(fac, 3) },
    }));
    return {
      as_of: new Date().toISOString().slice(0, 19) + "Z",
      month,
      days_elapsed: D,
      days_in_month: dim,
      mtd_h_count: r(mtd, 3),
      mtd_lo90: r(Math.max(0, mtd - 1.645 * sd), 3),
      mtd_hi90: r(mtd + 1.645 * sd, 3),
      expected_mtd: r(expected, 3),
      pct_rank_mtd: r(pct, 1),
      category: cat,
      typical_peak_month: peak,
      days_to_typical_peak: toPeak,
      last7d: { type: "FeatureCollection", features: feats },
      source_status: live.status,
      summary,
    } as Now;
  }
}

// ---------------- live detections (Cloudflare Pages Function /api/firms) ----------------
interface Det {
  lat: number;
  lon: number;
  date: string;
  time: string;
  conf: string;
  frp: number;
  sat: string;
}
const liveCache = new Map<string, Promise<{ dets: Det[]; status: "ok" | "unavailable" }>>();

async function liveDetections(area: Area, inp: Bundle["now_inputs"]): Promise<{ dets: Det[]; status: "ok" | "unavailable" }> {
  // the whole world and the biomes have no outline to filter by: their month so far uses the stored record only
  if (inp.unit === "WORLD" || inp.unit?.startsWith("BIOME-")) return { dets: [], status: "unavailable" };
  const key = area.area_id;
  let p = liveCache.get(key);
  if (!p) {
    p = fetchLive(area, inp).catch(() => ({ dets: [], status: "unavailable" as const }));
    liveCache.set(key, p);
  }
  return p;
}

async function fetchLive(area: Area, inp: Bundle["now_inputs"]) {
  const [w, s, e, n] = inp.bbox;
  const base = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/firms?bbox=${[w, s, e, n].map((v) => v.toFixed(2)).join(",")}`);
  if (!res.ok) return { dets: [] as Det[], status: "unavailable" as const };
  const text = await res.text();
  const dets: Det[] = [];
  let cols: string[] = [];
  let sat = "NOAA20";
  const inArea = await areaTest(area, inp);
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("#source=")) {
      sat = line.includes("NOAA21") ? "NOAA21" : "NOAA20";
      continue;
    }
    if (line.startsWith("latitude")) {
      cols = line.split(",");
      continue;
    }
    const v = line.split(",");
    const g = (k: string) => v[cols.indexOf(k)];
    const conf = (g("confidence") ?? "").toLowerCase();
    if (!["n", "h", "nominal", "high"].includes(conf)) continue;
    const lat = +g("latitude"), lon = +g("longitude");
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inArea(lat, lon)) continue;
    dets.push({ lat, lon, date: g("acq_date"), time: (g("acq_time") ?? "").padStart(4, "0"), conf, frp: +g("frp"), sat });
  }
  dets.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return { dets, status: "ok" as const };
}

/** Is a point inside the area? Its r5 cells when it has them, else the country outline. */
async function areaTest(area: Area, inp: Bundle["now_inputs"]): Promise<(lat: number, lon: number) => boolean> {
  if (area.cells_r5.length) {
    const set = new Set(area.cells_r5);
    return (lat, lon) => set.has(latLngToCell(lat, lon, 5));
  }
  if (inp.unit?.startsWith("ISO-")) {
    const [{ geoContains }, fc] = await Promise.all([import("d3"), fetch(`${import.meta.env.BASE_URL}static/admin0.geojson`).then((r) => r.json() as Promise<GeoJSON.FeatureCollection>)]);
    const iso3 = inp.unit.slice(4);
    const f = fc.features.find((x) => String(x.properties?.country_iso3 ?? x.properties?.iso3 ?? "") === iso3);
    if (f) return (lat, lon) => geoContains(f, [lon, lat]);
  }
  const [w, s, e, n] = inp.bbox;
  return (lat, lon) => lat >= s && lat <= n && lon >= w && lon <= e;
}
