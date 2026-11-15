// DOM layer for the v2 acts: data counters (act 3), big-number scorecard (act 4),
// Turing meter + 3-round human game (act 5). Runs on the new-act clock u.
// Every number comes from results.json; big numbers always carry their scale and test.

import { useEffect, useMemo, useRef, useState } from "react";
import { gameRight, gameWrong } from "./audio";
import { pct } from "./captionsU";
import type { StoryData, TuringRound } from "./data";
import { buzz, tapHaptic } from "./haptics";
import { fmt, ramp } from "./math";
import { film } from "./store";
import { U, inActsAt, splitK } from "./timeline";

interface Card {
  a: number;
  b: number;
  big: string;
  label: string;
  small?: string;
  count?: number; // count-up target (animated with u)
  extra?: "regimes" | "trio" | "versus" | "seam";
}

const win = (a: number, b: number, u: number, f = 0.01) => Math.min(ramp(a - f, a, u), 1 - ramp(b, b + f, u));

/** Top edge (px) of the caption currently on screen, or the bottom of the window. */
function visibleCaptionTop() {
  let top = window.innerHeight;
  document.querySelectorAll<HTMLElement>(".captions .caption").forEach((el) => {
    if (parseFloat(el.style.opacity || "0") > 0.25) top = Math.min(top, el.getBoundingClientRect().top);
  });
  return top;
}

export function ActsOverlay({ data }: { data: StoryData }) {
  const r = data.results;
  const D = r.data;
  const B2 = r.b2.models;
  const B3 = r.b3.models;
  const tu = r.turing;
  const m = (n: number) => `${(n / 1e6).toFixed(1)} M`;

  const cards: Card[] = useMemo(
    () => [
      {
        a: 0.055,
        b: 0.096,
        big: fmt(D.raw_rows_total),
        count: D.raw_rows_total,
        label: "raw fire detections · 5 satellites · 2000 → 2026",
        small: `MODIS ${m(D.raw_rows_by_sensor.MODIS)} · S-NPP ${m(D.raw_rows_by_sensor.SNPP)} · NOAA-20 ${m(D.raw_rows_by_sensor.NOAA20)} · NOAA-21 ${m(D.raw_rows_by_sensor.NOAA21)}`,
      },
      { a: 0.106, b: 0.136, big: fmt(D.mask_cells), count: D.mask_cells, label: "permanent hot spots removed", small: "gas flares · volcanoes · industry" },
      { a: 0.146, b: 0.18, big: fmt(D.r5_land_cells), count: D.r5_land_cells, label: `hexagons · ≈ ${D.r5_cell_km2} km² each`, small: "one shared grid for every satellite" },
      {
        a: 0.19,
        b: 0.228,
        big: fmt(D.product_rows),
        count: D.product_rows,
        label: `cell-months · ${D.product_months} months · ${D.product_first} → ${D.product_last}`,
        small: `Calember record v${D.product_version.replace("-preH0", "")}`,
        extra: "regimes",
      },
      { a: 0.238, b: 0.266, big: D.train_years, label: "the overlap years it learns from", small: "both sensors flying, same fires, minutes apart" },
      { a: 0.274, b: 0.298, big: `${D.folds} + 1`, label: "spatial folds + one sealed year (2020)", small: "every score is on data the model never saw" },
      {
        a: 0.428,
        b: 0.456,
        big: "",
        label: "R² against MODIS · unseen regions and years (2018–2019)",
        small: `1.000 = a perfect match. Overall skill (KGE): Calember ${B2.ember.primary.toFixed(4)} vs ${B2.sota_style.primary.toFixed(4)}.`,
        extra: "trio",
      },
      {
        a: 0.472,
        b: 0.5,
        big: "",
        label: "skill (KGE) on the sealed 2020 test, opened once",
        small: `One global ratio: ${B3.global_ratio.primary.toFixed(4)}`,
        extra: "versus",
      },
      {
        a: 0.56,
        b: 0.588,
        big: "",
        label: "size of the 2012 jump, after removing seasons and MODIS's own change",
        small: `Placebo dates 2015 / 2017: ${r.seam.placebo_2015_pp} / ${r.seam.placebo_2017_pp} pp · 90 % ranges hold ${pct(r.coverage90.b2_adm1)} (sealed 2020: ${pct(r.coverage90.b3_adm1)})`,
        extra: "seam",
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );

  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const numRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const meter = useRef<HTMLDivElement>(null);
  const needle = useRef<HTMLDivElement>(null);
  const meterBig = useRef<HTMLSpanElement>(null);
  const meterLabel = useRef<HTMLSpanElement>(null);
  const meterSmall = useRef<HTMLParagraphElement>(null);
  const game = useRef<HTMLDivElement>(null);
  const [gameOn, setGameOn] = useState(false);

  // scale for the Turing meter: 45 % … 80 %
  const X = (acc: number) => `${(((acc - 0.45) / 0.35) * 100).toFixed(2)}%`;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const u = film.u;
      const inActs = inActsAt(film.s);
      const split = window.innerWidth >= 760 && splitK(u, film.u > 0 && film.u < 1) > 0.5;
      const capTop = visibleCaptionTop();
      cards.forEach((c, i) => {
        const el = cardRefs.current[i];
        if (!el) return;
        // cards of the data act step aside for the method hold and do not come back after it
        const mHold = film.sm > 0 && film.sm < 1 ? 1 - ramp(0, 0.04, film.sm) : film.sm >= 1 && c.b <= 0.3 ? 0 : 1;
        const a = inActs ? win(c.a, c.b, u) * mHold : 0;
        el.style.opacity = a.toFixed(3);
        el.style.visibility = a > 0.001 ? "visible" : "hidden";
        // fit-to-space: never reach the caption below (scale about the card's top edge)
        let k = 1;
        if (a > 0.001) {
          const h = el.offsetHeight;
          const avail = capTop - 22 - el.offsetTop;
          if (h > 0 && avail < h) k = Math.max(0.5, avail / h);
        }
        el.style.transformOrigin = split ? "0 0" : "50% 0";
        el.style.transform = `translate3d(${split ? "0" : "-50%"}, ${((1 - a) * -12).toFixed(1)}px, 0) scale(${k.toFixed(3)})`;
        if (a > 0.001 && c.extra) spinReels(el, ramp(c.a - 0.012, c.a + 0.02, u), ramp(c.a + 0.016, c.a + 0.026, u));
        const n = numRefs.current[i];
        if (n && c.count !== undefined && a > 0.001) {
          const k = ramp(c.a - 0.01, c.a + 0.015, u);
          n.textContent = fmt(c.count * (1 - Math.pow(1 - k, 3)));
        }
      });
      // Turing meter: needle follows the stage
      if (meter.current && needle.current && meterBig.current && meterLabel.current && meterSmall.current) {
        const a = inActs ? win(U.flipRaw[0] - 0.01, 0.788, u) : 0;
        meter.current.style.opacity = a.toFixed(3);
        meter.current.style.visibility = a > 0.001 ? "visible" : "hidden";
        // fit-to-space, like the cards: the meter never reaches the caption below
        if (a > 0.001) {
          const el = meter.current;
          const h = el.offsetHeight;
          const avail = capTop - 22 - el.offsetTop;
          const k = h > 0 && avail < h ? Math.max(0.5, avail / h) : 1;
          el.style.transformOrigin = split ? "0 0" : "50% 0";
          el.style.transform = `${split ? "" : "translateX(-50%) "}scale(${k.toFixed(3)})`;
        }
        const k1 = ramp(U.flipSota[0], U.flipSota[1], u);
        const k2 = ramp(U.flipEmber[0], U.flipEmber[1], u);
        const acc = tu.raw_viirs + (tu.sota_style - tu.raw_viirs) * k1 + (tu.ember - tu.sota_style) * k2;
        needle.current.style.left = X(acc);
        meterBig.current.textContent = pct(acc);
        const stage = k2 > 0.5 ? "ember" : k1 > 0.5 ? "sota" : "raw";
        meter.current.dataset.stage = stage;
        meterLabel.current.textContent =
          stage === "ember" ? "Calember · spotted by the machine" : stage === "sota" ? "State-of-the-art style · spotted" : "Raw VIIRS · spotted";
        meterSmall.current.style.opacity = stage === "ember" ? "1" : "0";
      }
      // human game
      if (game.current) {
        const a = inActs ? win(U.game[0], U.game[1], u) : 0;
        game.current.style.opacity = a.toFixed(3);
        game.current.style.visibility = a > 0.001 ? "visible" : "hidden";
        game.current.style.pointerEvents = a > 0.6 ? "auto" : "none";
        const on = a > 0.6;
        if (on !== gameOnRef.current) {
          gameOnRef.current = on;
          setGameOn(on);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    const gameOnRef = { current: false };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  return (
    <>
      {cards.map((c, i) => (
        <div key={i} ref={(el) => (cardRefs.current[i] = el)} className={`bigcard ${c.extra ? `bc-${c.extra}` : ""}`} style={{ opacity: 0, visibility: "hidden" }}>
          {c.extra === "trio" ? (
            <div className="st-grid">
              {(
                [
                  ["biome", B2.ember.biome.r2, B2.sota_style.biome.r2],
                  ["country", B2.ember.country.r2, B2.sota_style.country.r2],
                  ["province", B2.ember.adm1.r2, B2.sota_style.adm1.r2],
                ] as const
              ).map(([k, v, sv]) => (
                <div key={k} className="st-col">
                  <span className="st-k">{k}</span>
                  <Reel value={v.toFixed(3)} cls="st-v" delay={["biome", "country", "province"].indexOf(k) * 0.16} />
                  <span className="st-s">SOTA-style {sv.toFixed(3)}</span>
                </div>
              ))}
            </div>
          ) : c.extra === "versus" ? (
            <div className="vs-row">
              <div className="st-col">
                <Reel value={B3.ember.primary.toFixed(4)} cls="st-v hero" spins={3} delay={0.1} />
                <span className="st-k">Calember</span>
              </div>
              <span className="vs-sep">vs</span>
              <div className="st-col">
                <Reel value={B3.sota_style.primary.toFixed(4)} cls="st-v ice" spins={1} />
                <span className="st-k ice">state-of-the-art style</span>
              </div>
              <span className="vs-badge">+{(B3.ember.primary - B3.sota_style.primary).toFixed(3)}</span>
            </div>
          ) : c.extra === "seam" ? (
            <div className="vs-row">
              <div className="st-col">
                <Reel value={`${Math.round(r.seam.raw_pp)}`} cls="st-v ice" suffix=" %" spins={1} />
                <span className="st-k ice">raw sensors</span>
              </div>
              <span className="vs-sep">→</span>
              <div className="st-col">
                <Reel value={r.seam.ember_pp.toFixed(1)} cls="st-v hero" suffix=" %" spins={2} delay={0.2} />
                <span className="st-k">Calember</span>
              </div>
            </div>
          ) : (
            <span ref={(el) => (numRefs.current[i] = el)} className="big-num">
              {c.big}
            </span>
          )}
          <span className={`big-label ${c.extra === "trio" ? "st-head" : ""}`}>{c.label}</span>
          {c.extra === "regimes" && (
            <div className="regimes">
              {D.regimes.map((g) => (
                <span key={g.code} className={`regime regime-${g.code}`}>
                  <b>{g.code}</b> {g.label} <i>{g.from} → {g.to}</i>
                </span>
              ))}
            </div>
          )}
          {c.small && <span className="big-small">{c.small}</span>}
        </div>
      ))}

      <div ref={meter} className="tmeter" style={{ opacity: 0, visibility: "hidden" }} aria-hidden="true">
        <span ref={meterBig} className="big-num" />
        <span ref={meterLabel} className="big-label" />
        <div className="tm-track">
          <div className="tm-coin" style={{ left: X(0.5) }}>
            <span>coin flip 50 %</span>
          </div>
          <div className="tm-mark ember" style={{ left: X(tu.ember) }}>
            <span>Calember</span>
          </div>
          <div className="tm-mark sota" style={{ left: X(tu.sota_style) }}>
            <span>SOTA-style</span>
          </div>
          <div className="tm-mark raw" style={{ left: X(tu.raw_viirs) }}>
            <span>raw VIIRS</span>
          </div>
          <div ref={needle} className="tm-needle" />
        </div>
        <p ref={meterSmall} className="big-small tm-small">
          Mean of 3 runs ({tu.ember_seeds.map((x) => pct(x)).join(" · ")}), ± {pct(tu.ci_half_width)} · {tu.n_regions} provinces with ≥ 50 hotspots/month ·
          sealed 2020: {pct(tu.ember_b3)}. Calember is tested as a realistic sample of its own forecast (with MODIS-like counting noise); the
          smooth calendar values alone are spotted {pct(tu.smooth_values_ember)} of the time, like every method's (SOTA-style{" "}
          {pct(tu.smooth_values_sota)}).
        </p>
      </div>

      <div ref={game} className="tgame" style={{ opacity: 0, visibility: "hidden" }}>
        <TuringGame rounds={data.rounds} active={gameOn} />
      </div>
    </>
  );
}

// ---- slot-machine reels for the score numbers ---------------------------------------------------
const STRIP = Array.from({ length: 50 }, (_, i) => i % 10);
/** A number whose digits spin like a slot machine and land left to right (positions set by spinReels). */
function Reel({ value, cls = "", spins = 2, delay = 0, suffix = "" }: { value: string; cls?: string; spins?: number; delay?: number; suffix?: string }) {
  let j = 0;
  return (
    <span className={`reel ${cls}`} data-spins={spins} data-delay={delay}>
      <span className="sr-only">{value + suffix}</span>
      {value.split("").map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={i} className="reel-col" data-d={ch} data-j={j++} aria-hidden="true">
            <span className="reel-strip">
              {STRIP.map((d, n) => (
                <span key={n}>{d}</span>
              ))}
            </span>
            <span className="reel-ghost">{ch}</span>
          </span>
        ) : (
          <span key={i} className="reel-ch" aria-hidden="true">
            {ch}
          </span>
        ),
      )}
      {suffix && (
        <span className="reel-ch" aria-hidden="true">
          {suffix}
        </span>
      )}
    </span>
  );
}
const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
/** k: spin progress 0..1 (scroll-driven); kb: the badge pop. */
function spinReels(card: HTMLElement, k: number, kb: number) {
  card.style.setProperty("--badge", kb.toFixed(3));
  card.querySelectorAll<HTMLElement>(".reel").forEach((r) => {
    const spins = Number(r.dataset.spins ?? 2);
    const delay = Number(r.dataset.delay ?? 0);
    const cols = r.querySelectorAll<HTMLElement>(".reel-col");
    cols.forEach((col) => {
      const j = Number(col.dataset.j);
      const d = Number(col.dataset.d);
      const e = easeOut(k * (1.25 + 0.25 * spins) - delay - j * 0.09);
      const pos = (spins * 10 + d) * e;
      const strip = col.firstElementChild as HTMLElement;
      strip.style.transform = `translate3d(0, ${(-pos).toFixed(3)}em, 0)`;
      strip.style.filter = e > 0.001 && e < 0.999 ? `blur(${((1 - e) * 3.5).toFixed(2)}px)` : "none";
    });
    r.classList.toggle("landed", k >= 0.999);
  });
}

function Spark({ v, max, label }: { v: number[]; max: number; label: string }) {
  const W = 260;
  const H = 96;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${(H - (y / max) * (H - 6) - 3).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="spark" role="img" aria-label={label}>
      <polyline points={`0,${H} ${pts} ${W},${H}`} className="spark-fill" />
      <polyline points={pts} className="spark-line" />
    </svg>
  );
}

function TuringGame({ rounds, active }: { rounds: TuringRound[]; active: boolean }) {
  const [i, setI] = useState(0);
  const [pick, setPick] = useState<"a" | "b" | null>(null);
  const [score, setScore] = useState(0);
  const done = i >= rounds.length;
  const r = rounds[Math.min(i, rounds.length - 1)];
  const max = Math.max(...r.a, ...r.b, 1);
  const choose = (p: "a" | "b") => {
    if (pick || done) return;
    tapHaptic();
    setPick(p);
    const ok = p === r.real_is;
    if (ok) {
      setScore((s) => s + 1);
      gameRight();
      buzz([8, 40, 8]);
    } else {
      gameWrong();
      buzz(30);
    }
  };
  const next = () => {
    setPick(null);
    setI((x) => x + 1);
  };
  const reset = () => {
    setPick(null);
    setI(0);
    setScore(0);
  };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "1") choose("a");
      if (e.key === "2") choose("b");
      if (e.key === "Enter" && pick) next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (done)
    return (
      <div className="tg-done">
        <span className="big-num">
          {score} / {rounds.length}
        </span>
        <span className="big-label">
          {score === rounds.length ? "Sharp eyes. Now try it without the raw-VIIRS round…" : "Hard, isn't it? So is it for the machine."}
        </span>
        <button className="ghost-btn" onClick={reset}>
          Play again
        </button>
      </div>
    );
  const label = (k: "a" | "b") => (k === r.real_is ? "Real MODIS" : r.kind === "raw" ? "Raw VIIRS" : "Calember");
  return (
    <div className="tg">
      <div className="tg-head">
        <span>
          Round {i + 1} / {rounds.length} · {r.region}, {r.start.slice(0, 4)}–{+r.start.slice(0, 4) + 1}
        </span>
        <span>score {score}</span>
      </div>
      <div className="tg-pair">
        {(["a", "b"] as const).map((k) => (
          <button
            key={k}
            className={`tg-card ${pick ? (k === r.real_is ? "real" : "fake") : ""} ${pick === k ? "picked" : ""}`}
            onClick={() => choose(k)}
            disabled={!active || !!pick}
            aria-label={`Record ${k.toUpperCase()}${pick ? `: ${label(k)}` : ""}`}
          >
            <span className="tg-key">{k === "a" ? "A · 1" : "B · 2"}</span>
            <Spark v={k === "a" ? r.a : r.b} max={max} label={`24 months of fire counts, record ${k.toUpperCase()}`} />
            <span className="tg-reveal">{pick ? label(k) : "monthly hotspots, 24 months"}</span>
          </button>
        ))}
      </div>
      <div className="tg-foot">
        {pick ? (
          <>
            <span className={pick === r.real_is ? "ok" : "no"}>{pick === r.real_is ? "Correct." : "Fooled."}</span>
            <span className="tg-note">The other one: {r.other_label}.</span>
            <button className="primary-btn small" onClick={next}>
              {i + 1 < rounds.length ? "Next round →" : "See score"}
            </button>
          </>
        ) : (
          <span className="tg-note">Which one did MODIS actually record? Click, or press 1 / 2.</span>
        )}
      </div>
    </div>
  );
}
