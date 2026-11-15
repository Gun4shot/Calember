// ⌘K / "/" search over 4,139 places (provinces, countries, biomes, the world). Arrow keys preview on the globe.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../app/api";
import type { SearchEntry } from "../../app/types";
import { loadSearch, outlineOf } from "../data";
import { centerOf, polysOf } from "../geo";
import { type Candidate, useObs } from "../store";
import { cam, flyTo } from "../world/camera";

const KIND: Record<string, string> = { admin1: "Province", country: "Country", biome: "Biome", world: "World" };
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function score(e: SearchEntry, q: string): number {
  const n = norm(e.name ?? "");
  const c = norm(e.country ?? "");
  if (!q) return e.kind === "world" ? 100 : e.kind === "country" ? 10 : 0;
  let s = 0;
  if (n === q) s += 100;
  else if (n.startsWith(q)) s += 60;
  else if (n.includes(` ${q}`)) s += 40;
  else if (n.includes(q)) s += 25;
  else if (`${n} ${c}`.includes(q)) s += 12;
  else {
    // all query words somewhere
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length > 1 && words.every((w) => `${n} ${c}`.includes(w))) s += 15;
    else return 0;
  }
  if (e.kind === "country") s += 8;
  if (e.kind === "world" || e.kind === "biome") s += 2;
  return s;
}

export async function candidateFromEntry(e: SearchEntry): Promise<Candidate> {
  const out = await outlineOf(e.admin_id).catch(() => null);
  const polys = out ? polysOf(out.f.geometry) : [];
  // places without an outline (the world, biomes) get their stage wherever the camera is looking
  const center: [number, number] = polys.length ? centerOf(polys) : e.kind === "world" || e.kind === "biome" ? [cam.lon, Math.max(-40, Math.min(50, cam.lat))] : [(e.bbox[0] + e.bbox[2]) / 2, (e.bbox[1] + e.bbox[3]) / 2];
  return {
    name: e.kind === "admin1" ? `${e.name}, ${e.country}` : (e.name ?? e.admin_id),
    kind: KIND[e.kind] ?? "Place",
    polys,
    center,
    request: () => api.areaByAdmin(e.admin_id),
    linkId: e.admin_id,
  };
}

function distFor(e: SearchEntry) {
  if (e.kind === "world" || e.kind === "biome") return cam.dist > 30 ? cam.dist : 36;
  const span = Math.max(e.bbox[2] - e.bbox[0], e.bbox[3] - e.bbox[1]);
  return Math.min(48, Math.max(17, 15 + span * 0.45));
}

export function CommandPalette() {
  const open = useObs((s) => s.paletteOpen);
  const set = useObs((s) => s.set);
  const forWhat = useObs((s) => s.paletteFor);
  const watched = useObs((s) => s.watched);
  const [all, setAll] = useState<SearchEntry[] | null>(null);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);

  useEffect(() => {
    if (open) {
      loadSearch().then(setAll, () => undefined);
      setQ("");
      setI(0);
      window.setTimeout(() => input.current?.focus(), 20);
    }
  }, [open]);

  const results = useMemo(() => {
    if (!all) return [];
    const nq = norm(q.trim());
    const list = all
      .filter((e) => e.name && !(e.kind === "biome" && e.admin_id === "BIOME-0"))
      .map((e) => ({ e, s: score(e, nq) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || (a.e.name ?? "").localeCompare(b.e.name ?? ""))
      .slice(0, 9)
      .map((r) => r.e);
    // with nothing typed, the places you watch come first
    const w = nq ? [] : watched.map((x) => all.find((e) => e.admin_id === x.id)).filter((e): e is SearchEntry => !!e);
    return [...w, ...list.filter((e) => !w.includes(e))].slice(0, 9);
  }, [all, q, watched]);

  // preview the highlighted result on the globe
  useEffect(() => {
    if (!open || !results[i] || useObs.getState().paletteFor === "compare") return; // comparing: the stage stays put
    const e = results[i];
    const seq = ++previewSeq.current;
    const id = window.setTimeout(async () => {
      const c = await candidateFromEntry(e);
      if (seq !== previewSeq.current || !useObs.getState().paletteOpen) return;
      useObs.setState({ hoverPolys: c.polys.length ? c.polys : null, hoverName: null });
      flyTo(c.center[1], c.center[0], distFor(e), 1.1);
    }, 140);
    return () => window.clearTimeout(id);
  }, [open, results, i]);

  if (!open) return null;
  const choose = async (e: SearchEntry) => {
    if (forWhat === "compare") {
      set({ paletteOpen: false, compareB: { name: e.kind === "admin1" ? `${e.name}, ${e.country}` : e.name, request: () => api.areaByAdmin(e.admin_id) } });
      return;
    }
    const c = await candidateFromEntry(e);
    set({ paletteOpen: false, hoverPolys: null });
    if (useObs.getState().mapMode === "on") {
      set({ afterMap: c, mapMode: "leaving" });
      return;
    }
    flyTo(c.center[1], c.center[0], distFor(e), 1.0);
    void useObs.getState().acquire(c);
  };
  return (
    <div className="palette-wrap" onMouseDown={(ev) => ev.target === ev.currentTarget && set({ paletteOpen: false, hoverPolys: null })}>
      <div className="palette glass" role="dialog" aria-modal="true" aria-label="Search any place">
        <div className="palette-in">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            value={q}
            placeholder={forWhat === "compare" ? "Compare with… a province, a country or a biome" : "A province, a country, a biome… try “Punjab”, “Bagmati”, “Amazonas”"}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[i] ? `pal-${results[i].admin_id}` : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setI((v) => Math.min(results.length - 1, v + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setI((v) => Math.max(0, v - 1));
              } else if (e.key === "Enter" && results[i]) {
                e.preventDefault();
                void choose(results[i]);
              } else if (e.key === "Escape") {
                set({ paletteOpen: false, hoverPolys: null });
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" className="palette-list">
          {!all && <li className="muted">Loading places…</li>}
          {all && results.length === 0 && <li className="muted">No place matches “{q}”.</li>}
          {results.map((e, k) => (
            <li
              key={e.admin_id}
              id={`pal-${e.admin_id}`}
              role="option"
              aria-selected={k === i}
              className={k === i ? "on" : ""}
              onMouseEnter={() => setI(k)}
              onClick={() => void choose(e)}
            >
              <span className={`kind-chip k-${e.kind}`}>{KIND[e.kind]}</span>
              <span className="pal-name">
                {watched.some((w) => w.id === e.admin_id) && <span className="pal-star" aria-label="watched">★ </span>}
                {e.name}
              </span>
              <span className="pal-country">{e.kind === "admin1" ? e.country : ""}</span>
              {k === i && <span className="pal-enter" aria-hidden="true">↵ {forWhat === "compare" ? "compare" : "open"}</span>}
            </li>
          ))}
        </ul>
        <p className="palette-foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd> preview on the globe · <kbd>↵</kbd> open · or close this and lasso any shape with <kbd>L</kbd>
        </p>
      </div>
    </div>
  );
}
