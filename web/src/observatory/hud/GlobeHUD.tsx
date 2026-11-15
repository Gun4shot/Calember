// Landing panels: the kinetic headline with the world's numbers under the playhead, layers and drawing tools.
import { CATEGORY_LABEL, MONTHS_LONG, fmt, monthLabel } from "../../app/format";
import type { Calendar } from "../../app/types";
import type { GlobeData } from "../data";
import { REGIME_COLORS } from "../data";
import { type Layer, useObs } from "../store";
import { Reel, Words } from "./kinetic";
import { useEffect, useState } from "react";
import { loadRegimes } from "../data";
import type { FireRegime } from "../../app/types";
import { CAT_GLYPH, ordinal } from "./glyphs";
import { isAlert, useWatchStatuses } from "./watch";

export function GlobeHUD({ world, g }: { world: Calendar | null; g: GlobeData | null }) {
  const monthIdx = useObs((s) => s.monthIdx);
  const layer = useObs((s) => s.layer);
  const tool = useObs((s) => s.tool);
  const set = useObs((s) => s.set);
  const hoverName = useObs((s) => s.hoverName);
  const error = useObs((s) => s.error);
  const satCard = useObs((s) => s.satCard);
  // below 900 px the tools panel folds away behind a button (tablets and phones can still draw and switch layers)
  const [toolsOpen, setToolsOpen] = useState(false);
  const m = world?.months[Math.min(monthIdx, (world?.months.length ?? 1) - 1)];
  const future = g ? monthIdx >= g.nMonths : false;
  const layers: Array<{ id: Layer; label: string; hint: string }> = [
    { id: "activity", label: "Fire activity", hint: "Hotspots per month (MODIS-equivalent)" },
    { id: "anomaly", label: "vs normal", hint: "This month against the same month in 2003–2025" },
    { id: "regimes", label: "Fire regimes", hint: "10 fire regimes: when and how each place burns" },
  ];
  return (
    <>
      <section className="headline glass" aria-labelledby="hl-title">
        <p className="kicker">Harmonized MODIS + VIIRS · 2000 → now</p>
        <Words as="h1" text="The fire memory that outlives its satellites." className="hl-title" />
        {m && !future && (
          <div className="hl-now" aria-live="off">
            <div className="hl-month">{monthLabel(m.month)} · the whole world</div>
            <div className="hl-big">
              <Reel value={fmt(m.h_count)} />
              <span className="hl-unit">hotspots (MODIS-equivalent)</span>
            </div>
            {m.category && (
              <div className={`hl-cat cat-${m.category}`}>
                <span aria-hidden="true">{CAT_GLYPH[m.category]}</span> {CATEGORY_LABEL[m.category]}
                {m.pct_rank !== null && <span className="muted"> · {ordinal(m.pct_rank)} percentile of {MONTHS_LONG[Number(m.month.slice(5)) - 1]}s, 2003–2025</span>}
                {m.provisional && <span className="muted"> · provisional</span>}
              </div>
            )}
          </div>
        )}
        {future && (
          <div className="hl-now ghost-note">
            <div className="hl-month">After 2027</div>
            <p>
              Terra and Aqua end science operations in 2027. Without harmonization their 26-year record would end with them. Calember keeps it going in the same unit,
              from the VIIRS satellites.
            </p>
          </div>
        )}
        <div className="hl-actions">
          <button type="button" className="btn-hot" onClick={() => set({ paletteOpen: true })}>
            Search any place
            <kbd>/</kbd>
          </button>
          <span className="muted small hl-or">or click the globe</span>
          <button type="button" className="btn-ghost tools-toggle" aria-expanded={toolsOpen} aria-controls="globe-tools" onClick={() => setToolsOpen(!toolsOpen)}>
            {toolsOpen ? "Hide tools" : "Layers & drawing"}
          </button>
        </div>
        <WatchRow />
      </section>

      <aside id="globe-tools" className={`globe-tools glass ${toolsOpen ? "open" : ""}`} aria-label="Globe layers and drawing tools" hidden={!!satCard}>
        <p className="kicker">Layer</p>
        <div className="layer-list" role="radiogroup" aria-label="Globe layer">
          {layers.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={layer === l.id} className={`layer-btn ${layer === l.id ? "on" : ""}`} onClick={() => set({ layer: l.id })} title={l.hint}>
              <span className={`layer-swatch sw-${l.id}`} aria-hidden="true" />
              {l.label}
            </button>
          ))}
        </div>
        <LayerLegend layer={layer} />
        <p className="kicker">Draw an area</p>
        <div className="tool-row">
          <button type="button" className={`tool-btn ${tool === "lasso" ? "on" : ""}`} aria-pressed={tool === "lasso"} onClick={() => set({ tool: tool === "lasso" ? "none" : "lasso", candidate: null })} aria-keyshortcuts="L">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 12c-2-5 4-9 9-7s4 8-2 9c-3 .5-5-1-5-1l-2 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Lasso <kbd>L</kbd>
          </button>
          <button type="button" className={`tool-btn ${tool === "circle" ? "on" : ""}`} aria-pressed={tool === "circle"} onClick={() => set({ tool: tool === "circle" ? "none" : "circle", candidate: null })} aria-keyshortcuts="C">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="10" cy="10" r="1.3" fill="currentColor" />
            </svg>
            Circle <kbd>C</kbd>
          </button>
        </div>
        {tool !== "none" && (
          <p className="tool-hint" role="status">
            {tool === "lasso" ? "Drag on the Earth to draw around an area. Release to close it." : "Press on the centre and drag out the radius."} <kbd>Esc</kbd> to cancel.
          </p>
        )}
        <CircleForm />
        <button type="button" className="btn-precise" onClick={() => set({ mapMode: "entering", tool: "none", candidate: null })} aria-keyshortcuts="M">
          <span className="bp-globe" aria-hidden="true" />
          <span>
            <b>Precise 2D map</b>
            <i>place names, roads, exact drawing</i>
          </span>
          <kbd>M</kbd>
        </button>
        <div className="see-key">
          <p className="kicker">On the globe</p>
          <span><i className="k-col" /> fire columns: hotspots this month</span>
          <span><i className="k-modis" /> MODIS satellites &amp; swaths (Terra, Aqua)</span>
          <span><i className="k-viirs" /> VIIRS satellites &amp; swaths (S-NPP, NOAA-20/21)</span>
          <span className="fine">Click a satellite for its story. Orbits are illustrative and sped up.</span>
        </div>
      </aside>

      {hoverName && <div className="hover-tag" aria-hidden="true">{hoverName}</div>}
      {error && (
        <div className="toast" role="alert">
          {error}
          <button type="button" onClick={() => set({ error: null })} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </>
  );
}

function LayerLegend({ layer }: { layer: Layer }) {
  const [regimes, setRegimes] = useState<FireRegime[] | null>(null);
  useEffect(() => {
    if (layer === "regimes" && !regimes) loadRegimes().then((r) => setRegimes(r.list), () => undefined);
  }, [layer, regimes]);
  if (layer === "activity")
    return (
      <div className="legend2">
        <div className="ramp-inferno" />
        <div className="legend2-ticks">
          <span>few</span>
          <span>hotspots per month</span>
          <span>many</span>
        </div>
      </div>
    );
  if (layer === "anomaly")
    return (
      <div className="legend2">
        <div className="cat-strip">
          {(["much_below", "below", "normal", "above", "much_above", "record"] as const).map((c) => (
            <span key={c} className={`cat-${c}`} title={CATEGORY_LABEL[c]}>
              {CAT_GLYPH[c]}
            </span>
          ))}
        </div>
        <div className="legend2-ticks">
          <span>below</span>
          <span>normal</span>
          <span>above · record</span>
        </div>
        <p className="fine">Colour only, from the globe layer. Exact numbers: pick an area.</p>
      </div>
    );
  return (
    <ul className="regime-legend">
      {(regimes ?? []).map((r) => (
        <li key={r.regime_id}>
          <i style={{ background: REGIME_COLORS[(r.regime_id - 1) % REGIME_COLORS.length] }} aria-hidden="true" />
          {r.name}
        </li>
      ))}
    </ul>
  );
}

/** Keyboard / screen-reader path for the circle tool. */
function CircleForm() {
  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState("27.7");
  const [lon, setLon] = useState("85.3");
  const [km, setKm] = useState("50");
  const [err, setErr] = useState<string | null>(null);
  if (!open)
    return (
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>
        Enter latitude / longitude instead
      </button>
    );
  return (
    <form
      className="ll-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const la = Number(lat), lo = Number(lon), r = Number(km);
        if (!(la >= -90 && la <= 90) || !(lo >= -180 && lo <= 180) || !(r >= 5 && r <= 1500)) {
          setErr("Latitude −90…90, longitude −180…180, radius 5–1,500 km.");
          return;
        }
        setErr(null);
        const [{ api }, { circleRing }, { resolveEarly }] = await Promise.all([import("../../app/api"), import("../geo"), import("../globe/Pickers")]);
        // like a circle dragged on the globe: measure it right away, so the chip shows its size and Open works
        resolveEarly({ name: `${r} km around ${la}°, ${lo}°`, kind: "Circle", polys: [[circleRing(la, lo, r)]], center: [lo, la], request: () => api.areaByCircle(la, lo, r) });
        const { flyTo, cam } = await import("../world/camera");
        flyTo(la, lo, Math.min(cam.dist, 22), 1.2);
      }}
    >
      <label>
        Lat <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
      </label>
      <label>
        Lon <input inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
      </label>
      <label>
        km <input inputMode="decimal" value={km} onChange={(e) => setKm(e.target.value)} />
      </label>
      <button type="submit" className="btn-small">
        Go
      </button>
      {err && <p className="warn small">{err}</p>}
    </form>
  );
}

/** The places you watch, each with its month so far against normal; above-normal ones are flagged. */
function WatchRow() {
  const watched = useObs((s) => s.watched);
  const st = useWatchStatuses(watched.map((w) => w.id));
  if (!watched.length) return null;
  return (
    <div className="watch-row" aria-label="Places you watch">
      <span className="kicker">Watching</span>
      {watched.map((w) => {
        const s = st[w.id];
        const c = s?.category ?? null;
        const tip = s ? `${MONTHS_LONG[Number(s.month.slice(5)) - 1]} so far: ${c ? CATEGORY_LABEL[c] : "no answer yet"} (${fmt(s.mtd)} vs ${fmt(s.expected)} typical by today)` : s === null ? "status unavailable" : "checking…";
        return (
          <a key={w.id} className={`watch-chip ${isAlert(c) ? "alert" : ""}`} href={`#/area/${encodeURIComponent(w.id)}`} title={tip}>
            {w.name.split(",")[0]}
            {c && (
              <span className={`cat-${c}`} aria-label={CATEGORY_LABEL[c]}>
                {CAT_GLYPH[c]}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}
