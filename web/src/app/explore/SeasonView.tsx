import { scaleLinear } from "d3";
import { MONTHS_SHORT, fmt } from "../format";
import type { Season } from "../types";

// Season ribbon (F15): one line per fire year from onset (10 % of the year's hotspots) to end (90 %), dot at the peak.
export function SeasonView({ season }: { season: Season }) {
  const ok = season.years.filter((y) => !y.insufficient && y.onset_doy !== null);
  if (ok.length < 3) return <p className="muted">{season.summary}</p>;
  const W = 520, ROW = 9, L = 40, R = 8, T = 18;
  const H = T + ok.length * ROW + 16;
  const x = scaleLinear().domain([0, 365]).range([L, W - R]);
  const sm = season.fire_year_start_month;
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const m = ((sm - 1 + i) % 12) + 1;
    const dayOf = Math.round(i * 30.44);
    return { m, d: dayOf };
  });
  const tr = season.trends;
  const line = (k: "onset" | "peak" | "end" | "length") => {
    const t = tr[k];
    if (!t || t.sen_days_per_decade == null || t.p == null) return null;
    return { v: t.sen_days_per_decade, p: t.p };
  };
  return (
    <figure className="season">
      <p className="summary-small">{season.summary}</p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Fire season timing per year. ${season.summary}`}>
        {ticks.map((t) => (
          <g key={t.m}>
            <line x1={x(t.d)} x2={x(t.d)} y1={T - 4} y2={H - 14} stroke="#232830" />
            <text x={x(t.d) + 2} y={T - 7} className="cal-axis">
              {MONTHS_SHORT[t.m - 1]}
            </text>
          </g>
        ))}
        {ok.map((y, i) => {
          const yy = T + i * ROW + ROW / 2;
          return (
            <g key={y.fire_year}>
              <text x={L - 5} y={yy + 3} textAnchor="end" className="cal-axis">
                {y.fire_year}
              </text>
              <line x1={x(y.onset_doy!)} x2={x(y.end_doy!)} y1={yy} y2={yy} stroke="#c97a3a" strokeWidth={4} strokeLinecap="round" />
              <circle cx={x(y.peak_doy!)} cy={yy} r={3} fill="#ffe08a" />
            </g>
          );
        })}
      </svg>
      <figcaption className="series-legend">
        <span className="leg-item">
          <span className="leg-line" style={{ background: "#c97a3a", height: 4 }} /> fire season (10 % → 90 % of the year's hotspots)
        </span>
        <span className="leg-item">
          <span className="dot" style={{ background: "#ffe08a" }} /> peak
        </span>
      </figcaption>
      <dl className="trend-list">
        {(["onset", "peak", "end", "length"] as const).map((k) => {
          const t = line(k);
          return (
            <div key={k}>
              <dt>{k === "length" ? "Season length" : `Season ${k}`}</dt>
              <dd>
                {t ? (
                  <>
                    {t.v > 0 ? "+" : ""}
                    {fmt(t.v, 1)} days / decade <span className={t.p < 0.05 ? "sig" : "muted"}>{t.p < 0.01 ? "p < 0.01" : `p = ${t.p.toFixed(2)}`}</span>
                  </>
                ) : (
                  "–"
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </figure>
  );
}
