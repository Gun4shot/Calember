import { useEffect, useState } from "react";
import { AboutPage } from "./about/AboutPage";
import { api } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import { AreaPanel } from "./explore/AreaPanel";
import { AreaPicker } from "./explore/AreaPicker";
import { MapView } from "./explore/MapView";
import { LabPage } from "./lab/LabPage";
import { type Route, useApp } from "./store";
import { TuringPage } from "./turing/TuringPage";

const NAV: Array<{ r: Route; label: string }> = [
  { r: "explore", label: "Explore" },
  { r: "lab", label: "Lab" },
  { r: "turing", label: "Turing test" },
  { r: "about", label: "About" },
];

export function EmberApp() {
  const route = useApp((s) => s.route);
  const setRoute = useApp((s) => s.setRoute);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  useEffect(() => {
    api.health().then(() => setApiOk(true), () => setApiOk(false));
    // deep link: #/explore/<admin id>
    const m = window.location.hash.match(/^#\/explore\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      void useApp.getState().select(() => api.areaByAdmin(id), id, id);
    }
  }, []);
  useEffect(() => {
    document.title = `Calember · ${NAV.find((n) => n.r === route)?.label ?? "fire calendar"}`;
  }, [route]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="#/explore" onClick={() => setRoute("explore")} aria-label="Calember home">
          <span className="brand-mark" aria-hidden="true" />
          Calember
        </a>
        <nav aria-label="Main">
          <ul>
            {NAV.map((n) => (
              <li key={n.r}>
                <a href={`#/${n.r}`} aria-current={route === n.r ? "page" : undefined} className={route === n.r ? "is-on" : ""}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <a className="film-link" href="app.html">
          Open the 3D Observatory
        </a>
        <a className="film-link" href="./">
          Watch the story
        </a>
      </header>
      {apiOk === false && route === "explore" && (
        <div className="banner" role="alert">
          The data service is offline, so area calendars cannot load right now. The Lab and the Turing test still work.
        </div>
      )}
      {route === "explore" && (
        <main className="explore" id="main">
          <aside className="side" aria-label="Pick an area and read its fire calendar">
            <AreaPicker />
            <AreaPanel />
          </aside>
          <section className="map-col" aria-label="Map">
            <MapView />
          </section>
        </main>
      )}
      {route === "lab" && <ErrorBoundary label="Lab"><LabPage /></ErrorBoundary>}
      {route === "turing" && <ErrorBoundary label="Turing test"><TuringPage /></ErrorBoundary>}
      {route === "about" && <AboutPage />}
    </div>
  );
}
