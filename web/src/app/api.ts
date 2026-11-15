import type { ApiError, Area, AreaCells, AreaCellsMonth, AreaDaily, AreaPlaces, Rankings, Calendar, Drift, Health, FireRegime, Now, Season, SearchEntry, TuringRound, Twins, ValidationReport } from "./types";

import * as engine from "./engine/region";
import { withVersion } from "./snapVersion";
import { drawnSource, runExport, type ExportKind, type ExportOptions, type ExportSource } from "./engine/exports";
import { STATIC_MODE, SnapMissing, bundle, dailyFrom, nowFrom, snap } from "./snapshot";

// Same-origin /api in dev (Vite proxy) and in production unless VITE_API_BASE points elsewhere.
const API = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";
const STATIC = `${import.meta.env.BASE_URL}static`;

export class ApiFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiFailure("upstream_unavailable", "The Calember data service is not reachable. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as T | ApiError | null;
  if (!res.ok || body === null) {
    const e = (body as ApiError | null)?.error;
    throw new ApiFailure(e?.code ?? "internal", e?.message ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

async function staticJson<T>(name: string): Promise<T> {
  const res = await fetch(withVersion(`${STATIC}/${name}`));
  if (!res.ok) throw new ApiFailure("not_found", `Could not load ${name}.`);
  return (await res.json()) as T;
}

// Static mode (no Python server): named places read the precomputed snapshot, drawn areas are computed in the browser
// from the region tiles (engine/), and live detections and the Turing score come from Cloudflare Pages Functions.
function viaSnap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof SnapMissing) throw new ApiFailure("not_found", e.message.includes(":") ? "This place is not in the record." : e.message);
    if (e instanceof engine.EngineError) throw new ApiFailure(e.code, e.message);
    if (e instanceof ApiFailure) throw e;
    throw new ApiFailure("upstream_unavailable", "Could not load the data for this area. Check your connection and try again.");
  });
}
const isDrawn = engine.isDrawnId;
const drawnArea = (id: string) => viaSnap(async () => (await engine.drawn(id)).area);

/** The export source of any area id (named place or drawn). */
export async function exportSource(id: string): Promise<ExportSource> {
  if (isDrawn(id)) return drawnSource(id);
  const b = await bundle(id);
  return { area: b.area, calendar: async () => b.calendar, season: async () => b.season };
}
/** Runs a download in the browser (static mode). Errors come back as ApiFailure with a message for the user. */
export const exportFile = (id: string, kind: ExportKind, o?: ExportOptions) => viaSnap(async () => runExport(await exportSource(id), kind, o));
export type { ExportKind };

const live = {
  health: () => call<Health>("/api/health"),
  areaByAdmin: (admin_id: string) => call<Area>("/api/areas", { method: "POST", body: JSON.stringify({ admin_id }) }),
  areaByCircle: (lat: number, lon: number, radius_km: number) =>
    call<Area>("/api/areas", { method: "POST", body: JSON.stringify({ circle: { lat, lon, radius_km } }) }),
  areaByPolygon: (coords: [number, number][]) =>
    call<Area>("/api/areas", {
      method: "POST",
      body: JSON.stringify({ geometry: { type: "Polygon", coordinates: [[...coords, coords[0]]] } }),
    }),
  area: (id: string) => call<Area>(`/api/areas/${id}`),
  areaByCells: (h3_cells: string[]) => call<Area>("/api/areas", { method: "POST", body: JSON.stringify({ h3_cells }) }),
  cells: (id: string) => call<AreaCells>(`/api/areas/${id}/cells`),
  cellsMonth: (id: string, month: string) => call<AreaCellsMonth>(`/api/areas/${id}/cells_month?month=${month}`),
  daily: (id: string, month: string) => call<AreaDaily>(`/api/areas/${id}/daily?month=${month}`),
  places: (id: string) => call<AreaPlaces>(`/api/areas/${id}/places`),
  rankings: (month?: string) => call<Rankings>(`/api/rankings${month ? `?month=${month}` : ""}`),
  calendar: (id: string, baseline = "2003-2025") => call<Calendar>(`/api/areas/${id}/calendar?baseline=${baseline}`),
  season: (id: string) => call<Season>(`/api/areas/${id}/season`),
  twins: (id: string, mode: "calendar" | "season") => call<Twins>(`/api/areas/${id}/twins?mode=${mode}&k=5`),
  now: (id: string) => call<Now>(`/api/areas/${id}/now`),
  exportUrl: (id: string, kind: "calendar.csv" | "hotspots.csv" | "season.csv" | "calendar.stl" | "bundle.zip", qs = "") => `${API}/api/areas/${id}/export/${kind}${qs}`,
  turingAnswer: (round_id: string, choice: "a" | "b") =>
    call<{ correct: boolean; modis_is: "a" | "b" }>("/api/turing/answer", { method: "POST", body: JSON.stringify({ round_id, choice }) }),
  turingStats: () => call<Record<"raw" | "harmonized", { n: number; accuracy: number | null }>>("/api/turing/stats"),
};

export const api: typeof live = STATIC_MODE
  ? {
      ...live,
      health: () => viaSnap(snap.health),
      areaByAdmin: (id) => viaSnap(() => snap.area(id)),
      areaByCircle: (lat, lon, km) => drawnArea(engine.circleId(lat, lon, km)),
      areaByPolygon: (coords) => drawnArea(engine.polygonId(coords)),
      areaByCells: (cells) => {
        const id = engine.cellsId(cells);
        return id ? drawnArea(id) : Promise.reject(new ApiFailure("invalid_geometry", "Pick one region at a time."));
      },
      area: (id) => (isDrawn(id) ? drawnArea(id) : viaSnap(() => snap.area(id))),
      cells: (id) => viaSnap(() => (isDrawn(id) ? engine.cells(id) : snap.cells(id))),
      cellsMonth: (id, month) =>
        viaSnap(async () => {
          if (isDrawn(id)) return engine.cellsMonth(id, month);
          // large named places (over 4,000 cells) have no month grid in the snapshot: sum the region tiles instead
          return snap.cellsMonth(id, month).catch(async (e) => {
            if (!(e instanceof SnapMissing)) throw e;
            const c = await snap.cells(id);
            return { ...(await engine.cellsMonth(id, month, 2003, 2025, c.cells)), area_id: id };
          });
        }),
      daily: (id, month) =>
        viaSnap(async () => {
          if (!isDrawn(id)) return snap.daily(id, month);
          const d = await engine.drawn(id);
          return dailyFrom(await engine.loadDaily(id, d.area.cells_r5), id, month);
        }),
      places: (id) => viaSnap(() => (isDrawn(id) ? engine.places(id) : snap.places(id))),
      rankings: (month) => viaSnap(() => snap.rankings(month)),
      calendar: (id) => viaSnap(() => (isDrawn(id) ? engine.calendar(id) : snap.calendar(id))),
      season: (id) => viaSnap(() => (isDrawn(id) ? engine.season(id) : snap.season(id))),
      twins: (id, mode) => viaSnap(() => (isDrawn(id) ? engine.twins(id, mode) : snap.twins(id, mode))),
      now: (id) =>
        viaSnap(async () => {
          if (!isDrawn(id)) return snap.now(id);
          const [{ area, inputs }, cal] = await Promise.all([engine.nowInputs(id), engine.calendar(id)]);
          return nowFrom({ area, calendar: cal, now_inputs: inputs }, await engine.loadDaily(id, area.cells_r5));
        }),
      // the Sensor Turing test: answers and the crowd score are kept by a Pages Function (D1); answers are checked offline too
      turingAnswer: async (round_id, choice) => {
        try {
          return await call<{ correct: boolean; modis_is: "a" | "b" }>("/api/turing/answer", { method: "POST", body: JSON.stringify({ round_id, choice }) });
        } catch {
          const r = (await statics.turing()).rounds.find((x) => x.id === round_id) as (TuringRound & { modis_is?: "a" | "b" }) | undefined;
          if (!r?.modis_is) throw new ApiFailure("not_found", "Unknown round.");
          return { correct: choice === r.modis_is, modis_is: r.modis_is };
        }
      },
    }
  : live;

export const statics = {
  search: () => staticJson<SearchEntry[]>("search_index.json"),
  validation: () => staticJson<ValidationReport>("validation_report.json"),
  drift: () => staticJson<Drift>("drift.json"),
  turing: () => staticJson<{ window_months: number; rounds: TuringRound[] }>("turing_rounds.json"),
  mapStats: () => staticJson<{ baseline: [number, number]; cells: string[]; mean_annual_meh: number[]; peak_month: number[] }>("map_r3_stats.json"),
  admin0: () => staticJson<GeoJSON.FeatureCollection>("admin0.geojson"),
  admin1Url: `${STATIC}/admin1.geojson`,
  regimes: () => staticJson<FireRegime[]>("regimes.json"),
  regimeMap: () => staticJson<{ cells: string[]; regime_id: number[] }>("regime_map_r3.json"),
  globeCells: () => staticJson<{ cells: string[]; lat: number[]; lon: number[] }>("globe_cells_r3.json"),
  globeMonths: () => staticJson<{ months: string[] }>("globe_months.json"),
  globeBytes: async () => {
    const res = await fetch(withVersion(`${STATIC}/globe_r3_monthly.u8`));
    if (!res.ok) throw new ApiFailure("not_found", "Could not load the globe layer.");
    return new Uint8Array(await res.arrayBuffer());
  },
  admin1: () => staticJson<GeoJSON.FeatureCollection>("admin1.geojson"),
  globeMeta: () => staticJson<{ latest_month: string; month_to_date?: string; product_version?: string; h_max: number }>("globe_meta.json"),
};
