// Keyboard help: "?" (or the ⌨ button in the top bar) lists every shortcut the Observatory understands.
import { useEffect } from "react";
import { useObs } from "../store";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      ["/  or  Ctrl K", "Search any place on Earth"],
      ["?", "Show or hide this list"],
      ["Esc", "Close a panel, leave an area or the 2D map"],
    ],
  },
  {
    title: "On the globe",
    keys: [
      ["Space", "Play or pause 26 years of fire"],
      ["←  →", "One month back or forward (Shift: one year)"],
      ["L", "Lasso: draw any shape"],
      ["C", "Circle: drag a radius"],
      ["M", "Precise 2D map (place names, roads)"],
    ],
  },
  {
    title: "In an area",
    keys: [
      ["1 – 7", "Verdict, Terrain, Calendar, Season, Helix, Twins, Take it"],
      ["T", "The numbers as a table"],
      ["R", "Calendar: raw sensors ⇄ harmonized (see the 2012 cliff)"],
      ["F", "Calendar: flat heatmap ⇄ 3D"],
      ["← → ↑ ↓", "Calendar: move month by month, year by year"],
    ],
  },
  {
    title: "Turing test",
    keys: [
      ["1  2", "Pick the real MODIS series"],
      ["Enter", "Next round"],
    ],
  },
];

export function Shortcuts() {
  const open = useObs((s) => s.shortcutsOpen);
  const set = useObs((s) => s.set);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        set({ shortcutsOpen: !useObs.getState().shortcutsOpen });
      } else if (e.key === "Escape" && useObs.getState().shortcutsOpen) {
        e.stopImmediatePropagation();
        set({ shortcutsOpen: false });
      }
    };
    // capture, so Esc closes this list before it closes the area underneath
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [set]);
  if (!open) return null;
  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && set({ shortcutsOpen: false })}>
      <div className="keys-modal glass" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header className="overlay-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="icon-btn" onClick={() => set({ shortcutsOpen: false })} aria-label="Close keyboard shortcuts" autoFocus>
            ✕
          </button>
        </header>
        <div className="keys-grid">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.keys.map(([k, what]) => (
                  <div key={k} className="keys-row">
                    <dt>
                      {k.split(/\s{2,}/).map((part, i) => (part === "or" ? <span key={i}>or</span> : <kbd key={i}>{part}</kbd>))}
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="fine">
          Prefer no 3D or a screen reader? Open the <a href="classic.html">classic view</a> of the same data.
        </p>
      </div>
    </div>
  );
}
