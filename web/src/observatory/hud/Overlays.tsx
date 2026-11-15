// Lab, Turing and About open over the dimmed, still-turning planet.
import { useEffect } from "react";
import { ProofLab } from "../lab/ProofLab";
import { TuringArena } from "../lab/TuringArena";
import { Rankings } from "../lab/Rankings";
import { useObs } from "../store";

export function Overlays() {
  const view = useObs((s) => s.view);
  useEffect(() => {
    if (view !== "lab" && view !== "turing" && view !== "about" && view !== "rankings") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (window.location.hash = "/");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);
  if (view === "lab") return <ProofLab />;
  if (view === "turing") return <TuringArena />;
  if (view === "about") return <About />;
  if (view === "rankings") return <Rankings />;
  return null;
}

function About() {
  return (
    <section className="about glass" aria-label="About Calember">
      <a className="icon-btn arena-x" href="#/" aria-label="Back to the globe">
        ✕
      </a>
      <p className="kicker">About</p>
      <h1>Calember: the fire memory that outlives its satellites.</h1>
      <p>
        NASA's Terra and Aqua satellites have counted active fires with MODIS since 2000 and end science operations in 2027. The sharper VIIRS sensors (since 2012) count several times
        more fires, so the two records cannot be compared directly. Calember translates VIIRS into <b>hotspots (MODIS-equivalent)</b>: what MODIS Terra + Aqua would have counted at their
        original overpass times. The result is one record from November 2000 to now, for any place on Earth.
      </p>
      <h2>The method in four steps</h2>
      <ol className="limits">
        <li>
          <b>Clean and grid.</b> Every MODIS and VIIRS detection from NASA FIRMS, minus gas flares, volcanoes and industry, on one hexagon grid (≈ 253 km²) per month.
        </li>
        <li>
          <b>Learn on the overlap.</b> In 2012–2019 both sensors flew; a machine-learning model learns, from what VIIRS saw in a cell, around it and before it, what MODIS counted.
        </li>
        <li>
          <b>Translate.</b> Every VIIRS month becomes hotspots (MODIS-equivalent) with a 90 % range; months with satellite data losses are gap-filled and flagged.
        </li>
        <li>
          <b>Prove.</b> Scores come only from regions held out of training and from 2020, sealed in advance. The <a href="#/lab">Proof Lab</a> shows them.
        </li>
      </ol>
      <h2>How the record is built, month by month</h2>
      <ul className="limits">
        <li>2000-11 → 2002-06: Terra only, scaled to Terra + Aqua.</li>
        <li>2002-07 → 2011-12: MODIS Terra + Aqua, as measured.</li>
        <li>2012-01 → 2019-12: MODIS blended with the VIIRS translation.</li>
        <li>2020-01 → now: VIIRS translated to MODIS-equivalent (MODIS has drifted).</li>
        <li>Latest months: near-real-time NOAA-20 / NOAA-21, marked provisional.</li>
      </ul>
      <h2>Data and credits</h2>
      <p>
        Fire detections: NASA FIRMS (MODIS Collection 6.1; VIIRS 375 m S-NPP, NOAA-20, NOAA-21). Night Earth: NASA Earth Observatory Black Marble 2016. Boundaries: Natural Earth. Biomes:
        RESOLVE Ecoregions 2017 (CC-BY 4.0). No NASA logos are used; this is not an official NASA product.
      </p>
      <h2>Getting around</h2>
      <p>
        Search with <kbd>/</kbd>, open a place, then walk its seven stations with <kbd>1</kbd>–<kbd>7</kbd>. Press <kbd>?</kbd> for every keyboard shortcut. The{" "}
        <a href="classic.html">classic view</a> shows the same data without 3D, for screen readers and older devices.
      </p>
      <p className="ctl-row">
        <a className="btn-ghost" href="./">Watch the story</a>
        <button type="button" className="btn-ghost" onClick={() => useObs.getState().set({ shortcutsOpen: true })}>
          Keyboard shortcuts
        </button>
      </p>
    </section>
  );
}
