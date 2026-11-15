// "Day by day": every day of the judged month against the typical day (median and middle half of the same day of
// the month, 2003–2025), or the running total against a typical month's running total. Data: /api/areas/{id}/daily.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../app/api";
import { MONTHS_SHORT, fmt } from "../../app/format";
import type { AreaDaily } from "../../app/types";
import { fmtS } from "./glyphs";

const W = 330, H = 156, L = 4, R = 4, T = 22, B = 16;
/** 0.04× stays 0.04× (not "0.0×"), 1.6× stays 1.6×, 23× stays 23×. */
const xTimes = (r: number) => `${r >= 10 ? Math.round(r) : r >= 0.1 ? r.toFixed(1) : r.toFixed(2)}×`;

export function DailyStrip({ areaId, month }: { areaId: string; month: string }) {
  const [d, setD] = useState<AreaDaily | null>(null);
  const [err, setErr] = useState(false);
  const [mode, setMode] = useState<"daily" | "cum">("daily");
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setD(null);
    setErr(false);
    api.daily(areaId, month).then((x) => alive && setD(x), () => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [areaId, month]);

  const g = useMemo(() => {
    if (!d) return null;
    const n = d.days.length;
    const bw = (W - L - R) / n;
    const x = (i: number) => L + i * bw;
    if (mode === "daily") {
      const max = Math.max(1, ...d.days.map((v) => Math.max(v.h ?? 0, v.p75)));
      const y = (v: number) => H - B - (v / max) * (H - B - T);
      let band = "";
      d.days.forEach((v, i) => (band += `${i ? "L" : "M"}${(x(i) + bw / 2).toFixed(1)},${y(v.p75).toFixed(1)}`));
      [...d.days].reverse().forEach((v, j) => (band += `L${(x(n - 1 - j) + bw / 2).toFixed(1)},${y(v.p25).toFixed(1)}`));
      const med = d.days.map((v, i) => `${i ? "L" : "M"}${(x(i) + bw / 2).toFixed(1)},${y(v.typical).toFixed(1)}`).join("");
      return { kind: "daily" as const, n, bw, x, y, band: band + "Z", med, max };
    }
    const max = Math.max(1, ...d.days.map((v) => Math.max(v.cum, v.cum_p75)));
    const y = (v: number) => H - B - (v / max) * (H - B - T);
    let band = "";
    d.days.forEach((v, i) => (band += `${i ? "L" : "M"}${(x(i) + bw / 2).toFixed(1)},${y(v.cum_p75).toFixed(1)}`));
    [...d.days].reverse().forEach((v, j) => (band += `L${(x(n - 1 - j) + bw / 2).toFixed(1)},${y(v.cum_p25).toFixed(1)}`));
    const med = d.days.map((v, i) => `${i ? "L" : "M"}${(x(i) + bw / 2).toFixed(1)},${y(v.cum_typical).toFixed(1)}`).join("");
    const have = d.days.filter((v) => v.h !== null);
    const line = have.map((v, i) => `${i ? "L" : "M"}${(x(v.day - 1) + bw / 2).toFixed(1)},${y(v.cum).toFixed(1)}`).join("");
    return { kind: "cum" as const, n, bw, x, y, band: band + "Z", med, line, max };
  }, [d, mode]);

  if (err) return null;
  const mName = MONTHS_SHORT[Number(month.slice(5, 7)) - 1];
  const have = d?.days.filter((v) => v.h !== null) ?? [];
  const busiest = have.length ? have.reduce((a, b) => ((b.h ?? 0) > (a.h ?? 0) ? b : a)) : null;
  const above = have.filter((v) => (v.h ?? 0) > v.p75 && (v.h ?? 0) > 0).length;
  const last = have[have.length - 1];
  const hv = hover !== null && d ? d.days[hover] : null;
  return (
    <div className="daily">
      <p className="kicker daily-kicker">Day by day · {mName} {month.slice(0, 4)}</p>
      <div className="daily-head">
        <div className="daily-title">
          {d && have.length > 0 && (
            <p className="daily-big">
              {mode === "daily" ? (
                <>
                  <b className={above > 0 ? "hi" : ""}>{above}</b> of {have.length} days above usual
                </>
              ) : (
                last && (
                  <>
                    <b>{last.cum_typical > 0 ? xTimes(last.cum / last.cum_typical) : "–"}</b> a typical month by day {last.day}
                  </>
                )
              )}
            </p>
          )}
        </div>
        <div className="seg2 tiny" role="radiogroup" aria-label="Daily view">
          <button type="button" role="radio" aria-checked={mode === "daily"} onClick={() => setMode("daily")}>
            each day
          </button>
          <button type="button" role="radio" aria-checked={mode === "cum"} onClick={() => setMode("cum")}>
            running total
          </button>
        </div>
      </div>
      {!d || !g ? (
        <div className="daily-skel" aria-hidden="true" />
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className={`daily-svg ${g.kind}`}
          key={`${month}-${mode}`}
          role="img"
          aria-label={`${mName} ${month.slice(0, 4)} day by day. ${busiest ? `Busiest day ${busiest.day} with ${fmt(busiest.h)} hotspots.` : ""} ${above} days above the usual range.`}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="d-bar-g" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#6b4424" />
              <stop offset="1" stopColor="#ffc27a" />
            </linearGradient>
          </defs>
          <path d={g.band} className="d-band" />
          <path d={g.med} className="d-med" pathLength={1} />
          {g.kind === "daily" &&
            d.days.map((v, i) =>
              v.h === null ? (
                <rect key={i} x={g.x(i) + 0.6} y={T} width={Math.max(1, g.bw - 1.2)} height={H - B - T} className="d-future" />
              ) : (
                <rect
                  key={i}
                  x={g.x(i) + 0.6}
                  y={g.y(v.h)}
                  width={Math.max(1, g.bw - 1.2)}
                  height={Math.max(0.5, H - B - g.y(v.h))}
                  className={`d-bar ${v.h > v.p75 && v.h > 0 ? "hi" : v.h < v.p25 ? "lo" : ""} ${hover === i ? "on" : ""}`}
                  style={{ animationDelay: `${i * 22}ms` }}
                />
              ),
            )}
          {g.kind === "cum" && <path d={g.line} className="d-line" pathLength={1} />}
          {g.kind === "daily" && busiest && (busiest.h ?? 0) > 0 && hover === null && (
            <g className="d-peak" style={{ animationDelay: `${(busiest.day - 1) * 22 + 450}ms` }}>
              <circle cx={g.x(busiest.day - 1) + g.bw / 2} cy={g.y(busiest.h ?? 0) - 4} r={2.2} />
              <text x={Math.min(W - 18, Math.max(18, g.x(busiest.day - 1) + g.bw / 2))} y={g.y(busiest.h ?? 0) - 9} textAnchor="middle">
                {fmtS(busiest.h)}
              </text>
            </g>
          )}
          {d.days.map((_, i) => (
            <rect key={`h${i}`} x={g.x(i)} y={0} width={g.bw} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
          {[1, 10, 20, d.days.length].map((day) => (
            <text key={day} x={g.x(day - 1) + g.bw / 2} y={H - 4} className="d-axis" textAnchor="middle">
              {day}
            </text>
          ))}
        </svg>
      )}
      <p className="daily-read" aria-live="polite">
        {hv ? (
          hv.h === null ? (
            <>
              <b>
                {mName} {hv.day}
              </b>{" "}
              · no data yet · typical {fmtS(hv.typical)}
            </>
          ) : mode === "daily" ? (
            <>
              <b>
                {mName} {hv.day}
              </b>{" "}
              · {fmtS(hv.h)} hotspots · typical {fmtS(hv.typical)} (middle half {fmtS(hv.p25)}–{fmtS(hv.p75)})
            </>
          ) : (
            <>
              <b>
                by {mName} {hv.day}
              </b>{" "}
              · {fmtS(hv.cum)} so far · a typical month {fmtS(hv.cum_typical)}
            </>
          )
        ) : d && busiest ? (
          mode === "daily" ? (
            <>
              Busiest day: <b>{mName} {busiest.day}</b> ({fmtS(busiest.h)}). Point at a day for its numbers.
            </>
          ) : (
            last && (
              <>
                By {mName} {last.day}: <b>{fmtS(last.cum)}</b> against a typical {fmtS(last.cum_typical)} ({last.cum_typical > 0 ? xTimes(last.cum / last.cum_typical) : "–"}).
              </>
            )
          )
        ) : (
          "Loading the days…"
        )}
      </p>
      <p className="fine">
        <span className="dk-band" /> usual range (middle half of {d?.baseline[0] ?? 2003}–{d?.baseline[1] ?? 2025}, same day of the month) · <span className="dk-med" /> typical
        {d && d.days.some((v) => v.h === null) ? ` · data through ${d.data_through}` : ""}
      </p>
    </div>
  );
}
