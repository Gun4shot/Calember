// The Area Dossier's DOM layer: header, the always-on answer strip, the chapter rail and one panel per station.
// Every station answers in words and numbers first; every 3D view has a flat/table equivalent.
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiFailure, api, exportFile, type ExportKind } from "../../app/api";
import { STATIC_MODE } from "../../app/snapshot";
import { isDrawnId } from "../../app/engine/region";
import { uiZoom } from "../../uiZoom";
import { CATEGORY_LABEL, MONTHS_LONG, MONTHS_SHORT, REGIME_LABEL, fmt, monthLabel } from "../../app/format";
import type { Calendar, CalendarMonth } from "../../app/types";
import { MONTH_HUES } from "../stage/Terrain";
import { gridOf, latestJudged, rawTotal, sameMonth } from "../stage/model";
import { STATIONS, type Station, useObs } from "../store";
import { CAT_GLYPH, CAT_HEX, fmtS, ordinal } from "./glyphs";
import { Reel, Words } from "./kinetic";
import { DailyStrip } from "./DailyStrip";
import { flyTo } from "../world/camera";
import { R } from "../geo";
import { cellToChildren } from "h3-js";
import { idxOf, monthAt } from "./TimeRibbon";

const regimeWords = (r: string) => REGIME_LABEL[r as keyof typeof REGIME_LABEL] ?? r;

export function AreaHUD() {
  const area = useObs((s) => s.area);
  const shape = useObs((s) => s.shape);
  const station = useObs((s) => s.station);
  const set = useObs((s) => s.set);
  const cal = useObs((s) => s.calendar);
  const error = useObs((s) => s.error);
  const table = useObs((s) => s.table);
  const [collapsed, setCollapsed] = useState(false);
  useAreaKeys();
  useHashSync();
  useTimelineSync();
  if (!area || !shape) return null;
  return (
    <>
      <AreaHeader />
      <AnswerStrip />
      <nav className="rail glass" aria-label="Stations">
        {STATIONS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`rail-btn ${station === s.id ? "on" : ""}`}
            aria-current={station === s.id ? "step" : undefined}
            onClick={() => {
              set({ station: s.id, flat: window.innerWidth < 640 });
            }}
            title={`${s.label}: ${s.q} (${s.key})`}
          >
            <span className="rail-n">{i + 1}</span>
            <span className="rail-l">{s.label}</span>
          </button>
        ))}
      </nav>
      <section className={`station glass ${collapsed ? "collapsed" : ""}`} key={station} aria-labelledby="st-title">
        <button type="button" className="icon-btn st-collapse" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? "Show the panel" : "Hide the panel to see the 3D view"}>
          {collapsed ? "▴" : "▾"}
        </button>
        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}
        {!cal && !error && <p className="loading-line">Reading 26 years of fire for {shape.name}…</p>}
        {cal && station === "verdict" && <VerdictPanel cal={cal} />}
        {station === "terrain" && <TerrainPanel />}
        {cal && station === "calendar" && <CalendarPanel cal={cal} />}
        {station === "season" && <SeasonPanel />}
        {cal && station === "helix" && <HelixPanel cal={cal} />}
        {station === "twins" && <TwinsPanel />}
        {cal && station === "take" && <TakePanel />}
      </section>
      <CalTooltip />
      {table && cal && <TableModal cal={cal} />}
    </>
  );
}

/** The time ribbon and the dossier's chosen month move together: scrub or type a month to judge it. */
function useTimelineSync() {
  const monthIdx = useObs((s) => s.monthIdx);
  const pinned = useObs((s) => s.pinned);
  const cal = useObs((s) => s.calendar);
  const set = useObs((s) => s.set);
  // remember what we last synced, so only the side that actually changed drives the other (no ping-pong)
  const last = useRef({ m: monthIdx, p: pinned });
  useEffect(() => {
    const prev = last.current;
    if (pinned && pinned !== prev.p) {
      const i = idxOf(pinned);
      last.current = { m: i, p: pinned };
      if (i !== monthIdx) set({ monthIdx: i, playing: false });
    } else if (monthIdx !== prev.m) {
      const mm = monthAt(monthIdx);
      const ok = !!cal && cal.months.some((x) => x.month === mm);
      last.current = { m: monthIdx, p: ok ? mm : pinned };
      if (ok && mm !== pinned) set({ pinned: mm });
    }
  }, [monthIdx, pinned, cal, set]);
}

/** Mirrors the dossier state into the URL so any view can be shared (replaceState: no history spam). */
function useHashSync() {
  const station = useObs((s) => s.station);
  const valueMode = useObs((s) => s.valueMode);
  const colorMode = useObs((s) => s.colorMode);
  const flat = useObs((s) => s.flat);
  const pinned = useObs((s) => s.pinned);
  const view = useObs((s) => s.view);
  useEffect(() => {
    if (view !== "area") return;
    const id = decodeURIComponent(window.location.hash.replace(/^#\/?/, "").split("?")[0]).split("/")[1];
    if (!id) return;
    const q = new URLSearchParams();
    if (valueMode === "raw") q.set("raw", "1");
    if (colorMode === "anomaly") q.set("anom", "1");
    if (flat) q.set("flat", "1");
    if (pinned) q.set("m", pinned);
    const next = `#/area/${encodeURIComponent(id)}/${station}${q.toString() ? `?${q}` : ""}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  }, [station, valueMode, colorMode, flat, pinned, view]);
}

function useAreaKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,select,[role=combobox]")) return;
      const st = useObs.getState();
      if (st.view !== "area" || st.paletteOpen) return;
      const s = STATIONS.find((x) => x.key === e.key);
      if (s) {
        st.set({ station: s.id, flat: window.innerWidth < 640 });
        return;
      }
      if (e.key === "Escape") {
        if (st.table) st.set({ table: false });
        else st.closeArea();
      } else if (e.key.toLowerCase() === "f" && st.station === "calendar") st.set({ flat: !st.flat });
      else if (e.key.toLowerCase() === "r" && st.station === "calendar") st.set({ valueMode: st.valueMode === "raw" ? "harmonized" : "raw" });
      else if (e.key.toLowerCase() === "t") st.set({ table: !st.table });
      else if (st.station === "calendar" && st.calendar && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const g = gridOf(st.calendar);
        const cur = st.pinned ? g.byMonth.get(st.pinned) : null;
        let y = cur ? g.years[cur.row] : g.years[g.years.length - 1];
        let m = cur ? cur.col + 1 : 1;
        if (e.key === "ArrowLeft") m -= 1;
        if (e.key === "ArrowRight") m += 1;
        if (e.key === "ArrowUp") y -= 1;
        if (e.key === "ArrowDown") y += 1;
        if (m < 1) { m = 12; y -= 1; }
        if (m > 12) { m = 1; y += 1; }
        const key = `${y}-${String(m).padStart(2, "0")}`;
        if (g.byMonth.has(key)) st.set({ pinned: key, hoverMonth: key });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function AreaHeader() {
  const area = useObs((s) => s.area)!;
  const shape = useObs((s) => s.shape)!;
  const twins = useObs((s) => s.twins);
  const closeArea = useObs((s) => s.closeArea);
  const set = useObs((s) => s.set);
  const watched = useObs((s) => s.watched);
  const toggleWatch = useObs((s) => s.toggleWatch);
  const [copied, setCopied] = useState(false);
  // only named places (province, country, biome, world) can be watched: drawn shapes are not kept by the API
  const linkId = decodeURIComponent(window.location.hash.replace(/^#\/?/, "").split("?")[0]).split("/")[1] ?? "";
  const watchId = linkId && !linkId.startsWith("a_") && !isDrawnId(linkId) ? linkId : null;
  const watching = !!watchId && watched.some((w) => w.id === watchId);
  return (
    <header className="area-head2 glass">
      <div className="ah-main">
        <p className="kicker">{shape.kind}</p>
        <Words as="h1" text={shape.name} className="ah-name" step={60} />
        <p className="ah-meta">
          {fmt(area.area_km2)} km² · {area.n_cells_r5 ? `${fmt(area.n_cells_r5)} grid cells` : area.kind ?? ""}
          {area.coverage === "partial" ? " · partly over water" : ""}
        </p>
        {twins?.query.regime_name && (
          <p className="ah-regime" title={twins.query.regime_description}>
            <span className="regime-dot" aria-hidden="true" />
            {twins.query.regime_name}
            {twins.query.regime_share != null && <span className="muted"> · {Math.round(twins.query.regime_share * 100)} % of its fire</span>}
          </p>
        )}
      </div>
      <div className="ah-actions">
        {watchId && (
          <button
            type="button"
            className="icon-btn watch-btn"
            aria-pressed={watching}
            title={watching ? "Stop watching this place" : "Watch this place: it shows on the globe with its month so far, and flags when it runs above normal"}
            onClick={() => toggleWatch(watchId, shape.name)}
          >
            {watching ? "★" : "☆"}
            <span className="sr-only">{watching ? "Stop watching" : "Watch this place"}</span>
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title="Compare with another place"
          onClick={() => set({ paletteOpen: true, paletteFor: "compare" })}
        >
          ⇄<span className="sr-only">Compare with another place</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Copy a link to this view"
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? "✓" : "⧉"}
          <span className="sr-only">Copy link</span>
        </button>
        <button type="button" className="icon-btn" onClick={closeArea} aria-label="Back to the globe (Esc)">
          ✕
        </button>
      </div>
    </header>
  );
}

/** One line of plain answers, always visible (Guideline: answer first, in under 10 seconds). */
function AnswerStrip() {
  const cal = useObs((s) => s.calendar);
  const now = useObs((s) => s.now);
  const season = useObs((s) => s.season);
  if (!cal) return <div className="answer glass shimmer" aria-hidden="true" />;
  const last = latestJudged(cal);
  const best = [...cal.years].filter((y) => y.complete).sort((a, b) => b.total - a.total)[0];
  const peak = [...cal.climatology].filter((c) => c.median !== null).sort((a, b) => (b.median ?? 0) - (a.median ?? 0))[0];
  return (
    <div className="answer glass" role="note" aria-label="Key answers">
      {last?.category && (
        <span className={`ans cat-${last.category}`}>
          <b>{monthLabel(last.month)}</b> {CAT_GLYPH[last.category]} {CATEGORY_LABEL[last.category]}
          {last.pct_rank !== null && <i> · {ordinal(last.pct_rank)} pct</i>}
        </span>
      )}
      {now && now.category && (
        <span className={`ans cat-${now.category}`}>
          <b>{MONTHS_LONG[Number(now.month.slice(5)) - 1]} so far</b> {CAT_GLYPH[now.category]} {CATEGORY_LABEL[now.category]}
          <span className={`live-dot ${now.source_status}`} title={`Live data: ${now.source_status}`} />
        </span>
      )}
      {peak && (
        <span className="ans">
          <b>Peak month</b> {MONTHS_LONG[peak.month_num - 1]}
          {now && now.days_to_typical_peak > 0 && <i> · in {now.days_to_typical_peak} days</i>}
        </span>
      )}
      {best && (
        <span className="ans">
          <b>Worst year</b> {best.year}
        </span>
      )}
      {season?.trends.onset && season.trends.onset.p !== null && season.trends.onset.p < 0.05 && season.trends.onset.sen_days_per_decade != null && (
        <span className="ans">
          <b>Season</b> starts {Math.abs(season.trends.onset.sen_days_per_decade).toFixed(0)} d/decade {season.trends.onset.sen_days_per_decade > 0 ? "later" : "earlier"}
        </span>
      )}
    </div>
  );
}

/** Splits a verdict into its first sentence (the answer) and the rest (supporting detail). */
function splitLead(text: string): [string, string] {
  const m = /[.!?]\s+(?=[A-Z0-9(])/.exec(text);
  return m ? [text.slice(0, m.index + 1), text.slice(m.index + 1).trim()] : [text, ""];
}

function Head({ k, q, verdict }: { k: string; q: string; verdict: string }) {
  const [lead, rest] = splitLead(verdict);
  // long supporting text: the next sentence stays, the remainder is one click away
  const [sub, extra] = rest.length > 150 ? splitLead(rest) : [rest, ""];
  return (
    <>
      <p className="kicker">{k}</p>
      <h2 id="st-title" className="st-q">
        {q}
      </h2>
      <Words as="p" text={lead} className="st-verdict" step={28} />
      {rest && <p className="st-sub">{sub}</p>}
      {extra && <More label="More">{extra}</More>}
    </>
  );
}

/** Explanations and fine print, one click away so the panel stays calm. */
function More({ label = "How to read this", children }: { label?: string; children: React.ReactNode }) {
  return (
    <details className="more">
      <summary>{label}</summary>
      <div className="more-body">{children}</div>
    </details>
  );
}

function Foot({ children }: { children?: React.ReactNode }) {
  const set = useObs((s) => s.set);
  return (
    <div className="st-foot">
      {children}
      <button type="button" className="btn-ghost" onClick={() => set({ table: true })}>
        Table <kbd>T</kbd>
      </button>
    </div>
  );
}

// ---------------- 1 · Verdict ----------------
function VerdictPanel({ cal }: { cal: Calendar }) {
  const pinned = useObs((s) => s.pinned);
  const now = useObs((s) => s.now);
  const set = useObs((s) => s.set);
  const sel = (pinned && cal.months.find((m) => m.month === pinned)) || latestJudged(cal);
  if (!sel) return <p>No months to judge yet.</p>;
  const all = sameMonth(cal, sel.month);
  const rank = [...all].sort((a, b) => b.h_count - a.h_count).findIndex((m) => m.month === sel.month) + 1;
  const mName = MONTHS_LONG[Number(sel.month.slice(5, 7)) - 1];
  // a provisional month that has already ended is not "so far": it is complete but not yet final
  const tense = !sel.provisional ? "was" : sel.month < new Date().toISOString().slice(0, 7) ? "is provisionally" : "is so far";
  const verdict =
    (sel.median_m ?? 0) < 1 && sel.h_count < 1
      ? `${monthLabel(sel.month)}: almost no fire (${fmtS(sel.h_count)} hotspots), as usual for ${MONTHS_LONG[Number(sel.month.slice(5, 7)) - 1]} here.`
      : sel.category
        ? `${monthLabel(sel.month)} ${tense} ${CATEGORY_LABEL[sel.category]}: ${fmtS(sel.h_count)} hotspots against a typical ${fmtS(sel.median_m)}.`
        : `${monthLabel(sel.month)}: ${fmtS(sel.h_count)} hotspots.`;
  const latest = latestJudged(cal);
  // the default view answers "right now" first (month to date, live), then the last judged month on the stage
  const lead = !!now && !!latest && sel.month === latest.month && now.month > sel.month;
  const nowLine =
    lead && now!.category
      ? `${MONTHS_LONG[Number(now!.month.slice(5)) - 1]} so far is ${CATEGORY_LABEL[now!.category]}: ${fmtS(now!.mtd_h_count)} hotspots, against ${fmtS(now!.expected_mtd)} typical by today.`
      : null;
  const mtd = now && (
    <div className={`mtd ${lead ? "mtd-lead" : ""}`}>
      <p className="kicker">
        {lead ? "Right now · " : ""}
        {MONTHS_LONG[Number(now.month.slice(5)) - 1]} so far · day {now.days_elapsed} of {now.days_in_month}
        <span className={`live-pill ${now.source_status}`}>{now.source_status === "ok" ? "live" : now.source_status}</span>
      </p>
      <Gauge value={now.mtd_h_count} expected={now.expected_mtd} lo={now.mtd_lo90} hi={now.mtd_hi90} />
      <More label="More">
        <p>{now.summary}</p>
        <p>
          Falling sparks on the stage: {fmt(now.last7d?.features?.length ?? 0)} live NOAA-20 / NOAA-21 detections from the last 7 days.
          {now.source_status !== "ok" ? " The live NASA FIRMS feed is not connected right now, so this uses the stored record only." : ""}
        </p>
      </More>
    </div>
  );
  return (
    <>
      <Head k="1 · Verdict" q="Is this month normal?" verdict={nowLine ? `${nowLine} Last month: ${verdict}` : verdict} />
      {lead && mtd}
      {lead && <p className="kicker verdict-split">{monthLabel(sel.month)} · the month on the stage</p>}
      <div className="bigstats">
        <div className={`bigstat cat-${sel.category ?? "normal"}`}>
          <span className="bs-k">pct vs {cal.baseline[0]}–{String(cal.baseline[1]).slice(2)}</span>
          <span className="bs-v">{sel.pct_rank !== null ? <Reel value={ordinal(sel.pct_rank)} /> : "–"}</span>
        </div>
        <div className="bigstat">
          <span className="bs-k">× typical</span>
          <span className="bs-v">{sel.ratio_to_median !== null ? <Reel value={sel.ratio_to_median >= 0.1 ? sel.ratio_to_median.toFixed(1) : sel.ratio_to_median.toFixed(2)} /> : "–"}</span>
        </div>
        <div className="bigstat">
          <span className="bs-k">rank, all yrs</span>
          <span className="bs-v">
            <Reel value={`${rank}/${all.length}`} />
          </span>
        </div>
      </div>
      <DailyStrip areaId={useObs.getState().area!.area_id} month={sel.month} />
      <ReadLineup cal={cal} sel={sel} mName={mName} />
      <p className="st-meta">
        {sel.hi90 > sel.lo90 ? <span>90 % range {fmtS(sel.lo90)}–{fmtS(sel.hi90)}</span> : null}
        <span>Source: {regimeWords(sel.regime)}</span>
        {sel.provisional ? <span>provisional (near-real-time data)</span> : null}
      </p>
      <LateBurning cal={cal} />
      <OffSeason cal={cal} sel={sel} />
      {latest && pinned !== latest.month && (
        <button type="button" className="link-btn" onClick={() => set({ pinned: latest.month })}>
          ← back to the latest month ({monthLabel(latest.month)})
        </button>
      )}
      {!lead && mtd}
      <Foot />
    </>
  );
}

/** How to read the line-up, with its extremes and median as plain numbers. */
function ReadLineup({ cal, sel, mName }: { cal: Calendar; sel: CalendarMonth; mName: string }) {
  const set = useObs((s) => s.set);
  const all = sameMonth(cal, sel.month).filter((m) => m.h_count > 0 || m.month === sel.month);
  if (!all.length) return null;
  const sorted = [...all].sort((a, b) => a.h_count - b.h_count);
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  const med = sel.median_m ?? cal.climatology.find((c) => c.month_num === Number(sel.month.slice(5, 7)))?.median ?? null;
  const y = (m: CalendarMonth) => m.month.slice(0, 4);
  return (
    <div className="read-box">
      <div className="lu-stats">
        <button type="button" onClick={() => set({ pinned: lo.month })} title="Judge this month">
          <span>quietest</span>
          <b>{y(lo)}</b>
          <i>{fmtS(lo.h_count)}</i>
        </button>
        <div>
          <span>median</span>
          <b>{fmtS(med)}</b>
          <i>{cal.baseline[0]}–{String(cal.baseline[1]).slice(2)}</i>
        </div>
        <button type="button" onClick={() => set({ pinned: hi.month })} title="Judge this month">
          <span>busiest</span>
          <b>{y(hi)}</b>
          <i>{fmtS(hi.h_count)}</i>
        </button>
      </div>
      <More label="How to read the 3D view">
      <ul>
        <li>
          <i className="rk-pillar" /> Each pillar is <b>{mName} of one year</b> ({y(sorted.reduce((a, b) => (a.month < b.month ? a : b)))}–{y(sorted.reduce((a, b) => (a.month > b.month ? a : b)))}), sorted from quietest (left) to busiest (right). Height = hotspots.
        </li>
        <li>
          <i className={`rk-sel cat-${sel.category ?? "normal"}`} /> The lit pillar with the flag is the month being judged.
        </li>
        <li>
          <i className="rk-band" /> Glass band = the middle half of {cal.baseline[0]}–{cal.baseline[1]}; dashed line = the median.
        </li>
      </ul>
      <p>Click any pillar or year label to judge that year, or pick a month on the timeline below.</p>
      </More>
    </div>
  );
}

/** Off-season months are honest but uninformative: offer the most recent peak-season month. */
function OffSeason({ cal, sel }: { cal: Calendar; sel: CalendarMonth }) {
  const set = useObs((s) => s.set);
  const peak = [...cal.climatology].filter((c) => c.median !== null).sort((a, b) => (b.median ?? 0) - (a.median ?? 0))[0];
  if (!peak || (peak.median ?? 0) <= 0 || (sel.median_m ?? 0) > 0.08 * (peak.median ?? 0)) return null;
  const mm = String(peak.month_num).padStart(2, "0");
  const last = [...cal.months].reverse().find((m) => m.month.endsWith(`-${mm}`) && m.category !== null);
  if (!last || last.month === sel.month) return null;
  return (
    <p className="cliff-note">
      <b>Off-season.</b> {MONTHS_LONG[Number(sel.month.slice(5, 7)) - 1]} is quiet here; fire peaks in {MONTHS_LONG[peak.month_num - 1]}.{" "}
      <button type="button" className="link-btn" onClick={() => set({ pinned: last.month })}>
        Judge {monthLabel(last.month)} instead →
      </button>
    </p>
  );
}

/** Drifted MODIS (Aqua now passes about an hour later) seeing clearly MORE than Calember signals burning moving later in the day. */
function LateBurning({ cal }: { cal: Calendar }) {
  const recent = cal.months.filter((m) => !m.provisional).slice(-24);
  const h = recent.reduce((s, m) => s + m.h_count, 0);
  const modis = recent.reduce((s, m) => s + m.raw.modis, 0);
  if (h < 200 || modis <= 1.15 * h) return null;
  return (
    <details className="cliff-note note-d">
      <summary>
        <b>Time-of-day caveat</b>
      </summary>
      In the last two years the real MODIS record, whose afternoon pass has drifted about an hour later, saw {fmt(modis)} hotspots here,{" "}
      {Math.round(100 * (modis / h - 1))} % more than Calember's {fmt(h)}. Burning may have moved later in the day; Calember reproduces the original early-afternoon pass, so recent months
      can read lower than the burning itself.
    </details>
  );
}

function Gauge({ value, expected, lo, hi }: { value: number; expected: number; lo: number; hi: number }) {
  const max = Math.max(value, expected, hi) * 1.15 || 1;
  const pct = (v: number) => `${Math.min(100, (100 * v) / max)}%`;
  return (
    <div className="fuel" role="img" aria-label={`So far ${fmt(value)} hotspots, typical by today ${fmt(expected)}`}>
      <div className="fuel-band" style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }} />
      <div className="fuel-bar" style={{ width: pct(value) }} />
      <div className="fuel-exp" style={{ left: pct(expected) }}>
        <span style={{ left: `clamp(0px, 50%, 100%)`, transform: expected / max < 0.25 ? "translateX(0)" : expected / max > 0.75 ? "translateX(-100%)" : "translateX(-50%)" }}>typical by today {fmtS(expected)}</span>
      </div>
      <div className="fuel-val" style={{ left: pct(value), transform: value / max < 0.1 ? "translateX(0)" : "translateX(-50%)" }}>
        so far {fmtS(value)}
      </div>
    </div>
  );
}

// ---------------- 2 · Terrain ----------------
function TerrainPanel() {
  const cells = useObs((s) => s.cells);
  const places = useObs((s) => s.places);
  const focus = useObs((s) => s.placeFocus);
  const cellsError = useObs((s) => s.cellsError);
  const colorBy = useObs((s) => s.terrainColor);
  const year = useObs((s) => s.terrainYear);
  const mode = useObs((s) => s.terrainMode);
  const pinned = useObs((s) => s.pinned);
  const cm = useObs((s) => s.cellsMonth);
  const set = useObs((s) => s.set);
  // month mode: the timeline month across the cells, and how many cells sit above / below their own normal
  const mstats = useMemo(() => {
    if (mode !== "month" || !cm || cm.month !== pinned) return null;
    let tot = 0, typ = 0, above = 0, below = 0, burning = 0;
    cm.values.forEach((v, i) => {
      const t = cm.typical[i];
      tot += v;
      typ += t;
      if (v > 0) burning++;
      if (v + t < 1) return; // a cell with no fire either way is neither
      const r = (v + 0.5) / (t + 0.5);
      if (r >= 1.5) above++;
      else if (r <= 1 / 1.5) below++;
    });
    return { tot, typ, above, below, burning, n: cm.values.length };
  }, [mode, cm, pinned]);
  const stats = useMemo(() => {
    if (!cells) return null;
    const v = [...cells.mean_annual].sort((a, b) => b - a);
    const total = v.reduce((s, x) => s + x, 0);
    const top = v.slice(0, Math.max(1, Math.round(v.length * 0.1))).reduce((s, x) => s + x, 0);
    const peaks = new Array(12).fill(0);
    cells.peak_month.forEach((p, i) => p && (peaks[p - 1] += cells.mean_annual[i]));
    const pk = peaks.indexOf(Math.max(...peaks));
    return { share: total > 0 ? top / total : 0, total, n: v.length, pk, burning: v.filter((x) => x > 0).length };
  }, [cells]);
  const top = places?.places[0];
  const verdict = mode === "month"
    ? mstats && pinned
      ? `${monthLabel(pinned)}: ${fmtS(mstats.tot)} hotspots across the area (typical ${fmtS(mstats.typ)}). ${fmt(mstats.above)} cells burned clearly more than usual, ${fmt(mstats.below)} clearly less.`
      : "Reading the month in every cell…"
    : top && places && places.n_places > 1
    ? `Most of the fire is in ${top.name} (${Math.round(top.share * 100)} %)${places.places[1] ? `, then ${places.places[1].name} (${Math.round(places.places[1].share * 100)} %)` : ""}.`
    : stats
    ? `${Math.round(stats.share * 100)} % of the fire falls in the busiest 10 % of the area. ${fmt(stats.burning)} of ${fmt(stats.n)} cells burned at least once.`
    : cellsError
      ? "This area is too large for the fine grid; showing the coarse 12,400 km² cells from the globe."
      : "Mapping where it burns…";
  return (
    <>
      <Head k="2 · Terrain" q="Where in the area does it burn?" verdict={verdict} />
      <div className="ctl-row">
        <div className="seg2 cool" role="radiogroup" aria-label="Period">
          <button type="button" role="radio" aria-checked={mode === "mean"} onClick={() => set({ terrainMode: "mean", terrainColor: colorBy === "anom" ? "amount" : colorBy })}>
            Long-term
          </button>
          <button type="button" role="radio" aria-checked={mode === "month"} onClick={() => set({ terrainMode: "month", terrainColor: colorBy === "peak" ? "anom" : colorBy })} title="The month on the timeline below">
            {pinned ? monthLabel(pinned) : "Timeline month"}
          </button>
        </div>
        <div className="seg2" role="radiogroup" aria-label="Colour">
          <button type="button" role="radio" aria-checked={colorBy === "amount"} onClick={() => set({ terrainColor: "amount" })}>
            How much
          </button>
          {mode === "month" ? (
            <button type="button" role="radio" aria-checked={colorBy === "anom"} onClick={() => set({ terrainColor: "anom" })}>
              vs its normal
            </button>
          ) : (
            <button type="button" role="radio" aria-checked={colorBy === "peak"} onClick={() => set({ terrainColor: "peak" })}>
              Peak month
            </button>
          )}
        </div>
      </div>
      {mode === "month" && colorBy === "anom" && <div className="anom-key" aria-hidden="true" />}
      {mode === "mean" && colorBy === "peak" && (
        <div className="month-wheel" aria-label="Peak month colours">
          {MONTHS_SHORT.map((m, i) => (
            <span key={m} style={{ background: MONTH_HUES[i] }}>
              {m}
            </span>
          ))}
        </div>
      )}
      {mode === "mean" && cells?.years && (
        <label className="year-slider">
          <span>
            {year ?? `Mean ${cells.first_year}–${cells.last_year}`}
            {year !== null && (
              <button type="button" className="link-btn" onClick={() => set({ terrainYear: null })}>
                show the mean
              </button>
            )}
          </span>
          <input
            type="range"
            min={cells.years[0]}
            max={cells.years[cells.years.length - 1]}
            value={year ?? cells.years[cells.years.length - 1]}
            onChange={(e) => set({ terrainYear: Number(e.target.value) })}
          />
        </label>
      )}
      {places && places.places.length > 0 && (
        <div className="where">
          <p className="kicker">
            {places.n_places > 1 ? "Where it burns most" : "Where it burns hottest"} · {places.period.slice(0, 4)}–{places.period.slice(-7, -3)}
          </p>
          {/* a single province would list only itself at 100 %: show just the hottest cell then */}
          {places.n_places > 1 && (
          <ol className="where-list" onMouseLeave={() => set({ placeFocus: null })}>
            {places.places.map((p) => (
              <li key={p.code} className={focus === p.code ? "on" : ""}>
                <button
                  type="button"
                  onMouseEnter={() => cells?.adm1 && set({ placeFocus: p.code })}
                  onFocus={() => cells?.adm1 && set({ placeFocus: p.code })}
                  onClick={() => set({ placeFocus: focus === p.code ? null : p.code })}
                  aria-pressed={focus === p.code}
                >
                  <span className="wl-name">{p.name}</span>
                  <span className="wl-bar">
                    <i style={{ width: `${Math.max(2, 100 * (p.share / places.places[0].share))}%` }} />
                  </span>
                  <span className="wl-pct">{p.share >= 0.1 ? Math.round(p.share * 100) : (p.share * 100).toFixed(1)} %</span>
                </button>
              </li>
            ))}
          </ol>
          )}
          {places.n_places > places.places.length && <p className="fine">+ {places.n_places - places.places.length} more with smaller shares.</p>}
          {places.hottest && (
            <p className="hot-line">
              <b>Hottest cell</b> (≈253 km²) is {places.hottest.where}
              {places.hottest.province ? `, in ${places.hottest.province}` : ""}, at {Math.abs(places.hottest.lat).toFixed(2)}°{places.hottest.lat >= 0 ? "N" : "S"}{" "}
              {Math.abs(places.hottest.lon).toFixed(2)}°{places.hottest.lon >= 0 ? "E" : "W"}: about {fmt(places.hottest.mean_annual)} hotspots a year, {places.hottest.times_average}× the area's
              average cell.
            </p>
          )}
        </div>
      )}
      <More>
        <p>
          Each hex is one grid cell of about {cells ? "253" : "12,400"} km², raised by its mean hotspots per year (MODIS-equivalent). Hover a cell for its numbers. Drag to orbit the stage.
        </p>
        {mode === "month" && (
          <p>Scrub or play the timeline below and the terrain regrows month by month. {colorBy === "anom" ? "Blue: less than this cell's usual for the month · grey: usual · orange to red: more." : ""}</p>
        )}
        {cells?.adm1 && places && places.n_places > 1 && <p>Hover a name to light up its cells on the stage.</p>}
      </More>
      <Foot />
    </>
  );
}

// ---------------- 3 · Calendar ----------------
function CalendarPanel({ cal }: { cal: Calendar }) {
  const valueMode = useObs((s) => s.valueMode);
  const colorMode = useObs((s) => s.colorMode);
  const flat = useObs((s) => s.flat);
  const set = useObs((s) => s.set);
  const area = useObs((s) => s.area)!;
  const jump = useMemo(() => {
    const yr = (y: number) => cal.months.filter((m) => m.month.startsWith(`${y}-`));
    const raw = (ys: number[]) => ys.reduce((s, y) => s + yr(y).reduce((a, m) => a + rawTotal(m), 0), 0) / ys.length;
    const har = (ys: number[]) => ys.reduce((s, y) => s + yr(y).reduce((a, m) => a + m.h_count, 0), 0) / ys.length;
    const before = [2009, 2010, 2011], after = [2012, 2013, 2014];
    const rb = raw(before), ra = raw(after), hb = har(before), ha = har(after);
    return rb > 0 && hb > 0 ? { raw: ra / rb, harm: ha / hb } : null;
  }, [cal]);
  return (
    <>
      <Head k="3 · Burning calendar" q="Every month since 2000" verdict={cal.summary} />
      <div className="ctl-row">
        <div className="seg2 cool" role="radiogroup" aria-label="Values">
          <button type="button" role="radio" aria-checked={valueMode === "harmonized"} onClick={() => set({ valueMode: "harmonized" })}>
            Harmonized
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={valueMode === "raw"}
            onClick={() => set({ valueMode: "raw" })}
          >
            Raw sensors <kbd>R</kbd>
          </button>
        </div>
        <div className="seg2" role="radiogroup" aria-label="Colour">
          <button type="button" role="radio" aria-checked={colorMode === "count" || valueMode === "raw"} onClick={() => set({ colorMode: "count" })}>
            Count
          </button>
          <button type="button" role="radio" aria-checked={colorMode === "anomaly" && valueMode !== "raw"} disabled={valueMode === "raw"} title={valueMode === "raw" ? "vs normal only makes sense for the harmonized record" : undefined} onClick={() => set({ colorMode: "anomaly" })}>
            vs normal
          </button>
        </div>
        <button type="button" className={`btn-ghost ${flat ? "on" : ""}`} aria-pressed={flat} onClick={() => set({ flat: !flat })}>
          {flat ? "3D" : "Flatten"} <kbd>F</kbd>
        </button>
      </div>
      {valueMode === "raw" && jump && (
        <p className="cliff-note" role="status">
          <b>The 2012 cliff.</b> Summing every sensor, 2012–14 look {jump.raw.toFixed(1)}× busier than 2009–11 here, because VIIRS joined and sees smaller fires. Harmonized:{" "}
          {jump.harm.toFixed(2)}×. The icy-blue part of each block is the excess that harmonization removes.
        </p>
      )}
      {colorMode === "anomaly" && valueMode === "harmonized" && (
        <div className="cat-legend">
          {(["much_below", "below", "normal", "above", "much_above", "record"] as const).map((c) => (
            <span key={c}>
              <i style={{ background: CAT_HEX[c] }} />
              {CAT_GLYPH[c]} {CATEGORY_LABEL[c]}
            </span>
          ))}
        </div>
      )}
      <More>
        <p>
          Rows are years (oldest at the back), columns are months; height and colour show hotspots (MODIS-equivalent). The white ridge in front is a typical year (median, middle half
          shaded); the wall on the right is each year's total. Hover or use the arrow keys; click to pin a month. Hatched blocks are provisional.
        </p>
      </More>
      <Foot>
        {STATIC_MODE ? (
          <button type="button" className="btn-ghost" onClick={() => void exportFile(area.area_id, "calendar.csv").catch(() => undefined)}>
            ↓ calendar.csv
          </button>
        ) : (
          <a className="btn-ghost" href={api.exportUrl(area.area_id, "calendar.csv")} download>
            ↓ calendar.csv
          </a>
        )}
      </Foot>
    </>
  );
}

function CalTooltip() {
  const hm = useObs((s) => s.hoverMonth);
  const cal = useObs((s) => s.calendar);
  const station = useObs((s) => s.station);
  const valueMode = useObs((s) => s.valueMode);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const on = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", on);
    return () => window.removeEventListener("pointermove", on);
  }, []);
  if (!hm || !cal || station !== "calendar") return null;
  const m: CalendarMonth | undefined = gridOf(cal).byMonth.get(hm)?.m;
  if (!m) return null;
  const tot = rawTotal(m) || 1;
  const z = uiZoom();
  const left = Math.min(window.innerWidth / z - 300, pos.x / z + 18);
  const top = Math.min(window.innerHeight / z - 260, pos.y / z + 14);
  return (
    <div className="caltip glass" style={{ left, top }} role="tooltip">
      <b>{monthLabel(m.month)}</b>
      <div className="ct-big">
        {fmt(m.h_count)} <span>hotspots</span>
      </div>
      <div className="muted">
        90 % range {fmt(m.lo90)}–{fmt(m.hi90)}
      </div>
      {m.category && (
        <div className={`cat-${m.category}`}>
          {CAT_GLYPH[m.category]} {CATEGORY_LABEL[m.category]}
          {m.pct_rank !== null && ` · ${ordinal(m.pct_rank)} pct`}
          {m.ratio_to_median !== null && ` · ${m.ratio_to_median.toFixed(1)}× typical`}
        </div>
      )}
      <div className="ct-src">{regimeWords(m.regime)}</div>
      <div className="ct-raw" aria-label="Raw detections by sensor">
        <span style={{ width: `${(100 * m.raw.modis) / tot}%` }} className="r-m" />
        <span style={{ width: `${(100 * (m.raw.snpp + m.raw.noaa20 + m.raw.noaa21)) / tot}%` }} className="r-v" />
      </div>
      <div className="ct-raw-l">
        <span className="r-mt">MODIS {fmt(m.raw.modis)}</span>
        <span className="r-vt">VIIRS {fmt(m.raw.snpp + m.raw.noaa20 + m.raw.noaa21)}</span>
        {valueMode === "raw" && <span>raw sum {fmt(rawTotal(m))}</span>}
      </div>
      {(m.provisional || m.modis_outage || (m.fill_frac ?? 0) >= 0.1) && (
        <div className="muted small">
          {m.provisional ? "provisional · " : ""}
          {m.modis_outage ? "MODIS data gap · " : ""}
          {(m.fill_frac ?? 0) >= 0.1 ? `${Math.round((m.fill_frac ?? 0) * 100)} % gap-filled` : ""}
        </div>
      )}
    </div>
  );
}

// ---------------- 4 · Season ----------------
function SeasonPanel() {
  const season = useObs((s) => s.season);
  if (!season) return <Head k="4 · Season" q="Is the fire season shifting?" verdict="Measuring every fire season…" />;
  const t = season.trends;
  const row = (k: "onset" | "peak" | "end" | "length", label: string) => {
    const tr = t[k];
    if (!tr) return null;
    const v = tr.sen_days_per_decade ?? 0;
    const sig = tr.p !== null && tr.p < 0.05;
    return (
      <tr key={k} className={sig ? "sig" : ""}>
        <th scope="row">{label}</th>
        <td>{Math.abs(v) < 0.5 ? "steady" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} days / decade`}</td>
        <td>{tr.p === null ? "–" : tr.p < 0.01 ? "p < 0.01" : `p = ${tr.p.toFixed(2)}`}</td>
      </tr>
    );
  };
  const valid = season.years.filter((y) => !y.insufficient);
  return (
    <>
      <Head k="4 · Fire tree rings" q="Is the fire season shifting?" verdict={season.summary} />
      <table className="mini-table">
        <thead>
          <tr>
            <th scope="col">Season</th>
            <th scope="col">Trend</th>
            <th scope="col">Significance</th>
          </tr>
        </thead>
        <tbody>
          {row("onset", "Onset (10 %)")}
          {row("peak", "Peak")}
          {row("end", "End (90 %)")}
          {row("length", "Length")}
          {t.total && (
            <tr className={t.total.p !== null && t.total.p < 0.05 ? "sig" : ""}>
              <th scope="row">Yearly total</th>
              <td>
                {(t.total.sen_pct_per_decade ?? 0) > 0 ? "+" : "−"}
                {Math.abs(t.total.sen_pct_per_decade ?? 0).toFixed(0)} % / decade
              </td>
              <td>{t.total.p === null ? "–" : t.total.p < 0.01 ? "p < 0.01" : `p = ${t.total.p.toFixed(2)}`}</td>
            </tr>
          )}
        </tbody>
      </table>
      <More label="How to read the rings">
      <p>
        Each ring is one fire year ({valid.length} measured, oldest and darkest in the centre, newest and brightest outside), drawn from onset to end with a bead at the peak; thicker rings burned more. The fire year starts in{" "}
        {MONTHS_LONG[season.fire_year_start_month - 1]}, after the quietest month.{season.two_seasons ? ` Two seasons here: ${season.two_seasons.join(" and ")}.` : ""} Orange arcs on the rim are
        significant shifts.
      </p>
      </More>
      <Foot />
    </>
  );
}

// ---------------- 5 · Helix ----------------
function HelixPanel({ cal }: { cal: Calendar }) {
  const playIdx = useObs((s) => s.playIdx);
  const colorMode = useObs((s) => s.colorMode);
  const set = useObs((s) => s.set);
  const [speed, setSpeed] = useState(1);
  const playing = playIdx !== null;
  const cur = playIdx !== null ? cal.months[Math.min(playIdx, cal.months.length - 1)] : null;
  const toggle = async () => {
    const sound = await import("../../app/explore/sound");
    if (playing) {
      sound.stopCalendar();
      set({ playIdx: null });
      return;
    }
    set({ playIdx: 0 });
    void sound.playCalendar(
      cal.months,
      (i) => set({ playIdx: i }),
      () => set({ playIdx: null }),
      speed,
    );
  };
  useEffect(() => () => void import("../../app/explore/sound").then((s) => s.stopCalendar()), []);
  return (
    <>
      <Head k="5 · Fire Helix" q="26 years in one spiral" verdict="One turn per year, January at the top. Thick, orange turns are big, above-normal seasons; a twist in the hot band means the season moved." />
      <div className="ctl-row">
        <button type="button" className="btn-hot" onClick={() => void toggle()} aria-pressed={playing}>
          {playing ? "■ Stop" : "▶ Listen to 26 years"}
        </button>
        <label className="speed">
          speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={playing}>
            <option value={0.6}>slow</option>
            <option value={1}>normal</option>
            <option value={1.8}>fast</option>
          </select>
        </label>
      </div>
      <div className="seg2" role="radiogroup" aria-label="Colour">
        <button type="button" role="radio" aria-checked={colorMode === "anomaly"} onClick={() => set({ colorMode: "anomaly" })}>
          vs normal
        </button>
        <button type="button" role="radio" aria-checked={colorMode === "count"} onClick={() => set({ colorMode: "count" })}>
          Count
        </button>
      </div>
      <p className="play-read" aria-live="polite">
        {cur ? (
          <>
            <b>{monthLabel(cur.month)}</b> · {fmt(cur.h_count)} hotspots {cur.category ? `· ${CATEGORY_LABEL[cur.category]}` : ""}
          </>
        ) : (
          "Each month is a note: higher = more fire, silence = none, a soft tick each new year."
        )}
      </p>
      <Foot />
    </>
  );
}

// ---------------- 6 · Twins ----------------
function Flower({ a, b, size = 64 }: { a: number[]; b?: number[]; size?: number }) {
  const c = size / 2;
  const max = Math.max(...a, ...(b ?? []), 1e-6);
  const path = (v: number[]) =>
    v
      .map((x, i) => {
        const ang = ((i + 0.5) / 12) * Math.PI * 2;
        const r = 4 + (c - 6) * Math.sqrt(x / max);
        return `${i ? "L" : "M"}${(c + Math.sin(ang) * r).toFixed(1)},${(c - Math.cos(ang) * r).toFixed(1)}`;
      })
      .join("") + "Z";
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="flower" aria-hidden="true">
      <circle cx={c} cy={c} r={c - 2} fill="none" stroke="rgba(160,185,230,0.18)" />
      {b && <path d={path(b)} fill="none" stroke="#9fb3d9" strokeWidth="1.2" strokeDasharray="2 2" />}
      <path d={path(a)} fill="rgba(255,179,71,0.35)" stroke="#ffb347" strokeWidth="1.3" />
      <line x1={c} y1={2} x2={c} y2={7} stroke="#9fb3d9" />
    </svg>
  );
}

function TwinsPanel() {
  const twins = useObs((s) => s.twins);
  const mode = useObs((s) => s.twinMode);
  const setMode = useObs((s) => s.setTwinMode);
  const focus = useObs((s) => s.twinFocus);
  const acquire = useObs((s) => s.acquire);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (focus !== null) ref.current?.children[focus]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus]);
  if (!twins) return <Head k="6 · Fire Twins" q="Who else on Earth burns like this?" verdict="Searching 8,535 fire regions…" />;
  const first = twins.twins[0];
  return (
    <>
      <Head
        k="6 · Fire Twins"
        q="Who else on Earth burns like this?"
        verdict={first ? `Closest twin: ${first.name}, ${fmt(first.distance_km)} km away, ${first.similarity}/100 similar. ${first.why}` : "No twins found."}
      />
      <div className="seg2" role="radiogroup" aria-label="Match">
        <button type="button" role="radio" aria-checked={mode === "season"} onClick={() => setMode("season")}>
          Same season shape
        </button>
        <button type="button" role="radio" aria-checked={mode === "calendar"} onClick={() => setMode("calendar")}>
          Same months
        </button>
      </div>
      <More label="How to read the flowers">
        <div className="flower-key">
          <Flower a={twins.query.shape12} size={46} />
          <span>
            This area's season flower: 12 petals, January at the top, petal length = share of the year's fire. Dashed = this area, filled = the twin.
          </span>
        </div>
      </More>
      <ol className="twin-list" ref={ref}>
        {twins.twins.map((t, i) => (
          <li key={t.h3_r3} className={focus === i ? "on" : ""} onMouseEnter={() => useObs.setState({ twinFocus: i })}>
            <Flower a={t.shape12} b={twins.query.shape12} />
            <div className="tw-body">
              <b>
                {i + 1}. {t.name}
              </b>
              <span className="tw-meta">
                {t.similarity}/100 · {fmt(t.distance_km)} km{t.shift_months ? ` · ${t.shift_months > 0 ? "+" : ""}${t.shift_months} months` : ""}
              </span>
              <span className="tw-why">{t.why}</span>
              <span className="tw-actions">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => useObs.setState({ compareB: { name: t.name, request: () => api.areaByCells(cellToChildren(t.h3_r3, 5)) } })}
                >
                  compare
                </button>
                <button type="button" className="link-btn" onClick={() => flyTo(t.lat - 6, t.lon, R * 2.6, 1.4)}>
                  fly there
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    void acquire({
                      name: t.name,
                      kind: "Fire Twin",
                      polys: [],
                      center: [t.lon, t.lat],
                      request: () => api.areaByCells(cellToChildren(t.h3_r3, 5)),
                    })
                  }
                >
                  open as area
                </button>
              </span>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

// ---------------- downloads made in the browser (static deployment) ----------------
const DL: [ExportKind, string, string][] = [
  ["calendar.csv", "calendar.csv", "every month: value, 90 % range, vs normal, sensors"],
  ["season.csv", "season.csv", "onset, peak, end per fire year"],
  ["hotspots.csv", "hotspots.csv", "every detection with its MODIS-equivalent weight"],
  ["bundle.zip", "bundle.zip", "all CSVs + README + metadata"],
  ["calendar.stl", "calendar.stl", "3D-print this calendar (shown on the stage)"],
];
function StaticDownloads({ id, hasCells, qs }: { id: string; hasCells: boolean; qs: { start: string; end: string } }) {
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [prog, setProg] = useState<[number, number] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (kind: ExportKind) => {
    if (busy) return;
    setBusy(kind);
    setMsg(null);
    setProg(null);
    try {
      await exportFile(id, kind, { ...qs, onProgress: (d, t) => setProg([d, t]) });
    } catch (e) {
      setMsg(e instanceof ApiFailure ? e.message : "The download could not be made. Please try again.");
    } finally {
      setBusy(null);
      setProg(null);
    }
  };
  const needsCells = (k: ExportKind) => k === "hotspots.csv" || k === "bundle.zip";
  return (
    <>
      <div className="dl-grid">
        {DL.map(([k, label, sub]) => {
          const off = needsCells(k) && !hasCells;
          return (
            <button key={k} type="button" className={`dl ${k === "calendar.stl" ? "hot" : ""} ${off ? "off" : ""}`} aria-disabled={off} aria-busy={busy === k} disabled={off || (busy !== null && busy !== k)} onClick={() => void run(k)}>
              <b>{label}</b>
              <span>
                {off
                  ? "too large: pick a province or draw a smaller area"
                  : busy === k
                    ? prog && prog[1] > 1
                      ? `fetching detections… ${Math.round((100 * prog[0]) / prog[1])} %`
                      : "preparing…"
                    : sub}
              </span>
            </button>
          );
        })}
      </div>
      {msg && (
        <p className="fine" role="alert">
          {msg}
        </p>
      )}
    </>
  );
}

// ---------------- 7 · Take it with you ----------------
function TakePanel() {
  const area = useObs((s) => s.area)!;
  const id = area.area_id;
  const hasCells = area.cells_r5.length > 0;
  const pinned = useObs((s) => s.pinned);
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 864e5));
  const [start, setStart] = useState(() => daysAgo(365));
  const [end, setEnd] = useState(() => iso(today));
  const qs = `?start=${start}&end=${end}`;
  // one-click ranges: the live week, the last month, the year, or the month being judged on the other stations
  const monthEnd = (m: string) => iso(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)));
  const presets: [string, string, string][] = [
    ["Last 7 days", daysAgo(7), iso(today)],
    ["Last 30 days", daysAgo(30), iso(today)],
    ["Last 12 months", daysAgo(365), iso(today)],
    ...(pinned ? ([[monthLabel(pinned), `${pinned}-01`, monthEnd(pinned)]] as [string, string, string][]) : []),
  ];
  const nDays = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1);
  return (
    <>
      <Head k="7 · Take it with you" q="Data, print, share" verdict="Everything on this stage, as files you can open, cite and print. The stage shows the 3D-printable calendar." />
      {STATIC_MODE ? (
        <StaticDownloads id={id} hasCells={hasCells} qs={{ start, end }} />
      ) : (
      <>
      <div className="dl-grid">
        <a className="dl" href={api.exportUrl(id, "calendar.csv")} download>
          <b>calendar.csv</b>
          <span>every month: value, 90 % range, vs normal, sensors</span>
        </a>
        <a className="dl" href={api.exportUrl(id, "season.csv")} download>
          <b>season.csv</b>
          <span>onset, peak, end per fire year</span>
        </a>
        <a className={`dl ${hasCells ? "" : "off"}`} href={hasCells ? api.exportUrl(id, "hotspots.csv", qs) : undefined} download aria-disabled={!hasCells}>
          <b>hotspots.csv</b>
          <span>{hasCells ? "every detection with its MODIS-equivalent weight" : "too large: pick a province or draw a smaller area"}</span>
        </a>
        <a className="dl" href={api.exportUrl(id, "bundle.zip", qs)} download>
          <b>bundle.zip</b>
          <span>all CSVs + README + metadata</span>
        </a>
        <a className="dl hot" href={api.exportUrl(id, "calendar.stl")} download>
          <b>calendar.stl</b>
          <span>3D-print this calendar (shown on the stage)</span>
        </a>
      </div>
      </>
      )}
      {hasCells && (
        <>
          <div className="seg2 tiny date-presets" role="radiogroup" aria-label="Date range for hotspots.csv and the bundle">
            {presets.map(([label, a, b]) => (
              <button key={label} type="button" role="radio" aria-checked={start === a && end === b} onClick={() => (setStart(a), setEnd(b))}>
                {label}
              </button>
            ))}
          </div>
          <div className="date-row">
            <label>
              from <input type="date" value={start} min="2000-11-01" max={end} onChange={(e) => e.target.value && setStart(e.target.value)} />
            </label>
            <label>
              to <input type="date" value={end} min={start} max={iso(today)} onChange={(e) => e.target.value && setEnd(e.target.value)} />
            </label>
            <span className="fine">
              {nDays > 0 ? `${fmt(nDays)} day${nDays === 1 ? "" : "s"}` : "pick an end after the start"} · for hotspots.csv and the bundle
            </span>
          </div>
        </>
      )}
      <p className="fine">Data: NASA FIRMS (MODIS C6.1, VIIRS 375 m). Unit: hotspots (MODIS-equivalent). Regimes T/M/B/V/N are explained in each file's README.</p>
    </>
  );
}

// ---------------- table (every station) ----------------
function TableModal({ cal }: { cal: Calendar }) {
  const set = useObs((s) => s.set);
  const shape = useObs((s) => s.shape);
  const g = gridOf(cal);
  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && set({ table: false })}>
      <div className="table-modal glass" role="dialog" aria-modal="true" aria-label="Calendar as a table">
        <header className="overlay-head">
          <h2>{shape?.name}: hotspots (MODIS-equivalent) per month</h2>
          <button type="button" className="icon-btn" onClick={() => set({ table: false })} aria-label="Close table">
            ✕
          </button>
        </header>
        <div className="table-scroll">
          <table className="cal-table">
            <caption className="sr-only">Monthly hotspots, baseline {cal.baseline[0]}–{cal.baseline[1]}</caption>
            <thead>
              <tr>
                <th scope="col">Year</th>
                {MONTHS_SHORT.map((m) => (
                  <th key={m} scope="col">
                    {m}
                  </th>
                ))}
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {[...g.years].reverse().map((y) => {
                const yt = cal.years.find((v) => v.year === y);
                return (
                  <tr key={y}>
                    <th scope="row">{y}</th>
                    {MONTHS_SHORT.map((_, c) => {
                      const m = g.byMonth.get(`${y}-${String(c + 1).padStart(2, "0")}`)?.m;
                      return (
                        <td key={c} className={m?.category ? `tc-${m.category}` : ""} title={m?.category ? CATEGORY_LABEL[m.category] : undefined}>
                          {m ? fmt(m.h_count) : ""}
                          {m?.provisional ? "*" : ""}
                        </td>
                      );
                    })}
                    <td className="tot">{yt ? fmt(yt.total) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fine" style={{ padding: "0 16px 12px" }}>
          * provisional. Cell tint = vs normal ({cal.baseline[0]}–{cal.baseline[1]}). {cal.summary}
        </p>
      </div>
    </div>
  );
}

export type { Station };
