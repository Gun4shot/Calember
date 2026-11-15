import { useEffect, useId, useMemo, useState } from "react";
import { api, statics } from "../api";
import { type PickMode, useApp } from "../store";
import type { SearchEntry } from "../types";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const SUGGESTED: Array<{ id: string; label: string }> = [
  { id: "IND-3249", label: "Punjab, India" },
  { id: "NPL-1130", label: "Bagmati, Nepal" },
  { id: "AUS-2650", label: "Northern Territory" },
  { id: "BRA-602", label: "Mato Grosso, Brazil" },
  { id: "CAN-633", label: "British Columbia" },
];

export function AreaPicker() {
  const [index, setIndex] = useState<SearchEntry[]>([]);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const pickMode = useApp((s) => s.pickMode);
  const setPickMode = useApp((s) => s.setPickMode);
  const radiusKm = useApp((s) => s.radiusKm);
  const setRadius = useApp((s) => s.setRadius);
  const select = useApp((s) => s.select);
  const listId = useId();

  useEffect(() => {
    statics.search().then(setIndex, () => setIndex([]));
  }, []);

  const results = useMemo(() => {
    const n = norm(q.trim());
    if (n.length < 2) return [];
    const starts: SearchEntry[] = [];
    const contains: SearchEntry[] = [];
    for (const e of index) {
      const name = norm(e.name);
      if (name.startsWith(n)) starts.push(e);
      else if (name.includes(n) || norm(e.country).startsWith(n)) contains.push(e);
      if (starts.length > 12) break;
    }
    return [...starts, ...contains].slice(0, 8);
  }, [q, index]);

  const choose = (e: SearchEntry) => {
    setQ("");
    if (e.kind === "admin1") void select(() => api.areaByAdmin(e.admin_id), e.name, e.admin_id);
    else void select(() => api.areaByAdmin(e.admin_id), e.name, e.admin_id);
  };

  const modes: Array<{ m: PickMode; label: string; hint: string }> = [
    { m: "region", label: "Click a region", hint: "Click any province or state on the map." },
    { m: "circle", label: "Circle", hint: "Click the map to centre a circle." },
    { m: "draw", label: "Draw", hint: "Click corners; double-click or Enter to finish." },
  ];

  return (
    <div className="picker">
      <label className="field-label" htmlFor="place-search">
        Find a place
      </label>
      <div className="combo">
        <input
          id="place-search"
          className="input"
          type="search"
          placeholder="Province, state or country…"
          value={q}
          autoComplete="off"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (!results.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === "Escape") setQ("");
          }}
        />
        {results.length > 0 && (
          <ul id={listId} className="combo-list" role="listbox" aria-label="Matching places">
            {results.map((r, i) => (
              <li
                key={r.admin_id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "is-active" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(r);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span>{r.name}</span>
                <span className="muted">{r.kind === "country" ? "Country" : r.country}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="field-label" id="mode-label">
        Or pick on the map
      </div>
      <div className="seg" role="radiogroup" aria-labelledby="mode-label">
        {modes.map(({ m, label }) => (
          <button key={m} type="button" role="radio" aria-checked={pickMode === m} className={pickMode === m ? "seg-on" : ""} onClick={() => setPickMode(m)}>
            {label}
          </button>
        ))}
      </div>
      <p className="hint">{modes.find((x) => x.m === pickMode)?.hint}</p>
      {pickMode === "circle" && (
        <div className="radius">
          <label htmlFor="radius">Radius: {radiusKm} km</label>
          <input id="radius" type="range" min={10} max={300} step={10} value={radiusKm} onChange={(e) => setRadius(Number(e.target.value))} />
        </div>
      )}

      <div className="field-label">Try</div>
      <div className="chips">
        {SUGGESTED.map((s) => (
          <button key={s.id} type="button" className="chip" onClick={() => void select(() => api.areaByAdmin(s.id), s.label, s.id)}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
