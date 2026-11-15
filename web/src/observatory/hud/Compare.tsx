// Compare two places: the open area against a second one (a twin, or any place picked in the search palette).
// Three questions, each with its own motion: who burns more per km² (a tug-of-war bar that snaps to the ratio),
// when in the year each burns (a season clock whose petals spin open), and how much in every year since 2001
// (a race: both lines draw themselves year by year, the gap between them shaded by whoever leads).
// Numbers come from both areas' /calendar responses.
import { curveCatmullRomClosed, lineRadial } from "d3";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../app/api";
import { CATEGORY_LABEL, MONTHS_LONG, MONTHS_SHORT, fmt, monthLabel } from "../../app/format";
import type { Area, Calendar } from "../../app/types";
import { sfx } from "../sfx";
import { latestJudged } from "../stage/model";
import { useObs } from "../store";
import { CAT_GLYPH, fmtS } from "./glyphs";
import { Words } from "./kinetic";

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

// ---------- motion helpers ----------
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
/** overshoots a little, then settles (the "snap") */
const easeBack = (k: number) => 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 0 → 1 over `ms`, starting `delay` ms after `key` changes. With reduced motion it is 1 at once. */
function useProgress(key: string, ms: number, delay = 0) {
  const [p, setP] = useState(0);
  useEffect(() => {
    if (reduced()) {
      setP(1);
      return;
    }
    setP(0);
    const t0 = performance.now() + delay;
    let raf = 0;
    const tick = () => {
      const k = clamp01((performance.now() - t0) / ms);
      setP(k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key, ms, delay]);
  return p;
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
  const ready = !!(A && B);
  useEffect(() => {
    if (ready) sfx.compare();
  }, [ready, side]);
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
        {!B && !err && <p className="muted cmp-pad loading-line">Reading {nameB}…</p>}
        {A && B && (
          <div className="cmp-body">
            <Words text={insight} as="p" className="cmp-insight" />
            <Duel a={A.density} b={B.density} nameA={short(nameA)} nameB={short(nameB)} />
            <div className="cmp-cards">
              {([["a", nameA, A, area.area_km2], ["b", nameB, B, side!.area.area_km2]] as const).map(([k, n, S, km2], i) => (
                <div key={k} className={`cmp-card cmp-${k}`}>
                  <b>{n}</b>
                  <span className="muted small">{fmt(km2)} km²</span>
                  <dl>
                    <dt>hotspots a year</dt>
                    <dd>
                      <CountUp value={S.mean} format={fmt} delay={300 + i * 160} />
                    </dd>
                    <dt>per 1,000 km²</dt>
                    <dd>
                      <CountUp value={S.density} format={fmtS} delay={420 + i * 160} />
                    </dd>
                    <dt>peak month</dt>
                    <dd>{MONTHS_LONG[S.peak]}</dd>
                    <dt>busiest year</dt>
                    <dd>{S.busiest.year ? <CountUp value={S.busiest.year} from={2000} format={(v) => String(Math.round(v))} delay={540 + i * 160} /> : "–"}</dd>
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
                <SeasonClock a={A.shape} b={B.shape} nameA={short(nameA)} nameB={short(nameB)} />
              </figure>
              <figure>
                <figcaption>How much · hotspots per 1,000 km², every year</figcaption>
                <YearRace a={A.years} b={B.years} nameA={short(nameA)} nameB={short(nameB)} />
              </figure>
            </div>
            <p className="fine cmp-pad">Hotspots (MODIS-equivalent). Per-area density includes land that never burns. Typical year: monthly means, 2003–2025.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** A number that counts up (ease-out) once the comparison lands. */
function CountUp({ value, format, delay = 0, from = 0 }: { value: number; format: (v: number) => string; delay?: number; from?: number }) {
  const p = useProgress(`${value}`, 1100, delay);
  return <>{format(from + (value - from) * easeOut(p))}</>;
}

/** Tug of war: each side's share of the combined density. Starts level, then snaps (with a small overshoot) to the real split. */
function Duel({ a, b, nameA, nameB }: { a: number; b: number; nameA: string; nameB: string }) {
  const p = useProgress(`${a}|${b}`, 1500, 450);
  const share = a + b > 0 ? a / (a + b) : 0.5;
  const pct = Math.min(97, Math.max(3, 100 * (0.5 + (share - 0.5) * easeBack(p))));
  return (
    <div className="duel" role="img" aria-label={`Hotspots per 1,000 km² a year: ${nameA} ${fmtS(a)}, ${nameB} ${fmtS(b)}`}>
      <div className="duel-bar">
        <div className="duel-a" style={{ width: `${pct}%` }} />
        <div className="duel-b" style={{ width: `${100 - pct}%` }} />
        <div className={`duel-spark ${p >= 1 ? "settled" : ""}`} style={{ left: `${pct}%` }} />
      </div>
      <div className="duel-legend">
        <span style={{ color: COL.a }}>
          {nameA} <b>{fmtS(a)}</b>
        </span>
        <span className="muted">hotspots per 1,000 km² a year</span>
        <span style={{ color: COL.b }}>
          <b>{fmtS(b)}</b> {nameB}
        </span>
      </div>
    </div>
  );
}

const SC_R = 92, SC_R0 = 12;

/** Season clock: January at the top, clockwise. Each place's typical year is a petal that spins open from the centre. */
function SeasonClock({ a, b, nameA, nameB }: { a: number[]; b: number[]; nameA: string; nameB: string }) {
  const p = useProgress(`${a.join()}|${b.join()}`, 1700, 500);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...a, ...b, 0.01);
  const grow = Math.max(0, easeBack(p));
  const spin = (1 - easeOut(p)) * -120;
  const r = (v: number) => SC_R0 + (SC_R - SC_R0) * (v / max);
  const petal = (v: number[]) => lineRadial<number>().angle((_, i) => (i / 12) * Math.PI * 2).radius((d) => r(d)).curve(curveCatmullRomClosed.alpha(0.5))(v) ?? "";
  const xy = (i: number, rad: number) => {
    const t = (i / 12) * Math.PI * 2;
    return [Math.sin(t) * rad, -Math.cos(t) * rad] as const;
  };
  const pa = a.indexOf(Math.max(...a)), pb = b.indexOf(Math.max(...b));
  const done = p >= 1;
  return (
    <div className="sclock">
      <svg viewBox="-130 -122 260 244" className="cmp-svg" role="img" aria-label={`Season clock. ${nameA} peaks in ${MONTHS_LONG[pa]}, ${nameB} in ${MONTHS_LONG[pb]}.`} onMouseLeave={() => setHover(null)}>
        <defs>
          <radialGradient id="sc-fa">
            <stop offset="0" stopColor={COL.a} stopOpacity="0.05" />
            <stop offset="1" stopColor={COL.a} stopOpacity="0.32" />
          </radialGradient>
          <radialGradient id="sc-fb">
            <stop offset="0" stopColor={COL.b} stopOpacity="0.04" />
            <stop offset="1" stopColor={COL.b} stopOpacity="0.28" />
          </radialGradient>
          <linearGradient id="sc-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#e8f1ff" stopOpacity="0" />
            <stop offset="1" stopColor="#e8f1ff" stopOpacity="0.16" />
          </linearGradient>
          <filter id="sc-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* rings at half and full scale, with month spokes */}
        {[0.5, 1].map((f) => (
          <circle key={f} r={r(max * f)} className="sc-ring" />
        ))}
        <text x={4} y={-r(max) + 11} className="cmp-ax sc-max">{Math.round(max * 100)}%</text>
        {MONTHS_SHORT.map((m, i) => {
          const [x, y] = xy(i, SC_R);
          const [lx, ly] = xy(i, SC_R + 15);
          return (
            <g key={m}>
              <line x1={0} y1={0} x2={x} y2={y} className={`sc-spoke ${hover === i ? "on" : ""}`} />
              <text x={lx} y={ly + 3.5} textAnchor="middle" className={`cmp-ax ${hover === i || (done && (i === pa || i === pb)) ? "sc-lbl-on" : ""}`}>
                {m}
              </text>
            </g>
          );
        })}
        {/* a slow radar hand keeps the clock alive once the petals have landed */}
        <g className={`sc-hand ${done ? "on" : ""}`}>
          <path d={`M0 0 L0 ${-SC_R} A${SC_R} ${SC_R} 0 0 1 ${Math.sin(0.55) * SC_R} ${-Math.cos(0.55) * SC_R} Z`} fill="url(#sc-sweep)" transform="rotate(-31.5)" />
          <line x1={0} y1={0} x2={0} y2={-SC_R} className="sc-hand-line" />
        </g>
        <g transform={`rotate(${spin.toFixed(2)}) scale(${grow.toFixed(4)})`}>
          <path d={petal(a)} fill="url(#sc-fa)" stroke={COL.a} strokeWidth={2} filter="url(#sc-glow)" />
          <path d={petal(b)} fill="url(#sc-fb)" stroke={COL.b} strokeWidth={2} filter="url(#sc-glow)" />
        </g>
        {/* peaks: a spoke and a pulsing beacon for each place */}
        {done &&
          ([
            [pa, a[pa], COL.a],
            [pb, b[pb], COL.b],
          ] as const).map(([i, v, c], k) => {
            const [x, y] = xy(i, r(v));
            return (
              <g key={k} className="sc-peak" style={{ animationDelay: `${k * 160}ms` }}>
                <line x1={0} y1={0} x2={x} y2={y} stroke={c} strokeWidth={1.2} strokeDasharray="2 2" opacity={0.8} />
                <circle cx={x} cy={y} r={4} fill={c} />
                <circle cx={x} cy={y} r={4} fill="none" stroke={c} className="sc-pulse" style={{ animationDelay: `${k * 600}ms` }} />
              </g>
            );
          })}
        {hover !== null &&
          ([
            [a[hover], COL.a],
            [b[hover], COL.b],
          ] as const).map(([v, c], k) => {
            const [x, y] = xy(hover, r(v));
            return <circle key={k} cx={x} cy={y} r={3.6} fill={c} stroke="#0b0f18" strokeWidth={1.2} />;
          })}
        {/* hover targets: one wedge per month */}
        {MONTHS_SHORT.map((m, i) => {
          const t0 = ((i - 0.5) / 12) * Math.PI * 2, t1 = ((i + 0.5) / 12) * Math.PI * 2, R = SC_R + 20;
          return (
            <path
              key={m}
              d={`M0 0 L${Math.sin(t0) * R} ${-Math.cos(t0) * R} A${R} ${R} 0 0 1 ${Math.sin(t1) * R} ${-Math.cos(t1) * R} Z`}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          );
        })}
      </svg>
      <p className="cmp-read" aria-live="polite">
        {hover !== null ? (
          <>
            <b>{MONTHS_LONG[hover]}</b> · <span style={{ color: COL.a }}>{nameA} {Math.round(a[hover] * 100)}%</span> · <span style={{ color: COL.b }}>{nameB} {Math.round(b[hover] * 100)}%</span>
          </>
        ) : (
          <>
            Peaks: <span style={{ color: COL.a }}>{MONTHS_SHORT[pa]}</span> · <span style={{ color: COL.b }}>{MONTHS_SHORT[pb]}</span>. Point at a month.
          </>
        )}
      </p>
    </div>
  );
}

const W = 520, H = 210, L = 38, R = 14, T = 16, Bm = 22;
type Pt = { year: number; v: number };

/** The race: both records draw themselves year by year, glowing heads in front, the gap shaded by whoever leads. */
function YearRace({ a, b, nameA, nameB }: { a: Pt[]; b: Pt[]; nameA: string; nameB: string }) {
  const p = useProgress(`${a.length}|${b.length}|${a[0]?.v}|${b[0]?.v}`, 2600, 700);
  const [hover, setHover] = useState<number | null>(null);
  const ys = [...a, ...b].map((q) => q.year);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const max = Math.max(...a.map((q) => q.v), ...b.map((q) => q.v), 1e-6);
  const x = (yr: number) => L + ((yr - y0) / Math.max(1, y1 - y0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - Bm);
  const path = (v: Pt[]) => v.map((q, i) => `${i ? "L" : "M"}${x(q.year).toFixed(1)},${y(q.v).toFixed(1)}`).join("");
  const k = easeInOut(p);
  const headYr = y0 + k * (y1 - y0);
  const headX = x(headYr);
  const at = (v: Pt[], yr: number) => {
    const i = v.findIndex((q) => q.year >= yr);
    if (i <= 0) return v[Math.max(0, i)]?.v ?? 0;
    const q0 = v[i - 1], q1 = v[i];
    return q0.v + ((yr - q0.year) / Math.max(1e-9, q1.year - q0.year)) * (q1.v - q0.v);
  };

  // the lead, segment by segment: amber where A is ahead, ice where B is (split where the lines cross)
  const lead = useMemo(() => {
    const bm = new Map(b.map((q) => [q.year, q.v]));
    const both = a.filter((q) => bm.has(q.year)).map((q) => ({ year: q.year, a: q.v, b: bm.get(q.year)! }));
    const out: { d: string; ahead: "a" | "b" }[] = [];
    const P = (yr: number, v: number) => `${x(yr).toFixed(1)},${y(v).toFixed(1)}`;
    for (let i = 0; i + 1 < both.length; i++) {
      const s = both[i], e = both[i + 1];
      if (e.year - s.year !== 1) continue;
      const d0 = s.a - s.b, d1 = e.a - e.b;
      if (d0 * d1 >= 0) {
        out.push({ d: `M${P(s.year, s.a)}L${P(e.year, e.a)}L${P(e.year, e.b)}L${P(s.year, s.b)}Z`, ahead: d0 + d1 >= 0 ? "a" : "b" });
      } else {
        const t = d0 / (d0 - d1), xi = s.year + t, vi = s.a + t * (e.a - s.a);
        out.push({ d: `M${P(s.year, s.a)}L${P(xi, vi)}L${P(s.year, s.b)}Z`, ahead: d0 > 0 ? "a" : "b" });
        out.push({ d: `M${P(xi, vi)}L${P(e.year, e.a)}L${P(e.year, e.b)}Z`, ahead: d1 > 0 ? "a" : "b" });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, max]);

  const done = p >= 1;
  const hv = hover !== null ? { year: hover, a: a.find((q) => q.year === hover)?.v, b: b.find((q) => q.year === hover)?.v } : null;
  const ha = at(a, headYr), hb = at(b, headYr);
  const id = useMemo(() => `yr${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div className="yrace">
      <svg viewBox={`0 0 ${W} ${H}`} className="cmp-svg" role="img" aria-label={`Hotspots per 1,000 km² in every year, ${nameA} and ${nameB}`} onMouseLeave={() => setHover(null)}>
        <defs>
          <clipPath id={`${id}-clip`}>
            <rect x={0} y={0} width={headX} height={H} />
          </clipPath>
          <filter id={`${id}-glow`} x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id={`${id}-head`}>
            <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
            <stop offset="0.35" stopColor="#fff" stopOpacity="0.35" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} className="cmp-grid" />
            <text x={L - 6} y={y(max * f) + 3} textAnchor="end" className="cmp-ax">{fmtS(max * f)}</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="cmp-grid" />
        <g clipPath={`url(#${id}-clip)`}>
          {lead.map((s, i) => (
            <path key={i} d={s.d} className={`yr-lead ${s.ahead}`} />
          ))}
          <path d={path(a)} fill="none" stroke={COL.a} strokeWidth={2.2} strokeLinejoin="round" filter={`url(#${id}-glow)`} />
          <path d={path(b)} fill="none" stroke={COL.b} strokeWidth={2.2} strokeLinejoin="round" filter={`url(#${id}-glow)`} />
        </g>
        {/* each year's dot pops as the head passes it */}
        {a.map((q) => (
          <circle key={`a${q.year}`} cx={x(q.year)} cy={y(q.v)} r={hover === q.year ? 4.2 : 2.3} fill={COL.a} className={`yr-dot ${x(q.year) <= headX + 0.5 ? "on" : ""}`} />
        ))}
        {b.map((q) => (
          <circle key={`b${q.year}`} cx={x(q.year)} cy={y(q.v)} r={hover === q.year ? 4.2 : 2.3} fill={COL.b} className={`yr-dot ${x(q.year) <= headX + 0.5 ? "on" : ""}`} />
        ))}
        {/* racing heads and the year counter, while drawing */}
        {!done && p > 0 && (
          <g>
            <line x1={headX} x2={headX} y1={T - 4} y2={H - Bm} className="yr-scan" />
            <circle cx={headX} cy={y(ha)} r={11} fill={`url(#${id}-head)`} />
            <circle cx={headX} cy={y(hb)} r={11} fill={`url(#${id}-head)`} />
            <circle cx={headX} cy={y(ha)} r={3.4} fill={COL.a} />
            <circle cx={headX} cy={y(hb)} r={3.4} fill={COL.b} />
            <text x={Math.min(W - R - 2, headX + 6)} y={T + 2} textAnchor={headX > W - 60 ? "end" : "start"} className="yr-count">
              {Math.floor(headYr)}
            </text>
          </g>
        )}
        {hv && (
          <line x1={x(hv.year)} x2={x(hv.year)} y1={T - 4} y2={H - Bm} className="yr-cross" />
        )}
        {[y0, 2010, 2020, y1]
          .filter((v, i, arr) => arr.indexOf(v) === i && v >= y0 && v <= y1)
          .map((yr) => (
            <text key={yr} x={x(yr)} y={H - 6} textAnchor="middle" className="cmp-ax">
              {yr}
            </text>
          ))}
        {/* hover targets: one column per year */}
        {Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i).map((yr) => (
          <rect key={yr} x={x(yr) - (W - L - R) / Math.max(1, y1 - y0) / 2} y={0} width={(W - L - R) / Math.max(1, y1 - y0)} height={H} fill="transparent" onMouseEnter={() => setHover(yr)} />
        ))}
      </svg>
      <p className="cmp-read" aria-live="polite">
        {hv ? (
          <>
            <b>{hv.year}</b> · <span style={{ color: COL.a }}>{nameA} {fmtS(hv.a)}</span> · <span style={{ color: COL.b }}>{nameB} {fmtS(hv.b)}</span> per 1,000 km²
          </>
        ) : (
          <>
            Shading shows who leads: <span style={{ color: COL.a }}>{nameA}</span> or <span style={{ color: COL.b }}>{nameB}</span>. Point at a year.
          </>
        )}
      </p>
    </div>
  );
}
