// DOM layer: gate, skip, captions (cinematic subtitles), telemetry HUD, progress rail,
// lens readout and region chips. Per-frame updates write to refs (no React re-renders).

import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { initAudio, regionChord, setMuted, uiTick } from "./audio";
import { ActsOverlay } from "./ActsOverlay";
import { scrollToS, scrollToT, stopScroll } from "./clock";
import { EndCalendar } from "./EndCalendar";
import { DAY, PunjabDay } from "./PunjabDay";
import type { StoryData } from "./data";
import { globeVisibility, rawMixAt } from "./Globe";
import { tapHaptic } from "./haptics";
import { fmt, ramp } from "./math";
import { LENS_MONTHS, harmonizeK, playK } from "./Ridge";
import { film, useUI } from "./store";
import { EYES, T, T_SENS, buildCaptions, mToS, globeMonthS, inActsAt, splitK, tToS, uToS, vToS, type Caption } from "./timeline";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const prettyMonth = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

/** Chapter marks on the scroll position s. */
const CHAPTERS = [
  { s: 0.0, label: "Watchers" },
  { s: tToS(0.16), label: "2012" },
  { s: vToS(0.05), label: "Look closer" },
  { s: tToS(0.29), label: "Pixels" },
  { s: tToS(0.44), label: "Cliff" },
  { s: tToS(0.58), label: "Harmonize" },
  { s: uToS(0.045), label: "Data" },
  { s: mToS(0.04), label: "Method" },
  { s: uToS(0.312), label: "Scorecard" },
  { s: uToS(0.605), label: "Turing test" },
  { s: tToS(0.812), label: "Your turn" },
].sort((x, y) => x.s - y.s);

const SEEN_KEY = "ember.storySeen";
/** playhead window of the real-image card (break through the clouds → just before the grid lands) */
/** Aqua artist's concept beside the opening caption ("two satellites") */
const SAT = [0.008, 0.078] as const;

/** Restart a CSS "bump" animation on an element (number ticks). */
function bump(el: HTMLElement) {
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}
const readSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
};
const writeSeen = () => {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
};

/** Leave the story for the Observatory with a short ember fade (the Observatory opens on the same night Earth). */
function goObservatory() {
  document.body.classList.add("leaving");
  window.setTimeout(() => (window.location.href = "app.html"), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650);
}

export function Overlay({ data }: { data: StoryData }) {
  const started = useUI((s) => s.started);
  const sound = useUI((s) => s.sound);
  const start = useUI((s) => s.start);
  const toggleSound = useUI((s) => s.toggleSound);
  const regionIdx = useUI((s) => s.regionIdx);
  const setRegion = useUI((s) => s.setRegion);
  const captions = useMemo(() => buildCaptions(data), [data]);
  const [seen] = useState(readSeen);

  const capRefs = useRef<(HTMLDivElement | null)[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const scrimLeft = useRef<HTMLDivElement>(null);
  const scrimBottom = useRef<HTMLDivElement>(null);
  const hudDate = useRef<HTMLSpanElement>(null);
  const hudSensors = useRef<HTMLSpanElement>(null);
  const hudMode = useRef<HTMLSpanElement>(null);
  const hud = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const haze = useRef<HTMLDivElement>(null);
  const lensBox = useRef<HTMLDivElement>(null);
  const lensYear = useRef<HTMLSpanElement>(null);
  const lensRaw = useRef<HTMLSpanElement>(null);
  const lensRatio = useRef<HTMLSpanElement>(null);
  const counter = useRef<HTMLDivElement>(null);
  const sat = useRef<HTMLElement>(null);
  const dive = useRef<HTMLDivElement>(null);
  const diveM = useRef<HTMLSpanElement>(null);
  const diveV = useRef<HTMLSpanElement>(null);
  const satImg = useRef<HTMLImageElement>(null);
  const cntModis = useRef<HTMLSpanElement>(null);
  const cntViirs = useRef<HTMLSpanElement>(null);
  const lastCounts = useRef({ m: -1, v: -1 });
  const lensHarm = useRef<HTMLSpanElement>(null);
  const lensModis = useRef<HTMLSpanElement>(null);
  const lensNoteRef = useRef<HTMLParagraphElement>(null);
  const lensPunjabRef = useRef<HTMLParagraphElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLDivElement>(null);
  const cta = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stopScroll(!started);
  }, [started]);

  // ?t=0.55 opens the film silently at that point (reproducible shots for review and recording)
  useEffect(() => {
    const P = new URLSearchParams(location.search);
    const q = P.get("t") ?? P.get("u") ?? P.get("m") ?? P.get("s");
    if (q === null) return;
    start(false);
    const v = Number.isFinite(Number(q)) ? Number(q) : 0;
    const to = P.has("t") ? tToS(v) : P.has("u") ? uToS(v) : P.has("m") ? mToS(v) : v;
    setTimeout(() => scrollToS(to, true), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setMuted(!sound);
    // the Observatory starts with the same sound choice the viewer made here
    if (started) {
      try {
        localStorage.setItem("calember.sound", sound ? "1" : "0");
      } catch {
        /* storage is optional */
      }
    }
  }, [sound, started]);

  // per-frame DOM updates
  useEffect(() => {
    let raf = 0;
    const g = data.globe;
    const sw = g.months.indexOf("2012-01");
    const ridgeMonths = data.ridge.months;
    const loop = () => {
      const t = film.t;
      const u = film.u;
      const inActs = inActsAt(film.s);
      // split layout (text left, 3D right) during the new acts on wide screens
      const k = splitK(u, film.u > 0 && film.u < 1);
      const wide = window.innerWidth >= 760;
      if (root.current) root.current.dataset.split = wide && k > 0.5 ? "1" : "0";
      // the real-image card sits on the right: captions move to the left column meanwhile
      if (root.current) root.current.dataset.side = wide && !inActs && t > DAY[0] - 0.006 && t < DAY[1] + 0.004 ? "1" : "0";
      if (scrimLeft.current) scrimLeft.current.style.opacity = (wide && started ? k : 0).toFixed(3);
      if (scrimBottom.current) scrimBottom.current.style.opacity = (started ? 1 - (wide ? 0.85 * k : 0) : 0).toFixed(3);
      captions.forEach((c, i) => {
        const el = capRefs.current[i];
        if (!el) return;
        const isU = c.space === "u";
        const isV = c.space === "v";
        const isM = c.space === "m";
        const x = isU ? u : isV ? film.sv : isM ? film.sm : t;
        const f = isU ? 0.005 : isV || isM ? 0.03 : 0.008; // u captions: fade out, then in (no cross-fade overlap)
        const live = isU ? inActs : isV ? film.sv > 0 && film.sv < 1 : isM ? film.sm > 0 && film.sm < 1 : !inActs || t < 0.749;
        let a = live ? Math.min(ramp(c.a - f, c.a, x), 1 - ramp(c.b, c.b + f, x)) : 0;
        // while the look-closer sequence holds the playhead, the story's own captions step aside
        if (!isV && film.sv > 0 && film.sv < 1) a *= 1 - ramp(0, 0.04, film.sv);
        // …and a line that ended before the hold does not come back after it
        if (!isU && !isV && !isM && film.sv >= 1 && c.b <= T_SENS) a = 0;
        // the method hold works the same way for the act captions around it (u holds at 0.3 meanwhile)
        if (isU && film.sm > 0 && film.sm < 1) a *= 1 - ramp(0, 0.04, film.sm);
        if (isU && film.sm >= 1 && c.b <= 0.3) a = 0;
        el.style.opacity = Math.min(1, a * 3).toFixed(3);
        el.style.transform = `translate3d(0, ${((1 - a) * 10).toFixed(1)}px, 0)`;
        el.style.visibility = a > 0.001 ? "visible" : "hidden";
        el.style.setProperty("--a", a.toFixed(3)); // drives the word-by-word reveal in CSS
      });
      // HUD
      if (hudDate.current && hudSensors.current && hudMode.current && hud.current) {
        const gv = globeVisibility(t);
        let date = "";
        let sensors = "";
        let mode = "";
        if (gv > 0.5 && film.sv > 0.02 && film.sv < 0.98) {
          const sv = film.sv;
          const gd = data.extras.globe_dive;
          date = new Date(`${gd.date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
          const where = sv > EYES.dive[0] + 0.08 && sv < EYES.out[1] - 0.05 ? "Punjab · " : "";
          sensors = `${where}${sv < EYES.sweep[0] + 0.05 ? "Aqua MODIS" : "Suomi NPP VIIRS"}`;
          mode = sv < EYES.synIn[1] ? "synthetic → real" : sv > EYES.synOut[0] ? "real → synthetic" : "real image · NASA Worldview";
        } else if (gv > 0.5) {
          const m = Math.round(globeMonthS(film.s, g.meta.n_months, sw));
          const ym = g.months[Math.min(g.months.length - 1, Math.max(0, m))];
          date = prettyMonth(ym);
          const y = +ym.slice(0, 4);
          const raw = rawMixAt(t) > 0.5;
          const sf = data.ridge.sensor_first ?? { SNPP: "2012-01", NOAA20: "2018-04", NOAA21: "2023-03" };
          sensors = raw
            ? ym >= sf.NOAA21
              ? "MODIS + VIIRS S-NPP + NOAA-20 + NOAA-21"
              : ym >= sf.NOAA20
                ? "MODIS + VIIRS S-NPP + NOAA-20"
                : ym >= sf.SNPP
                  ? "MODIS + VIIRS S-NPP"
                  : "MODIS Terra + Aqua"
            : y >= 2012
              ? "harmonized · MODIS-equivalent"
              : y >= 2002 && ym >= "2002-07"
                ? "MODIS Terra + Aqua"
                : "MODIS Terra";
          mode = raw ? "raw · sensors summed" : "";
        } else if (t > 0.28 && t < 0.43) {
          date = "Punjab · 30.6°N 75.6°E";
          sensors = t < T.viirsPlate ? (t < T.modisPlate ? "" : "MODIS · 1 km") : "VIIRS · 375 m";
          mode = "illustration";
        } else if (inActs) {
          const inMethod = film.sm > 0 && film.sm < 1;
          date = inMethod ? "The method in one picture" : u < 0.3 ? "The data & the method" : u < 0.59 ? "The scorecard" : "The Sensor Turing Test";
          sensors = inMethod ? "satellites → one record" : u < 0.3 ? `Calember record v${data.results.data.product_version.replace("-preH0", "")}` : u < 0.46 ? "sealed 2020 test · province-months" : u < 0.506 ? "three tests · skill (KGE)" : u < 0.59 ? "real data · NASA FIRMS" : `${data.results.turing.n_regions} provinces · 24-month records`;
          mode = "";
        } else if (t >= 0.43) {
          const k = harmonizeK(t);
          date = data.ridge.regions[useUI.getState().regionIdx].name;
          sensors = `${data.ridge.months[0]} → ${data.ridge.months[data.ridge.months.length - 1]} · monthly hotspots`;
          mode = k < 0.05 ? "raw · sensors summed" : k > 0.95 ? "harmonized · MODIS-equivalent" : "harmonizing…";
        }
        hudDate.current.textContent = date;
        hudSensors.current.textContent = sensors;
        hudMode.current.textContent = mode;
        hud.current.style.opacity = started ? "1" : "0";
      }
      if (rail.current) rail.current.style.transform = `scaleX(${film.s.toFixed(4)})`;
      if (haze.current) {
        const h = Math.max(ramp(0.258, 0.282, t) * (1 - ramp(0.282, 0.31, t)), ramp(0.93, 0.945, t) * (1 - ramp(0.945, 0.965, t)));
        haze.current.style.opacity = (h * 0.3).toFixed(3);
      }
      // look-closer: live counts in the 50 km window, ticking as the squares light up
      if (dive.current && diveM.current && diveV.current) {
        const sv = film.sv;
        const live = sv > 0 && sv < 1;
        const a = live ? Math.min(ramp(EYES.modis[0], EYES.modis[0] + 0.03, sv), 1 - ramp(EYES.out[0], EYES.out[0] + 0.04, sv)) : 0;
        dive.current.style.opacity = a.toFixed(3);
        dive.current.style.visibility = a > 0.002 ? "visible" : "hidden";
        if (a > 0.002) {
          const f = data.extras.globe_dive.focus;
          const km = ramp(EYES.modis[0], EYES.modis[1], sv);
          const kv = ramp(EYES.sweep[0] + 0.02, EYES.sweep[1] + 0.03, sv);
          diveM.current.textContent = fmt(f.modis * km);
          diveV.current.textContent = fmt(f.viirs * kv);
          dive.current.dataset.stage = kv > 0.05 ? "viirs" : "modis";
        }
      }
      // the satellite itself, while the opening caption introduces Terra and Aqua
      if (sat.current && satImg.current) {
        const a = Math.min(ramp(SAT[0], SAT[0] + 0.012, t), 1 - ramp(SAT[1] - 0.012, SAT[1], t)) * (started ? 1 : 0);
        sat.current.style.opacity = a.toFixed(3);
        sat.current.style.transform = `translate3d(0, ${((1 - a) * 18).toFixed(1)}px, 0)`;
        sat.current.style.visibility = a > 0.001 ? "visible" : "hidden";
        satImg.current.style.transform = `scale(${(1.02 + 0.08 * ramp(SAT[0], SAT[1], t)).toFixed(3)}) translate3d(${(-1.5 * ramp(SAT[0], SAT[1], t)).toFixed(2)}%, 0, 0)`;
      }
      // pixel-beat counter: MODIS 1 vs VIIRS 1…6, ticking with each pop
      if (counter.current && cntModis.current && cntViirs.current) {
        const a = Math.min(ramp(T.modisPop - 0.006, T.modisPop, t), 1 - ramp(T.platesOut[0], T.platesOut[0] + 0.01, t));
        counter.current.style.opacity = a.toFixed(3);
        const m = t >= T.modisPop ? 1 : 0;
        let v = 0;
        const step = T.viirsStepSpring / T.springSpeed;
        for (let i = 0; i < 6; i++) if (t >= T.viirsPop + i * step) v++;
        counter.current.dataset.stage = t >= T.viirsPlate ? "viirs" : "modis";
        if (m !== lastCounts.current.m) {
          cntModis.current.textContent = String(m);
          bump(cntModis.current);
        }
        if (v !== lastCounts.current.v) {
          cntViirs.current.textContent = String(v);
          bump(cntViirs.current);
        }
        lastCounts.current = { m, v };
      }
      // lens readout
      const play = playK(t);
      if (lensBox.current && chips.current && hint.current) {
        lensBox.current.style.opacity = play.toFixed(3);
        chips.current.style.opacity = play.toFixed(3);
        chips.current.style.pointerEvents = play > 0.5 ? "auto" : "none";
        hint.current.style.opacity = (play * (film.lensMonth >= 0 ? 1 : 0)).toFixed(3);
        if (play > 0.01 && lensYear.current && lensRaw.current && lensHarm.current && lensModis.current) {
          const reg = data.ridge.regions[useUI.getState().regionIdx];
          const c = Math.round(film.lensMonth);
          const i0 = Math.max(0, c - LENS_MONTHS / 2);
          const i1 = Math.min(ridgeMonths.length - 1, c + LENS_MONTHS / 2 - 1);
          let raw = 0,
            harm = 0,
            modis = 0;
          for (let i = i0; i <= i1; i++) {
            raw += reg.raw_sum[i];
            harm += reg.harmonized[i];
            modis += reg.modis[i];
          }
          lensYear.current.textContent = `${prettyMonth(ridgeMonths[i0])} – ${prettyMonth(ridgeMonths[i1])}`;
          lensRaw.current.textContent = fmt(raw);
          if (lensRatio.current) lensRatio.current.textContent = harm > 0 ? `${(raw / harm).toFixed(1)}×` : "—";
          lensHarm.current.textContent = fmt(harm);
          lensModis.current.textContent = fmt(modis);
          if (lensNoteRef.current) lensNoteRef.current.style.display = ridgeMonths[i1] >= "2020-07" ? "block" : "none";
          // Punjab after 2022: burning moved later in the day (data/products/drift.json → case_punjab)
          if (lensPunjabRef.current) lensPunjabRef.current.style.display = reg.id === "punjab" && ridgeMonths[i1] >= "2023-01" ? "block" : "none";
        }
      }
      if (cta.current) {
        const a = ramp(0.955, 0.98, t);
        cta.current.style.opacity = a.toFixed(3);
        cta.current.style.pointerEvents = a > 0.5 ? "auto" : "none";
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [captions, data, started]);

  const begin = async (withSound: boolean) => {
    tapHaptic();
    start(withSound);
    writeSeen();
    if (withSound) {
      try {
        await initAudio();
        setMuted(false);
      } catch {
        /* audio is optional */
      }
    }
  };
  const skip = () => {
    tapHaptic();
    writeSeen();
    goObservatory(); // straight into the Calember Observatory
  };
  const onSound = async () => {
    tapHaptic();
    if (!sound) {
      try {
        await initAudio();
      } catch {
        /* ignore */
      }
    }
    toggleSound();
  };

  // keyboard: ←/→ jump chapters, M mute
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!started) return;
      if (e.key === "m" || e.key === "M") onSound();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const s0 = film.target;
        const next =
          e.key === "ArrowRight" ? CHAPTERS.find((c) => c.s > s0 + 0.004)?.s ?? 1 : [...CHAPTERS].reverse().find((c) => c.s < s0 - 0.004)?.s ?? 0;
        scrollToS(next + 0.004);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, sound]);

  return (
    <div ref={root} className="overlay" data-split="0">
      <div ref={haze} className="haze" aria-hidden="true" />
      <div className="scrim-top" aria-hidden="true" style={{ opacity: started ? 1 : 0 }} />
      <div ref={scrimBottom} className="scrim-bottom" aria-hidden="true" style={{ opacity: started ? 1 : 0 }} />
      <div ref={scrimLeft} className="scrim-left" aria-hidden="true" style={{ opacity: 0 }} />

      {/* top bar */}
      <header className="topbar" style={{ opacity: started ? 1 : 0 }}>
        <span className="wordmark">Calember</span>
        <div className="topbar-actions">
          <button className="ghost-btn" onClick={onSound} aria-pressed={sound} aria-label={sound ? "Mute sound" : "Turn sound on"}>
            <SoundIcon on={sound} /> <span className="hide-sm">{sound ? "Sound on" : "Sound off"}</span>
          </button>
          <button className="ghost-btn" onClick={skip}>
            Open the Observatory →
          </button>
        </div>
      </header>

      {/* telemetry HUD */}
      <div ref={hud} className="hud" aria-hidden="true">
        <span ref={hudDate} className="hud-date" />
        <span ref={hudSensors} className="hud-sensors" />
        <span ref={hudMode} className="hud-mode" />
      </div>

      {/* captions */}
      <div className="captions" aria-live="off">
        {captions.map((c, i) => (
          <CaptionView key={c.id} c={c} ref={(el) => (capRefs.current[i] = el)} />
        ))}
      </div>

      {/* one of the two MODIS satellites */}
      <figure ref={sat} className="photo photo-sat" style={{ opacity: 0, visibility: "hidden" }}>
        <div className="photo-frame">
          <img
            ref={satImg}
            src={`${import.meta.env.BASE_URL}static/textures/aqua_artist_concept.jpg`}
            alt="Artist's concept of NASA's Aqua satellite, gold-foiled with one long solar panel, orbiting above Earth."
            loading="lazy"
            decoding="async"
          />
          <span className="photo-badge">Aqua · MODIS</span>
        </div>
        <figcaption>
          <strong>Aqua</strong> (2002) and its sister <strong>Terra</strong> (1999) each carry a MODIS: Terra in the morning, Aqua in the early
          afternoon. Both end science operations in 2027.
          <span className="photo-credit">Artist's concept · NASA (PIA18156)</span>
        </figcaption>
      </figure>


      {/* real detections of the same day (story_extras.json) */}
      <PunjabDay data={data} />

      {/* look-closer counter: detections in the 50 km window */}
      <div ref={dive} className="counter dive-counter" style={{ opacity: 0, visibility: "hidden" }} aria-hidden="true">
        <div className="cnt cnt-modis">
          <span className="cnt-label">Aqua MODIS · this window</span>
          <span ref={diveM} className="cnt-num">0</span>
          <span className="cnt-unit">fire detections</span>
        </div>
        <div className="cnt-vs">vs</div>
        <div className="cnt cnt-viirs">
          <span className="cnt-label">Suomi NPP VIIRS · same window</span>
          <span ref={diveV} className="cnt-num">0</span>
          <span className="cnt-unit">fire detections</span>
        </div>
      </div>

      {/* pixel-beat counter */}
      <div ref={counter} className="counter" aria-hidden="true">
        <div className="cnt cnt-modis">
          <span className="cnt-label">MODIS · 1 km pixels</span>
          <span ref={cntModis} className="cnt-num">0</span>
          <span className="cnt-unit">fire detected</span>
        </div>
        <div className="cnt-vs">vs</div>
        <div className="cnt cnt-viirs">
          <span className="cnt-label">VIIRS · 375 m pixels</span>
          <span ref={cntViirs} className="cnt-num">0</span>
          <span className="cnt-unit">fire detections</span>
        </div>
      </div>

      <ActsOverlay data={data} />

      {/* lens readout + regions */}
      <div ref={lensBox} className="lens-readout" aria-live="polite">
        <span ref={lensYear} className="lens-year" />
        <div className="lens-grid">
          <span className="k ice-t">Raw, sensors summed</span>
          <span ref={lensRaw} className="v" />
          <span className="k muted-t">Raw ÷ Calember</span>
          <span ref={lensRatio} className="v ratio" />
          <span className="k amber-t">Calember, harmonized</span>
          <span ref={lensHarm} className="v" />
          <span className="k white-t">MODIS actually saw</span>
          <span ref={lensModis} className="v" />
        </div>
        <p ref={lensNoteRef} className="lens-note">
          After 2020 Terra and Aqua drift to new overpass times, so MODIS no longer measures by its original standard. Depending on
          when fires burn locally it reads higher or lower. Calember keeps the original standard.
        </p>
        <p ref={lensPunjabRef} className="lens-note lens-note-warn">
          Recent drops in Punjab are partly because burning moved later in the day, after the satellites pass. Calember keeps the
          original early-afternoon view, so it shows a larger decline than the burning itself.
        </p>
      </div>
      <div ref={hint} className="lens-hint" aria-hidden="true">
        {matchMedia("(pointer: coarse)").matches ? "← drag along the ridge →" : "← move your pointer along the ridge →"}
      </div>
      <div ref={chips} className="chips" role="group" aria-label="Region">
        {data.ridge.regions.map((r, i) => (
          <button
            key={r.id}
            className={`chip ${i === regionIdx ? "on" : ""}`}
            aria-pressed={i === regionIdx}
            onClick={() => {
              tapHaptic();
              regionChord();
              setRegion(i);
            }}
          >
            {r.name.replace(", India", "")}
          </button>
        ))}
      </div>

      {/* what Calember is for: one real 'is this normal?' answer */}
      <EndCalendar data={data} />

      {/* end CTA */}
      <div ref={cta} className="cta">
        <a
          className="primary-btn"
          href="app.html"
          onClick={(e) => {
            e.preventDefault();
            tapHaptic();
            uiTick();
            goObservatory();
          }}
        >
          Enter the Calember Observatory →
        </a>
        <button className="ghost-btn" onClick={() => scrollToT(0)}>
          Watch again
        </button>
      </div>

      {/* progress rail with chapters */}
      <nav className="rail" aria-label="Story chapters" style={{ opacity: started ? 1 : 0 }}>
        <div className="rail-track">
          <div ref={rail} className="rail-fill" />
        </div>
        <div className="rail-ticks">
          {CHAPTERS.map((c) => (
            <button key={c.label} className="rail-tick" style={{ left: `${c.s * 100}%` }} onClick={() => scrollToS(c.s + 0.004)}>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      </nav>

      {!started && <Gate onBegin={begin} onSkip={skip} seen={seen} />}
    </div>
  );
}

const CaptionView = forwardRef<HTMLDivElement, { c: Caption }>(function CaptionView({ c }, ref) {
  return (
    <div ref={ref} className={`caption caption-${c.id}`} style={{ opacity: 0, visibility: "hidden" }}>
      {c.kicker && <div className="caption-kicker">{c.kicker}</div>}
      <p className="caption-text" aria-label={c.text}>
        <Words text={c.text} />
      </p>
      {c.sub && <p className="caption-sub">{c.sub}</p>}
      {c.tag && <span className="caption-tag">{c.tag}</span>}
    </div>
  );
});

/** Splits a caption into words for the scroll-driven reveal (CSS reads --i, --n and the caption's --a). */
function Words({ text }: { text: string }) {
  const words = text.split(" ");
  return (
    <>
      {words.map((w, i) => (
        <span key={i} aria-hidden="true" className={`w ${/\d/.test(w) ? "num" : ""}`} style={{ ["--i" as string]: i, ["--n" as string]: words.length }}>
          {w}
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  );
}

function Gate({ onBegin, onSkip, seen }: { onBegin: (s: boolean) => void; onSkip: () => void; seen: boolean }) {
  const [typed, setTyped] = useState("");
  const line = "TERRA · 2000-11-01 · 10:30 LOCAL · FIRST LIGHT";
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTyped(line);
      return;
    }
    let i = 0;
    const id = setInterval(() => {
      i++;
      setTyped(line.slice(0, i));
      if (i >= line.length) clearInterval(id);
    }, 38);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <div className="gate-inner">
        <p className="gate-telemetry" aria-hidden="true">
          {typed}
          <span className="caret" />
        </p>
        <h1 id="gate-title" className="gate-title" aria-label="Calember">
          {"Calember".split("").map((ch, i) => (
            <span key={i} aria-hidden="true" style={{ animationDelay: `${300 + i * 130}ms` }}>
              {ch}
            </span>
          ))}
        </h1>
        <p className="gate-lede">The fire memory that outlives its satellites.</p>
        <div className="gate-actions">
          <button className="primary-btn" onClick={() => onBegin(true)} autoFocus>
            <SoundIcon on /> Begin the story
          </button>
          <button className="ghost-btn" onClick={() => onBegin(false)}>
            Begin without sound
          </button>
          <button className="link-btn" onClick={onSkip}>
            {seen ? "Skip to the Observatory →" : "Skip the story, open the Observatory →"}
          </button>
        </div>
        <p className="gate-hint">Scroll or press ↓ to move through it · about 4 minutes · headphones recommended</p>
        <p className="gate-credit">Data: NASA FIRMS (MODIS, VIIRS) · Imagery: NASA Earth Observatory, Black Marble 2016</p>
      </div>
    </div>
  );
}

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ verticalAlign: "-3px" }}>
      <path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor" />
      {on ? (
        <path d="M11 5.5c1 .8 1 4.2 0 5M12.8 3.8c2 1.8 2 6.6 0 8.4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      ) : (
        <path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
    </svg>
  );
}

