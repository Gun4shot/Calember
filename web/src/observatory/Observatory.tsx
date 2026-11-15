import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { api } from "../app/api";
import { outlineOfDrawn } from "../app/engine/region";
import type { Calendar } from "../app/types";
import { type GlobeData, loadGlobe, loadWorld, outlineOf } from "./data";
import { centerOf, polysOf } from "./geo";
import { AreaHUD } from "./hud/AreaHUD";
import { CandidateChip } from "./hud/CandidateChip";
import { CommandPalette } from "./hud/CommandPalette";
import { Compare } from "./hud/Compare";
import { GlobeHUD } from "./hud/GlobeHUD";
import { LiveRegion } from "./hud/LiveRegion";
import { Overlays } from "./hud/Overlays";
import { SatCard } from "./hud/SatCard";
import { Shortcuts } from "./hud/Shortcuts";
import { TimeRibbon, idxOf } from "./hud/TimeRibbon";
import { TopBar } from "./hud/TopBar";
import { type Candidate, type Station, STATIONS, useObs } from "./store";
import { cam, flyTo } from "./world/camera";
import { RECORD_LEN, World } from "./world/World";
import { soundPref } from "./sfx";

const PrecisionMap = lazy(() => import("./map/PrecisionMap"));

/** Deep links (F24): #/area/<admin id or area id>[/<station>][?raw=1&anom=1&flat=1&m=YYYY-MM], #/lab, #/turing, #/about. */
function applyParams(q: URLSearchParams) {
  const p: Partial<ReturnType<typeof useObs.getState>> = {};
  // a deep link describes the whole view: anything not in it is the default
  p.valueMode = q.get("raw") === "1" ? "raw" : "harmonized";
  p.colorMode = q.get("anom") === "1" && q.get("raw") !== "1" ? "anomaly" : "count";
  p.flat = q.has("flat") ? q.get("flat") === "1" : window.innerWidth < 640;
  useObs.setState(p);
  const m = q.get("m");
  if (m && /^\d{4}-\d{2}$/.test(m)) {
    const apply = () => useObs.setState({ pinned: m });
    if (useObs.getState().calendar) apply();
    else {
      const un = useObs.subscribe((s) => {
        if (s.calendar) {
          un();
          apply();
        }
      });
    }
  }
}

async function openFromHash() {
  const full = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
  const [h, qs] = full.split("?");
  const q = new URLSearchParams(qs ?? "");
  const st = useObs.getState();
  if (h.startsWith("area/")) {
    const [, id, station] = h.split("/");
    if (!id) return;
    if (st.area && (st.area.area_id === id || window.location.hash.includes(id)) && st.view === "area") {
      if (station && STATIONS.some((s) => s.id === station)) st.set({ station: station as Station });
      applyParams(q);
      return;
    }
    // one open per area at a time (StrictMode's double mount, or the hashchange that acquire itself triggers, would
    // otherwise acquire twice, and the second calendar response would re-pin the latest month over `?m=`)
    if (opening === id) return;
    opening = id;
    try {
      await openArea(id, station, q);
    } finally {
      opening = null;
    }
  } else if (h === "lab" || h === "turing" || h === "about" || h === "rankings") {
    st.set({ view: h, candidate: null });
  } else if (st.view === "area") {
    // the browser's Back button (or any link to #/) leaves the open area, like ✕ does
    st.closeArea();
  } else if (st.view !== "globe") {
    st.set({ view: "globe" });
  }
}

let opening: string | null = null;

async function openArea(id: string, station: string | undefined, q: URLSearchParams) {
  {
    const outline = id.startsWith("x_") ? null : await outlineOf(id).catch(() => null);
    const drawnRing = id.startsWith("x_") ? outlineOfDrawn(id) : null;
    const polys = outline ? polysOf(outline.f.geometry) : drawnRing ? [drawnRing] : [];
    const c: Candidate = {
      name: outline?.name ?? (id.startsWith("x_c_") ? `Custom area (${id.split("_").pop()} km circle)` : id.startsWith("x_") ? "Custom area" : id),
      kind: id.startsWith("ISO-") ? "Country" : id === "WORLD" ? "World" : id.startsWith("BIOME-") ? "Biome" : id.startsWith("a_") || id.startsWith("x_") ? "Area" : "Province",
      polys,
      center: polys.length ? centerOf(polys) : [cam.lon, Math.max(-40, Math.min(50, cam.lat))],
      request: () => (id.startsWith("a_") || id.startsWith("x_") ? api.area(id) : api.areaByAdmin(id)),
      linkId: id,
    };
    flyTo(c.center[1], c.center[0], cam.dist, 0.01);
    await useObs.getState().acquire(c);
    if (station && STATIONS.some((s) => s.id === station)) useObs.setState({ station: station as Station });
    applyParams(q);
  }
}

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__obs = { useObs, cam };

export function Observatory() {
  const [g, setG] = useState<GlobeData | null>(null);
  const [world, setWorld] = useState<Calendar | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const area = useObs((s) => s.area);
  const view = useObs((s) => s.view);
  const mapMode = useObs((s) => s.mapMode);

  useEffect(() => {
    // sound follows the viewer's last choice (the story's "Begin the story" counts); it wakes on the first gesture
    if (soundPref() && !useObs.getState().sound) useObs.getState().set({ sound: true });
    loadGlobe().then(
      (d) => {
        setG(d);
        // start at the latest complete month, unless a deep link (or an open area) already chose a month:
        // overriding it here would make the timeline sync re-pin the latest month and drop `?m=`
        const pinned = useObs.getState().pinned;
        const idx = pinned ? idxOf(pinned) : Math.max(0, d.months.indexOf(d.latest));
        useObs.setState({ monthIdx: idx });
      },
      (e) => setLoadErr(String(e)),
    );
    loadWorld().then(setWorld, () => undefined);
    void openFromHash();
    const onHash = () => void openFromHash();
    window.addEventListener("hashchange", onHash);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = !!t?.closest?.("input,textarea,select,[contenteditable=true]");
      const st = useObs.getState();
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !e.shiftKey && !typing)) {
        e.preventDefault();
        st.set({ paletteOpen: true });
        return;
      }
      if (typing || st.paletteOpen) return;
      if (st.view === "globe" && e.key.toLowerCase() === "m") {
        if (st.mapMode === "off") st.set({ mapMode: "entering", tool: "none", satCard: null, hoverPolys: null, hoverName: null });
        else if (st.mapMode === "on") st.set({ mapMode: "leaving" });
        return;
      }
      if (st.view === "globe" && st.mapMode === "off") {
        if (e.key.toLowerCase() === "l") st.set({ tool: st.tool === "lasso" ? "none" : "lasso", candidate: null });
        else if (e.key.toLowerCase() === "c") st.set({ tool: st.tool === "circle" ? "none" : "circle", candidate: null });
        else if (e.key === "Escape") st.set({ tool: "none", candidate: null, satCard: null, hoverPolys: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // which globe cells fall inside the acquired area (they stay lit while the rest of the planet dims)
  const inArea = useMemo(() => {
    if (!g || !area) return null;
    const set = new Set<string>();
    // r5 → r3 parents (cell ids are hex strings); h3 r5 parent at r3 is computed lazily via h3-js
    return { set, area };
  }, [g, area]);
  const [inAreaMask, setMask] = useState<Uint8Array | null>(null);
  useEffect(() => {
    if (!g || !inArea) {
      setMask(null);
      return;
    }
    let alive = true;
    import("h3-js").then(({ cellToParent }) => {
      if (!alive) return;
      const parents = new Set(inArea.area.cells_r5.map((c) => cellToParent(c, 3)));
      const m = new Uint8Array(g.nCells);
      g.cells.forEach((c, i) => (m[i] = parents.has(c) ? 1 : 0));
      setMask(m);
    });
    return () => {
      alive = false;
    };
  }, [g, inArea]);

  useEffect(() => {
    document.title = view === "area" && area ? `${useObs.getState().shape?.name ?? area.name} · Calember Observatory` : `Calember Observatory`;
  }, [view, area]);

  return (
    <div className={`obs view-${view}`}>
      <a className="skip-link" href="#hud-main">
        Skip to the panels
      </a>
      <World g={g} inArea={inAreaMask} paused={mapMode === "on"} />
      {mapMode !== "off" && (
        <Suspense fallback={null}>
          <PrecisionMap />
        </Suspense>
      )}
      <div className="hud" id="hud-main">
        <TopBar />
        {view === "globe" && mapMode === "off" && <GlobeHUD world={world} g={g} />}
        {view === "globe" && <CandidateChip />}
        {view === "area" && <AreaHUD />}
        {mapMode === "off" && <TimeRibbon world={world} recordLen={g?.nMonths ?? RECORD_LEN} />}
        <SatCard />
        <CommandPalette />
        <Shortcuts />
        {view === "area" && <Compare />}
        <Overlays />
        <LiveRegion />
        {!g && !loadErr && <Loader />}
        {loadErr && (
          <div className="fatal" role="alert">
            Could not load the fire record ({loadErr}). <a href="">Reload</a> or <a href="./">watch the story</a>.
          </div>
        )}
      </div>
    </div>
  );
}

function Loader() {
  return (
    <div className="loader" role="status">
      <div className="loader-ring" aria-hidden="true" />
      <p>Loading 26 years of fire…</p>
    </div>
  );
}
