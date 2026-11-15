import { CATEGORY_COLOR, CATEGORY_LABEL, MONTHS_LONG, fmt } from "../format";
import type { Now } from "../types";

// "Right now" (F14): this month so far vs a typical year by the same date, plus live detections of the last 7 days.
export function NowCard({ now }: { now: Now }) {
  const max = Math.max(now.mtd_hi90, now.expected_mtd, 1) * 1.15;
  const pct = (v: number) => `${Math.min(100, (100 * v) / max)}%`;
  const live = now.last7d.features.length;
  const month = MONTHS_LONG[Number(now.month.slice(5, 7)) - 1];
  return (
    <section className="now-card" aria-labelledby="now-title">
      <div className="now-head">
        <h3 id="now-title" className="h3">
          Right now: {month} so far
        </h3>
        <span className="muted">
          day {now.days_elapsed} of {now.days_in_month}
        </span>
      </div>
      <div className="now-big">
        <strong>{fmt(now.mtd_h_count)}</strong> hotspots
        {now.category && (
          <span className="badge" style={{ borderColor: CATEGORY_COLOR[now.category] }}>
            {CATEGORY_LABEL[now.category]}
          </span>
        )}
      </div>
      <div className="now-bar" role="img" aria-label={`This month so far ${fmt(now.mtd_h_count)}; a typical year by this date ${fmt(now.expected_mtd)}.`}>
        <span className="now-range" style={{ left: pct(now.mtd_lo90), width: `calc(${pct(now.mtd_hi90)} - ${pct(now.mtd_lo90)})` }} />
        <span className="now-fill" style={{ width: pct(now.mtd_h_count) }} />
        <span className="now-typ" style={{ left: pct(now.expected_mtd) }} />
      </div>
      <div className="now-legend muted">
        <span>
          <span className="now-key now-key-fill" /> this month
        </span>
        <span>
          <span className="now-key now-key-typ" /> typical by today ({fmt(now.expected_mtd)})
        </span>
      </div>
      <p className="now-text">{now.summary}</p>
      <p className="fine">
        {now.source_status === "ok"
          ? `${fmt(live)} live satellite detections in the last 7 days (NOAA-20 and NOAA-21, near-real-time), shown as dots on the map.`
          : "Live satellite data is not reachable right now; the numbers use the stored record."}
      </p>
    </section>
  );
}
