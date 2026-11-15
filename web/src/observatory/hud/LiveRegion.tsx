// Screen-reader announcements: area verdicts and station changes.
import { useEffect, useState } from "react";
import { CATEGORY_LABEL, monthLabel } from "../../app/format";
import { STATIONS, useObs } from "../store";

export function LiveRegion() {
  const [msg, setMsg] = useState("");
  const cal = useObs((s) => s.calendar);
  const shape = useObs((s) => s.shape);
  const station = useObs((s) => s.station);
  const view = useObs((s) => s.view);
  useEffect(() => {
    if (!cal || !shape) return;
    // the same month the Verdict station judges first (the latest with a "vs normal" answer, provisional or not)
    const last = [...cal.months].reverse().find((m) => m.category);
    setMsg(`${shape.name} opened. ${cal.summary} ${last ? `${monthLabel(last.month)}${last.provisional ? " (provisional)" : ""}: ${CATEGORY_LABEL[last.category!]}.` : ""}`);
  }, [cal, shape]);
  useEffect(() => {
    if (view === "area") setMsg(`${STATIONS.find((s) => s.id === station)?.label}: ${STATIONS.find((s) => s.id === station)?.q}`);
  }, [station, view]);
  return (
    <div className="sr-only" aria-live="polite" role="status">
      {msg}
    </div>
  );
}
