// Areas answered in the browser from the region tiles (pipeline/build_region_tiles.py): drawn shapes (lasso, circle,
// coordinates, a twin's region), and any area's hotspot estimate. Mirrors api/ember_api/areas.py and main.py.
//
// Drawn ids carry their shape, so links and reloads work:
//   x_c_<lat>_<lon>_<km>   circle      x_p_<lat,lon;…>   polygon      x_h_<r3 cell>   a twin's region (its r5 cells)
import { cellArea, cellToChildren, cellToLatLng, cellToParent, gridDisk, latLngToCell, polygonToCells } from "h3-js";
import type { Area, AreaCells, AreaCellsMonth, AreaPlaces, Calendar, Season, Twins } from "../types";
import { fetchCal2, pool } from "./cal2";
import { calendarResponse, features, monthList, regimeOf, seasonResponse, why, type Bounds, type MonthRow, type SeasonCfg } from "./science";
import { argmax, fetchRetry, pyRound, r } from "./stats";
import { withVersion } from "../snapVersion";

export const SNAP = ((import.meta.env.VITE_SNAP_BASE as string | undefined) ?? `${import.meta.env.BASE_URL}snap`).replace(/\/$/, "");
export class EngineError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// ---------------- engine metadata ----------------
export interface Meta {
  baseline_years: [number, number];
  pct_bounds: Bounds;
  season: SeasonCfg;
  twins: { exclude_km: number; k: number; weights: Record<string, number> };
  api: { max_area_cells_r5: number; max_csv_rows: number; small_area_km2: number };
  product: { version: string; model: string; latest_complete_month: string; month_to_date: string };
  last_day: string;
  data_version: string | null;
  config_hash: string | null;
  refsrc: Record<string, string>;
  global_nrt_factor: number;
}
const once = new Map<string, Promise<unknown>>();
function json<T>(path: string): Promise<T> {
  let p = once.get(path) as Promise<T> | undefined;
  if (!p) {
    p = fetchRetry(withVersion(`${SNAP}/${path}`)).then((res) => {
      if (!res.ok) throw new EngineError("upstream_unavailable", "Could not load the data files. Check your connection and try again.");
      return res.json() as Promise<T>;
    });
    p.catch(() => once.delete(path));
    once.set(path, p);
  }
  return p;
}
export const meta = () => json<Meta>("engine/meta.json");
/** Every land r5 cell (areas.py coverage test), sorted u64 ids. */
let landP: Promise<BigUint64Array> | null = null;
function landCells(): Promise<BigUint64Array> {
  if (!landP) {
    landP = fetchRetry(withVersion(`${SNAP}/engine/land.u64.gz`)).then(async (res) => {
      if (!res.ok) throw new EngineError("upstream_unavailable", "Could not load the data files. Check your connection and try again.");
      let buf = await res.arrayBuffer();
      const b = new Uint8Array(buf);
      if (b[0] === 0x1f && b[1] === 0x8b) buf = await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
      return new BigUint64Array(buf);
    });
    landP.catch(() => (landP = null));
  }
  return landP;
}
function isLand(land: BigUint64Array, cell: string): boolean {
  const x = BigInt(`0x${cell}`);
  let lo = 0, hi = land.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (land[mid] === x) return true;
    if (land[mid] < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
export const names = () => json<{ adm1: Record<string, [string | null, string | null]>; iso3: Record<string, string> }>("engine/names.json");

// ---------------- ids and shapes (api/ember_api/areas.py) ----------------
export const isDrawnId = (id: string) => id.startsWith("x_");
export function circleId(lat: number, lon: number, km: number) {
  return `x_c_${lat.toFixed(3)}_${lon.toFixed(3)}_${Math.round(km)}`;
}
export function polygonId(coords: [number, number][]) {
  return `x_p_${coords.map(([lo, la]) => `${la.toFixed(3)},${lo.toFixed(3)}`).join(";")}`; // coords are [lon, lat]
}
export function cellsId(cells: string[]): string | null {
  const parents = new Set(cells.map((c) => cellToParent(c, 3)));
  return parents.size === 1 ? `x_h_${[...parents][0]}` : null;
}
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371.0088, rad = Math.PI / 180;
  const p1 = lat1 * rad, p2 = lat2 * rad, dp = p2 - p1, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function shapeOf(id: string): { cells: string[]; name: string } {
  const [, kind, ...rest] = id.split("_");
  if (kind === "c") {
    const [lat, lon, rad] = rest.map(Number);
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) || !(rad > 0 && rad <= 1000))
      throw new EngineError("invalid_geometry", "Latitude, longitude or radius is out of range (radius 1-1000 km).");
    const centre = latLngToCell(lat, lon, 5);
    const k = Math.ceil(rad / 14) + 1;
    const cells = gridDisk(centre, k).filter((x) => {
      const [a, b] = cellToLatLng(x);
      return haversineKm(lat, lon, a, b) <= rad;
    });
    return { cells: cells.length ? cells : [centre], name: `Custom area (${rad} km circle)` };
  }
  if (kind === "p") {
    const ring = rest
      .join("_")
      .split(";")
      .map((p) => p.split(",").map(Number))
      .map(([la, lo]) => [lo, la] as [number, number]);
    if (ring.length < 3 || ring.some((p) => p.some((v) => !Number.isFinite(v)))) throw new EngineError("invalid_geometry", "The area must be a polygon. Draw at least three points.");
    const closed = [...ring, ring[0]];
    let cells = polygonToCells(closed, 5, true);
    if (!cells.length) {
      const lon = closed.reduce((s, p) => s + p[0], 0) / closed.length, lat = closed.reduce((s, p) => s + p[1], 0) / closed.length;
      cells = [latLngToCell(lat, lon, 5)];
    }
    return { cells, name: "Custom area" };
  }
  if (kind === "h") return { cells: cellToChildren(rest[0], 5), name: "Custom area" };
  throw new EngineError("not_found", "Unknown area.");
}

/** The outline of a drawn id as [lon, lat] rings (circles and polygons), so a shared link redraws the shape. */
export function outlineOfDrawn(id: string): [number, number][][] | null {
  const [, kind, ...rest] = id.split("_");
  if (kind === "c") {
    const [lat, lon, km] = rest.map(Number);
    const out: [number, number][] = [];
    const d = km / 6371, la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    for (let i = 0; i < 96; i++) {
      const b = (2 * Math.PI * i) / 96;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      out.push([((((lo2 * 180) / Math.PI + 540) % 360) - 180), (la2 * 180) / Math.PI]);
    }
    return [[...out, out[0]]];
  }
  if (kind === "p") {
    const ring = rest.join("_").split(";").map((p) => p.split(",").map(Number)).map(([la, lo]) => [lo, la] as [number, number]);
    return [[...ring, ring[0]]];
  }
  return null;
}

// ---------------- tiles ----------------
interface GHead {
  months: [string, string];
  cells: string[];
  adm1: (string | null)[];
  iso3: (string | null)[];
  biome: (number | null)[];
}
interface YHead {
  first_day: string;
  cells: string[];
}
type G = NonNullable<Awaited<ReturnType<typeof fetchCal2<GHead>>>>;
type Y = NonNullable<Awaited<ReturnType<typeof fetchCal2<YHead>>>>;
const gTiles = new Map<string, Promise<G | null>>();
const yTiles = new Map<string, Promise<Y | null>>();
function tile<T>(cache: Map<string, Promise<T | null>>, dir: string, r2: string): Promise<T | null> {
  let p = cache.get(r2);
  if (!p) {
    p = fetchCal2(withVersion(`${SNAP}/${dir}/${r2}.bin.gz`)) as Promise<T | null>;
    p.catch(() => cache.delete(r2));
    cache.set(r2, p);
  }
  return p;
}

/** Everything the API knows about a set of r5 cells, summed from the tiles. */
export interface Region {
  cells: string[];
  months: string[]; // 2000-11 .. month_to_date
  /** per area cell: monthly h_count (null = no product rows) */
  series: (Float32Array | null)[];
  adm1: (string | null)[];
  iso3: (string | null)[];
  land: boolean[];
  rows: MonthRow[];
}
const regions = new Map<string, Promise<Region>>();

export function loadRegion(key: string, cells: string[]): Promise<Region> {
  let p = regions.get(key);
  if (!p) {
    p = (async () => {
      const m = await meta();
      const byR2 = new Map<string, number[]>();
      cells.forEach((c, i) => {
        const k = cellToParent(c, 2);
        const a = byR2.get(k);
        if (a) a.push(i);
        else byR2.set(k, [i]);
      });
      const months = monthList("2000-11", m.product.month_to_date);
      const nm = months.length;
      const H = new Float64Array(nm), RAND2 = new Float64Array(nm), FILLED = new Float64Array(nm);
      const RAW = [new Float64Array(nm), new Float64Array(nm), new Float64Array(nm), new Float64Array(nm)];
      const PROV = new Uint8Array(nm), OUT = new Uint8Array(nm), HAS = new Uint8Array(nm);
      const SYS = new Map<number, Float64Array>(); // biome -> per month sum of h_sd_sys
      const series: (Float32Array | null)[] = new Array(cells.length).fill(null);
      const adm1: (string | null)[] = new Array(cells.length).fill(null);
      const iso3: (string | null)[] = new Array(cells.length).fill(null);
      const land: boolean[] = new Array(cells.length).fill(false);
      const r2s = [...byR2.keys()];
      const tiles = await pool(r2s, 6, (k) => tile<G>(gTiles, "g", k));
      r2s.forEach((k, ti) => {
        const t = tiles[ti];
        if (!t) return;
        const local = new Map(t.header.cells.map((c, i) => [c, i]));
        const slot = new Int32Array(t.header.cells.length).fill(-1);
        for (const i of byR2.get(k)!) {
          const li = local.get(cells[i]);
          if (li === undefined) continue;
          slot[li] = i;
          land[i] = true;
          adm1[i] = t.header.adm1[li];
          iso3[i] = t.header.iso3?.[li] ?? null;
        }
        const off = monthList("2000-11", t.header.months[0]).length - 1; // tile month index -> region month index
        const c = t.col;
        const ci = c.ci as Uint16Array, km = c.k as Uint16Array;
        for (let j = 0; j < t.header.n; j++) {
          const i = slot[ci[j]];
          if (i < 0) continue;
          const mi = km[j] + off;
          if (mi < 0 || mi >= nm) continue;
          const h = c.h[j];
          let s = series[i];
          if (!s) s = series[i] = new Float32Array(nm);
          s[mi] = h;
          HAS[mi] = 1;
          H[mi] += h;
          RAND2[mi] += c.sr[j] * c.sr[j];
          FILLED[mi] += h * c.ff[j];
          RAW[0][mi] += c.rm[j];
          RAW[1][mi] += c.rs[j];
          RAW[2][mi] += c.r20[j];
          RAW[3][mi] += c.r21[j];
          if (c.fl[j] & 1) PROV[mi] = 1;
          if (c.fl[j] & 2) OUT[mi] = 1;
          const b = t.header.biome[ci[j]] ?? -1;
          let sb = SYS.get(b);
          if (!sb) SYS.set(b, (sb = new Float64Array(nm)));
          sb[mi] += c.ss[j];
        }
      });
      const rows: MonthRow[] = months.map((mo, k) => {
        let sys2 = 0;
        for (const sb of SYS.values()) sys2 += sb[k] * sb[k];
        const h = H[k];
        return {
          month: mo,
          regime: regimeOf(mo),
          h,
          sd: Math.sqrt(sys2 + RAND2[k]),
          raw: [RAW[0][k], RAW[1][k], RAW[2][k], RAW[3][k]],
          provisional: HAS[k] ? PROV[k] === 1 : mo >= "2026-08",
          outage: OUT[k] === 1,
          fill: h > 0 ? FILLED[k] / h : 0,
        };
      });
      return { cells, months, series, adm1, iso3, land, rows };
    })();
    p.catch(() => regions.delete(key));
    regions.set(key, p);
  }
  return p;
}

/** Harmonized daily totals of a set of cells, from 2000-11-01 through the last stored day. */
const dailies = new Map<string, Promise<{ first: string; last: string; h: Float64Array }>>();
export function loadDaily(key: string, cells: string[]) {
  let p = dailies.get(key);
  if (!p) {
    p = (async () => {
      const m = await meta();
      const first = "2000-11-01";
      const t0 = Date.UTC(2000, 10, 1);
      const n = Math.round((Date.UTC(+m.last_day.slice(0, 4), +m.last_day.slice(5, 7) - 1, +m.last_day.slice(8, 10)) - t0) / 864e5) + 1;
      const h = new Float64Array(n);
      const want = new Set(cells);
      const r2s = [...new Set(cells.map((c) => cellToParent(c, 2)))];
      await pool(r2s, 6, async (k) => {
        const t = await tile<Y>(yTiles, "y", k);
        if (!t) return;
        const ok = t.header.cells.map((c) => want.has(c));
        const ci = t.col.ci as Uint16Array, day = t.col.day as Uint16Array, v = t.col.h as Float32Array;
        for (let j = 0; j < t.header.n; j++) if (ok[ci[j]] && day[j] < n) h[day[j]] += v[j];
      });
      return { first, last: m.last_day, h };
    })();
    p.catch(() => dailies.delete(key));
    dailies.set(key, p);
  }
  return p;
}

// ---------------- drawn areas ----------------
interface Drawn {
  area: Area;
  region: Region;
}
const drawnCache = new Map<string, Promise<Drawn>>();
export function drawn(id: string): Promise<Drawn> {
  let p = drawnCache.get(id);
  if (!p) {
    p = (async () => {
      const m = await meta();
      const { cells: raw, name } = shapeOf(id);
      const cells = [...new Set(raw)].sort();
      if (cells.length > m.api.max_area_cells_r5)
        throw new EngineError("area_too_large", `This area has ${cells.length.toLocaleString("en-US")} grid cells; the limit is ${m.api.max_area_cells_r5.toLocaleString("en-US")}. Pick a smaller area.`);
      const [region, land] = await Promise.all([loadRegion(id, cells), landCells()]);
      const nLand = cells.filter((c) => isLand(land, c)).length;
      if (nLand === 0) throw new EngineError("outside_coverage", "This area has no land in the fire record (open ocean is not covered).");
      const ll = cells.map((c) => cellToLatLng(c));
      const lats = ll.map((p) => p[0]), lons = ll.map((p) => p[1]);
      const km2 = cells.reduce((s, c) => s + cellArea(c, "km2"), 0);
      const area: Area = {
        area_id: id,
        name,
        area_km2: pyRound(km2, 1),
        n_cells_r5: cells.length,
        bbox: [pyRound(Math.min(...lons), 4), pyRound(Math.min(...lats), 4), pyRound(Math.max(...lons), 4), pyRound(Math.max(...lats), 4)],
        centroid: [pyRound(lons.reduce((a, b) => a + b, 0) / lons.length, 4), pyRound(lats.reduce((a, b) => a + b, 0) / lats.length, 4)],
        coverage: nLand === cells.length ? "full" : "partial",
        small_area_warning: km2 < m.api.small_area_km2,
        cells_r5: cells,
      };
      return { area, region };
    })();
    p.catch(() => drawnCache.delete(id));
    drawnCache.set(id, p);
  }
  return p;
}

const calRows = (rg: Region, end: string) => rg.rows.filter((x) => x.month <= end);

export async function calendar(id: string): Promise<Calendar> {
  const [m, d] = await Promise.all([meta(), drawn(id)]);
  return calendarResponse(id, calRows(d.region, m.product.latest_complete_month), m.baseline_years, m.pct_bounds, m.product.latest_complete_month);
}

export async function cells(id: string): Promise<AreaCells> {
  const [m, { region: rg }] = await Promise.all([meta(), drawn(id)]);
  const latest = m.product.latest_complete_month;
  const fy = 2001, ly = 2025, ny = ly - fy + 1;
  const y = +latest.slice(0, 4), mo = +latest.slice(5, 7);
  const m0 = mo < 12 ? `${y - 1}-${String(mo + 1).padStart(2, "0")}` : `${y}-01`;
  const yrs: number[] = [];
  for (let yy = fy; yy <= y; yy++) yrs.push(yy);
  const out: AreaCells = { area_id: id, unit: "MEH", first_year: fy, last_year: ly, latest_month: latest, cells: [], lat: [], lon: [], mean_annual: [], peak_month: [], recent12: [] };
  const byYear: number[][] = [];
  rg.cells.forEach((c, i) => {
    const [la, lo] = cellToLatLng(c);
    out.cells.push(c);
    out.lat.push(pyRound(la, 4));
    out.lon.push(pyRound(lo, 4));
    const s = rg.series[i];
    let t = 0, rec = 0;
    const byM = new Float64Array(13), byY = new Float64Array(yrs.length);
    if (s)
      rg.months.forEach((mm, k) => {
        if (mm < `${fy}-01` || mm > latest) return;
        const yy = +mm.slice(0, 4);
        if (yy <= ly) {
          t += s[k];
          byM[+mm.slice(5, 7)] += s[k];
        }
        if (mm >= m0) rec += s[k];
        byY[yy - fy] += s[k];
      });
    out.mean_annual.push(pyRound(t / ny, 3));
    let pk: number | null = null;
    if (t > 0 && s) {
      pk = 1;
      for (let k = 2; k <= 12; k++) if (byM[k] > byM[pk]) pk = k;
    }
    out.peak_month.push(pk);
    out.recent12.push(pyRound(rec, 3));
    byYear.push(Array.from(byY, (v) => pyRound(v, 2)));
  });
  if (rg.cells.length <= 4000) {
    out.years = yrs;
    out.by_year = byYear;
  }
  out.adm1 = rg.adm1;
  return out;
}

/** /cells_month for a drawn area, or for any area given its cells in display order (named places too large for the snapshot's month grid). */
export async function cellsMonth(id: string, month: string, b0 = 2003, b1 = 2025, cells?: string[]): Promise<AreaCellsMonth> {
  const rg = cells ? await loadRegion(`named:${id}`, cells) : (await drawn(id)).region;
  if (!/^\d{4}-\d{2}$/.test(month)) throw new EngineError("invalid_geometry", "month must look like 2026-10 and baseline like 2003-2025.");
  const y = +month.slice(0, 4), mm = month.slice(5, 7);
  const k = rg.months.indexOf(month);
  const base: number[] = [];
  rg.months.forEach((x, j) => {
    const yy = +x.slice(0, 4);
    if (x.slice(5, 7) === mm && yy >= b0 && yy <= b1 && yy !== y) base.push(j);
  });
  const n = Math.max(1, b1 - b0 + 1 - (y >= b0 && y <= b1 ? 1 : 0));
  return {
    area_id: id,
    unit: "MEH",
    month,
    baseline: [b0, b1],
    values: rg.series.map((s) => pyRound(s && k >= 0 ? s[k] : 0, 3)),
    typical: rg.series.map((s) => pyRound(s ? base.reduce((a, j) => a + s[j], 0) / n : 0, 3)),
  };
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
export async function places(id: string, k = 6): Promise<AreaPlaces> {
  const [m, nm, { area, region: rg }] = await Promise.all([meta(), names(), drawn(id)]);
  const latest = m.product.latest_complete_month;
  const years = +latest.slice(0, 4) - 2000 + (+latest.slice(5, 7) + 2) / 12;
  const sub = rg.cells
    .map((c, i) => {
      const s = rg.series[i];
      let tot = 0;
      if (s) for (let j = 0; j < s.length; j++) tot += s[j];
      const a = rg.adm1[i];
      const [an, ac] = a ? (nm.adm1[a] ?? [null, null]) : [null, null];
      const [la, lo] = cellToLatLng(c);
      return { tot, lat: la, lon: lo, adm1: a, adm1_name: an, country: ac ?? (rg.iso3[i] ? nm.iso3[rg.iso3[i]!] ?? null : null) };
    })
    .filter((x) => x.tot > 0);
  const total = sub.reduce((s, x) => s + x.tot, 0);
  const out: AreaPlaces = { area_id: id, level: "province", period: `2000-11 – ${latest}`, total: pyRound(total, 1), places: [], hottest: null, n_places: 0 };
  if (total <= 0) return out;
  const g = new Map<string, { name: string | null; country: string | null; tot: number; cells: number }>();
  for (const x of sub) {
    if (!x.adm1) continue;
    const o = g.get(x.adm1) ?? { name: x.adm1_name, country: x.country, tot: 0, cells: 0 };
    o.tot += x.tot;
    o.cells++;
    g.set(x.adm1, o);
  }
  const list = [...g].sort((a, b) => b[1].tot - a[1].tot);
  out.n_places = list.length;
  out.places = list.slice(0, k).map(([code, o]) => ({ code, name: o.name || o.country || "", country: o.country ?? "", share: pyRound(o.tot / total, 4), mean_annual: pyRound(o.tot / years, 1), cells: o.cells }));
  const h = sub.reduce((a, b) => (b.tot > a.tot ? b : a));
  const [cx, cy] = area.centroid;
  const dx = (h.lon - cx) * Math.cos((cy * Math.PI) / 180), dy = h.lat - cy;
  const far = Math.hypot(dx, dy);
  const half = Math.max(1e-6, (area.bbox[2] - area.bbox[0] + area.bbox[3] - area.bbox[1]) / 2);
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  const where = far < 0.15 * half ? "near the centre" : `in the ${COMPASS[Math.floor((((deg + 360 + 22.5) % 360) + 360) % 360 / 45)]}`;
  const meanCell = total / Math.max(1, sub.length);
  out.hottest = {
    lat: pyRound(h.lat, 3), lon: pyRound(h.lon, 3), province: h.adm1_name, country: h.country ?? "", share: pyRound(h.tot / total, 4),
    times_average: pyRound(h.tot / meanCell, 1), mean_annual: pyRound(h.tot / years, 1), where,
  };
  return out;
}

export async function season(id: string): Promise<Season> {
  const [m, d] = await Promise.all([meta(), drawn(id)]);
  const daily = await loadDaily(id, d.area.cells_r5);
  return seasonResponse(id, daily.first, daily.h, m.season, m.baseline_years);
}

// ---------------- twins (main.py /twins) ----------------
interface TwinsIndex {
  scaler: { weights: Record<string, number>; s_shape: number; density: [number, number]; R: [number, number]; cv: [number, number]; trend: [number, number] };
  regimes: Record<string, { name: string; description: string }>;
  cent: Record<string, number[]>;
  h3_r3: string[];
  name: string[];
  lat: number[];
  lon: number[];
  total_meh: number[];
  regime_id: number[];
  R: number[];
  density: number[];
  cv: number[];
  trend: number[];
  bimodal: boolean[];
  mean_annual: number[];
  X: number[][];
  S: number[][];
}
export async function twins(id: string, mode: "calendar" | "season", k = 5): Promise<Twins> {
  const [m, T, d] = await Promise.all([meta(), json<TwinsIndex>("engine/twins.json"), drawn(id)]);
  const [b0, b1] = m.baseline_years;
  const g = new Map<number, number[]>();
  for (let y = b0; y <= b1; y++) g.set(y, new Array(12).fill(0));
  for (const x of d.region.rows) {
    const y = +x.month.slice(0, 4);
    if (y >= b0 && y <= b1) g.get(y)![+x.month.slice(5, 7) - 1] = x.h;
  }
  const q = features(g, d.area.area_km2);
  if (!q || q.mean_annual < 1) throw new EngineError("not_found", "Too few fires in this area to find twins.");
  const sc = T.scaler, w = sc.weights;
  const z = (key: "density" | "R" | "cv" | "trend", v: number) => (v - sc[key][0]) / sc[key][1];
  const ws = Math.sqrt(w.shape) / sc.s_shape;
  const qv = [...q.shape12.map((v) => v * ws), Math.sqrt(w.density) * z("density", q.density), Math.sqrt(w.concentration) * z("R", q.R),
    Math.sqrt(w.variability) * z("cv", q.cv), Math.sqrt(w.trend) * z("trend", Math.min(100, Math.max(-100, q.trend)))];
  const n = T.X.length;
  const qpk = argmax(q.shape12);
  const shift = new Int32Array(n);
  const dist2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const X = T.X[i];
    let s = 0;
    if (mode === "season") {
      const sh = (((qpk - argmax(T.S[i])) % 12) + 12) % 12;
      shift[i] = sh;
      for (let j = 0; j < 12; j++) s += (T.S[i][(((j - sh) % 12) + 12) % 12] * ws - qv[j]) ** 2;
    } else for (let j = 0; j < 12; j++) s += (X[j] - qv[j]) ** 2;
    for (let j = 12; j < X.length; j++) s += (X[j] - qv[j]) ** 2;
    dist2[i] = Math.sqrt(s);
  }
  const [lon, lat] = d.area.centroid;
  const km = T.lat.map((la, i) => haversineKm(lat, lon, la, T.lon[i]));
  const order: number[] = [];
  const seen = new Set<string>();
  for (const i of Array.from({ length: n }, (_, i) => i).sort((a, b) => dist2[a] - dist2[b])) {
    if (km[i] < m.twins.exclude_km || seen.has(T.name[i])) continue;
    seen.add(T.name[i]);
    order.push(i);
    if (order.length === k) break;
  }
  const r3s = new Set(d.area.cells_r5.map((c) => cellToParent(c, 3)));
  const wReg = new Map<number, number>();
  T.h3_r3.forEach((c, i) => {
    if (r3s.has(c)) wReg.set(T.regime_id[i], (wReg.get(T.regime_id[i]) ?? 0) + T.total_meh[i]);
  });
  let qreg: number, qshare: number | null;
  if (wReg.size) {
    const top = [...wReg].sort((a, b) => b[1] - a[1])[0];
    qreg = top[0];
    qshare = top[1] / [...wReg.values()].reduce((a, b) => a + b, 0);
  } else {
    const ds = Object.entries(T.cent).map(([rid, c]) => [Number(rid), c.reduce((s, v, j) => s + (v - qv[j]) ** 2, 0)] as const);
    qreg = ds.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
    qshare = null;
  }
  const twinsOut = order.map((i) => {
    const shp = T.S[i];
    const tf = { shape12: shp, peak_month: argmax(shp) + 1, R: T.R[i], density: T.density[i], cv: T.cv[i], trend: T.trend[i], bimodal: T.bimodal[i], mean_annual: T.mean_annual[i] };
    let sh = shift[i];
    if (sh > 6) sh -= 12;
    return {
      h3_r3: T.h3_r3[i], name: T.name[i], lat: T.lat[i], lon: T.lon[i], similarity: Math.trunc(pyRound(100 / (1 + dist2[i]))), distance_km: Math.trunc(pyRound(km[i])),
      shape12: shp.map((v) => pyRound(v, 4)), shift_months: sh, regime_id: T.regime_id[i], regime_name: T.regimes[String(T.regime_id[i])].name, why: why(q, tf, sh, mode),
    };
  });
  return {
    area_id: id,
    mode,
    query: {
      shape12: q.shape12.map((v) => pyRound(v, 4)), peak_month: qpk + 1, regime_id: qreg, regime_name: T.regimes[String(qreg)].name,
      regime_description: T.regimes[String(qreg)].description, regime_share: qshare === null ? null : pyRound(qshare, 3),
      R: pyRound(q.R, 3), trend_pct_per_decade: pyRound(q.trend, 1), bimodal: q.bimodal,
    } as Twins["query"],
    twins: twinsOut,
  };
}

/** The inputs of the "right now" answer for a drawn area (main.py /now): NOAA-20 factor and recent relative uncertainty. */
export async function nowInputs(id: string) {
  const [m, d] = await Promise.all([meta(), drawn(id)]);
  const recent = d.region.rows.filter((x) => x.month >= "2026-05" && x.month <= "2026-10");
  const n20 = recent.reduce((s, x) => s + x.raw[2], 0), hs = recent.reduce((s, x) => s + x.h, 0);
  const fac = n20 >= 50 ? hs / n20 : m.global_nrt_factor;
  const ratios = recent.map((x) => x.sd / Math.max(x.h, 1e-9)).sort((a, b) => a - b);
  const rel = ratios.length ? (ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2) : 0.1;
  return { area: d.area, inputs: { nrt_factor: fac, rel_sd: rel, bbox: d.area.bbox, unit: null as string | null, pct_bounds: m.pct_bounds as unknown as Record<string, number> } };
}

/** Rough upper bound of hotspot rows (hotspots.py estimate_rows): raw detections of all sensors in the date range. */
export async function estimateRows(key: string, cells: string[], d0: string, d1: string): Promise<number> {
  const rg = await loadRegion(key, cells);
  return rg.rows.filter((x) => x.month >= d0.slice(0, 7) && x.month <= d1.slice(0, 7)).reduce((s, x) => s + x.raw[0] + x.raw[1] + x.raw[2] + x.raw[3], 0);
}
export { r };
