// hotspots.csv in the browser (api/ember_api/hotspots.py): the cleaned detections of an area from the partitions in the
// public data archive (pipeline/build_hotspot_parts.py), with the same columns, order, det_id and meh_weight as the API.
import { cellToParent } from "h3-js";
import { blake2b64 } from "./blake2b";
import { fetchCal2, pool } from "./cal2";
import { EngineError, estimateRows, meta } from "./region";
import { pyRepr } from "./stats";

const ENV = import.meta.env;
export const HOTSPOT_BASE = ((ENV.VITE_HOTSPOT_BASE as string | undefined) ?? "https://huggingface.co/datasets/Sidant/calember-hotspots/resolve/main").replace(/\/$/, "");
export const COLS = ["det_id", "acq_datetime_utc", "date", "local_solar_hour", "lat", "lon", "instrument", "satellite", "source", "daynight",
  "confidence", "frp_mw", "bt_mir_k", "bt_tir_k", "scan_km", "track_km", "h3_r5", "regime", "meh_weight", "provisional"];
const SAT = ["TERRA", "AQUA", "SNPP", "NOAA20", "NOAA21"];
const REG = ["", "T", "M", "B", "V", "N"];
// block -> instrument, source label, sensor family, ordering group, the SP block whose last day hides older NRT rows
const BLOCK: { inst: "MODIS" | "VIIRS"; src: "SP" | "NRT"; group: number; spOf?: number }[] = [
  { inst: "MODIS", src: "SP", group: 0 },
  { inst: "VIIRS", src: "SP", group: 0 },
  { inst: "VIIRS", src: "SP", group: 0 },
  { inst: "VIIRS", src: "SP", group: 1 },
  { inst: "VIIRS", src: "NRT", group: 1, spOf: 3 },
  { inst: "MODIS", src: "SP", group: 2 },
  { inst: "MODIS", src: "NRT", group: 2, spOf: 5 },
  { inst: "VIIRS", src: "SP", group: 2 },
  { inst: "VIIRS", src: "NRT", group: 2, spOf: 7 },
  { inst: "VIIRS", src: "SP", group: 2 },
  { inst: "VIIRS", src: "NRT", group: 2, spOf: 9 },
];

interface HHead {
  year: number;
  first_day: string;
  cells: string[];
}
const DAY = 864e5;
const T0 = Date.UTC(2000, 10, 1);
const dayIndex = (iso: string) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - T0) / DAY);
const isoDay = (k: number) => new Date(T0 + k * DAY).toISOString().slice(0, 10);

/** "-12.34567" from an integer of 1e-5 units (Python f"{v:.5f}" of the lossless value) */
function fixed5(i: number): string {
  const s = i < 0 ? "-" : "";
  const a = Math.abs(i);
  return `${s}${Math.floor(a / 1e5)}.${String(a % 1e5).padStart(5, "0")}`;
}

export interface HotspotRequest {
  key: string; // cache key for the area's tiles
  cells: string[];
  start?: string;
  end?: string;
  sensors?: string;
  onProgress?: (done: number, total: number) => void;
}

/** Validates like main.py _hotspot_args and returns [d0, d1, sensors]. */
export async function hotspotArgs(req: HotspotRequest): Promise<[string, string, Set<string>]> {
  const m = await meta();
  if (!req.cells.length) throw new EngineError("area_too_large", "Hotspot downloads are available for provinces, drawn areas and smaller countries. For this area, download the calendar instead.");
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if ((req.start && !ok(req.start)) || (req.end && !ok(req.end))) throw new EngineError("invalid_geometry", "start and end must be dates like 2024-03-01.");
  const d1 = req.end || m.last_day;
  const d0 = req.start || isoDay(dayIndex(d1) - 364);
  if (d0 > d1) throw new EngineError("invalid_geometry", "start must be before end.");
  const sens = new Set((req.sensors ?? "MODIS,VIIRS").split(",").map((s) => s.trim().toUpperCase()).filter((s) => s === "MODIS" || s === "VIIRS"));
  if (!sens.size) (sens.add("MODIS"), sens.add("VIIRS"));
  const est = await estimateRows(req.key, req.cells, d0, d1);
  if (est > m.api.max_csv_rows)
    throw new EngineError("area_too_large", `About ${Math.round(est).toLocaleString("en-US")} hotspots match; the limit is ${m.api.max_csv_rows.toLocaleString("en-US")}. Please narrow the dates.`);
  return [d0, d1, sens];
}

/** The CSV as text parts (header first), ready for a Blob. */
export async function hotspotsCsv(req: HotspotRequest): Promise<string[]> {
  const [d0, d1, sens] = await hotspotArgs(req);
  const want = new Set(req.cells);
  const r2s = [...new Set(req.cells.map((c) => cellToParent(c, 2)))];
  const years: number[] = [];
  for (let y = +d0.slice(0, 4); y <= +d1.slice(0, 4); y++) years.push(y);
  const jobs = years.flatMap((y) => r2s.map((r2) => [y, r2] as const));
  let done = 0;
  req.onProgress?.(0, jobs.length);
  const parts = await pool(jobs, 8, async ([y, r2]) => {
    const t = await fetchCal2<HHead>(`${HOTSPOT_BASE}/${y}/${r2}.bin.gz`).catch(() => {
      throw new EngineError("upstream_unavailable", "The detection archive is not reachable right now. Please try again in a minute.");
    });
    req.onProgress?.(++done, jobs.length);
    return t;
  });
  const k0 = dayIndex(d0), k1 = dayIndex(d1);
  // pick rows: in the area, in the dates, of the requested sensors
  type Pick = { p: number; i: number; g: number; y: number; b: number; key: number };
  const picks: Pick[] = [];
  const lastSp = new Map<number, number>();
  parts.forEach((t, p) => {
    if (!t) return;
    const inArea = t.header.cells.map((c) => want.has(c));
    const c = t.col;
    for (let i = 0; i < t.header.n; i++) {
      if (!inArea[c.ci[i]]) continue;
      const day = c.day[i];
      if (day < k0 || day > k1) continue;
      const b = c.blk[i], B = BLOCK[b];
      if (!sens.has(B.inst)) continue;
      if (B.group > 0 && B.src === "SP") lastSp.set(b, Math.max(lastSp.get(b) ?? -1, day));
      picks.push({ p, i, g: B.group, y: t.header.year, b, key: day * 10000 + c.t[i] });
    }
  });
  // the API's order: archive years (each: MODIS, S-NPP, NOAA-20), then NOAA-21, then the 2026 files; each by date and time
  const rows = picks.filter((x) => {
    const sp = BLOCK[x.b].spOf;
    return sp === undefined || !lastSp.has(sp) || Math.floor(x.key / 10000) > lastSp.get(sp)!;
  });
  const P = (x: Pick) => parts[x.p]!.col;
  rows.sort((a, b) => a.g - b.g || (a.g === 0 ? a.y - b.y : 0) || a.b - b.b || a.key - b.key || P(a).lat[a.i] - P(b).lat[b.i] || P(a).lon[a.i] - P(b).lon[b.i] || P(a).sat[a.i] - P(b).sat[b.i]);
  const out: string[] = [COLS.join(",") + "\n"];
  let buf: string[] = [];
  for (const x of rows) {
    const t = parts[x.p]!, c = t.col, i = x.i;
    const B = BLOCK[x.b];
    const sat = SAT[c.sat[i]];
    const date = isoDay(c.day[i]);
    const tt = String(c.t[i]).padStart(4, "0");
    const lat = c.lat[i], lon = c.lon[i];
    const conf = c.conf[i] === 201 ? "n" : c.conf[i] === 202 ? "h" : String(c.conf[i]);
    const dn = c.dn[i] === 0 ? "D" : c.dn[i] === 1 ? "N" : "";
    buf.push(
      [
        blake2b64(`${sat}|${date}|${tt}|${fixed5(lat)}|${fixed5(lon)}`),
        `${date}T${tt.slice(0, 2)}:${tt.slice(2)}:00Z`,
        date,
        pyRepr(c.lsh[i] / 100),
        pyRepr(lat / 1e5),
        pyRepr(lon / 1e5),
        B.inst,
        sat,
        B.src,
        dn,
        conf,
        pyRepr(c.frp[i] / 100),
        pyRepr(c.bm[i] / 100),
        pyRepr(c.bt[i] / 100),
        pyRepr(c.sc[i] / 100),
        pyRepr(c.tr[i] / 100),
        t.header.cells[c.ci[i]],
        REG[c.reg[i]],
        pyRepr(c.w[i] / 1e4),
        c.prov[i] ? "true" : "false",
      ].join(","),
    );
    if (buf.length >= 20000) {
      out.push(buf.join("\n") + "\n");
      buf = [];
    }
  }
  if (buf.length) out.push(buf.join("\n") + "\n");
  return out;
}
