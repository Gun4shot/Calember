// Every download of the static site, made in the browser with the API's formats (main.py exports):
// calendar.csv, season.csv, calendar.stl, hotspots.csv and bundle.zip, for named places and drawn areas alike.
import type { Area, Calendar, Season } from "../types";
import { hotspotsCsv } from "./hotspots";
import { BUNDLE_README } from "./readme";
import { drawn, isDrawnId, meta } from "./region";
import * as region from "./region";
import { calendarCsv, type MonthRow } from "./science";
import { pyRepr, pyRound } from "./stats";
import { stl } from "./stl";

export type ExportKind = "calendar.csv" | "season.csv" | "calendar.stl" | "hotspots.csv" | "bundle.zip";

/** What the exports need about an area; named places come from the snapshot, drawn areas from the engine. */
export interface ExportSource {
  area: Area;
  calendar: () => Promise<Calendar>;
  /** unrounded monthly rows when known (drawn areas) */
  rows?: () => Promise<MonthRow[]>;
  season: () => Promise<Season | null>;
}

function save(name: string, parts: BlobPart[], type: string) {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const fnum = (v: number | null, nd = 3) => (v === null || v === undefined ? "" : pyRepr(pyRound(v, nd)));
async function calendarCsvOf(src: ExportSource): Promise<string> {
  const m = await meta();
  if (src.rows) return calendarCsv((await src.rows()).filter((x) => x.month <= m.product.latest_complete_month), m.baseline_years, m.pct_bounds);
  const cal = await src.calendar();
  const head = "year,month,month_num,regime,h_count,lo90,hi90,raw_modis,raw_snpp,raw_noaa20,raw_noaa21,median_m,ratio_to_median,pct_rank,robust_z,category,provisional";
  const lines = cal.months.map((x) =>
    [x.month.slice(0, 4), x.month, +x.month.slice(5, 7), x.regime, fnum(x.h_count), fnum(x.lo90), fnum(x.hi90), x.raw.modis, x.raw.snpp, x.raw.noaa20, x.raw.noaa21,
      fnum(x.median_m), fnum(x.ratio_to_median), fnum(x.pct_rank, 1), fnum(x.robust_z), x.category ?? "", String(x.provisional)].join(","),
  );
  return [head, ...lines].join("\n") + "\n";
}
const SEASON_COLS = ["fire_year", "start_date", "onset", "peak", "end", "onset_doy", "peak_doy", "end_doy", "length_days", "total", "insufficient"] as const;
async function seasonCsvOf(src: ExportSource): Promise<string> {
  const s = await src.season();
  const lines = (s?.years ?? []).map((y) =>
    SEASON_COLS.map((c) => {
      const v = (y as unknown as Record<string, unknown>)[c];
      if (v === null || v === undefined) return "";
      if (typeof v === "boolean") return String(v);
      return c === "total" ? pyRepr(v as number) : String(v);
    }).join(","),
  );
  return [SEASON_COLS.join(","), ...lines].join("\n") + "\n";
}
async function stlOf(src: ExportSource): Promise<ArrayBuffer> {
  const vals = new Map<string, number>();
  const months = src.rows ? (await src.rows()).map((x) => [x.month, x.h] as const) : (await src.calendar()).months.map((x) => [x.month, x.h_count] as const);
  for (const [mo, h] of months) if (mo >= "2001-01" && mo <= "2025-12") vals.set(mo, h);
  return stl(vals, src.area.name);
}

// ---------------- zip (stored + deflate via CompressionStream) ----------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function zip(files: [string, Uint8Array][]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  const now = new Date();
  const dosT = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosD = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, data] of files) {
    const nm = new TextEncoder().encode(name);
    const comp = await deflate(data);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 8, true);
    lh.setUint16(10, dosT, true);
    lh.setUint16(12, dosD, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nm.length, true);
    parts.push(lh.buffer, nm, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 8, true);
    ch.setUint16(12, dosT, true);
    ch.setUint16(14, dosD, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nm.length, true);
    ch.setUint32(42, off, true);
    const c = new Uint8Array(46 + nm.length);
    c.set(new Uint8Array(ch.buffer));
    c.set(nm, 46);
    central.push(c);
    off += 30 + nm.length + comp.length;
  }
  const cs = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cs, true);
  end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

// ---------------- the downloads ----------------
export interface ExportOptions {
  start?: string;
  end?: string;
  sensors?: string;
  onProgress?: (done: number, total: number) => void;
}

/** Runs one download; throws region.EngineError with a message for the user when the request can't be served. */
export async function runExport(src: ExportSource, kind: ExportKind, o: ExportOptions = {}): Promise<void> {
  const id = src.area.area_id;
  const tag = id.replace(/[^\w-]+/g, "_");
  const enc = new TextEncoder();
  if (kind === "calendar.csv") return save(`calember_calendar_${tag}.csv`, [await calendarCsvOf(src)], "text/csv");
  if (kind === "season.csv") return save(`calember_season_${tag}.csv`, [await seasonCsvOf(src)], "text/csv");
  if (kind === "calendar.stl") return save(`calember_calendar_${tag}.stl`, [await stlOf(src)], "model/stl");
  const cells = src.area.cells_r5;
  const parts = await hotspotsCsv({ key: isDrawnId(id) ? id : `named:${id}`, cells, start: o.start, end: o.end, sensors: o.sensors, onProgress: o.onProgress });
  const m = await meta();
  const d1 = o.end || m.last_day;
  const d0 = o.start || new Date(Date.parse(d1) - 364 * 864e5).toISOString().slice(0, 10);
  if (kind === "hotspots.csv") return save(`calember_hotspots_${tag}_${d0}_${d1}.csv`, parts, "text/csv");
  const hot = new Uint8Array(await new Blob(parts).arrayBuffer());
  const metaJson = {
    request: { area_id: id, hotspots_start: d0, hotspots_end: d1, baseline: `${m.baseline_years[0]}-${m.baseline_years[1]}` },
    area: src.area,
    data_version: m.data_version,
    product_version: m.product.version,
    model: m.product.model,
    config_hash: m.config_hash,
    generated: new Date().toISOString().slice(0, 19) + "Z",
  };
  const blob = await zip([
    ["calendar.csv", enc.encode(await calendarCsvOf(src))],
    ["hotspots.csv", hot],
    ["season.csv", enc.encode(await seasonCsvOf(src))],
    ["README.txt", enc.encode(BUNDLE_README)],
    ["metadata.json", enc.encode(JSON.stringify(metaJson, null, 1))],
  ]);
  save(`calember_${tag}.zip`, [blob], "application/zip");
}

/** Export source for a drawn area (engine) */
export async function drawnSource(id: string): Promise<ExportSource> {
  const d = await drawn(id);
  return {
    area: d.area,
    calendar: () => region.calendar(id),
    rows: async () => d.region.rows,
    season: () => region.season(id),
  };
}
