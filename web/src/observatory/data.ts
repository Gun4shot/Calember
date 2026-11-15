// Static data for the Observatory (all from web/public/static, built by the pipeline) + a few cached API calls.
import { api, statics } from "../app/api";
import type { Calendar, Drift, FireRegime, SearchEntry } from "../app/types";
import { type Indexed, indexFeatures } from "./geo";

export interface GlobeData {
  cells: string[];
  lat: Float32Array;
  lon: Float32Array;
  months: string[];
  bytes: Uint8Array; // n_months × n_cells, log1p_u8
  nCells: number;
  nMonths: number;
  hMax: number;
  latest: string;
}

const once = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => (p ??= f().catch((e) => { p = null; throw e; }));
};

export const loadGlobe = once(async (): Promise<GlobeData> => {
  const [c, m, bytes, meta] = await Promise.all([statics.globeCells(), statics.globeMonths(), statics.globeBytes(), statics.globeMeta()]);
  const n = c.cells.length;
  return {
    cells: c.cells,
    lat: Float32Array.from(c.lat),
    lon: Float32Array.from(c.lon),
    months: m.months,
    bytes,
    nCells: n,
    nMonths: m.months.length,
    hMax: meta.h_max,
    latest: meta.latest_month,
  };
});

/** Decode a globe byte back to MEH (inverse of log1p_u8). */
export const decode = (b: number, hMax: number) => Math.expm1((b / 255) * Math.log1p(hMax));

/**
 * Anomaly class per cell-month for the "vs normal" globe layer (Guideline §4.7 categories, baseline 2003–2025,
 * leave-one-out), computed in the browser from the globe layer. Byte values are log-quantized, so this is an
 * approximation used for colour only; area numbers always come from the API.
 * Codes: 0 none, 1 much below, 2 below, 3 normal, 4 above, 5 much above, 6 record.
 */
let anomCache: Uint8Array | null = null;
export function globeAnomaly(g: GlobeData): Uint8Array {
  if (anomCache) return anomCache;
  const out = new Uint8Array(g.bytes.length);
  const monthNum = g.months.map((m) => Number(m.slice(5, 7)) - 1);
  const year = g.months.map((m) => Number(m.slice(0, 4)));
  const base: number[][] = Array.from({ length: 12 }, () => []);
  g.months.forEach((_, i) => {
    if (year[i] >= 2003 && year[i] <= 2025) base[monthNum[i]].push(i);
  });
  const vals = new Float32Array(32);
  for (let c = 0; c < g.nCells; c++) {
    for (let mi = 0; mi < g.nMonths; mi++) {
      const x = g.bytes[mi * g.nCells + c];
      const idx = base[monthNum[mi]];
      let n = 0, below = 0, equal = 0, max = 0;
      for (const j of idx) {
        if (j === mi) continue;
        const v = g.bytes[j * g.nCells + c];
        vals[n++] = v;
        if (v < x) below++;
        else if (v === x) equal++;
        if (v > max) max = v;
      }
      if (x === 0 && max === 0) continue; // never burns here in this month
      const pct = (100 * (below + 0.5 * equal)) / Math.max(1, n);
      out[mi * g.nCells + c] = x > max && x > 0 ? 6 : pct > 90 ? 5 : pct > 75 ? 4 : pct >= 25 ? 3 : pct >= 10 ? 2 : 1;
    }
  }
  anomCache = out;
  return out;
}

export const loadWorld = once(async () => {
  const area = await api.areaByAdmin("WORLD");
  return (await api.calendar(area.area_id)) as Calendar;
});

export const loadSearch = once(() => statics.search() as Promise<SearchEntry[]>);
export const loadDrift = once(() => statics.drift() as Promise<Drift>);
export const loadRegimes = once(async () => {
  const [list, map] = await Promise.all([statics.regimes() as Promise<FireRegime[]>, statics.regimeMap()]);
  const byCell = new Map<string, number>();
  map.cells.forEach((c, i) => byCell.set(c, map.regime_id[i]));
  return { list, byCell };
});

export const loadAdmin0 = once(async () =>
  indexFeatures(await statics.admin0(), (p) => `ISO-${String(p.country_iso3)}`, (p) => String(p.name)),
);
export const loadAdmin1 = once(async () =>
  indexFeatures(await statics.admin1(), (p) => String(p.admin_id), (p) => `${String(p.name)}, ${String(p.country_name ?? p.country_iso3 ?? "")}`),
);

/** Outline polygons for an admin id (province or ISO-xxx country), if we have them. */
export async function outlineOf(adminId: string): Promise<Indexed | null> {
  if (adminId.startsWith("ISO-")) return (await loadAdmin0()).find((f) => f.id === adminId) ?? null;
  if (adminId === "WORLD" || adminId.startsWith("BIOME-")) return null;
  return (await loadAdmin1()).find((f) => f.id === adminId) ?? null;
}

// Regime palette (10 regimes): distinct hues, ordered around the colour wheel.
export const REGIME_COLORS = ["#7fd8ff", "#ffb347", "#c792ea", "#ff6f61", "#ffd166", "#06d6a0", "#ef476f", "#4cc9f0", "#f4a261", "#9ef01a", "#b5838d", "#90a4ae"];
