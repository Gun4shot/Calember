// Compare two places: the open area against a second one (a twin, or any place picked in the search palette).
// Two questions only, so it stays readable: when in the year does each burn (season shape), and how much per
// 1,000 km² in every year since 2001. Numbers come from both areas' /calendar responses.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../app/api";
import { CATEGORY_LABEL, MONTHS_LONG, MONTHS_SHORT, fmt, monthLabel } from "../../app/format";
import type { Area, Calendar } from "../../app/types";
import { latestJudged } from "../stage/model";
import { useObs } from "../store";
import { CAT_GLYPH, fmtS } from "./glyphs";

const COL = { a: "#ffb347", b: "#7fd8ff" };

interface Side {
  name: string;
  area: Area;
  cal: Calendar;
}

function summarize(s: Side) {
  const yrs = s.cal.years.filter((y) => y.complete && y.year >= 2001 && y.year <= 2025);
  const mean = yrs.length ? yrs.reduce((t, y) => t + y.total, 0) / yrs.length : 0;
  const clim = MONTHS_SHORT.map((_, i) => s.cal.climatology.find((c) => c.month_num === i + 1)?.mean ?? 0);
  const cs = clim.reduce((a, b) => a + b, 0) || 1;
  const shape = clim.map((v) => v / cs);
  const peak = shape.indexOf(Math.max(...shape));
  const busiest = yrs.reduce((a, b) => (b.total > a.total ? b : a), yrs[0] ?? { year: 0, total: 0 });
  const dens = (v: number) => (s.area.area_km2 > 0 ? (v / s.area.area_km2) * 1000 : 0);
  return { mean, density: dens(mean), shape, peak, busiest, years: yrs.map((y) => ({ year: y.year, v: dens(y.total) })), last: latestJudged(s.cal) };
}

export function Compare() {
  const b = useObs((s) => s.compareB);
  const area = useObs((s) => s.area);
  const cal = useObs((s) => s.calendar);
  const shape = useObs((s) => s.shape);
  const set = useObs((s) => s.set);
  const [side, setSide] = useState<Side | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!b) return;
    let alive = true;
    setSide(null);
    setErr(null);
    b.request()
      .then(async (ar) => ({ name: b.name, area: ar, cal: await api.calendar(ar.area_id) }))
      .then((s) => alive && setSide(s), (e) => alive && setErr(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [b]);

  useEffect(() => {
    if (!b) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopImmediatePropagation(), set({ compareB: null }));
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [b, set]);

  const A = useMemo(() => (area && cal && shape ? summarize({ name: shape.name, area, cal }) : null), [area, cal, shape]);
  const B = useMemo(() => (side ? summarize(side) : null), [side]);
  if (!b || !area || !shape) return null;
  const nameA = shape.name, nameB = b.name;
  const short = (n: string) => n.split(",")[0];

  let insight = "";
  if (A && B) {
    const r = B.density / Math.max(1e-9, A.density);
    const dens = r >= 1.15 ? `${short(nameB)} burns ${r.toFixed(1)}× as much per km²` : r <= 1 / 1.15 ? `${short(nameA)} burns ${(1 / r).toFixed(1)}× as much per km²` : "Both burn about as much per km²";
    const gap = Math.min((A.peak - B.peak + 12) % 12, (B.peak - A.peak + 12) % 12);
    const when = gap === 0 ? `both peak in ${MONTHS_LONG[A.peak]}` : `their peaks are ${gap} month${gap > 1 ? "s" : ""} apart (${MONTHS_SHORT[A.peak]} vs ${MONTHS_SHORT[B.peak]})`;
    insight = `${dens}; ${when}.`;
  }

  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && set({ compareB: null })}>
      <div className="compare-modal glass" role="dialog" aria-modal="true" aria-label={`Compare ${nameA} and ${nameB}`}>
        <header className="overlay-head">
          <h2>
            <span style={{ color: COL.a }}>{short(nameA)}</span> <span className="muted">vs</span> <span style={{ color: COL.b }}>{short(nameB)}</span>
          </h2>
          <button type="button" className="icon-btn" onClick={() => set({ compareB: null })} aria-label="Close the comparison" autoFocus>
            ✕
          </button>
        </header>
        {err && <p className="warn small cmp-pad">Could not load {nameB}: {err}</p>}
        {!B && !err && <p className="muted cmp-pad">Reading {nameB}…</p>}
        {A && B && (
          <div className="cmp-body">
            <p className="cmp-insight">{insight}</p>
            <div className="cmp-cards">
              {([["a", nameA, A, area.area_km2], ["b", nameB, B, side!.area.area_km2]] as const).map(([k, n, S, km2]) => (
                <div key={k} className={`cmp-card cmp-${k}`}>
                  <b>{n}</b>
                  <span className="muted small">{fmt(km2)} km²</span>
                  <dl>
                    <dt>hotspots a year</dt>
                    <dd>{fmt(S.mean)}</dd>
                    <dt>per 1,000 km²</dt>
                    <dd>{fmtS(S.density)}</dd>
                    <dt>peak month</dt>
                    <dd>{MONTHS_LONG[S.peak]}</dd>
                    <dt>busiest year</dt>
                    <dd>{S.busiest.year || "–"}</dd>
                    {S.last?.category && (
                      <>
                        <dt>{monthLabel(S.last.month)}</dt>
                        <dd className={`cat-${S.last.category}`}>
                          {CAT_GLYPH[S.last.category]} {CATEGORY_LABEL[S.last.category]}
                        </dd>
                      </>
                    )}
                  </dl>
                </div>
              ))}
            </div>
            <div className="cmp-charts">
              <figure>
                <figcaption>When it burns · share of a typical year's fire, by month</figcaption>
                <SeasonChart a={A.shape} b={B.shape} />
              </figure>
              <figure>
                <figcaption>How much · hotspots per 1,000 km², every year</figcaption>
                <YearChart a={A.years} b={B.years} />
              </figure>
            </div>
            <p className="fine cmp-pad">Hotspots (MODIS-equivalent). Per-area density includes land that never burns. Typical year: monthly means, 2003–2025.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const W = 520, H = 170, L = 34, R = 10, T = 12, Bm = 22;

function SeasonChart({ a, b }: { a: number[]; b: number[] }) {
  const max = Math.max(...a, ...b, 0.01);
  const x = (i: number) => L + (i / 11) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - Bm);
  const path = (v: number[]) => v.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join("");
  const area = (v: number[]) => `${path(v)}L${x(11)},${y(0)}L${x(0)},${y(0)}Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cmp-svg" role="img" aria-label="Season shape of both places">
      {[0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} className="cmp-grid" />
          <text x={L - 6} y={y(max * f) + 3} textAnchor="end" className="cmp-ax">{Math.round(max * f * 100)}%</text>
        </g>
      ))}
      <path d={area(a)} fill={COL.a} fillOpacity={0.14} />
      <path d={area(b)} fill={COL.b} fillOpacity={0.12} />
      <path d={path(a)} fill="none" stroke={COL.a} strokeWidth={2.2} />
      <path d={path(b)} fill="none" stroke={COL.b} strokeWidth={2.2} />
      {MONTHS_SHORT.map((m, i) => (
        <text key={m} x={x(i)} y={H - 6} textAnchor="middle" className="cmp-ax">{m[0]}</text>
      ))}
    </svg>
  );
}

function YearChart({ a, b }: { a: { year: number; v: number }[]; b: { year: number; v: number }[] }) {
  const ys = [...a, ...b].map((p) => p.year);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const max = Math.max(...a.map((p) => p.v), ...b.map((p) => p.v), 1e-6);
  const x = (yr: number) => L + ((yr - y0) / Math.max(1, y1 - y0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - Bm);
  const path = (v: { year: number; v: number }[]) => v.map((p, i) => `${i ? "L" : "M"}${x(p.year).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cmp-svg" role="img" aria-label="Hotspots per 1,000 km² in every year, both places">
      {[0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} className="cmp-grid" />
          <text x={L - 6} y={y(max * f) + 3} textAnchor="end" className="cmp-ax">{fmtS(max * f)}</text>
        </g>
      ))}
      <path d={path(a)} fill="none" stroke={COL.a} strokeWidth={2.2} />
      <path d={path(b)} fill="none" stroke={COL.b} strokeWidth={2.2} />
      {a.map((p) => <circle key={`a${p.year}`} cx={x(p.year)} cy={y(p.v)} r={2.2} fill={COL.a} />)}
      {b.map((p) => <circle key={`b${p.year}`} cx={x(p.year)} cy={y(p.v)} r={2.2} fill={COL.b} />)}
      {[y0, 2010, 2020, y1].filter((v, i, arr) => arr.indexOf(v) === i && v >= y0 && v <= y1).map((yr) => (
        <text key={yr} x={x(yr)} y={H - 6} textAnchor="middle" className="cmp-ax">{yr}</text>
      ))}
    </svg>
  );
}
