import type { ApiError, Area, AreaCells, AreaCellsMonth, AreaDaily, AreaPlaces, Rankings, Calendar, Drift, Health, FireRegime, Now, Season, SearchEntry, TuringRound, Twins, ValidationReport } from "./types";

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
  const res = await fetch(`${STATIC}/${name}`);
  if (!res.ok) throw new ApiFailure("not_found", `Could not load ${name}.`);
  return (await res.json()) as T;
}

export const api = {
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
    const res = await fetch(`${STATIC}/globe_r3_monthly.u8`);
    if (!res.ok) throw new ApiFailure("not_found", "Could not load the globe layer.");
    return new Uint8Array(await res.arrayBuffer());
  },
  admin1: () => staticJson<GeoJSON.FeatureCollection>("admin1.geojson"),
  globeMeta: () => staticJson<{ latest_month: string; month_to_date?: string; product_version?: string; h_max: number }>("globe_meta.json"),
};
