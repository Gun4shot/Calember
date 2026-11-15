import { scaleLinear, scaleLog } from "d3";
import { useMemo } from "react";
import { fmt } from "../format";
import type { Calendar } from "../types";

// Annual totals: Calember (harmonized, 90 % band) vs raw sensors summed vs observed MODIS. Complete years only.
export function SeriesChart({ cal }: { cal: Calendar }) {
  const rows = useMemo(() => {
    const by = new Map<number, { h: number; raw: number; modis: number; n: number }>();
    for (const m of cal.months) {
      const y = Number(m.month.slice(0, 4));
      const r = by.get(y) ?? { h: 0, raw: 0, modis: 0, n: 0 };
      r.h += m.h_count;
      r.raw += m.raw.modis + m.raw.snpp + m.raw.noaa20 + m.raw.noaa21;
      r.modis += m.raw.modis;
      r.n += 1;
      by.set(y, r);
    }
    return cal.years
      .filter((y) => y.complete)
      .map((y) => ({ year: y.year, lo: y.lo90, hi: y.hi90, ...by.get(y.year)! }));
  }, [cal]);
  if (rows.length < 3) return null;
  const W = 520, H = 190, L = 46, R = 20, T = 12, B = 24;
  const x = scaleLinear().domain([rows[0].year, rows[rows.length - 1].year]).range([L, W - R]);
  // log scale: raw VIIRS-era sums are several times higher; a linear axis would flatten Calember and MODIS
  const yMax = Math.max(...rows.map((r) => Math.max(r.hi, r.raw)));
  const yMin = Math.max(1, Math.min(...rows.map((r) => Math.min(r.lo || r.h, r.modis || r.h, r.h)).filter((v) => v > 0)) * 0.7);
  const y = scaleLog().domain([yMin, yMax * 1.3]).range([H - B, T]).clamp(true);
  const lin = (v: number) => Math.max(v, yMin); // keep zeros on the log axis floor
  const line =(k: "h" | "raw" | "modis") => rows.map((r, i) => `${i ? "L" : "M"}${x(r.year).toFixed(1)},${y(lin(r[k])).toFixed(1)}`).join("");
  const band = rows.map((r, i) => `${i ? "L" : "M"}${x(r.year).toFixed(1)},${y(lin(r.hi)).toFixed(1)}`).join("") +
    [...rows].reverse().map((r) => `L${x(r.year).toFixed(1)},${y(lin(r.lo)).toFixed(1)}`).join("") + "Z";
  const ticks = y.ticks().filter((t) => [1, 2, 5].includes(Number(String(t)[0])) && String(Math.round(t)).replace(/^[125]/, "").replace(/0/g, "") === "");
  const viirsStart = x(2012);
  const last = rows[rows.length - 1];
  const jump = rows.find((r) => r.year === 2012);
  const before = rows.find((r) => r.year === 2011);
  return (
    <figure className="series">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="series-title series-desc">
        <title id="series-title">Yearly totals: Calember versus raw sensor counts</title>
        <desc id="series-desc">
          {jump && before
            ? `Raw counts jump from ${fmt(before.raw)} in 2011 to ${fmt(jump.raw)} in 2012 when VIIRS starts; Calember goes from ${fmt(before.h)} to ${fmt(jump.h)}.`
            : "Yearly totals."}{" "}
          In {last.year}, Calember counts {fmt(last.h)} and observed MODIS {fmt(last.modis)}.
        </desc>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#262b33" />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" className="cal-axis">
              {t >= 1000 ? `${t / 1000}k` : Math.round(t)}
            </text>
          </g>
        ))}
        {[2005, 2010, 2015, 2020, 2025].filter((v) => v >= rows[0].year && v <= last.year).map((v) => (
          <text key={v} x={x(v)} y={H - 6} textAnchor="middle" className="cal-axis">
            {v}
          </text>
        ))}
        {viirsStart > L && (
          <g>
            <line x1={viirsStart} x2={viirsStart} y1={T} y2={H - B} stroke="#3c4350" strokeDasharray="3 3" />
            <text x={viirsStart + 4} y={T + 9} className="cal-axis">
              VIIRS starts
            </text>
          </g>
        )}
        <path d={band} fill="rgba(255, 196, 92, 0.18)" />
        <path d={line("raw")} fill="none" stroke="#8bd3ff" strokeWidth={1.5} strokeDasharray="4 3" />
        <path d={line("modis")} fill="none" stroke="#9aa3b2" strokeWidth={1.2} />
        <path d={line("h")} fill="none" stroke="#ffc45c" strokeWidth={2.2} />
        {/* Ghost MODIS (F18): the observed MODIS line drifts and ends with the satellites; Calember carries the record on */}
        {last.year >= 2022 && (
          <text x={x(last.year) - 2} y={Math.min(H - B - 4, y(lin(last.modis)) + 13)} textAnchor="end" className="cal-axis ghost-label">
            MODIS: drifting, ends ~2027
          </text>
        )}
      </svg>
      <figcaption className="series-legend">
        <span className="leg-item">
          <span className="leg-line" style={{ background: "#ffc45c" }} /> Calember (harmonized, 90 % band)
        </span>
        <span className="leg-item">
          <span className="leg-line leg-dash" /> Raw: all sensors summed
        </span>
        <span className="leg-item">
          <span className="leg-line" style={{ background: "#9aa3b2" }} /> Observed MODIS
        </span>
      </figcaption>
    </figure>
  );
}
