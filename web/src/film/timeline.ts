// The film's single source of truth: when things happen (as fractions of the scroll),
// and what the captions say. Captions are templates filled from the data files.

import type { StoryData } from "./data";
import { buildCaptionsU } from "./captionsU";
import { fmt } from "./math";

/** Beat boundaries on the playhead t ∈ [0, 1]. */
export const T = {
  // Act I · The Watchers: MODIS months 2000-11 → 2011-12 on the globe
  modisMonths: [0.0, 0.15] as const,
  // Act II · A sharper eye: 2012-01 → last month, raw sensors summed (the globe "catches fire")
  viirsMonths: [0.155, 0.25] as const,
  rawOn: [0.15, 0.17] as const,
  // descent to Punjab
  descend: [0.25, 0.32] as const,
  // the pixel beat
  modisPlate: 0.325,
  modisPop: 0.345,
  viirsPlate: 0.365,
  viirsPop: 0.38,
  platesOut: [0.412, 0.43] as const,
  /** playhead -> spring-time factor for the pixel beat */
  springSpeed: 42,
  /** spring-time delay between successive VIIRS pixels */
  viirsStepSpring: 0.12,
  // Act III · the cliff
  ridgeRise: [0.415, 0.47] as const,
  cliffHit: 0.535,
  // Act IV · harmonize (scroll drives the collapse)
  harmonize: [0.575, 0.655] as const,
  checkLine: [0.69, 0.735] as const,
  // Act V · your turn (lens playground)
  play: [0.8, 0.915] as const,
  // rise back to the globe, the unbroken record
  ascend: [0.915, 1.0] as const,
};

// ---- v2/v3 time warp ---------------------------------------------------------------
// Scroll progress s ∈ [0,1]. The legacy playhead t (acts 1–2 and 6–7) holds at T_HOLD while the
// new acts run on their own local time u ∈ [0,1]. v3: u is piecewise linear in s, so the
// scorecard (u 0.30–0.59) gets twice the scroll of v2 without re-timing any u-based beat.
// Scroll budget in screens. v3.2 adds a hold inside acts 1–2: at T_SENS (end of 2011, before VIIRS
// joins) the playhead stops while the "two eyes" globe interlude runs on its own clock v ∈ [0,1].
//   [acts 1 to T_SENS] [two-eyes hold] [T_SENS to T_HOLD] [act 3 data] [act 4 scorecard] [act 5 Turing] [acts 6–7]
// v3.4 (D-027): the "look closer" real-Earth sequence holds the playhead at T_SENS, right after "2012: VIIRS
// joins … looking harder", so it is the evidence for that line. Everything cut in D-026 is back.
//   [acts 1 → T_SENS] [look-closer hold] [T_SENS → T_HOLD] [data] [scorecard] [seam] [Turing] [lens + ascent]
// v3.5: a "method in one picture" hold (the flow diagram, its own clock m ∈ [0,1]) sits between the data act and
// the scorecard; u holds at 0.3 meanwhile.
//   [acts 1 → T_SENS] [look-closer] [T_SENS → T_HOLD] [data] [method] [scorecard] [seam] [Turing] [lens + ascent]
const BUDGET = [3.1, 3.6, 5.5, 2.6, 2.4, 6.6, 1.6, 4.5, 4.48];
/** u at the act boundaries inside the new-acts window (0.3 twice = the method hold; 0.552–0.59 = the seam) */
// (0.94 at 97 % of the Turing budget: the quiet tail after "see it for yourself" passes quickly)
const U_KNOTS = [0, 0.3, 0.3, 0.552, 0.59, 0.94, 1];
const TOTAL = BUDGET.reduce((a, b) => a + b, 0);
const cum = (n: number) => BUDGET.slice(0, n).reduce((a, b) => a + b, 0) / TOTAL;
/** Scroll length in viewport heights. */
export const SCROLL_SCREENS = Math.round(TOTAL);
/** playhead held while the look-closer sequence plays (after the "6× brighter" globe, before the descent) */
export const T_SENS = 0.249;
const SA = cum(1); // hold starts
const SB = cum(2); // hold ends
export const S1 = cum(3);
export const S2 = cum(8);
/** the method hold (flow diagram) */
const MA = cum(4);
const MB = cum(5);
/** s at the u knots */
const S_KNOTS = [S1, MA, MB, cum(6), cum(7), cum(7) + 0.97 * (S2 - cum(7)), S2];
export const T_HOLD = 0.75;
/** After the Turing act, the camera's flight back to the ridge (t 0.75 → 0.80) takes 7 % of the last stretch, not 20 %. */
const TAIL_X = [0, 0.07, 1];
const TAIL_Y = [0, 0.2, 1];

function pw(x: number, xs: number[], ys: number[]) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + ((x - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ys[i] - ys[i - 1]);
  return ys[ys.length - 1];
}
export function sToT(s: number) {
  if (s <= SA) return (s / SA) * T_SENS;
  if (s < SB) return T_SENS;
  if (s <= S1) return T_SENS + ((s - SB) / (S1 - SB)) * (T_HOLD - T_SENS);
  if (s < S2) return T_HOLD;
  return T_HOLD + pw((s - S2) / (1 - S2), TAIL_X, TAIL_Y) * (1 - T_HOLD);
}
/** method flow-diagram clock: 0 before, 1 after */
export function sToM(s: number) {
  return Math.min(1, Math.max(0, (s - MA) / (MB - MA)));
}
export function mToS(m: number) {
  return MA + m * (MB - MA);
}
/** two-eyes interlude clock: 0 before, 1 after */
export function sToV(s: number) {
  return Math.min(1, Math.max(0, (s - SA) / (SB - SA)));
}
export function vToS(v: number) {
  return SA + v * (SB - SA);
}
export function sToU(s: number) {
  return pw(s, S_KNOTS, U_KNOTS);
}
export function tToS(t: number) {
  if (t <= T_SENS) return (t / T_SENS) * SA;
  if (t <= T_HOLD) return SB + ((t - T_SENS) / (T_HOLD - T_SENS)) * (S1 - SB);
  return S2 + pw((t - T_HOLD) / (1 - T_HOLD), TAIL_Y, TAIL_X) * (1 - S2);
}
export function uToS(u: number) {
  return pw(u, U_KNOTS, S_KNOTS);
}
/** true while the scroll is inside the new acts (with a small margin at both ends) */
export function inActsAt(s: number) {
  return s > S1 - 0.005 && s < S2 + 0.005;
}

/**
 * Split layout for the new acts: text in a left column, the 3D subject slides to the right
 * (narrow screens: subject slides up, text stays below). 0 → 1 on entry, 1 → 0 on exit.
 */
export function splitK(u: number, inActs: boolean) {
  if (!inActs) return 0;
  const a = Math.min(1, Math.max(0, u / 0.035));
  const b = Math.min(1, Math.max(0, (0.99 - u) / 0.04));
  const k = Math.min(a, b);
  return k * k * (3 - 2 * k);
}

/** The lens playground on the ridge (cut in D-026, restored in D-027). */
export const LENS = true;

/** Two-eyes interlude beats on v (the globe holds at the end of 2011). */
export const EYES = {
  synIn: [0.03, 0.13] as const, // swipe: synthetic Earth → the real day
  dive: [0.14, 0.36] as const, // camera dives into a 50 km window over Punjab
  modis: [0.3, 0.4] as const, // MODIS detections light up
  sweep: [0.48, 0.58] as const, // scan line: MODIS → VIIRS
  out: [0.72, 0.86] as const, // back out to the planet
  synOut: [0.87, 0.97] as const, // swipe back to the synthetic Earth
};

/** New-act beats on u. */
export const U = {
  // Act 3 · data & method (data tower, x −34)
  stream: [0.05, 0.19] as const,
  clean: [0.1, 0.14] as const,
  grid: [0.14, 0.19] as const,
  stack: [0.185, 0.235] as const,
  overlap: [0.235, 0.27] as const,
  folds: [0.27, 0.3] as const,
  // Act 4 · scorecard (scatter wall behind the ridge)
  fly: [0.3, 0.335] as const, // dots land on the chart floor at their MODIS value
  rise: [0.342, 0.364] as const, // …and rise to the global-ratio guess; error rays grow
  stageSota: [0.378, 0.398] as const,
  stageEmber: [0.418, 0.442] as const,
  show: [0.46, 0.482] as const, // camera to the grouped bar chart
  bars: [0.466, 0.498] as const,
  outage: [0.506, 0.552] as const, // 3D: the Aqua data loss of Aug 2020, day by day
  seam: [0.552, 0.59] as const, // 3D: the 2012 seam, planet-wide
  // Act 5 · Turing test (wall, x +34)
  rule: [0.6, 0.655] as const,
  flipRaw: [0.655, 0.67] as const,
  flipSota: [0.695, 0.71] as const,
  flipEmber: [0.735, 0.75] as const,
  game: [0.79, 0.87] as const,
};

export interface Caption {
  id: string;
  /** which clock the window is on: legacy playhead t (default), new-act time u, the two-eyes clock v, or the method clock m */
  space?: "t" | "u" | "v" | "m";
  a: number; // fully visible from
  b: number; // until
  kicker?: string;
  text: string;
  sub?: string;
  tag?: string; // small label, e.g. "illustration"
}

export function buildCaptions(d: StoryData): Caption[] {
  const { derived: x } = d;
  const hero = d.ridge.regions[x.heroIndex];
  const gd = d.extras.globe_dive;
  return [
    {
      id: "watchers",
      a: 0.012,
      b: 0.07,
      kicker: "2000 – 2011",
      text: "For 25 years, two satellites have written down every fire on Earth.",
      sub: `Terra and Aqua carry MODIS; each glow is a month of fire. Both drift off schedule (Aqua now passes at ${d.facts.drift.aqua_2025}, not ${d.facts.drift.aqua_2003}) and retire in 2027.`,
    },
    {
      id: "belt",
      a: 0.088,
      b: 0.143,
      text: "Watch Africa's fire belt swing north and south with the seasons.",
      sub: "Same sensors, same rules, every month: a record you can compare.",
    },
    {
      id: "viirs",
      a: 0.165,
      b: 0.198,
      kicker: "2012",
      text: "Then, in 2012, a sharper satellite joins: VIIRS.",
      sub: "Its detections are added to MODIS's, month after month.",
    },
    {
      id: "brighter",
      a: 0.215,
      b: 0.248,
      text: `Add its detections, and the planet suddenly looks ${x.globeRawRatio.toFixed(1)}× more on fire.`,
      sub: "It isn't. We just started looking harder.",
    },
    {
      id: "eyes_day",
      space: "v",
      a: 0.07,
      b: 0.16,
      kicker: `Look closer · ${dayLabel(gd.date)} · one real day`,
      text: "Here is the real planet, one afternoon, as Aqua's MODIS saw it.",
      sub: "The dark stripes are not a glitch: they are gaps between its passes, places MODIS never saw that day.",
    },
    {
      id: "eyes_modis",
      space: "v",
      a: 0.33,
      b: 0.47,
      kicker: "Punjab · a 50 km window",
      text: `In this window, MODIS sees ${fmt(gd.focus.modis)} fires.`,
      sub: `Each orange square is one MODIS detection at its real size, about 1 km across. All of Punjab & Haryana that afternoon: ${fmt(gd.modis_in_state)}.`,
    },
    {
      id: "eyes_viirs",
      space: "v",
      a: 0.59,
      b: 0.72,
      kicker: "Suomi NPP VIIRS · minutes later",
      text: `VIIRS sees the same window as ${fmt(gd.focus.viirs)} fires: ${Math.round(gd.focus.viirs / gd.focus.modis)}× as many.`,
      sub: `Smaller pixels catch smaller fires and split big ones. Across the state it is ${(gd.viirs_in_state / gd.modis_in_state).toFixed(1)}×; worldwide, ${x.globeRawRatio.toFixed(1)}×. The gap changes from place to place, so no single number can undo it.`,
    },
    {
      id: "punjab",
      a: 0.29,
      b: 0.318,
      kicker: "Punjab, India · after the rice harvest",
      text: "One field of stubble is burning.",
      tag: "illustration",
    },
    {
      id: "modis1",
      a: 0.336,
      b: 0.356,
      kicker: "MODIS · 1 km pixels",
      text: "The old eye sees one pixel. One fire.",
      tag: "illustration",
    },
    {
      id: "viirs6",
      a: 0.374,
      b: 0.405,
      kicker: "VIIRS · 375 m pixels",
      text: "The new eye sees the same fire as six.",
      sub: "Same fire, different count. Neither is wrong, but you can't add them up.",
      tag: "illustration",
    },
    {
      id: "stitch",
      a: 0.44,
      b: 0.497,
      kicker: hero.name,
      text: "Now stitch 25 years of Punjab's fires together, month by month…",
    },
    {
      id: "cliff",
      a: 0.515,
      b: 0.565,
      kicker: "2012",
      text: `…and from 2012 the record reads ${x.heroRawRatio.toFixed(1)}× higher.`,
      sub: "Not more fire. A different eye. Every region we tested has this cliff.",
    },
    {
      id: "translate",
      a: 0.585,
      b: 0.675,
      kicker: "Calember",
      text: "Calember translates what VIIRS sees into what MODIS would have seen.",
      sub: "Keep scrolling: watch the cliff come down.",
    },
    {
      id: "check",
      a: 0.695,
      b: 0.742,
      text: "The cliff is gone. The thin white line is what MODIS actually saw.",
      sub: `Calember never saw those values; they are the test. 2013–2019 total: ${(x.heroHarmRatio * 100).toFixed(0)}% of MODIS.`,
    },
    ...buildCaptionsU(d),
    {
      id: "m_flow",
      space: "m",
      a: 0.06,
      b: 0.42,
      kicker: "The method in one picture",
      text: "Five satellites in. One record out.",
      sub: "VIIRS (blue) is cleaned, put on one grid and described cell by cell. MODIS (amber) is the answer key in the years both flew.",
    },
    {
      id: "m_prove",
      space: "m",
      a: 0.5,
      b: 0.95,
      kicker: "Learn · translate · prove",
      text: "A model learns the translation, then has to prove it on places and a year it never saw.",
      sub: `Every VIIRS month becomes MODIS-equivalent, with a 90 % range, and joins MODIS's own record back to ${d.results.data.product_first.slice(0, 4)}.`,
    },
    {
      id: "play",
      a: 0.812,
      b: 0.91,
      kicker: "Your turn",
      text: "Drag the lens along the record to see the raw data underneath.",
      sub: "Switch regions below. Every one of them had a cliff.",
    },
    {
      id: "unbroken",
      a: 0.94,
      b: 1.01,
      kicker: `${d.ridge.months[0].slice(0, 4)} → ${d.ridge.months[d.ridge.months.length - 1].slice(0, 4)} · harmonized`,
      text: "Terra and Aqua retire in 2027. Their fire record doesn't have to.",
      sub: `Calember carries it forward on VIIRS: one unbroken record across sensors and satellites. ${fmt(sumAll(hero.product ?? hero.harmonized))} MODIS-equivalent hotspots in ${hero.name.replace(", India", "")} alone.`,
    },
  ];
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function sumAll(a: number[]) {
  let s = 0;
  for (const v of a) s += v;
  return s;
}

/**
 * Globe month from the scroll position: the VIIRS-era months (t 0.155 → 0.25) are spread over the
 * look-closer hold too, so the planet never freezes while the real Earth swipes in and out.
 */
export function globeMonthS(s: number, nMonths: number, switchIdx: number): number {
  const a = tToS(T.viirsMonths[0]);
  if (s >= a && s <= SB) return switchIdx + ((s - a) / (SB - a)) * (nMonths - 1 - switchIdx);
  return globeMonthAt(sToT(s), nMonths, switchIdx);
}

/** Which globe month (fractional index) is shown at playhead t. */
export function globeMonthAt(t: number, nMonths: number, switchIdx: number): number {
  const [a0, a1] = T.modisMonths;
  const [b0, b1] = T.viirsMonths;
  const [c0, c1] = T.ascend;
  if (t <= a1) return ((t - a0) / (a1 - a0)) * (switchIdx - 1);
  if (t < b0) return switchIdx - 1;
  if (t <= b1) return switchIdx + ((t - b0) / (b1 - b0)) * (nMonths - 1 - switchIdx);
  if (t < c0) return nMonths - 1;
  // the ascent replays the whole harmonized record
  const k = Math.min(1, Math.max(0, (t - c0 - 0.02) / (c1 - c0 - 0.03)));
  return k * (nMonths - 1);
}
