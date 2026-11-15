import { create } from "zustand";
import { ApiFailure, api } from "./api";
import type { Area, Calendar, Now, Season, Twins } from "./types";

export type Route = "explore" | "lab" | "turing" | "about";
export type PickMode = "region" | "circle" | "draw";

interface AppState {
  route: Route;
  pickMode: PickMode;
  radiusKm: number;
  area: Area | null;
  calendar: Calendar | null;
  loading: string | null;
  error: string | null;
  season: Season | null;
  twins: Twins | null;
  twinMode: "calendar" | "season";
  now: Now | null;
  mapLayer: "density" | "regimes";
  flyTo: { lon: number; lat: number; zoom: number } | null;
  colorMode: "count" | "anomaly";
  valueMode: "harmonized" | "raw";
  setRoute: (r: Route) => void;
  setPickMode: (m: PickMode) => void;
  setRadius: (km: number) => void;
  setColorMode: (m: "count" | "anomaly") => void;
  setTwinMode: (m: "calendar" | "season") => void;
  setMapLayer: (m: "density" | "regimes") => void;
  setFlyTo: (f: { lon: number; lat: number; zoom: number } | null) => void;
  setValueMode: (m: "harmonized" | "raw") => void;
  select: (fetcher: () => Promise<Area>, label: string, linkId?: string) => Promise<void>;
  clear: () => void;
}

const routeFromHash = (): Route => {
  const h = window.location.hash.replace(/^#\/?/, "").split("/")[0];
  return (["explore", "lab", "turing", "about"] as Route[]).includes(h as Route) ? (h as Route) : "explore";
};

export const useApp = create<AppState>((set, get) => ({
  route: routeFromHash(),
  pickMode: "region",
  radiusKm: 50,
  area: null,
  calendar: null,
  season: null,
  twins: null,
  twinMode: "season",
  now: null,
  mapLayer: "density",
  flyTo: null,
  loading: null,
  error: null,
  colorMode: "count",
  valueMode: "harmonized",
  setRoute: (route) => {
    window.location.hash = `/${route}`;
    set({ route });
  },
  setPickMode: (pickMode) => set({ pickMode }),
  setRadius: (radiusKm) => set({ radiusKm }),
  setColorMode: (colorMode) => set({ colorMode }),
  setTwinMode: (twinMode) => {
    set({ twinMode, twins: null });
    const a = get().area;
    if (a) api.twins(a.area_id, twinMode).then((twins) => { if (get().area?.area_id === a.area_id) set({ twins }); }, () => undefined);
  },
  setMapLayer: (mapLayer) => set({ mapLayer }),
  setFlyTo: (flyTo) => set({ flyTo }),
  setValueMode: (valueMode) => set({ valueMode }),
  select: async (fetcher, label, linkId) => {
    set({ loading: `Reading the fire record for ${label}…`, error: null });
    try {
      const area = await fetcher();
      set({ area, calendar: null, season: null, twins: null, now: null, loading: `Building the calendar for ${area.name}…` });
      const id = area.area_id;
      // deep link (F24): #/explore/<admin id> reopens this area
      window.history.replaceState(null, "", linkId ? `#/explore/${encodeURIComponent(linkId)}` : "#/explore");
      const mine = () => get().area?.area_id === id;
      // the extra views load in parallel and never block the calendar
      api.season(id).then((season) => { if (mine()) set({ season }); }, () => undefined);
      api.twins(id, get().twinMode).then((twins) => { if (mine()) set({ twins }); }, () => undefined);
      api.now(id).then((now) => { if (mine()) set({ now }); }, () => undefined);
      const calendar = await api.calendar(id);
      if (mine()) set({ calendar, loading: null });
    } catch (e) {
      set({ loading: null, error: e instanceof ApiFailure ? e.message : String(e) });
    }
  },
  clear: () => set({ area: null, calendar: null, season: null, twins: null, now: null, error: null }),
}));

window.addEventListener("hashchange", () => useApp.setState({ route: routeFromHash() }));
