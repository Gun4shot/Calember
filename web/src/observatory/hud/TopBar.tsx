import { useState } from "react";
import { useObs } from "../store";

export function TopBar() {
  const view = useObs((s) => s.view);
  const set = useObs((s) => s.set);
  const sound = useObs((s) => s.sound);
  // phones: the nav collapses into this menu
  const [menu, setMenu] = useState(false);
  const nav = [
    { id: "globe", label: "Observatory", href: "#/" },
    { id: "rankings", label: "Rankings", href: "#/rankings" },
    { id: "lab", label: "Proof Lab", href: "#/lab" },
    { id: "turing", label: "Turing test", href: "#/turing" },
    { id: "about", label: "About", href: "#/about" },
  ];
  return (
    <header className="topbar2">
      <a className="brand2" href="#/" aria-label="Calember Observatory home" onClick={() => useObs.getState().closeArea()}>
        <span className="brand2-mark" aria-hidden="true" />
        <span className="brand2-name">Calember</span>
        <span className="brand2-sub">Observatory</span>
      </a>
      <button type="button" className="search-btn" onClick={() => set({ paletteOpen: true })} aria-keyshortcuts="Control+K /">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span>Search any place on Earth</span>
        <kbd>/</kbd>
      </button>
      <nav aria-label="Main" className="nav2">
        {nav.map((n) => (
          <a key={n.id} href={n.href} aria-current={view === n.id || (n.id === "globe" && view === "area") ? "page" : undefined}>
            {n.label}
          </a>
        ))}
      </nav>
      <div className="topbar2-tools">
        <button type="button" className={`icon-btn ${sound ? "" : "sound-hint"}`} aria-pressed={sound} onClick={() => set({ sound: !sound })} title={sound ? "Sound on" : "Turn on sound for the full experience"}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 8h3l4-3v10l-4-3H3z" fill="currentColor" />
            {sound ? <path d="M13 7c1.5 1.6 1.5 4.4 0 6M15.5 5c2.6 2.8 2.6 7.2 0 10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /> : <path d="M13 8l4 4M17 8l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
          </svg>
          <span className="sr-only">{sound ? "Turn sound off" : "Turn sound on"}</span>
          <span className="sound-label" aria-hidden="true">{sound ? "Sound on" : "Sound off"}</span>
        </button>
        <button type="button" className="icon-btn keys-btn" onClick={() => set({ shortcutsOpen: true })} aria-keyshortcuts="Shift+?" title="Keyboard shortcuts (?)">
          <span aria-hidden="true">?</span>
          <span className="sr-only">Keyboard shortcuts</span>
        </button>
        <a className="ghost-link" href="./">
          Watch the story
        </a>
        <button type="button" className="icon-btn menu-btn" aria-expanded={menu} aria-controls="phone-menu" onClick={() => setMenu(!menu)}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d={menu ? "M5 5l10 10M15 5L5 15" : "M3 6h14M3 10h14M3 14h14"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span className="sr-only">Menu</span>
        </button>
      </div>
      {menu && (
        <nav id="phone-menu" className="phone-menu glass" aria-label="Main" onClick={() => setMenu(false)}>
          {nav.map((n) => (
            <a key={n.id} href={n.href} aria-current={view === n.id || (n.id === "globe" && view === "area") ? "page" : undefined}>
              {n.label}
            </a>
          ))}
          <a href="./">Watch the story</a>
          <a href="classic.html">Classic view (no 3D)</a>
        </nav>
      )}
    </header>
  );
}
