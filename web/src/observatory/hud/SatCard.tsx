// Satellite card: the instrument, its pixel to scale, and its overpass time measured from our own fire data.
import { useEffect, useState } from "react";
import type { Drift } from "../../app/types";
import { loadDrift } from "../data";
import { SATS, hhmm, measuredHours } from "../sats/satData";
import { useObs } from "../store";

export function SatCard() {
  const id = useObs((s) => s.satCard);
  const set = useObs((s) => s.set);
  const monthIdx = useObs((s) => s.monthIdx);
  const [drift, setDrift] = useState<Drift | null>(null);
  useEffect(() => {
    if (id) loadDrift().then(setDrift, () => undefined);
  }, [id]);
  const sat = SATS.find((s) => s.id === id);
  if (!sat) return null;
  const hourAt = drift ? measuredHours(drift) : null;
  const year = 2000 + (monthIdx + 10) / 12;
  // the pre-drift reference: median of 2003–2019 (as in drift.json's summary), or the first full years for later satellites
  const refYears = sat.id === "TERRA" || sat.id === "AQUA" ? Array.from({ length: 17 }, (_, k) => 2003.5 + k) : [Number(sat.start.slice(0, 4)) + 1.5];
  const refHours = hourAt ? refYears.map((y) => hourAt(sat.id, y)).filter((h): h is number => h !== null).sort((a, b) => a - b) : [];
  const first = refHours.length ? refHours[Math.floor(refHours.length / 2)] : null;
  const now = hourAt?.(sat.id, year);
  const drifted = first != null && now != null ? Math.round((now - first) * 60) : null;
  const px = sat.instrument === "MODIS" ? 1000 : 375;
  return (
    <aside className={`satcard glass sat-${sat.instrument.toLowerCase()}`} aria-label={`${sat.name} satellite`}>
      <button type="button" className="icon-btn satcard-x" onClick={() => set({ satCard: null })} aria-label="Close">
        ✕
      </button>
      <p className="kicker">{sat.instrument} fire eye</p>
      <h2>{sat.name}</h2>
      <dl className="satcard-facts">
        <div>
          <dt>Pixel</dt>
          <dd>{sat.pixel}</dd>
        </div>
        <div>
          <dt>Swath</dt>
          <dd>{sat.swathKm.toLocaleString("en")} km</dd>
        </div>
        <div>
          <dt>Fire record</dt>
          <dd>
            {sat.start}
            {sat.end ? ` → ${sat.end}` : " → now"}
          </dd>
        </div>
        <div>
          <dt>Daytime pass</dt>
          <dd>
            {now != null ? hhmm(now) : "…"} <span className="muted">measured</span>
          </dd>
        </div>
      </dl>
      {drifted !== null && Math.abs(drifted) >= 10 && (
        <p className="satcard-drift">
          Drifted <strong>{drifted > 0 ? "+" : ""}{drifted} min</strong> since its pre-drift years ({first != null ? hhmm(first) : ""} → {now != null ? hhmm(now) : ""} in {Math.floor(year)}), measured from the
          fire detections themselves.
        </p>
      )}
      <div className="px-compare" aria-label={`One ${sat.instrument} pixel compared with one ${sat.instrument === "MODIS" ? "VIIRS" : "MODIS"} pixel, to scale`}>
        <span className="px px-modis" style={{ width: 54, height: 54 }} />
        <span className="px px-viirs" style={{ width: (54 * 375) / 1000, height: (54 * 375) / 1000 }} />
        <span className="px-cap">
          1 MODIS pixel (1 km) vs 1 VIIRS pixel (375 m), to scale. {px === 375 ? "Seven of these fit in one MODIS pixel." : ""}
        </span>
      </div>
      <p className="satcard-note">{sat.note}</p>
      {sat.retire && <p className="satcard-retire">Science operations end in {sat.retire}.</p>}
      <p className="fine">Orbits on screen: sun-synchronous, altitude ×2, sped up (illustration). Pass times: drift.json.</p>
    </aside>
  );
}
