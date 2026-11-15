// Loads the static story files built by pipeline/build_story_data.py.
// Every number shown in the film comes from these files.

export interface RidgeRegion {
  id: string;
  name: string;
  n_cells_r5?: number;
  modis: number[];
  viirs_snpp: number[];
  viirs_noaa20: number[];
  raw_sum: number[];
  /** shown on the ridge: product, except 2012–2019 = cross-fitted model alone (independent of this region's MODIS) */
  harmonized: number[];
  /** the harmonized product itself (h_count) in every month: use for record totals */
  product?: number[];
  regime?: string[];
}
export interface RidgeFile {
  months: string[];
  switch_month: string;
  model: string;
  unit: string;
  notes: string;
  product_version?: string;
  /** first month with data per sensor in the product */
  sensor_first?: { MODIS: string; SNPP: string; NOAA20: string; NOAA21: string };
  regions: RidgeRegion[];
}
export interface GlobeMeta {
  h_max: number;
  n_cells: number;
  n_months: number;
  model: string;
  monthly_total_harm: number[];
  monthly_total_raw: number[];
}
export interface Facts {
  seam_2012: { raw_sum_pp: number; harmonized_pp: number; n_units: number; definition: string };
  h2: {
    year: number;
    n_units: number;
    auc_oof: number;
    detect_rate_by_npix: Record<string, number>;
    detect_rate_day_night: Record<string, number>;
  };
  drift: { aqua_2003: string; aqua_2025: string; terra_2003: string; terra_2025: string };
}
type Sc = { kge: number; r2: number; bias_pct: number };
type Scales = { primary: number; adm1: Sc; country: Sc; biome: Sc; r5: Sc };
type Trio = { global_ratio: Scales; sota_style: Scales; ember: Scales };
export interface Results {
  built: string;
  data: {
    raw_rows_total: number;
    raw_rows_by_sensor: Record<string, number>;
    satellites: string[];
    mask_cells: number;
    r5_land_cells: number;
    r5_cell_km2: number;
    product_rows: number;
    product_months: number;
    product_first: string;
    product_last: string;
    product_version: string;
    regimes: { code: string; label: string; from: string; to: string }[];
    train_years: string;
    folds: number;
  };
  b2: { test: string; models: Trio };
  b3: { test: string; models: Trio; excl_aqua_outage: { global_ratio: number; sota_style: number; ember: number; note: string } };
  seam: { raw_pp: number; global_ratio_pp: number; ember_pp: number; placebo_2015_pp: number; placebo_2017_pp: number; handover_2020_pp: number };
  turing: {
    n_regions: number;
    ember: number;
    ember_seeds: number[];
    sota_style: number;
    raw_viirs: number;
    ci_half_width: number;
    ember_b3: number;
    smooth_values_ember: number;
    smooth_values_sota: number;
  };
  coverage90: { b2_adm1: number; b3_adm1: number };
  calendar_kappa: { ember: number; sota_style: number };
}
export interface TuringRound {
  kind: "raw" | "ember";
  region: string;
  start: string;
  a: number[];
  b: number[];
  real_is: "a" | "b";
  other_label: string;
}

export interface PunjabDay {
  date: string;
  region: string;
  bbox: [number, number, number, number];
  outline: [number, number][][];
  /** lat, lon, scan_km, track_km */
  modis: [number, number, number, number][];
  viirs: [number, number, number, number][];
  cleaning: string;
  source: string;
}
export interface Extras {
  punjab_day: PunjabDay;
  aqua_outage: {
    days: string[];
    terra: number[];
    aqua: number[];
    /** Aqua's centred 61-day median: what a normal day looked like */
    aqua_normal: number[];
    /** Calember daily world total (MODIS-equivalent) */
    ember: number[];
    ember_note: string;
    outage: [string, string];
    unit: string;
    source: string;
  };
  /** detections on the day of the globe imagery (22 Aug 2019) */
  sensor_day: { date: string; modis_aqua: number; viirs_snpp: number; cleaning: string };
  /** the globe dive: daytime detections in the Punjab close-up on 7 Nov 2016 (lat, lon, scan_km, track_km) */
  globe_dive: {
    date: string;
    box: [number, number, number, number];
    modis: [number, number, number, number][];
    viirs: [number, number, number, number][];
    modis_in_state: number;
    viirs_in_state: number;
    /** the 0.5° window with the most VIIRS detections: where the camera dives */
    focus: { lat: number; lon: number; box_deg: number; viirs: number; modis: number };
  };
}
/** Accuracy of each method on the sealed 2020 scatter (province-months with MODIS >= minObs). */
export interface MethodStats {
  within25: number;
  off2x: number;
  medMiss: number;
}
export interface ScatterStats {
  minObs: number;
  n: number;
  m: [MethodStats, MethodStats, MethodStats]; // global ratio, SOTA-style, Calember
}

export interface StoryData {
  results: Results;
  extras: Extras;
  scatterStats: ScatterStats;
  /** sealed 2020 test: province-months x [observed, global ratio, SOTA-style, Calember] */
  scatter: Float32Array;
  rounds: TuringRound[];
  ridge: RidgeFile;
  facts: Facts;
  globe: {
    meta: GlobeMeta;
    months: string[];
    lat: Float32Array;
    lon: Float32Array;
    harm: Uint8Array; // months × cells
    raw: Uint8Array;
  };
  land: Float32Array; // lat, lon pairs
  derived: Derived;
}

/** Values computed once from the files and used in captions. */
export interface Derived {
  /** global raw-sum ÷ harmonized, 2013–2019 (how much brighter the stitched record looks) */
  globeRawRatio: number;
  /** Punjab raw-sum ÷ MODIS observed, 2013–2019 */
  heroRawRatio: number;
  /** Punjab harmonized ÷ MODIS observed, 2013–2019 (should be near 1) */
  heroHarmRatio: number;
  switchIndex: number;
  heroIndex: number;
}

const BASE = `${import.meta.env.BASE_URL}static/story/`;

async function json<T>(name: string): Promise<T> {
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return (await r.json()) as T;
}
async function bin(name: string): Promise<ArrayBuffer> {
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

function sumRange(a: number[], months: string[], y0: number, y1: number) {
  let s = 0;
  for (let i = 0; i < months.length; i++) {
    const y = +months[i].slice(0, 4);
    if (y >= y0 && y <= y1) s += a[i];
  }
  return s;
}

export async function loadStory(): Promise<StoryData> {
  const [ridge, facts, meta, gm, cells, harm, raw, land, results, scatter, rounds, extras] = await Promise.all([
    json<RidgeFile>("story_ridge.json"),
    json<Facts>("story_facts.json"),
    json<GlobeMeta>("globe_meta.json"),
    json<{ months: string[] }>("globe_months.json"),
    json<{ lat: number[]; lon: number[] }>("globe_cells.json"),
    bin("globe_harm.u8"),
    bin("globe_raw.u8"),
    bin("land_points.bin"),
    json<Results>("results.json"),
    bin("scatter_b3.bin"),
    json<{ rounds: TuringRound[] }>("turing_rounds.json"),
    json<Extras>("story_extras.json"),
  ]);
  const months = gm.months;
  const heroIndex = Math.max(0, ridge.regions.findIndex((r) => r.id === "punjab"));
  const hero = ridge.regions[heroIndex];
  const globeRawRatio =
    sumRange(meta.monthly_total_raw, months, 2013, 2019) / sumRange(meta.monthly_total_harm, months, 2013, 2019);
  const heroModis = sumRange(hero.modis, ridge.months, 2013, 2019);
  const derived: Derived = {
    globeRawRatio,
    heroRawRatio: sumRange(hero.raw_sum, ridge.months, 2013, 2019) / heroModis,
    heroHarmRatio: sumRange(hero.harmonized, ridge.months, 2013, 2019) / heroModis,
    switchIndex: ridge.months.indexOf(ridge.switch_month),
    heroIndex,
  };
  const sc = new Float32Array(scatter);
  return {
    results,
    extras,
    scatterStats: scatterStats(sc, 10),
    scatter: sc,
    rounds: rounds.rounds,
    ridge,
    facts,
    globe: {
      meta,
      months,
      lat: Float32Array.from(cells.lat),
      lon: Float32Array.from(cells.lon),
      harm: new Uint8Array(harm),
      raw: new Uint8Array(raw),
    },
    land: new Float32Array(land),
    derived,
  };
}

/** Share within ±25 %, share off by more than 2×, and median |pred/obs − 1|, per method. */
export function scatterStats(src: Float32Array, minObs: number): ScatterStats {
  const n4 = src.length / 4;
  const ratios: number[][] = [[], [], []];
  for (let i = 0; i < n4; i++) {
    const o = src[4 * i];
    if (o < minObs) continue;
    for (let m = 0; m < 3; m++) ratios[m].push(src[4 * i + 1 + m] / o);
  }
  const m = ratios.map((r) => {
    let w = 0;
    let off = 0;
    const miss = r.map((x) => Math.abs(x - 1)).sort((a, b) => a - b);
    for (const x of r) {
      if (Math.abs(x - 1) <= 0.25) w++;
      if (x > 2 || x < 0.5) off++;
    }
    return { within25: w / r.length, off2x: off / r.length, medMiss: miss[Math.floor(miss.length / 2)] };
  }) as [MethodStats, MethodStats, MethodStats];
  return { minObs, n: ratios[0].length, m };
}
