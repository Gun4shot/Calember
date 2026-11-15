import { scaleSequentialLog } from "d3";
import { useMemo, useRef, useState } from "react";
import { CATEGORY_COLOR, CATEGORY_LABEL, CATEGORY_ORDER, MONTHS_SHORT, REGIME_LABEL, fmt, monthLabel } from "../format";
import type { Calendar as Cal, CalendarMonth } from "../types";
import { uiZoom } from "../../uiZoom";

const CW = 30, CH = 17, GAP = 2, LEFT = 50, TOP = 20, BARW = 96;

const rampColors = ["#2a1530", "#5a1f4c", "#97304f", "#cf4d38", "#ef7f2b", "#f9b543", "#fde68a"];
const ramp = (t: number) => {
  const x = Math.max(0, Math.min(1, t)) * (rampColors.length - 1);
  const i = Math.floor(x);
  return i >= rampColors.length - 1 ? rampColors[rampColors.length - 1] : mix(rampColors[i], rampColors[i + 1], x - i);
};
function mix(a: string, b: string, t: number) {
  const p = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
}

export const rawTotal = (m: CalendarMonth) => m.raw.modis + m.raw.snpp + m.raw.noaa20 + m.raw.noaa21;

export function Calendar({ cal, colorMode, valueMode }: { cal: Cal; colorMode: "count" | "anomaly"; valueMode: "harmonized" | "raw" }) {
  const byMonth = useMemo(() => new Map(cal.months.map((m) => [m.month, m])), [cal]);
  const years = useMemo(() => {
    const ys = new Set(cal.months.map((m) => Number(m.month.slice(0, 4))));
    return [...ys].sort((a, b) => a - b);
  }, [cal]);
  const val = (m: CalendarMonth) => (valueMode === "raw" ? rawTotal(m) : m.h_count);
  const vmax = useMemo(() => Math.max(1, ...cal.months.map(val)), [cal, valueMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const color = useMemo(() => scaleSequentialLog(ramp).domain([1, vmax]).clamp(true), [vmax]);
  const effMode = valueMode === "raw" ? "count" : colorMode;
  const yearTot = useMemo(() => {
    const t = new Map<number, number>();
    for (const m of cal.months) t.set(Number(m.month.slice(0, 4)), (t.get(Number(m.month.slice(0, 4))) ?? 0) + val(m));
    return t;
  }, [cal, valueMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const yMax = Math.max(1, ...yearTot.values());
  const climMax = Math.max(1, ...cal.climatology.map((c) => c.median ?? 0));

  const [focus, setFocus] = useState<{ y: number; k: number } | null>(null);
  const [hover, setHover] = useState<{ y: number; k: number; x: number; yy: number } | null>(null);
  const gridRef = useRef<SVGSVGElement>(null);
  const cur = hover ?? (focus ? { ...focus, x: 0, yy: 0 } : null);
  const curMonth = cur ? byMonth.get(`${years[cur.y]}-${String(cur.k + 1).padStart(2, "0")}`) : undefined;

  const W = LEFT + 12 * (CW + GAP) + BARW + 8;
  const H = TOP + years.length * (CH + GAP) + 34;

  const fill = (m: CalendarMonth | undefined) => {
    if (!m) return "transparent";
    const v = val(m);
    if (effMode === "anomaly") return m.category ? CATEGORY_COLOR[m.category] : "#22262c";
    return v <= 0 ? "#15181d" : String(color(Math.max(v, 1)));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const f = focus ?? { y: years.length - 1, k: 0 };
    const mv: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.key in mv) {
      e.preventDefault();
      const [dy, dk] = mv[e.key];
      setFocus({ y: Math.max(0, Math.min(years.length - 1, f.y + dy)), k: Math.max(0, Math.min(11, f.k + dk)) });
    } else if (e.key === "Home") setFocus({ y: f.y, k: 0 });
    else if (e.key === "End") setFocus({ y: f.y, k: 11 });
  };

  const describe = (m: CalendarMonth) => {
    const v = val(m);
    const parts = [`${monthLabel(m.month)}: ${fmt(v)} ${valueMode === "raw" ? "raw detections (all sensors summed)" : "hotspots, MODIS-equivalent"}`];
    if (valueMode === "harmonized") parts.push(`90 % range ${fmt(m.lo90)} to ${fmt(m.hi90)}`);
    if (valueMode === "harmonized" && m.category) parts.push(`${CATEGORY_LABEL[m.category]} (percentile ${fmt(m.pct_rank)})`);
    if (m.provisional) parts.push("provisional");
    return parts.join(", ") + ".";
  };

  return (
    <div className="cal">
      <svg
        ref={gridRef}
        className="cal-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="grid"
        aria-label={`Burning calendar, ${years[0]} to ${years[years.length - 1]}. Use the arrow keys to move between months.`}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => !focus && setFocus({ y: years.length - 1, k: 0 })}
        onBlur={() => setFocus(null)}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(255,255,255,0.45)" strokeWidth="1.2" />
          </pattern>
        </defs>
        {MONTHS_SHORT.map((m, k) => (
          <text key={m} x={LEFT + k * (CW + GAP) + CW / 2} y={13} className="cal-axis" textAnchor="middle">
            {m[0]}
          </text>
        ))}
        <text x={LEFT + 12 * (CW + GAP) + 4} y={13} className="cal-axis">
          Year total
        </text>
        {years.map((y, yi) => {
          const top = TOP + yi * (CH + GAP);
          const tot = yearTot.get(y) ?? 0;
          const yr = cal.years.find((r) => r.year === y);
          return (
            <g key={y} role="row">
              <text x={LEFT - 6} y={top + CH - 4} className="cal-axis" textAnchor="end">
                {y}
              </text>
              {MONTHS_SHORT.map((_, k) => {
                const id = `${y}-${String(k + 1).padStart(2, "0")}`;
                const m = byMonth.get(id);
                const x = LEFT + k * (CW + GAP);
                const isF = focus?.y === yi && focus?.k === k;
                return (
                  <g key={id} role="gridcell" aria-label={m ? describe(m) : `${id}: no data`}>
                    <rect
                      x={x}
                      y={top}
                      width={CW}
                      height={CH}
                      rx={2}
                      fill={fill(m)}
                      stroke={isF || (hover?.y === yi && hover?.k === k) ? "#fff" : "none"}
                      strokeWidth={1.5}
                      onMouseMove={(e) => setHover({ y: yi, k, x: e.clientX, yy: e.clientY })}
                    />
                    {m?.provisional && <rect x={x} y={top} width={CW} height={CH} rx={2} fill="url(#hatch)" pointerEvents="none" />}
                    {m && valueMode === "harmonized" && ((m.fill_frac ?? 0) > 0.05 || m.modis_outage) && (
                      <circle cx={x + CW - 4} cy={top + 4} r={2} fill="#8bd3ff" pointerEvents="none" />
                    )}
                  </g>
                );
              })}
              <rect x={LEFT + 12 * (CW + GAP) + 4} y={top + 3} height={CH - 6} width={Math.max(1, ((BARW - 40) * tot) / yMax)} fill={yr?.complete === false ? "#5b6270" : "#c9a36a"} rx={1} />
              <text x={LEFT + 12 * (CW + GAP) + 8 + ((BARW - 40) * tot) / yMax} y={top + CH - 4} className="cal-num">
                {tot >= 1000 ? `${(tot / 1000).toFixed(tot >= 10000 ? 0 : 1)}k` : fmt(tot)}
              </text>
            </g>
          );
        })}
        {/* climatology (median of the baseline) */}
        <text x={LEFT - 6} y={TOP + years.length * (CH + GAP) + 24} className="cal-axis" textAnchor="end">
          Typical
        </text>
        {cal.climatology.map((c) => {
          const h = 22 * ((c.median ?? 0) / climMax);
          const base = TOP + years.length * (CH + GAP) + 30;
          return <rect key={c.month_num} x={LEFT + (c.month_num - 1) * (CW + GAP) + 3} y={base - h} width={CW - 6} height={Math.max(h, 0.5)} fill="#8a93a3" rx={1} />;
        })}
      </svg>

      {cur && curMonth && (
        <div
          className={`cal-tip ${hover ? "" : "cal-tip-docked"}`}
          style={hover ? { left: Math.min(hover.x / uiZoom() + 14, window.innerWidth / uiZoom() - 300), top: hover.yy / uiZoom() + 14 } : undefined}
          role="status"
          aria-live="polite"
        >
          <strong>{monthLabel(curMonth.month)}</strong>
          <div className="tip-big">
            {fmt(val(curMonth))} <span>{valueMode === "raw" ? "raw detections" : "hotspots (MODIS-equivalent)"}</span>
          </div>
          {valueMode === "harmonized" && (
            <div>
              90 % range {fmt(curMonth.lo90)}–{fmt(curMonth.hi90)}
            </div>
          )}
          {valueMode === "harmonized" && curMonth.category && (
            <div>
              <span className="swatch" style={{ background: CATEGORY_COLOR[curMonth.category] }} /> {CATEGORY_LABEL[curMonth.category]} · percentile {fmt(curMonth.pct_rank)} · typical{" "}
              {fmt(curMonth.median_m)}
            </div>
          )}
          <div className="muted">
            Raw: MODIS {fmt(curMonth.raw.modis)} · S-NPP {fmt(curMonth.raw.snpp)} · NOAA-20 {fmt(curMonth.raw.noaa20)}
            {curMonth.raw.noaa21 ? ` · NOAA-21 ${fmt(curMonth.raw.noaa21)}` : ""}
          </div>
          <div className="muted">{REGIME_LABEL[curMonth.regime]}</div>
          {curMonth.provisional && <div className="warn">Provisional (near-real-time data)</div>}
          {(curMonth.fill_frac ?? 0) > 0.05 && <div className="note">{Math.round((curMonth.fill_frac ?? 0) * 100)} % gap-filled (a satellite lost data this month)</div>}
        </div>
      )}

      <div className="cal-legend" aria-hidden="true">
        {effMode === "anomaly" ? (
          CATEGORY_ORDER.map((c) => (
            <span key={c} className="leg-item">
              <span className="swatch" style={{ background: CATEGORY_COLOR[c] }} />
              {CATEGORY_LABEL[c]}
            </span>
          ))
        ) : (
          <span className="leg-item">
            <span className="leg-ramp" /> 1 → {fmt(vmax)} per month (log scale)
          </span>
        )}
        <span className="leg-item">
          <span className="swatch swatch-hatch" /> provisional
        </span>
        {valueMode === "harmonized" && (
          <span className="leg-item">
            <span className="dot" /> gap-filled
          </span>
        )}
      </div>
    </div>
  );
}
