// The "target" chip: what you are about to open, with its size, and the Acquire button.
import { useEffect, useRef } from "react";
import { fmt } from "../../app/format";
import { useObs } from "../store";

export function CandidateChip() {
  const c = useObs((s) => s.candidate);
  const acquiring = useObs((s) => s.acquiring);
  const acquire = useObs((s) => s.acquire);
  const set = useObs((s) => s.set);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (c) btn.current?.focus({ preventScroll: true });
  }, [c]);
  if (!c) return null;
  const drawn = c.kind === "Drawn area" || c.kind === "Circle";
  const a = c.area;
  return (
    <div className="cand glass" role="dialog" aria-label={`Open ${c.name}`} key={c.name + c.kind}>
      <div className="cand-scan" aria-hidden="true" />
      <div className="cand-body">
        <p className="kicker">{c.kind} · target acquired</p>
        <h2 className="cand-name">{a && !a.name.startsWith("Custom area") ? a.name : c.name}</h2>
        <p className="cand-meta">
          {a ? (
            <>
              {fmt(a.area_km2)} km² · {fmt(a.n_cells_r5)} grid cells{a.small_area_warning ? " · small area: single months swing a lot" : ""}
            </>
          ) : drawn ? (
            "Measuring the area…"
          ) : (
            "Press Open to read its fire history"
          )}
        </p>
      </div>
      <div className="cand-actions">
        <button ref={btn} type="button" className="btn-hot" disabled={acquiring || (drawn && !a)} onClick={() => {
            // from the flat map: roll it back into the globe first, then lift the place
            if (useObs.getState().mapMode === "on") useObs.getState().set({ afterMap: c, mapMode: "leaving" });
            else void acquire(c);
          }}>
          {acquiring ? "Opening…" : "Open"}
          <span aria-hidden="true">↵</span>
        </button>
        <button type="button" className="icon-btn" onClick={() => set({ candidate: null })} aria-label="Cancel">
          ✕
        </button>
      </div>
    </div>
  );
}
