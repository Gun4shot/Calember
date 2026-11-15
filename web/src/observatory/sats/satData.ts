// The five fire satellites. Facts: Guideline §2.1 (sensor table), D-010 (S-NPP end), D-022 (NOAA-20/21 starts).
// Equator-crossing times are *measured* from the fire detections themselves (drift.json, median local solar hour
// of daytime detections per satellite and month). Orbits on screen are illustrative: circular, sun-synchronous,
// altitude ×3, and sped up.

import type { Drift } from "../../app/types";

export type SatId = "TERRA" | "AQUA" | "SNPP" | "NOAA20" | "NOAA21";

export interface Sat {
  id: SatId;
  name: string;
  instrument: "MODIS" | "VIIRS";
  altKm: number;
  swathKm: number;
  pixel: string;
  start: string; // first month in the fire record
  end?: string; // last month (FIRMS production)
  retire?: string; // planned end of science operations
  nominalHour: number; // daytime equator crossing at launch (local solar time)
  descendingDay: boolean; // Terra crosses the equator southbound in the morning
  phase: number; // position along the orbit at t = 0 (radians), so the train is spaced as in reality
  note: string;
}

export const SATS: Sat[] = [
  {
    id: "TERRA", name: "Terra", instrument: "MODIS", altKm: 705, swathKm: 2330, pixel: "1 km at nadir", start: "2000-11", retire: "2027",
    nominalHour: 10.5, descendingDay: true, phase: 1.1,
    note: "The first fire eye of the record. Morning orbit. Stopped orbit maneuvers in Feb 2020 and has drifted earlier since.",
  },
  {
    id: "AQUA", name: "Aqua", instrument: "MODIS", altKm: 705, swathKm: 2330, pixel: "1 km at nadir", start: "2002-07", retire: "2027",
    nominalHour: 13.5, descendingDay: false, phase: 0,
    note: "Afternoon orbit, flying minutes ahead of S-NPP for years: the natural paired experiment. Drifting later since 2021.",
  },
  {
    id: "SNPP", name: "Suomi NPP", instrument: "VIIRS", altKm: 824, swathKm: 3060, pixel: "375 m at nadir", start: "2012-01", end: "2026-11",
    nominalHour: 13.5, descendingDay: false, phase: -0.12,
    note: "The bridge: continuous since 2012 and orbit-twinned with Aqua. FIRMS stopped S-NPP fire production on 2 Nov 2026.",
  },
  {
    id: "NOAA20", name: "NOAA-20", instrument: "VIIRS", altKm: 824, swathKm: 3060, pixel: "375 m at nadir", start: "2018-04",
    nominalHour: 13.5, descendingDay: false, phase: Math.PI,
    note: "About 50 minutes (half an orbit) from S-NPP in the same plane. Carries Calember's near-real-time record.",
  },
  {
    id: "NOAA21", name: "NOAA-21", instrument: "VIIRS", altKm: 824, swathKm: 3060, pixel: "375 m at nadir", start: "2023-03",
    nominalHour: 13.5, descendingDay: false, phase: Math.PI / 2,
    note: "The newest VIIRS, roughly midway between S-NPP and NOAA-20. The record continues on it.",
  },
];

export const SAT_COLOR: Record<"MODIS" | "VIIRS", [number, number, number]> = {
  MODIS: [1.0, 0.62, 0.18],
  VIIRS: [0.5, 0.85, 1.0],
};

/** Measured daytime equator-crossing hour per satellite, smoothed by year (12-month median). */
export function measuredHours(drift: Drift) {
  const by = new Map<SatId, Map<string, number>>();
  for (const o of drift.overpass) {
    if (o.n < 1000) continue;
    const id = o.satellite as SatId;
    if (!by.has(id)) by.set(id, new Map());
    by.get(id)!.set(o.month, o.median_local_hour);
  }
  // per year: median of the months (robust to single noisy months)
  const yearly = new Map<SatId, Map<number, number>>();
  for (const [id, m] of by) {
    const ys = new Map<number, number[]>();
    for (const [month, h] of m) {
      const y = Number(month.slice(0, 4));
      if (!ys.has(y)) ys.set(y, []);
      ys.get(y)!.push(h);
    }
    const out = new Map<number, number>();
    for (const [y, hs] of ys) {
      hs.sort((a, b) => a - b);
      out.set(y, hs[Math.floor(hs.length / 2)]);
    }
    yearly.set(id, out);
  }
  /** Hour for a satellite at a fractional year (interpolated, clamped to the measured range). */
  return (id: SatId, yearF: number): number | null => {
    const m = yearly.get(id);
    if (!m || m.size === 0) return null;
    const ys = [...m.keys()].sort((a, b) => a - b);
    const y = yearF - 0.5;
    if (y <= ys[0]) return m.get(ys[0])!;
    if (y >= ys[ys.length - 1]) return m.get(ys[ys.length - 1])!;
    const i = ys.findIndex((v) => v > y);
    const a = ys[i - 1], b = ys[i];
    const k = (y - a) / (b - a);
    return m.get(a)! * (1 - k) + m.get(b)! * k;
  };
}

export const hhmm = (h: number) => {
  const H = Math.floor(h);
  const M = Math.round((h - H) * 60);
  return `${String(M === 60 ? H + 1 : H).padStart(2, "0")}:${String(M === 60 ? 0 : M).padStart(2, "0")}`;
};

// ---- orbital model (Earth-fixed frame, y = north) ----
export const SIM_DAY_S = 150; // one simulated day per 150 s of real time (illustrative speed-up)
export const PERIOD_MIN = { MODIS: 98.8, VIIRS: 101.4 };
export const INCL = 98.2 * (Math.PI / 180);
/** Right ascension of the ascending node (inertial lon, radians) for a daytime crossing hour. */
export function raanFor(sat: Sat, dayHour: number) {
  const ltan = sat.descendingDay ? dayHour + 12 : dayHour; // the ascending node is the night pass for Terra
  return (((ltan - 12) * 15) * Math.PI) / 180;
}
