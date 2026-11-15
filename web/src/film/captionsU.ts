// Captions for the v2 acts (data & method, scorecard, Turing test). They run on the
// new-act clock u (see timeline.ts). Every number comes from results.json.

import type { StoryData } from "./data";
import { fmt } from "./math";
import type { Caption } from "./timeline";

const m1 = (n: number) => `${(n / 1e6).toFixed(1)} million`;
const pctI = (x: number) => `${Math.round(x * 100)} %`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)} %`;
export const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")} %`;

/** "MODIS itself until 2011, MODIS and Calember blended 2012–2019, Calember from VIIRS since 2020." from the product regimes. */
function stackSub(regimes: { code: string; from: string; to: string }[]) {
  const R = Object.fromEntries(regimes.map((r) => [r.code, r]));
  const y = (ym: string) => ym.slice(0, 4);
  const parts = ["One unit for all of it: MODIS-equivalent hotspots."];
  if (R.M && R.B && R.V)
    parts.push(
      `MODIS itself until ${y(R.M.to)}, MODIS and Calember blended ${y(R.B.from)}–${y(R.B.to)}, Calember from VIIRS since ${y(R.V.from)}.`,
    );
  return parts.join(" ");
}

export function buildCaptionsU(d: StoryData): Caption[] {
  const r = d.results;
  const D = r.data;
  const b3 = r.b3.models;
  const ex = r.b3.excl_aqua_outage;
  const tu = r.turing;
  const S = d.scatterStats.m;
  const ao = d.extras.aqua_outage;
  const outageDays = ao.days.indexOf(ao.outage[1]) - ao.days.indexOf(ao.outage[0]) + 1;
  const U_ = (c: Omit<Caption, "space">): Caption => ({ ...c, space: "u" });
  return [
    U_({
      id: "d_raw",
      a: 0.055,
      b: 0.096,
      kicker: "The data",
      text: `${m1(D.raw_rows_total)} raw fire detections from five satellites, 2000 → 2026.`,
      sub: "MODIS on Terra and Aqua; VIIRS on Suomi NPP, NOAA-20 and NOAA-21. All from NASA FIRMS, every file checked.",
    }),
    U_({
      id: "d_clean",
      a: 0.106,
      b: 0.18,
      kicker: "Clean, then grid",
      text: "Gas flares and volcanoes never move, so they go. Every real fire lands on one shared grid.",
      sub: `${fmt(D.mask_cells)} permanent hot spots removed · ${fmt(D.r5_land_cells)} hexagons of about ${D.r5_cell_km2} km², the same for every satellite.`,
    }),
    U_({
      id: "d_stack",
      a: 0.19,
      b: 0.228,
      kicker: "The record",
      text: `${D.product_months} months stacked: ${m1(D.product_rows)} cell-months, ${D.product_first} → ${D.product_last}.`,
      sub: stackSub(D.regimes),
    }),
    U_({
      id: "d_overlap",
      a: 0.238,
      b: 0.266,
      kicker: "The overlap",
      text: `${D.train_years}: both sensors flew, so both answers are known.`,
      sub: "Those years teach the translation from what VIIRS sees to what MODIS would have counted.",
    }),
    U_({
      id: "d_folds",
      a: 0.274,
      b: 0.298,
      kicker: "Held out",
      text: `The world is split into ${D.folds} region folds, and 2020 is sealed.`,
      sub: "Every score that follows comes from places and a year the model never trained on.",
    }),
    U_({
      id: "s_q",
      a: 0.306,
      b: 0.338,
      kicker: "The scorecard",
      text: "How close does Calember get to what MODIS actually saw?",
      sub: "Each dot: one province, one month of 2020 (a year the model never saw), at what MODIS counted. Three methods now guess it from VIIRS alone.",
    }),
    U_({
      id: "s_h0",
      a: 0.348,
      b: 0.374,
      kicker: "Guess 1 · one global ratio",
      text: "Divide VIIRS by one number. The dots rise, but many land far from the line.",
      sub: `Only ${pctI(S[0].within25)} land within ±25 % (dashed lines: 2× off). Skill (KGE): ${b3.global_ratio.primary.toFixed(4)}.`,
    }),
    U_({
      id: "s_sota",
      a: 0.384,
      b: 0.41,
      kicker: "Guess 2 · state of the art",
      text: "A look-up table per biome and month, as global fire-emission models use (GFED5-NRT style).",
      sub: `A little tighter: ${pctI(S[0].within25)} → ${pctI(S[1].within25)} within ±25 %. Skill (KGE): ${b3.sota_style.primary.toFixed(4)}.`,
    }),
    U_({
      id: "s_ember",
      a: 0.424,
      b: 0.456,
      kicker: "Guess 3 · Calember",
      text: "Calember: the cloud locks onto the line.",
      sub: `${pctI(S[2].within25)} within ±25 %, and misses of 2× or worse fall from ${pct1(S[1].off2x)} to ${pct1(S[2].off2x)}. Skill (KGE) on the sealed year: ${b3.ember.primary.toFixed(4)}.`,
    }),
    U_({
      id: "s_bars",
      a: 0.47,
      b: 0.5,
      kicker: "Three tests, one winner",
      text: "Better than the state of the art on every test we ran.",
      sub: "Each group is a separate test. Calember (orange) is tallest in all three, including 2020, a year sealed in advance and opened once.",
    }),
    U_({
      id: "s_outage",
      a: 0.512,
      b: 0.546,
      kicker: "Why 2020 scores lower",
      text: `In August 2020, the Aqua satellite lost most of its fire detections for ${outageDays} days.`,
      sub: `The red ghosts are what Aqua missed: the MODIS "truth" has a hole, while Calember, built from VIIRS, keeps counting. Without those weeks: Calember ${ex.ember.toFixed(4)}, state-of-the-art style ${ex.sota_style.toFixed(4)}.`,
    }),
    U_({
      id: "s_seam",
      a: 0.558,
      b: 0.588,
      kicker: "Seamless, and honest about it",
      text: `The 2012 jump: ${Math.round(r.seam.raw_pp)} % raw, ${r.seam.ember_pp.toFixed(1)} % with Calember.`,
      sub: `The whole planet, month by month: when VIIRS joins, the raw count leaps and Calember holds the line. When it says "90 % sure", it is right ${pct(r.coverage90.b2_adm1)} of the time.`,
    }),
    U_({
      id: "t_q",
      a: 0.605,
      b: 0.652,
      kicker: "The Sensor Turing Test",
      text: "Could a machine tell real MODIS from Calember?",
      sub: `A classifier studies two-year fire records from ${tu.n_regions} provinces and guesses which one is real. Blind guessing scores 50 %.`,
    }),
    U_({ id: "t_raw", a: 0.662, b: 0.69, kicker: "Raw VIIRS", text: `Raw VIIRS: the machine spots it ${pct(tu.raw_viirs)} of the time.` }),
    U_({ id: "t_sota", a: 0.702, b: 0.73, kicker: "State of the art", text: `SOTA-style method: spotted ${pct(tu.sota_style)} of the time.` }),
    U_({
      id: "t_ember",
      a: 0.742,
      b: 0.785,
      kicker: "Calember",
      text: `Calember: ${pct(tu.ember)}. Barely better than a coin flip.`,
      sub: `Confirmed on the sealed 2020 test: ${pct(tu.ember_b3)}. Tested as a realistic sample, with MODIS-like counting noise.`,
    }),
    U_({ id: "t_game", a: 0.795, b: 0.868, kicker: "Your turn", text: "Can you beat the machine?", sub: "Three rounds. Pick the real MODIS record." }),
    U_({ id: "t_back", a: 0.892, b: 0.935, kicker: "Explore", text: "Now see it for yourself, back on the record." }),
  ];
}
