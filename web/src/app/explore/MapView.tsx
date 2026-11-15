import { cellToBoundary, cellsToMultiPolygon } from "h3-js";
import maplibregl, { type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { api, statics } from "../api";
import { useApp } from "../store";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
// up to 14 regimes: distinct hues, ordered so neighbours in the legend differ
export const REGIME_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#86bcb6", "#d37295", "#a0cbe8", "#8cd17d"];

function circlePolygon(lat: number, lon: number, km: number): GeoJSON.Feature {
  const pts: [number, number][] = [];
  const dLat = km / 110.574;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    pts.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } };
}

function regimeFeatures(cells: string[], rid: number[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < cells.length; i++) {
    const ring = cellToBoundary(cells[i], true);
    const lons = ring.map((p) => p[0]);
    if (Math.max(...lons) - Math.min(...lons) > 180) continue;
    features.push({ type: "Feature", properties: { rid: rid[i] }, geometry: { type: "Polygon", coordinates: [ring] } });
  }
  return { type: "FeatureCollection", features };
}

function hexFeatures(cells: string[], vals: number[], peaks: number[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (vals[i] < 1) continue;
    const ring = cellToBoundary(cells[i], true);
    const lons = ring.map((p) => p[0]);
    if (Math.max(...lons) - Math.min(...lons) > 180) continue; // skip antimeridian-crossing cells
    features.push({ type: "Feature", properties: { v: vals[i], peak: peaks[i] }, geometry: { type: "Polygon", coordinates: [ring] } });
  }
  return { type: "FeatureCollection", features };
}

export function MapView() {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawPts = useRef<[number, number][]>([]);
  const [drawCount, setDrawCount] = useState(0);
  const area = useApp((s) => s.area);
  const pickMode = useApp((s) => s.pickMode);
  const radiusKm = useApp((s) => s.radiusKm);
  const now = useApp((s) => s.now);
  const mapLayer = useApp((s) => s.mapLayer);
  const setMapLayer = useApp((s) => s.setMapLayer);
  const flyTo = useApp((s) => s.flyTo);
  const [regimes, setRegimes] = useState<Array<{ regime_id: number; name: string }>>([]);
  const [hover, setHover] = useState<string | null>(null);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- create the map once
  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({
      container: box.current,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": "#0a0c0f" } }],
      },
      center: [20, 15],
      zoom: 1.4,
      minZoom: 0.8,
      maxZoom: 9,
      attributionControl: { compact: true, customAttribution: "Fire data: NASA FIRMS · Boundaries: Natural Earth" },
      doubleClickZoom: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", async () => {
      const [a0, stats] = await Promise.all([statics.admin0(), statics.mapStats()]);
      map.addSource("countries", { type: "geojson", data: a0 });
      map.addLayer({ id: "countries-fill", type: "fill", source: "countries", paint: { "fill-color": "#161a20" } });
      map.addSource("fire", { type: "geojson", data: hexFeatures(stats.cells, stats.mean_annual_meh, stats.peak_month) });
      map.addLayer({
        id: "fire",
        type: "fill",
        source: "fire",
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["log10", ["max", 1, ["get", "v"]]],
            0, "#3a1c3f", 1, "#7b2a52", 2, "#c2453c", 2.7, "#f07a2c", 3.3, "#fbbf45", 4, "#fff4b8",
          ],
          "fill-opacity": 0.82,
        },
      });
      map.addLayer({ id: "countries-line", type: "line", source: "countries", paint: { "line-color": "#39404b", "line-width": 0.6 } });
      statics.regimeMap().then((rm) => {
        if (!map.getStyle()) return;
        map.addSource("regimes", { type: "geojson", data: regimeFeatures(rm.cells, rm.regime_id) });
        const colorExpr = ["match", ["get", "rid"], ...REGIME_COLORS.flatMap((c, i) => [i + 1, c]), "#666"] as unknown as maplibregl.ExpressionSpecification;
        map.addLayer({ id: "regimes", type: "fill", source: "regimes", layout: { visibility: useApp.getState().mapLayer === "regimes" ? "visible" : "none" },
                       paint: { "fill-color": colorExpr, "fill-opacity": 0.8 } }, "countries-line");
      }, () => undefined);
      statics.regimes().then(setRegimes, () => undefined);
      map.addSource("admin1", { type: "geojson", data: statics.admin1Url, promoteId: "admin_id" });
      map.addLayer({ id: "admin1-fill", type: "fill", source: "admin1", paint: { "fill-color": "#ffffff", "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.08, 0] } });
      map.addLayer({ id: "admin1-line", type: "line", source: "admin1", minzoom: 2.5, paint: { "line-color": "#4a525e", "line-width": 0.4 } });
      map.addSource("sel", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "sel-fill", type: "fill", source: "sel", paint: { "fill-color": "#ffd166", "fill-opacity": 0.12 } });
      map.addLayer({ id: "sel-line", type: "line", source: "sel", paint: { "line-color": "#ffd166", "line-width": 2 } });
      map.addSource("live", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "live", type: "circle", source: "live", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.5, 8, 4],
                     "circle-color": "#ff5a36", "circle-stroke-color": "#ffd2c4", "circle-stroke-width": 0.5, "circle-opacity": 0.9 } });
      map.addSource("draft", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "draft-fill", type: "fill", source: "draft", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#8bd3ff", "fill-opacity": 0.15 } });
      map.addLayer({ id: "draft-line", type: "line", source: "draft", paint: { "line-color": "#8bd3ff", "line-width": 1.5, "line-dasharray": [2, 1] } });
      map.addLayer({ id: "draft-pts", type: "circle", source: "draft", filter: ["==", "$type", "Point"], paint: { "circle-radius": 4, "circle-color": "#8bd3ff" } });
    });

    let hovered: string | null = null;
    map.on("mousemove", (e: MapMouseEvent) => {
      const s = useApp.getState();
      const draft = map.getSource("draft") as GeoJSONSource | undefined;
      if (s.pickMode === "region" && map.getLayer("admin1-fill")) {
        const f = map.queryRenderedFeatures(e.point, { layers: ["admin1-fill"] })[0];
        const id = (f?.properties?.admin_id as string | undefined) ?? null;
        if (id !== hovered) {
          if (hovered) map.setFeatureState({ source: "admin1", id: hovered }, { hover: false });
          if (id) map.setFeatureState({ source: "admin1", id }, { hover: true });
          hovered = id;
          setHover(f ? `${f.properties?.name}, ${f.properties?.country_name}` : null);
        }
        map.getCanvas().style.cursor = id ? "pointer" : "";
      } else if (s.pickMode === "circle" && draft) {
        draft.setData({ type: "FeatureCollection", features: [circlePolygon(e.lngLat.lat, e.lngLat.lng, s.radiusKm)] });
        map.getCanvas().style.cursor = "crosshair";
      } else if (s.pickMode === "draw" && draft) {
        const pts = [...drawPts.current, [e.lngLat.lng, e.lngLat.lat] as [number, number]];
        const feats: GeoJSON.Feature[] = drawPts.current.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
        if (pts.length >= 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
        if (pts.length >= 3) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
        draft.setData({ type: "FeatureCollection", features: feats });
        map.getCanvas().style.cursor = "crosshair";
      }
    });
    map.on("mouseout", () => setHover(null));
    map.on("click", (e: MapMouseEvent) => {
      const s = useApp.getState();
      if (s.pickMode === "region") {
        const f = map.queryRenderedFeatures(e.point, { layers: ["admin1-fill"] })[0];
        const id = f?.properties?.admin_id as string | undefined;
        if (id) void s.select(() => api.areaByAdmin(id), String(f?.properties?.name), id);
      } else if (s.pickMode === "circle") {
        void s.select(() => api.areaByCircle(e.lngLat.lat, e.lngLat.lng, s.radiusKm), `a ${s.radiusKm} km circle`);
      } else {
        drawPts.current = [...drawPts.current, [e.lngLat.lng, e.lngLat.lat]];
        setDrawCount(drawPts.current.length);
      }
    });
    map.on("dblclick", () => finishDraw());
    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishDraw = () => {
    const pts = drawPts.current;
    if (pts.length < 3) return;
    drawPts.current = [];
    setDrawCount(0);
    (mapRef.current?.getSource("draft") as GeoJSONSource | undefined)?.setData(EMPTY);
    void useApp.getState().select(() => api.areaByPolygon(pts), "your drawn area");
  };
  const cancelDraw = () => {
    drawPts.current = [];
    setDrawCount(0);
    (mapRef.current?.getSource("draft") as GeoJSONSource | undefined)?.setData(EMPTY);
  };

  // ---- live detections (last 7 days) of the selected area
  useEffect(() => {
    const src = mapRef.current?.getSource("live") as GeoJSONSource | undefined;
    src?.setData(now?.last7d ?? EMPTY);
  }, [now]);

  // ---- density / regimes layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("fire")) return;
    map.setLayoutProperty("fire", "visibility", mapLayer === "density" ? "visible" : "none");
    if (map.getLayer("regimes")) map.setLayoutProperty("regimes", "visibility", mapLayer === "regimes" ? "visible" : "none");
  }, [mapLayer]);

  // ---- fly to a twin
  useEffect(() => {
    if (flyTo && mapRef.current) mapRef.current.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom, duration: reduced ? 0 : 1600 });
  }, [flyTo, reduced]);

  // ---- mode changes clear the draft
  useEffect(() => {
    cancelDraw();
    if (mapRef.current) mapRef.current.getCanvas().style.cursor = "";
  }, [pickMode, radiusKm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useApp.getState().pickMode !== "draw") return;
      if (e.key === "Enter") finishDraw();
      if (e.key === "Escape") cancelDraw();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- show the selected area and fly there
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("sel") as GeoJSONSource | undefined;
      if (!src) return;
      if (!area) {
        src.setData(EMPTY);
        return;
      }
      const mp = cellsToMultiPolygon(area.cells_r5, true);
      src.setData({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: mp } });
      const [w, s, e, n] = area.bbox;
      map.fitBounds([[w, s], [e, n]], { padding: { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 7.5, duration: reduced ? 0 : 1200 });
    };
    if (map.isStyleLoaded() && map.getSource("sel")) apply();
    else map.once("idle", apply);
  }, [area, reduced]);

  return (
    <div className="map-wrap">
      <div ref={box} className="map" role="application" aria-label="World map of harmonized fire activity. Use the search box or the region list to pick an area with the keyboard." />
      {hover && pickMode === "region" && <div className="map-hover" aria-hidden="true">{hover}</div>}
      {pickMode === "draw" && (
        <div className="map-hint" role="status">
          {drawCount < 3 ? `Click the map to add corners (${drawCount}/3 minimum).` : `${drawCount} corners. Double-click or press Enter to finish.`}
          {drawCount > 0 && (
            <>
              {drawCount >= 3 && (
                <button type="button" className="btn btn-small" onClick={finishDraw}>
                  Finish
                </button>
              )}
              <button type="button" className="btn btn-small btn-ghost" onClick={cancelDraw}>
                Clear
              </button>
            </>
          )}
        </div>
      )}
      <div className="map-layers seg" role="radiogroup" aria-label="Map layer">
        <button type="button" role="radio" aria-checked={mapLayer === "density"} className={mapLayer === "density" ? "seg-on" : ""} onClick={() => setMapLayer("density")}>
          Fire density
        </button>
        <button type="button" role="radio" aria-checked={mapLayer === "regimes"} className={mapLayer === "regimes" ? "seg-on" : ""} onClick={() => setMapLayer("regimes")}>
          Fire regimes
        </button>
      </div>
      {mapLayer === "regimes" && regimes.length > 0 && (
        <div className="map-legend regime-legend">
          <span>Fire regimes ({regimes.length} types of fire year, by when and how much they burn)</span>
          <ul>
            {regimes.map((r) => (
              <li key={r.regime_id}>
                <span className="swatch" style={{ background: REGIME_COLORS[r.regime_id - 1] }} /> {r.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="map-legend" aria-hidden="true" hidden={mapLayer !== "density"}>
        <span>Average hotspots per year (MODIS-equivalent, 2003–2025)</span>
        <div className="legend-ramp" />
        <div className="legend-ticks">
          <span>1</span>
          <span>10</span>
          <span>100</span>
          <span>1k</span>
          <span>10k</span>
        </div>
      </div>
    </div>
  );
}
