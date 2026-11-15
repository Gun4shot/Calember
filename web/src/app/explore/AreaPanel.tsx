import { useState } from "react";
import { ApiFailure, api, exportFile, type ExportKind } from "../api";
import { STATIC_MODE } from "../snapshot";
import { CATEGORY_COLOR, CATEGORY_LABEL, MONTHS_LONG, REGIME_LABEL, fmt, monthLabel } from "../format";
import { useApp } from "../store";
import { ErrorBoundary } from "../ErrorBoundary";
import { Calendar } from "./Calendar";
import { NowCard } from "./NowCard";
import { SeasonView } from "./SeasonView";
import { SeriesChart } from "./SeriesChart";
import { playCalendar, stopCalendar } from "./sound";
import { TwinsView } from "./TwinsView";

export function AreaPanel() {
  const area = useApp((s) => s.area);
  const cal = useApp((s) => s.calendar);
  const loading = useApp((s) => s.loading);
  const error = useApp((s) => s.error);
  const colorMode = useApp((s) => s.colorMode);
  const valueMode = useApp((s) => s.valueMode);
  const setColorMode = useApp((s) => s.setColorMode);
  const setValueMode = useApp((s) => s.setValueMode);
  const clear = useApp((s) => s.clear);
  const season = useApp((s) => s.season);
  const twins = useApp((s) => s.twins);
  const now = useApp((s) => s.now);
  const [playing, setPlaying] = useState<number | null>(null);

  if (error)
    return (
      <div className="panel-msg" role="alert">
        <p>{error}</p>
        <button type="button" className="btn btn-ghost" onClick={clear}>
          Pick another area
        </button>
      </div>
    );
  if (!area)
    return (
      <div className="panel-intro">
        <h2>Every fire season since 2000, in one unit.</h2>
        <p>
          NASA's MODIS satellites counted fires from 2000; the sharper VIIRS sensors took over from 2012 and count several times more. Calember translates
          VIIRS into <em>what MODIS would have seen</em>, so 2005 and 2025 can be compared directly.
        </p>
        <p className="muted">Pick an area to see its fire calendar: search, click a province, draw a circle or a shape.</p>
        {loading && <p role="status">{loading}</p>}
      </div>
    );

  const latest = cal?.months.at(-1);
  // Drifted MODIS (Aqua now passes about an hour later) seeing clearly MORE than Calember signals burning moving later in the day.
  const recent = cal?.months.filter((m) => !m.provisional).slice(-24) ?? [];
  const recentH = recent.reduce((s, m) => s + m.h_count, 0);
  const recentModis = recent.reduce((s, m) => s + m.raw.modis, 0);
  // Drift normally makes MODIS see less (global 2025: 0.92 of Calember); clearly more (> 15 %) is the late-burning signature.
  const lateBurning = recentH >= 200 && recentModis > 1.15 * recentH;
  const peak = cal?.climatology.filter((c) => c.median !== null).sort((a, b) => (b.median ?? 0) - (a.median ?? 0))[0];
  const best = cal?.years.filter((y) => y.complete).sort((a, b) => b.total - a.total)[0];
  const qs = `?start=2025-11-01&end=2026-11-12`;

  return (
    <article className="panel-area" aria-labelledby="area-title">
      <header className="area-head">
        <div>
          <h2 id="area-title">{area.name}</h2>
          <p className="muted">
            {fmt(area.area_km2)} km² · {fmt(area.n_cells_r5)} grid cells {area.coverage === "partial" ? "· partly over water" : ""}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-small" onClick={clear} aria-label="Close this area">
          ✕
        </button>
      </header>
      {area.small_area_warning && <p className="note">Small area: monthly counts are low, so single months can swing a lot.</p>}
      {!cal && loading && (
        <p role="status" className="loading-line">
          {loading}
        </p>
      )}
      {cal && (
        <>
          <p className="summary">{cal.summary}</p>
          <dl className="facts">
            {latest && (
              <div>
                <dt>{monthLabel(latest.month)}</dt>
                <dd>
                  <strong>{fmt(latest.h_count)}</strong> hotspots
                  {latest.category && (
                    <span className="badge" style={{ borderColor: CATEGORY_COLOR[latest.category] }}>
                      {CATEGORY_LABEL[latest.category]}
                    </span>
                  )}
                  <span className="muted"> typical {fmt(latest.median_m)}</span>
                  {latest.provisional && <span className="muted"> · provisional</span>}
                </dd>
              </div>
            )}
            {peak && (
              <div>
                <dt>Typical peak</dt>
                <dd>
                  <strong>{MONTHS_LONG[peak.month_num - 1]}</strong> <span className="muted">median {fmt(peak.median)}</span>
                </dd>
              </div>
            )}
            {best && (
              <div>
                <dt>Most active year</dt>
                <dd>
                  <strong>{best.year}</strong> <span className="muted">{fmt(best.total)} hotspots</span>
                </dd>
              </div>
            )}
          </dl>

          {lateBurning && (
            <p className="note">
              In the last two years the real MODIS record, whose afternoon pass has drifted about an hour later, saw {fmt(recentModis)} hotspots here, {Math.round(100 * (recentModis / recentH - 1))} % more than
              Calember's {fmt(recentH)}. Burning may have moved later in the day: Calember reproduces the original early-afternoon pass, so it can show a larger decline than the
              burning itself. See the Lab.
            </p>
          )}
          {now && (
            <ErrorBoundary key={`now-${area.area_id}`} label="right-now card">
              <NowCard now={now} />
            </ErrorBoundary>
          )}
          <h3 className="h3">Burning calendar</h3>
          <div className="toolbar" role="group" aria-label="Calendar display">
            <div className="seg" role="radiogroup" aria-label="Values">
              <button type="button" role="radio" aria-checked={valueMode === "harmonized"} className={valueMode === "harmonized" ? "seg-on" : ""} onClick={() => setValueMode("harmonized")}>
                Harmonized
              </button>
              <button type="button" role="radio" aria-checked={valueMode === "raw"} className={valueMode === "raw" ? "seg-on" : ""} onClick={() => setValueMode("raw")}>
                Raw sensors
              </button>
            </div>
            <div className="seg" role="radiogroup" aria-label="Colour">
              <button type="button" role="radio" aria-checked={colorMode === "count"} className={colorMode === "count" ? "seg-on" : ""} onClick={() => setColorMode("count")}>
                Count
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={colorMode === "anomaly"}
                disabled={valueMode === "raw"}
                className={colorMode === "anomaly" && valueMode !== "raw" ? "seg-on" : ""}
                onClick={() => setColorMode("anomaly")}
                title={valueMode === "raw" ? "Anomalies are only meaningful for the harmonized record" : undefined}
              >
                vs normal
              </button>
            </div>
          </div>
          {valueMode === "raw" && (
            <p className="note">
              Raw mode sums every sensor as detected. Watch the jump in 2012 when VIIRS arrives: that jump is what harmonization removes.
            </p>
          )}
          <ErrorBoundary key={`cal-${area.area_id}`} label="calendar">
            <Calendar cal={cal} colorMode={colorMode} valueMode={valueMode} />
          </ErrorBoundary>
          <h3 className="h3">Yearly totals</h3>
          <ErrorBoundary key={`ser-${area.area_id}`} label="yearly chart">
            <SeriesChart cal={cal} />
          </ErrorBoundary>

          <h3 className="h3">Fire season timing</h3>
          {season ? (
            <ErrorBoundary key={`season-${area.area_id}`} label="season view">
              <SeasonView season={season} />
            </ErrorBoundary>
          ) : (
            <p className="muted">Measuring the fire seasons…</p>
          )}
          <ErrorBoundary key={`twins-${area.area_id}`} label="Fire Twins">
            <TwinsView tw={twins} />
          </ErrorBoundary>

          <h3 className="h3">Listen, print, download</h3>
          <div className="exports">
            <button
              type="button"
              className="btn btn-ghost"
              aria-pressed={playing !== null}
              onClick={() => {
                if (playing !== null) {
                  stopCalendar();
                  setPlaying(null);
                } else {
                  setPlaying(0);
                  void playCalendar(cal.months, (i) => setPlaying(i), () => setPlaying(null));
                }
              }}
            >
              {playing !== null ? `Stop (${cal.months[Math.min(playing, cal.months.length - 1)]?.month ?? ""})` : "Listen to 25 years"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
              Print area brief
            </button>
            <Dl className="btn btn-ghost" id={area.area_id} kind="calendar.stl">
              3D-print the calendar (STL)
            </Dl>
          </div>
          <p className="fine">Listen: each month is a note, higher = more fire, silence = none; a soft tick marks each new year.</p>
          <div className="exports">
            <Dl className="btn" id={area.area_id} kind="calendar.csv">
              Calendar CSV
            </Dl>
            <Dl className="btn" id={area.area_id} kind="hotspots.csv" qs={qs}>
              Hotspots CSV (last 12 months)
            </Dl>
            <Dl className="btn" id={area.area_id} kind="season.csv">
              Season CSV
            </Dl>
            <Dl className="btn btn-ghost" id={area.area_id} kind="bundle.zip" qs={qs}>
              Bundle (ZIP + README)
            </Dl>
          </div>

          <details className="table-wrap">
            <summary>Show the calendar as a table</summary>
            <table className="data-table">
              <caption>Monthly hotspots (MODIS-equivalent) for {area.name}. Baseline {cal.baseline[0]}–{cal.baseline[1]}.</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Hotspots</th>
                  <th scope="col">90 % range</th>
                  <th scope="col">vs normal</th>
                  <th scope="col">Raw sensors</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {[...cal.months].reverse().map((m) => (
                  <tr key={m.month}>
                    <th scope="row">{m.month}</th>
                    <td>{fmt(m.h_count)}</td>
                    <td>
                      {fmt(m.lo90)}–{fmt(m.hi90)}
                    </td>
                    <td>{m.category ? CATEGORY_LABEL[m.category] : "–"}</td>
                    <td>{fmt(m.raw.modis + m.raw.snpp + m.raw.noaa20 + m.raw.noaa21)}</td>
                    <td>
                      {m.regime}
                      {m.provisional ? " (provisional)" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <p className="fine">
            Unit: hotspots (MODIS-equivalent): what NASA FIRMS MODIS (Terra + Aqua) would have counted. Sources by period: {REGIME_LABEL.T} (2000–02),{" "}
            {REGIME_LABEL.M.toLowerCase()} (2002–11), blended (2012–19), VIIRS-based (2020 on). Months from Aug 2026 are provisional.
          </p>
        </>
      )}
    </article>
  );
}

/** A download: the API's export URL, or in the static deployment a file made in the browser. */
function Dl({ id, kind, qs = "", className, children }: { id: string; kind: ExportKind; qs?: string; className: string; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  if (!STATIC_MODE)
    return (
      <a className={className} href={api.exportUrl(id, kind, qs)} download>
        {children}
      </a>
    );
  const q = new URLSearchParams(qs.replace(/^\?/, ""));
  return (
    <button
      type="button"
      className={className}
      aria-busy={busy}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        exportFile(id, kind, { start: q.get("start") ?? undefined, end: q.get("end") ?? undefined })
          .catch((e) => window.alert(e instanceof ApiFailure ? e.message : "The download could not be made. Please try again."))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Preparing…" : children}
    </button>
  );
}
