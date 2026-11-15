// Closing beat: what Calember is for. One real answer to "is this month normal?" from the Calember record:
// a region's fire calendar (years × months) and one month against its own history
// (Guideline §4.7: median, percentile rank and category over the baseline years, excluding the month itself).

import { useEffect, useMemo, useRef } from "react";
import type { StoryData } from "./data";
import { fmt, ramp } from "./math";
import { film } from "./store";

const REGION = "can";
const MONTH = "2026-07"; // latest complete, non-provisional month with a clear signal
const BASE = [2003, 2025] as const;
const WINDOW = [0.948, 1.0] as const;
const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const STOPS = ["#0b0a1c", "#320a5e", "#781c6d", "#bb3754", "#ed6925", "#fbb61a", "#fcffa4"];

function heat(k: number) {
  const x = Math.min(1, Math.max(0, k)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i].match(/\w\w/g)!.map((h) => parseInt(h, 16));
  const b = STOPS[i + 1].match(/\w\w/g)!.map((h) => parseInt(h, 16));
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(",")})`;
}

export function EndCalendar({ data }: { data: StoryData }) {
  const box = useRef<HTMLElement>(null);
  const reg = data.ridge.regions.find((r) => r.id === REGION);
  const cal = useMemo(() => {
    if (!reg) return null;
    const series = reg.product ?? reg.harmonized;
    const v = new Map(data.ridge.months.map((m, i) => [m, series[i]]));
    const y0 = 2001;
    const y1 = +data.ridge.months[data.ridge.months.length - 1].slice(0, 4);
    const max = Math.max(...series);
    const rows = [];
    for (let y = y0; y <= y1; y++)
      rows.push({
        y,
        cells: MONTHS.map((_, i) => {
          const key = `${y}-${String(i + 1).padStart(2, "0")}`;
          const x = v.get(key);
          return { key, x, c: x === undefined ? "transparent" : heat(Math.log1p(x) / Math.log1p(max)) };
        }),
      });
    const mm = MONTH.slice(5);
    const S: number[] = [];
    for (let y = BASE[0]; y <= BASE[1]; y++) if (`${y}-${mm}` !== MONTH) S.push(v.get(`${y}-${mm}`) ?? 0);
    const x = v.get(MONTH) ?? 0;
    const sorted = [...S].sort((a, b) => a - b);
    const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const pct = (100 * (S.filter((s) => s < x).length + 0.5 * S.filter((s) => s === x).length)) / S.length;
    const rank = [...S, x].sort((a, b) => b - a).indexOf(x) + 1;
    const cat = x > Math.max(...S) ? "a record" : pct > 90 ? "much above normal" : pct > 75 ? "above normal" : pct < 10 ? "much below normal" : pct < 25 ? "below normal" : "normal";
    return { rows, x, med, ratio: x / med, rank, cat, n: S.length + 1, name: reg.name };
  }, [data, reg]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const a = Math.min(ramp(WINDOW[0], WINDOW[0] + 0.012, film.t), 1);
      if (box.current) {
        box.current.style.opacity = a.toFixed(3);
        box.current.style.visibility = a > 0.002 ? "visible" : "hidden";
        box.current.style.transform = `translate3d(0, ${((1 - a) * 18).toFixed(1)}px, 0)`;
        box.current.style.setProperty("--fill", ramp(WINDOW[0] + 0.004, WINDOW[0] + 0.03, film.t).toFixed(3));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!cal) return null;
  const monthName = new Date(`${MONTH}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  const yearOf = MONTH.slice(0, 4);
  const ord = (n: number) => (n === 1 ? "highest" : `${n}${n === 2 ? "nd" : n === 3 ? "rd" : "th"}-highest`);
  return (
    <figure ref={box} className="endcal" style={{ opacity: 0, visibility: "hidden" }} aria-label={`${cal.name}, ${monthName} ${yearOf}: ${fmt(cal.x)} hotspots, ${cal.ratio.toFixed(1)} times a normal ${monthName}`}>
      <figcaption className="fp-head">
        <span className="fp-kicker">Pick any place · is this normal?</span>
        <b>
          {cal.name}, {monthName} {yearOf}
        </b>
      </figcaption>
      <div className="ec-big">
        <span className="ec-ratio">{cal.ratio.toFixed(1)}×</span>
        <span className="ec-what">
          {/* "the usual", not "a normal": in small caps under the number, "A NORMAL JULY" read like a verdict */}
          the usual {monthName}
          <small>
            {fmt(cal.x)} hotspots vs a median of {fmt(cal.med)} · {ord(cal.rank)} of {cal.n} since {BASE[0]} · {cal.cat}
          </small>
        </span>
      </div>
      <div className="ec-grid" role="img" aria-label={`Fire calendar ${cal.rows[0].y}–${cal.rows[cal.rows.length - 1].y}`}>
        <span />
        {MONTHS.map((m, i) => (
          <span key={i} className="ec-mh">
            {m}
          </span>
        ))}
        {cal.rows.map((r, ri) => (
          <div key={r.y} className="ec-row" style={{ ["--d" as string]: (ri / cal.rows.length).toFixed(3) }}>
            <span className="ec-y">{r.y % 5 === 1 || r.y === cal.rows[cal.rows.length - 1].y ? r.y : ""}</span>
            {r.cells.map((c) => (
              <span key={c.key} className={`ec-c ${c.key === MONTH ? "hit" : ""}`} style={{ background: c.c }} title={c.x === undefined ? "" : `${c.key}: ${fmt(c.x)}`} />
            ))}
          </div>
        ))}
      </div>
      <p className="dm-note">
        Calember fire calendar: MODIS-equivalent hotspots per month, {cal.rows[0].y}–{cal.rows[cal.rows.length - 1].y}. Baseline: every {monthName} {BASE[0]}–{BASE[1]}.
      </p>
    </figure>
  );
}
