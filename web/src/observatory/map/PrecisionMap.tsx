// The precise 2D map. Entering it, the 3D camera dives, an iris of light opens and the real globe (MapLibre,
// vertical perspective) unrolls into a flat Mercator map while the graticule straightens and a radar sweep
// passes. Leaving it, the map rolls back up into a globe and the iris closes onto the 3D planet.
// Basemap: OpenFreeMap "dark" (no key; Guideline §5.2), with a plain fallback if it cannot load.
import maplibregl, { type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./pmap.css";
import { cellToBoundary } from "h3-js";
import { useEffect, useRef, useState } from "react";
import { api, statics } from "../../app/api";
import { fmt } from "../../app/format";
import { loadAdmin0, loadAdmin1 } from "../data";
import { R, centerOf, circleRing, haversineKm, polysOf } from "../geo";
import { resolveEarly } from "../globe/Pickers";
import { Words } from "../hud/kinetic";
import { sfx } from "../sfx";
import { type Candidate, useObs } from "../store";
import { cam, flyTo } from "../world/camera";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const FOV = 38;
/** MapLibre zoom whose globe has the same on-screen radius as our 3D globe seen from distance d. */
export function zoomForDist(d: number, H: number) {
  const f = H / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const rpx = (f * R) / Math.sqrt(Math.max(1e-6, d * d - R * R));
  return Math.log2((2 * Math.PI * rpx) / 512);
}
export function distForZoom(z: number, H: number) {
  const f = H / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const rpx = (512 * Math.pow(2, z)) / (2 * Math.PI);
  return Math.sqrt(Math.pow((f * R) / rpx, 2) + R * R);
}
const ENTRY_DIST = R * 2.25;
const FLAT_ZOOM = 5.2; // fully Mercator from 4.6

function graticule(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let lon = -180; lon < 180; lon += 10) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: Array.from({ length: 33 }, (_, i) => [lon, -80 + i * 5]) } });
  for (let lat = -80; lat <= 80; lat += 10) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]) } });
  return { type: "FeatureCollection", features };
}

function hexFeatures(cells: string[], vals: number[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (vals[i] < 1) continue;
    const ring = cellToBoundary(cells[i], true);
    const lons = ring.map((p) => p[0]);
    if (Math.max(...lons) - Math.min(...lons) > 180) continue;
    features.push({ type: "Feature", properties: { v: vals[i] }, geometry: { type: "Polygon", coordinates: [ring] } });
  }
  return { type: "FeatureCollection", features };
}

async function loadStyle(): Promise<maplibregl.StyleSpecification | string> {
  const fallback: maplibregl.StyleSpecification = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#070a12" } }] };
  try {
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 5000);
    const res = await fetch("https://tiles.openfreemap.org/styles/dark", { signal: ctl.signal });
    window.clearTimeout(t);
    if (!res.ok) return fallback;
    const style = (await res.json()) as maplibregl.StyleSpecification;
    // tint the basemap toward the Observatory's night palette
    for (const l of style.layers) {
      if (l.type === "background") (l.paint ??= {})["background-color"] = "#05070d";
      if (l.type === "fill" && /water/.test(l.id)) (l.paint ??= {})["fill-color"] = "#070b16";
      if (l.type === "symbol" && l.paint) (l.paint as Record<string, unknown>)["text-halo-color"] = "#05070d";
    }
    return style;
  } catch {
    return fallback;
  }
}

type Tool = "region" | "polygon" | "circle";

export default function PrecisionMap() {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mode = useObs((s) => s.mapMode);
  const set = useObs((s) => s.set);
  const [phase, setPhase] = useState<"closed" | "opening" | "open" | "closing">("closed");
  const [tool, setTool] = useState<Tool>("region");
  const toolRef = useRef<Tool>("region");
  const [hover, setHover] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [zoom, setZoom] = useState(0);
  const [verts, setVerts] = useState(0);
  const [banner, setBanner] = useState<string>("Unrolling the planet");
  const [dataReady, setDataReady] = useState(false);
  const draw = useRef<[number, number][]>([]);
  const circ = useRef<{ lat: number; lon: number; km: number } | null>(null);
  const reduced = useObs((s) => s.reduced);

  useEffect(() => {
    toolRef.current = tool;
    draw.current = [];
    setVerts(0);
    (mapRef.current?.getSource("draft") as GeoJSONSource | undefined)?.setData(EMPTY);
  }, [tool]);

  // ---- enter: dive, create the map at the matching globe zoom, open the iris, unroll
  useEffect(() => {
    if (!box.current) return;
    let alive = true;
    flyTo(cam.lat, cam.lon, ENTRY_DIST, reduced ? 0.01 : 0.7);
    sfx.unroll();
    const H = window.innerHeight;
    const z0 = zoomForDist(ENTRY_DIST, H);
    void loadStyle().then((style) => {
      if (!alive || !box.current) return;
      const map = new maplibregl.Map({
        container: box.current,
        style,
        center: [cam.lon, Math.max(-70, Math.min(75, cam.lat))],
        zoom: z0,
        maxZoom: 13,
        minZoom: 0.6,
        doubleClickZoom: false,
        attributionControl: { compact: true, customAttribution: "Fire data: NASA FIRMS · Boundaries: Natural Earth" },
      });
      mapRef.current = map;
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
      map.once("style.load", () => {
        if (!alive) return;
        // globe while zoomed out, flat Mercator once you are close: the zoom animation itself unrolls the planet
        map.setProjection({ type: ["interpolate", ["linear"], ["zoom"], 3.4, "vertical-perspective", 4.6, "mercator"] } as unknown as maplibregl.ProjectionSpecification);
        map.setSky({ "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 4, 0.6, 5, 0] } as unknown as maplibregl.SkySpecification);
        const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
        map.addSource("grat", { type: "geojson", data: graticule() });
        map.addLayer({ id: "grat", type: "line", source: "grat", paint: { "line-color": "#ffb347", "line-width": 1, "line-opacity": 0.75 } }, firstSymbol);
        wire(map);
        void addData(map, firstSymbol);
        // open the iris as soon as the first frame is drawn (tiles keep streaming in during the unroll)
        let started = false;
        const go = () => {
          if (started || !alive) return;
          started = true;
          startShow(map);
        };
        map.once("idle", go);
        window.setTimeout(go, 1500);
      });
    });
    async function addData(map: maplibregl.Map, firstSymbol: string | undefined) {
        const [a0, stats] = await Promise.all([statics.admin0(), statics.mapStats()]);
        if (!alive || !map.getStyle()) return;
        map.addSource("fire", { type: "geojson", data: hexFeatures(stats.cells, stats.mean_annual_meh) });
        map.addLayer(
          {
            id: "fire",
            type: "fill",
            source: "fire",
            paint: {
              "fill-color": ["interpolate", ["linear"], ["log10", ["max", 1, ["get", "v"]]], 0, "#3a1c3f", 1, "#7b2a52", 2, "#c2453c", 2.7, "#f07a2c", 3.3, "#fbbf45", 4, "#fff4b8"],
              "fill-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 4, 0.36, 6, 0.2, 9, 0.12],
              "fill-outline-color": "rgba(255, 179, 71, 0.25)",
            },
          },
          firstSymbol,
        );
        map.addSource("countries", { type: "geojson", data: a0, promoteId: "country_iso3" });
        map.addLayer({ id: "countries-line", type: "line", source: "countries", paint: { "line-color": "#6f8fc8", "line-width": 0.7, "line-opacity": 0.55 } }, firstSymbol);
        map.addLayer({ id: "countries-hit", type: "fill", source: "countries", maxzoom: 3.6, paint: { "fill-color": "#ffd37a", "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.1, 0] } }, firstSymbol);
        map.addSource("admin1", { type: "geojson", data: statics.admin1Url, promoteId: "admin_id" });
        map.addLayer({ id: "admin1-hit", type: "fill", source: "admin1", minzoom: 3.6, paint: { "fill-color": "#ffd37a", "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.12, 0] } }, firstSymbol);
        map.addLayer({ id: "admin1-line", type: "line", source: "admin1", minzoom: 3.6, paint: { "line-color": "#8fa6cf", "line-width": 0.6, "line-opacity": 0.5 } }, firstSymbol);
        map.addSource("sel", { type: "geojson", data: EMPTY });
        map.addLayer({ id: "sel-fill", type: "fill", source: "sel", paint: { "fill-color": "#ffd37a", "fill-opacity": 0.14 } });
        map.addLayer({ id: "sel-glow", type: "line", source: "sel", paint: { "line-color": "#ff8a3d", "line-width": 8, "line-opacity": 0.25, "line-blur": 4 } });
        map.addLayer({ id: "sel-line", type: "line", source: "sel", paint: { "line-color": "#ffd37a", "line-width": 2 } });
        map.addSource("draft", { type: "geojson", data: EMPTY });
        map.addLayer({ id: "draft-fill", type: "fill", source: "draft", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#7fd8ff", "fill-opacity": 0.14 } });
        map.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["!=", "$type", "Point"], paint: { "line-color": "#7fd8ff", "line-width": 2, "line-dasharray": [2, 1] } });
        map.addLayer({ id: "draft-pts", type: "circle", source: "draft", filter: ["==", "$type", "Point"], paint: { "circle-radius": 5, "circle-color": "#05070d", "circle-stroke-color": "#7fd8ff", "circle-stroke-width": 2 } });
        setDataReady(true);
    }
    function startShow(map: maplibregl.Map) {
        // the show: iris opens (CSS), then the zoom unrolls the globe into the flat map
        setPhase("opening");
        const target = Math.max(FLAT_ZOOM, map.getZoom() + 2.6);
        window.setTimeout(() => {
          if (!alive) return;
          setBanner("Vertical perspective → Mercator");
          map.easeTo({ zoom: target, pitch: 0, bearing: 0, duration: reduced ? 0 : 2600, easing: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2) });
          // the graticule straightens and then steps back
          const t0 = performance.now();
          const fade = () => {
            const k = Math.min(1, (performance.now() - t0) / 3200);
            if (map.getLayer("grat")) map.setPaintProperty("grat", "line-opacity", 0.75 - 0.65 * k);
            if (k < 1 && alive) requestAnimationFrame(fade);
          };
          fade();
        }, reduced ? 0 : 650);
        window.setTimeout(() => {
          if (!alive) return;
          setPhase("open");
          set({ mapMode: "on" });
        }, reduced ? 50 : 3300);
    }
    return () => {
      alive = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- leave: roll the map back into a globe, close the iris, hand the camera back to 3D
  useEffect(() => {
    if (mode !== "leaving") return;
    const map = mapRef.current;
    const H = window.innerHeight;
    sfx.rollup();
    setBanner("Mercator → globe");
    const finish = () => {
      const c = map?.getCenter();
      const z = map?.getZoom() ?? zoomForDist(ENTRY_DIST, H);
      if (c) {
        cam.lat = c.lat;
        cam.lon = c.lng;
        cam.dist = Math.max(R * 1.3, Math.min(R * 5, distForZoom(z, H)));
        cam.fly = null;
      }
      setPhase("closing");
      window.setTimeout(() => {
        const st = useObs.getState();
        const next = st.afterMap;
        set({ mapMode: "off", afterMap: null });
        if (next) void st.acquire(next);
        else flyTo(cam.lat, cam.lon, innerWidth < 640 ? R * 4.1 : R * 3.85, 1.6);
      }, reduced ? 0 : 750);
    };
    if (!map || reduced) return finish();
    const zGlobe = zoomForDist(ENTRY_DIST, H);
    map.easeTo({ zoom: zGlobe, pitch: 0, bearing: 0, duration: 1500, easing: (k) => k * k * (3 - 2 * k) });
    if (map.getLayer("grat")) map.setPaintProperty("grat", "line-opacity", 0.6);
    const id = window.setTimeout(finish, 1550);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // the candidate's outline on the map
  const cand = useObs((s) => s.candidate);
  useEffect(() => {
    const src = mapRef.current?.getSource("sel") as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(cand && cand.polys.length ? { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: cand.polys } } : EMPTY);
  }, [cand]);

  // keyboard: Esc leaves (or clears a drawing), Enter finishes a polygon
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea")) return;
      if (e.key === "Enter" && toolRef.current === "polygon") finishPolygon();
      if (e.key === "Escape") {
        if (draw.current.length) {
          draw.current = [];
          setVerts(0);
          (mapRef.current?.getSource("draft") as GeoJSONSource | undefined)?.setData(EMPTY);
        } else if (useObs.getState().mapMode === "on") set({ mapMode: "leaving" });
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishPolygon = () => {
    const pts = draw.current;
    if (pts.length < 3) return;
    draw.current = [];
    setVerts(0);
    (mapRef.current?.getSource("draft") as GeoJSONSource | undefined)?.setData(EMPTY);
    const ring: [number, number][] = [...pts, pts[0]];
    resolveEarly({ name: "Drawn area", kind: "Drawn area", polys: [[ring]], center: centerOf([[ring]]), request: () => api.areaByPolygon(pts) });
  };

  function wire(map: maplibregl.Map) {
    let hovered: { src: string; id: string | number } | null = null;
    const setHover2 = (h: { src: string; id: string | number } | null) => {
      if (hovered) map.setFeatureState({ source: hovered.src, id: hovered.id }, { hover: false });
      hovered = h;
      if (h) map.setFeatureState({ source: h.src, id: h.id }, { hover: true });
    };
    map.on("move", () => setZoom(map.getZoom()));
    map.on("mousemove", (e: MapMouseEvent) => {
      setCursor({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      const t = toolRef.current;
      const draft = map.getSource("draft") as GeoJSONSource | undefined;
      if (t === "region") {
        const layers = ["admin1-hit", "countries-hit"].filter((l) => map.getLayer(l));
        const f = map.queryRenderedFeatures(e.point, { layers })[0];
        if (f && f.id !== undefined) {
          const src = f.layer.id === "admin1-hit" ? "admin1" : "countries";
          if (!hovered || hovered.id !== f.id) setHover2({ src, id: f.id });
          setHover(src === "admin1" ? `${f.properties?.name}, ${f.properties?.country_name}` : String(f.properties?.name));
          map.getCanvas().style.cursor = "pointer";
        } else {
          setHover2(null);
          setHover(null);
          map.getCanvas().style.cursor = "";
        }
      } else if (t === "polygon" && draft) {
        const pts = [...draw.current, [e.lngLat.lng, e.lngLat.lat] as [number, number]];
        const feats: GeoJSON.Feature[] = draw.current.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
        if (pts.length >= 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
        if (pts.length >= 3) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
        draft.setData({ type: "FeatureCollection", features: feats });
        map.getCanvas().style.cursor = "crosshair";
      } else if (t === "circle" && draft) {
        map.getCanvas().style.cursor = "crosshair";
        if (circ.current) {
          circ.current.km = haversineKm(circ.current.lat, circ.current.lon, e.lngLat.lat, e.lngLat.lng);
          draft.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circleRing(circ.current.lat, circ.current.lon, Math.max(1, circ.current.km))] } }] });
          setHover(`${fmt(circ.current.km)} km radius`);
        }
      }
    });
    map.on("mousedown", (e: MapMouseEvent) => {
      if (toolRef.current !== "circle") return;
      map.dragPan.disable();
      circ.current = { lat: e.lngLat.lat, lon: e.lngLat.lng, km: 0 };
    });
    map.on("mouseup", () => {
      if (toolRef.current !== "circle" || !circ.current) return;
      map.dragPan.enable();
      const c = circ.current;
      circ.current = null;
      setHover(null);
      (map.getSource("draft") as GeoJSONSource | undefined)?.setData(EMPTY);
      const km = Math.max(5, Math.round(c.km));
      resolveEarly({
        name: `${km} km around ${c.lat.toFixed(3)}°, ${c.lon.toFixed(3)}°`,
        kind: "Circle",
        polys: [[circleRing(c.lat, c.lon, km)]],
        center: [c.lon, c.lat],
        request: () => api.areaByCircle(c.lat, c.lon, km),
      });
    });
    map.on("click", async (e: MapMouseEvent) => {
      const t = toolRef.current;
      if (t === "polygon") {
        draw.current = [...draw.current, [e.lngLat.lng, e.lngLat.lat]];
        setVerts(draw.current.length);
        return;
      }
      if (t !== "region") return;
      const layers = ["admin1-hit", "countries-hit"].filter((l) => map.getLayer(l));
      const f = map.queryRenderedFeatures(e.point, { layers })[0];
      if (!f) return;
      const isProv = f.layer.id === "admin1-hit";
      const id = isProv ? String(f.properties?.admin_id) : `ISO-${String(f.properties?.country_iso3)}`;
      const list = isProv ? await loadAdmin1() : await loadAdmin0();
      const it = list.find((x) => x.id === id);
      if (!it) return;
      const polys = polysOf(it.f.geometry);
      const c: Candidate = { name: it.name, kind: isProv ? "Province" : "Country", polys, center: centerOf(polys), request: () => api.areaByAdmin(id), linkId: id };
      set({ candidate: c, error: null });
    });
    map.on("dblclick", () => toolRef.current === "polygon" && finishPolygon());
  }

  const tools: Array<{ id: Tool; label: string; hint: string }> = [
    { id: "region", label: "Click a region", hint: "Countries when zoomed out, provinces when zoomed in" },
    { id: "polygon", label: "Draw a shape", hint: "Click corners; double-click or Enter to finish" },
    { id: "circle", label: "Drag a circle", hint: "Press on the centre and drag out the radius" },
  ];
  return (
    <div className={`pmap-wrap phase-${phase}`} aria-label="Precise 2D map">
      <div ref={box} className="pmap" role="application" aria-label="Flat map with place names. Pick an area by clicking a region, drawing a shape or dragging a circle." />
      <div className="iris" aria-hidden="true">
        <span className="iris-ring r1" />
        <span className="iris-ring r2" />
        <span className="iris-sweep" />
        <span className="iris-flash" />
      </div>
      {(phase === "closed" || phase === "opening" || phase === "closing" || mode === "leaving") && (
        <div className="unroll-banner" aria-live="polite">
          <p className="kicker">Precise map</p>
          <Words as="p" text={banner} className="ub-text" step={50} key={banner} />
          <p className="ub-coord">
            {cam.lat.toFixed(2)}° · {cam.lon.toFixed(2)}° · z {zoom.toFixed(1)}
          </p>
        </div>
      )}
      {phase === "open" && mode === "on" && (
        <>
          <div className="pmap-bar glass">
            <button type="button" className="btn-ghost back3d" onClick={() => set({ mapMode: "leaving" })} title="Roll the map back into the 3D globe (M or Esc)">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M3 10h14M10 3c3 3 3 11 0 14M10 3c-3 3-3 11 0 14" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              3D globe <kbd>M</kbd>
            </button>
            <div className="seg2" role="radiogroup" aria-label="How to pick an area">
              {tools.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={tool === t.id} onClick={() => setTool(t.id)} title={t.hint}>
                  {t.label}
                </button>
              ))}
            </div>
            <span className="pmap-hint">
              {tool === "polygon"
                ? verts < 3
                  ? `Click corners (${verts}/3 minimum)`
                  : `${verts} corners · double-click or Enter to finish · Esc to clear`
                : tools.find((t) => t.id === tool)?.hint}
            </span>
          </div>
          <div className="pmap-read glass" aria-hidden="true">
            {cursor ? `${cursor.lat.toFixed(4)}°, ${cursor.lon.toFixed(4)}°` : "—"} · zoom {zoom.toFixed(1)}
          </div>
          {hover && <div className="hover-tag">{hover}</div>}
          <div className="pmap-legend glass">
            <p className="kicker">Average hotspots per year</p>
            <div className="ramp-inferno" />
            <div className="legend2-ticks">
              <span>1</span>
              <span>100</span>
              <span>10k</span>
            </div>
            <p className="fine">MODIS-equivalent, 2003–2025, per ≈12,400 km² cell. Basemap © OpenStreetMap contributors, OpenFreeMap.</p>
            {!dataReady && <p className="fine loading-line">Loading fire cells and borders…</p>}
          </div>
        </>
      )}
    </div>
  );
}
