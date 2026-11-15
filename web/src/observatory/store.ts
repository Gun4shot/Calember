// App state (React-visible). Per-frame animation values live in `fx` (plain mutable object, never re-renders).
import { create } from "zustand";
import { ApiFailure, api } from "../app/api";
import type { Area, AreaCells, AreaPlaces, Calendar, Now, Season, Twins } from "../app/types";
import type { Poly } from "./geo";
import { saveSoundPref, sfx } from "./sfx";

export type View = "globe" | "area" | "lab" | "turing" | "about" | "rankings";
export type Station = "verdict" | "terrain" | "calendar" | "season" | "helix" | "twins" | "take";
export const STATIONS: Array<{ id: Station; label: string; q: string; key: string }> = [
  { id: "verdict", label: "Verdict", q: "Is this month normal?", key: "1" },
  { id: "terrain", label: "Terrain", q: "Where does it burn?", key: "2" },
  { id: "calendar", label: "Calendar", q: "Every month since 2000", key: "3" },
  { id: "season", label: "Season", q: "Is the season shifting?", key: "4" },
  { id: "helix", label: "Helix", q: "26 years in one spiral", key: "5" },
  { id: "twins", label: "Twins", q: "Who burns like this?", key: "6" },
  { id: "take", label: "Take it", q: "Data, print, share", key: "7" },
];
export type Layer = "activity" | "anomaly" | "regimes";
export type Tool = "none" | "lasso" | "circle";

/** A place the user is looking at before acquiring it. */
export interface Candidate {
  name: string;
  kind: string; // Province · Country · Biome · World · Drawn area · Circle · Fire Twin
  polys: Poly[]; // outline (may be empty for biomes / world)
  center: [number, number]; // lon, lat
  request: () => Promise<Area>;
  linkId?: string; // admin id for deep links
  area?: Area; // resolved early for drawn shapes (to show km² before acquiring)
}

interface S {
  view: View;
  station: Station;
  // globe
  monthIdx: number; // integer month index under the playhead
  playing: boolean;
  layer: Layer;
  tool: Tool;
  hoverName: string | null;
  hoverPolys: Poly[] | null;
  candidate: Candidate | null;
  paletteOpen: boolean;
  /** what the search palette is for: opening a place, or picking the second place of a comparison */
  paletteFor: "open" | "compare";
  /** the place compared with the open area (Compare overlay) */
  compareB: { name: string; request: () => Promise<Area> } | null;
  /** places the viewer watches (stored in this browser) */
  watched: { id: string; name: string }[];
  toggleWatch: (id: string, name: string) => void;
  /** the keyboard-shortcuts list ("?") */
  shortcutsOpen: boolean;
  satCard: string | null;
  /** precise 2D map: off → entering (globe unrolls) → on → leaving (map rolls back up into the globe) */
  mapMode: "off" | "entering" | "on" | "leaving";
  afterMap: Candidate | null; // a place to open once the map has rolled back into the globe
  // area
  acquiring: boolean;
  shape: { polys: Poly[]; center: [number, number]; name: string; kind: string } | null;
  area: Area | null;
  calendar: Calendar | null;
  now: Now | null;
  season: Season | null;
  twins: Twins | null;
  twinMode: "calendar" | "season";
  cells: AreaCells | null;
  places: AreaPlaces | null;
  placeFocus: string | null; // province / country code highlighted on the terrain
  cellsError: string | null;
  error: string | null;
  pinned: string | null; // "YYYY-MM" selected month (calendar / helix / verdict)
  colorMode: "count" | "anomaly";
  valueMode: "harmonized" | "raw";
  flat: boolean;
  terrainColor: "amount" | "peak" | "anom";
  /** Terrain's month mode: each cell in the timeline month, and its typical value for that calendar month */
  cellsMonth: { month: string; values: number[]; typical: number[] } | null;
  terrainYear: number | null;
  /** Terrain shows the long-term average ("mean") or the month on the timeline ("month") */
  terrainMode: "mean" | "month";
  hoverMonth: string | null;
  helixYear: number | null;
  twinFocus: number | null;
  table: boolean;
  playIdx: number | null; // sonification position
  sound: boolean;
  reduced: boolean;
  set: (p: Partial<S>) => void;
  acquire: (c: Candidate) => Promise<void>;
  setTwinMode: (m: "calendar" | "season") => void;
  closeArea: () => void;
}

const reducedMq = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

export const useObs = create<S>((set, get) => ({
  view: "globe",
  station: "verdict",
  monthIdx: 0,
  playing: false,
  layer: "activity",
  tool: "none",
  hoverName: null,
  hoverPolys: null,
  candidate: null,
  paletteOpen: false,
  paletteFor: "open",
  compareB: null,
  watched: loadWatched(),
  toggleWatch: (id, name) => {
    const w = get().watched;
    const next = w.some((x) => x.id === id) ? w.filter((x) => x.id !== id) : [...w, { id, name }].slice(-6);
    try {
      localStorage.setItem("calember.watch", JSON.stringify(next));
    } catch {
      /* storage is optional */
    }
    set({ watched: next });
  },
  shortcutsOpen: false,
  satCard: null,
  mapMode: "off",
  afterMap: null,
  acquiring: false,
  shape: null,
  area: null,
  calendar: null,
  now: null,
  season: null,
  twins: null,
  twinMode: "season",
  cells: null,
  places: null,
  placeFocus: null,
  cellsError: null,
  error: null,
  pinned: null,
  colorMode: "count",
  valueMode: "harmonized",
  flat: false,
  terrainColor: "amount",
  cellsMonth: null,
  terrainYear: null,
  terrainMode: "mean",
  hoverMonth: null,
  helixYear: null,
  twinFocus: null,
  table: false,
  playIdx: null,
  sound: false, // switched on at start-up when the viewer chose sound (see Observatory.tsx)
  reduced: reducedMq?.matches ?? false,
  set: (p) => {
    if (p.sound !== undefined && p.sound !== get().sound) {
      sfx.setEnabled(p.sound);
      saveSoundPref(p.sound);
    }
    if (p.candidate && p.candidate !== get().candidate) sfx.lock();
    if (p.paletteOpen && !get().paletteOpen) sfx.blip(true);
    if (p.paletteOpen === false && p.paletteFor === undefined) p = { ...p, paletteFor: "open" };
    if (p.satCard && p.satCard !== get().satCard) sfx.satellite(p.satCard === "TERRA" || p.satCard === "AQUA");
    set(p);
  },
  acquire: async (c) => {
    set({ acquiring: true, error: null, candidate: null, tool: "none", paletteOpen: false, satCard: null });
    fx.acquireT0 = performance.now();
    sfx.acquire(5);
    try {
      const area = c.area ?? (await c.request());
      const id = area.area_id;
      set({
        area,
        shape: { polys: c.polys, center: c.center, name: area.name && !area.name.startsWith("Custom area") ? area.name : c.name, kind: c.kind },
        calendar: null,
        now: null,
        season: null,
        twins: null,
        cells: null,
        cellsMonth: null,
        places: null,
        placeFocus: null,
        cellsError: null,
        pinned: null,
        valueMode: "harmonized",
        colorMode: "count",
        flat: window.innerWidth < 640, // phones read the calendar as an exact flat heatmap by default
        table: false,
        terrainYear: null,
        hoverMonth: null,
        view: "area",
        station: "verdict",
      });
      window.location.hash = `/area/${encodeURIComponent(c.linkId ?? id)}`;
      const mine = () => get().area?.area_id === id;
      api.calendar(id).then(
        (calendar) => {
          if (!mine()) return;
          const last = [...calendar.months].reverse().find((m) => m.category !== null && m.median_m !== null) ?? calendar.months[calendar.months.length - 1];
          set({ calendar, pinned: last?.month ?? null });
        },
        (e) => mine() && set({ error: e instanceof ApiFailure ? e.message : String(e) }),
      );
      api.now(id).then((now) => mine() && set({ now }), () => undefined);
      api.season(id).then((season) => mine() && set({ season }), () => undefined);
      api.twins(id, get().twinMode).then((twins) => mine() && set({ twins }), () => undefined);
      api.places(id).then((places) => mine() && set({ places }), () => undefined);
      api.cells(id).then(
        (cells) => mine() && set({ cells }),
        (e) => mine() && set({ cellsError: e instanceof ApiFailure ? e.message : String(e) }),
      );
    } catch (e) {
      set({ error: e instanceof ApiFailure ? e.message : String(e), view: "globe" });
    } finally {
      set({ acquiring: false });
    }
  },
  setTwinMode: (twinMode) => {
    set({ twinMode, twins: null });
    const a = get().area;
    if (a) api.twins(a.area_id, twinMode).then((twins) => get().area?.area_id === a.area_id && set({ twins }), () => undefined);
  },
  closeArea: () => {
    if (get().view === "area") sfx.close();
    set({ view: "globe", area: null, shape: null, calendar: null, now: null, season: null, twins: null, cells: null, cellsMonth: null, compareB: null, error: null, playIdx: null });
    window.location.hash = "/";
  },
}));

function loadWatched(): { id: string; name: string }[] {
  try {
    const v = JSON.parse(localStorage.getItem("calember.watch") ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === "string" && typeof x.name === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

reducedMq?.addEventListener("change", (e) => useObs.setState({ reduced: e.matches }));

/** Per-frame mutable animation state shared by the scene and the HUD (no React updates). */
export const fx = {
  monthF: 0, // smooth month position (float)
  simT: 0, // orbital sim clock (s); the Earth turns once per SIM_DAY_S
  acquireT0: -1e9, // performance.now() when the last acquisition started
  stageT0: -1e9, // when the stage appeared
  stationT0: -1e9, // when the current station became active
  rawMix: 0, // 0 harmonized → 1 raw (spring-animated)
  flatMix: 0,
  anomMix: 0,
  hoverCell: -1, // calendar block under the pointer
  pointer: { x: 0, y: 0 },
  globeDim: 0, // 0 normal → 1 dimmed behind the stage
};
