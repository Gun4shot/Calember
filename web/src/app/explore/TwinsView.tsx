import { MONTHS_SHORT, fmt } from "../format";
import { useApp } from "../store";
import type { Twins } from "../types";

function Shape({ a, b }: { a: number[]; b: number[] }) {
  const W = 120, H = 34;
  const max = Math.max(...a, ...b, 0.01);
  const path = (v: number[]) => v.map((p, i) => `${i ? "L" : "M"}${((i + 0.5) * W) / 12},${H - 2 - (p / max) * (H - 6)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="twin-shape" aria-hidden="true">
      <path d={path(a)} fill="none" stroke="#8a93a3" strokeWidth={1.5} />
      <path d={path(b)} fill="none" stroke="#ffc45c" strokeWidth={1.8} />
    </svg>
  );
}

// Fire Twins + regime (F20)
export function TwinsView({ tw }: { tw: Twins | null }) {
  const mode = useApp((s) => s.twinMode);
  const setMode = useApp((s) => s.setTwinMode);
  const setFlyTo = useApp((s) => s.setFlyTo);
  return (
    <section aria-labelledby="twins-title">
      <h3 id="twins-title" className="h3">
        Fire Twins: places that burn the same way
      </h3>
      {tw && (
        <p className="regime-line">
          Fire regime: <strong>{tw.query.regime_name}</strong>
          {tw.query.regime_share != null && <span className="muted"> ({Math.round(tw.query.regime_share * 100)} % of this area's fire)</span>}.{" "}
          <span className="muted">{tw.query.regime_description}</span>
        </p>
      )}
      <div className="seg" role="radiogroup" aria-label="How to match">
        <button type="button" role="radio" aria-checked={mode === "season"} className={mode === "season" ? "seg-on" : ""} onClick={() => setMode("season")}>
          Same season shape
        </button>
        <button type="button" role="radio" aria-checked={mode === "calendar"} className={mode === "calendar" ? "seg-on" : ""} onClick={() => setMode("calendar")}>
          Same months
        </button>
      </div>
      <p className="hint">
        {mode === "season" ? "Peaks are lined up, so places on the other side of the equator can match." : "Twins must burn in the same calendar months."} At least 1,000 km away.
      </p>
      {!tw && <p className="muted">Finding twins…</p>}
      {tw && (
        <ol className="twins">
          {tw.twins.map((t) => (
            <li key={t.h3_r3}>
              <div className="twin-top">
                <span className="twin-sim" title="Similarity, 100 = identical">
                  {t.similarity}
                </span>
                <button type="button" className="link-btn" onClick={() => setFlyTo({ lon: t.lon, lat: t.lat, zoom: 5 })}>
                  {t.name}
                </button>
                <span className="muted">{fmt(t.distance_km)} km away</span>
              </div>
              <div className="twin-body">
                <Shape a={tw.query.shape12} b={t.shape12} />
                <span className="twin-why">
                  {t.why} <span className="muted">Regime: {t.regime_name}.</span>
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="fine">
        Grey line: this area's typical year ({MONTHS_SHORT[0]}–{MONTHS_SHORT[11]}); gold: the twin's. Similarity combines season shape (50 %), fire density (20 %),
        seasonal concentration, year-to-year variation and trend (10 % each).
      </p>
    </section>
  );
}
