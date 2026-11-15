// The score: synthesized with Tone.js (lazy-loaded at the gate click). Two "voices":
// MODIS = low woody mallet, VIIRS = high glassy mallet. During the harmonize beat the two
// voices hold a detuned interval whose beating slows to unison as the cliff comes down.
// Cues fire only when the playhead moves forward, so scrubbing back never becomes noise.

import type * as ToneNS from "tone";
import { buzz } from "./haptics";
import { clamp, ramp } from "./math";
import { T } from "./timeline";

type ToneT = typeof ToneNS;
let Tone: ToneT | null = null;
let ready = false;
let muted = true;

interface Graph {
  master: ToneNS.Volume;
  droneGain: ToneNS.Gain;
  droneFilter: ToneNS.Filter;
  pops: ToneNS.NoiseSynth[];
  popFilter: ToneNS.Filter;
  bedGain: ToneNS.Gain;
  bedFilter: ToneNS.Filter;
  modis: ToneNS.PolySynth;
  viirs: ToneNS.PolySynth;
  hit: ToneNS.MembraneSynth;
  whoosh: ToneNS.NoiseSynth;
  whooshFilter: ToneNS.Filter;
  beatA: ToneNS.Oscillator;
  beatB: ToneNS.Oscillator;
  beatGain: ToneNS.Gain;
  pad: ToneNS.PolySynth;
  bell: ToneNS.PolySynth;
  lens: ToneNS.PolySynth;
}
let G: Graph | null = null;

export async function initAudio(): Promise<void> {
  if (ready) return;
  Tone = await import("tone");
  await Tone.start();
  const T_ = Tone;
  const master = new T_.Volume(-8);
  const limiter = new T_.Limiter(-2);
  master.chain(limiter, T_.getDestination());
  const reverb = new T_.Reverb({ decay: 5.5, wet: 0.32 });
  reverb.connect(master);
  const bus = new T_.Gain(1).connect(reverb);

  // drone bed: D2 + A2, lowpassed; opens with fire activity
  const droneFilter = new T_.Filter(260, "lowpass").connect(bus);
  const droneGain = new T_.Gain(0).connect(droneFilter);
  const o1 = new T_.Oscillator(73.42, "sine").connect(droneGain).start();
  const o2 = new T_.FatOscillator(110, "sawtooth", 18).connect(new T_.Gain(0.08).connect(droneGain)).start();
  void o1;
  void o2;

  // fire: a low "roar" felt more than heard (brown noise, steep 24 dB/oct lowpass at 120-280 Hz). It sounds only
  // while fire is on screen. The old bed was always on (a gain floor) and its lowpass opened to 780 Hz at 12 dB/oct, so
  // its hiss sat in the 300 Hz-4 kHz band where laptop speakers play: measured, it was the loudest layer there in
  // nearly every section of the film, which is what viewers heard as "static".
  const bedGain = new T_.Gain(0).connect(bus);
  const bedFilter = new T_.Filter({ frequency: 160, type: "lowpass", rolloff: -24 }).connect(bedGain);
  new T_.Noise("brown").connect(new T_.Filter(40, "highpass").connect(bedFilter)).start();
  // … plus sparse, soft "thumps" for big fire (pink noise, 12 ms attack, lowpassed at 600 Hz, so no crackle/hiss).
  // Round-robin voices so a retrigger never cuts a sounding envelope.
  const popFilter = new T_.Filter({ frequency: 600, type: "lowpass", rolloff: -24 }).connect(bus);
  const pops = [0, 1, 2, 3].map(() =>
    new T_.NoiseSynth({
      noise: { type: "pink" },
      envelope: { attack: 0.012, decay: 0.09, sustain: 0, release: 0.08 },
      volume: -30,
    }).connect(popFilter),
  );

  // the two sensor voices
  const modis = new T_.PolySynth(T_.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.4 },
    volume: -6,
  }).connect(new T_.Filter(1400, "lowpass").connect(bus));
  const viirs = new T_.PolySynth(T_.FMSynth, {
    harmonicity: 3.01,
    modulationIndex: 9,
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.6 },
    modulationEnvelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.1 },
    volume: -16,
  }).connect(bus);

  const hit = new T_.MembraneSynth({ pitchDecay: 0.09, octaves: 5, envelope: { attack: 0.001, decay: 1.4, sustain: 0, release: 1 }, volume: -4 }).connect(master);

  const whooshFilter = new T_.Filter(400, "bandpass").connect(bus);
  whooshFilter.Q.value = 1.2;
  const whoosh = new T_.NoiseSynth({ noise: { type: "pink" }, envelope: { attack: 0.6, decay: 0.8, sustain: 0, release: 0.6 }, volume: -12 }).connect(whooshFilter);

  // the harmonization interval
  const beatGain = new T_.Gain(0).connect(bus);
  const beatA = new T_.Oscillator(220, "triangle").connect(beatGain).start();
  const beatB = new T_.Oscillator(220, "triangle").connect(beatGain).start();

  const pad = new T_.PolySynth(T_.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.8, decay: 1.5, sustain: 0.4, release: 3.5 },
    volume: -14,
  }).connect(bus);
  const bell = new T_.PolySynth(T_.FMSynth, {
    harmonicity: 2,
    modulationIndex: 3,
    envelope: { attack: 0.002, decay: 1.6, sustain: 0, release: 1.6 },
    volume: -18,
  }).connect(bus);

  // lens playground: a soft, rounded mallet (sine, 8 ms attack, lowpassed) instead of the bright FM voice.
  // Fast drags used to fire FM notes up to B6 many times a second: that was the sharp, high-pitched "glitch".
  const lens = new T_.PolySynth({
    maxPolyphony: 8,
    voice: T_.Synth,
    options: { oscillator: { type: "sine" }, envelope: { attack: 0.008, decay: 0.28, sustain: 0, release: 0.25 }, volume: -14 },
  }).connect(new T_.Filter(1600, "lowpass").connect(bus));
  G = { master, droneGain, droneFilter, pops, popFilter, bedGain, bedFilter, modis, viirs, hit, whoosh, whooshFilter, beatA, beatB, beatGain, pad, bell, lens };
  ready = true;
  setMuted(muted);
  if (import.meta.env.DEV) Object.assign(window, { __G: G, __Tone: Tone });
}

export function setMuted(m: boolean) {
  muted = m;
  if (G && Tone) G.master.volume.rampTo(m ? -80 : -8, 0.4);
}
export const audioReady = () => ready && !muted;

// ---- cues --------------------------------------------------------------------------
const PENTA = ["D", "E", "F#", "A", "B"];
const note = (step: number, base = 4) => `${PENTA[((step % 5) + 5) % 5]}${base + Math.floor(step / 5)}`;

interface Cue {
  t: number;
  fire: () => void;
}
const VIIRS_STEP = T.viirsStepSpring / T.springSpeed; // matches Ground.tsx stagger

function cues(): Cue[] {
  const g = () => G!;
  const now = () => Tone!.now();
  const list: Cue[] = [
    { t: T.rawOn[0] + 0.006, fire: () => g().viirs.triggerAttackRelease(["A5", "D6", "F#6"], "8n", now(), 0.5) },
    { t: 0.268, fire: () => (g().whooshFilter.frequency.rampTo(2400, 1.4), g().whoosh.triggerAttackRelease("1n", now())) },
    { t: T.modisPlate + 0.012, fire: () => g().hit.triggerAttackRelease("A1", "8n", now(), 0.25) },
    { t: T.modisPop, fire: () => (g().modis.triggerAttackRelease("D3", "8n", now(), 0.9), buzz(10)) },
    { t: T.viirsPlate + 0.012, fire: () => g().hit.triggerAttackRelease("D2", "8n", now(), 0.18) },
    { t: 0.45, fire: () => g().whoosh.triggerAttackRelease("2n", now()) },
    { t: T.cliffHit, fire: () => (g().hit.triggerAttackRelease("D1", "2n", now(), 1), buzz([40, 30, 80])) },
    { t: T.harmonize[1] - 0.004, fire: () => (g().pad.triggerAttackRelease(["D3", "A3", "D4", "F#4"], "2n", now(), 0.7), buzz([6, 40, 6, 40, 12])) },
    { t: 0.94, fire: () => g().pad.triggerAttackRelease(["D2", "A2", "E3", "F#3", "A3"], "1n", now(), 0.6) },
  ];
  for (let i = 0; i < 6; i++) {
    list.push({ t: T.viirsPop + i * VIIRS_STEP, fire: () => (g().viirs.triggerAttackRelease(note(i + 3, 5), "16n", now(), 0.7), buzz(6)) });
  }
  return list.sort((a, b) => a.t - b.t);
}
let CUES: Cue[] | null = null;
let popBudget = 0;
let popVoice = 0;
let ctrlClock = 0;

/** Per-frame: forward-crossing cues every frame; continuous parameters ~10×/s (no zipper noise). */
export function audioTick(prevT: number, t: number, dt: number, activity: number, _pan: number) {
  if (!ready || !G || !Tone) return;
  if (!CUES) CUES = cues();
  const forward = t > prevT && t - prevT < 0.05; // ignore big jumps (skip, chapter clicks)
  if (forward && !muted) {
    for (const c of CUES) if (c.t > prevT && c.t <= t) c.fire();
  }
  ctrlClock += dt;
  if (ctrlClock >= 0.1) {
    ctrlClock = 0;
    const a = clamp(activity);
    G.droneGain.gain.rampTo(muted ? 0 : 0.1 + 0.14 * a, 0.25);
    G.droneFilter.frequency.rampTo(200 + 700 * a, 0.25);
    // no floor: with no fire on screen the roar is silent
    const fire = Math.max(0, a - 0.15) / 0.85;
    G.bedGain.gain.rampTo(muted ? 0 : 0.6 * fire * fire, 0.3);
    G.bedFilter.frequency.rampTo(120 + 160 * fire, 0.3);
    // the harmonization interval: audible beating that resolves to unison
    const win = ramp(T.harmonize[0] - 0.015, T.harmonize[0] + 0.01, t) * (1 - ramp(T.harmonize[1] + 0.01, T.harmonize[1] + 0.05, t));
    const k = ramp(T.harmonize[0], T.harmonize[1], t);
    G.beatGain.gain.rampTo(muted ? 0 : 0.1 * win, 0.2);
    G.beatB.frequency.rampTo(220 * (1 + 0.045 * (1 - k)), 0.15);
  }
  // sparse, soft thumps scheduled slightly ahead (late events are what click); only where fire is on screen
  if (!muted && activity > 0.3) {
    popBudget += dt * 5 * (activity - 0.3) * (activity - 0.3);
    if (popBudget > 1) {
      popBudget = -Math.random() * 0.5;
      const v = G.pops[popVoice++ % G.pops.length];
      v.triggerAttackRelease(0.03 + Math.random() * 0.05, Tone.now() + 0.04 + Math.random() * 0.04, 0.25 + Math.random() * 0.5);
    }
  }
}

/** Lens playground: one soft note per month entering the lens (raw above, harmonized below, both mid-range). */
let lastNoteAt = 0;
export function lensNote(raw: number, harm: number) {
  if (!ready || !G || !Tone || muted) return;
  const now = Tone.now();
  if (now - lastNoteAt < 0.12) return; // at most ~8 notes a second, however fast the drag
  lastNoteAt = now;
  const rs = Math.round(clamp(raw) * 9);
  const hs = Math.round(clamp(harm) * 9);
  const at = now + 0.03; // scheduled slightly ahead: late events are what click
  G.lens.triggerAttackRelease(note(rs, 4), 0.09, at, 0.22);
  G.lens.triggerAttackRelease(note(hs, 3), 0.12, at, 0.3);
}


/** Region switch: a short rising arpeggio. */
export function regionChord() {
  if (!ready || !G || !Tone || muted) return;
  const now = Tone.now() + 0.02;
  ["D4", "F#4", "A4", "D5"].forEach((n, i) => G!.bell.triggerAttackRelease(n, "16n", now + i * 0.06, 0.35));
}

/** Turing game: right / wrong. */
export function gameRight() {
  if (!ready || !G || !Tone || muted) return;
  const now = Tone.now() + 0.02;
  ["A4", "D5", "F#5"].forEach((n, i) => G!.bell.triggerAttackRelease(n, "16n", now + i * 0.07, 0.5));
}
export function gameWrong() {
  if (!ready || !G || !Tone || muted) return;
  G.hit.triggerAttackRelease("A1", "8n", Tone.now() + 0.02, 0.5);
}

// ---- v2 acts: cues on the new-act clock u (forward only) ---------------------------
interface CueU {
  u: number;
  fire: () => void;
}
let CUES_U: CueU[] | null = null;
function cuesU(): CueU[] {
  const g = () => G!;
  const now = () => Tone!.now() + 0.02;
  const list: CueU[] = [
    { u: 0.05, fire: () => (g().whooshFilter.frequency.rampTo(900, 0.6), g().whoosh.triggerAttackRelease(1.2, now(), 0.5)) },
    { u: 0.105, fire: () => g().viirs.triggerAttackRelease(["E5", "A5"], "16n", now(), 0.35) },
    { u: 0.145, fire: () => (g().modis.triggerAttackRelease("D3", "16n", now(), 0.7), buzz(8)) },
    { u: 0.24, fire: () => g().pad.triggerAttackRelease(["D3", "A3", "E4"], "2n", now(), 0.5) },
    { u: 0.272, fire: () => (g().hit.triggerAttackRelease("D2", "8n", now(), 0.45), buzz(12)) },
    { u: 0.305, fire: () => (g().whooshFilter.frequency.rampTo(1600, 0.8), g().whoosh.triggerAttackRelease(1.4, now(), 0.5)) },
    { u: 0.345, fire: () => g().modis.triggerAttackRelease(["D2", "G#2"], "8n", now(), 0.45) },
    { u: 0.388, fire: () => g().modis.triggerAttackRelease(["D2", "A2"], "8n", now(), 0.5) },
    { u: 0.43, fire: () => (g().pad.triggerAttackRelease(["D3", "A3", "D4", "F#4"], "2n", now(), 0.7), buzz([6, 40, 6, 40, 12])) },
    { u: 0.472, fire: () => ["D4", "F#4", "A4"].forEach((n, i) => g().bell.triggerAttackRelease(n, "16n", now() + i * 0.12, 0.4)) },
    { u: 0.522, fire: () => g().modis.triggerAttackRelease(["D2", "A2"], "8n", now(), 0.35) },
    { u: 0.575, fire: () => g().bell.triggerAttackRelease(["D5", "A5"], "4n", now(), 0.45) },
    { u: 0.6, fire: () => g().bell.triggerAttackRelease(["A5", "E6"], "8n", now(), 0.3) },
    { u: 0.66, fire: () => g().viirs.triggerAttackRelease(["B5", "E6"], "32n", now(), 0.4) },
    { u: 0.7, fire: () => g().viirs.triggerAttackRelease(["A5", "D6"], "32n", now(), 0.4) },
    { u: 0.742, fire: () => (g().pad.triggerAttackRelease(["D3", "A3", "D4"], "2n", now(), 0.6), buzz([10, 30, 10])) },
  ];
  // the record stacking up: one low note per two year-layers
  for (let i = 0; i < 13; i++) list.push({ u: U_STACK0 + (i / 13) * U_STACK_LEN, fire: () => g().modis.triggerAttackRelease(note(i, 2), "32n", now(), 0.4) });
  return list.sort((a, b) => a.u - b.u);
}
const U_STACK0 = 0.19;
const U_STACK_LEN = 0.04;
export function audioTickU(prevU: number, u: number, active: boolean) {
  if (!ready || !G || !Tone || muted || !active) return;
  if (!CUES_U) CUES_U = cuesU();
  if (!(u > prevU && u - prevU < 0.03)) return;
  for (const c of CUES_U) if (c.u > prevU && c.u <= u) c.fire();
}

/** Pixel-beat counter tick (one per detection). */
export function countTick(i: number, modis: boolean) {
  if (!ready || !G || !Tone || muted) return;
  if (modis) G.modis.triggerAttackRelease("D3", "16n", Tone.now() + 0.01, 0.6);
  else G.viirs.triggerAttackRelease(note(i + 3, 5), "32n", Tone.now() + 0.01, 0.5);
}

export function uiTick() {
  if (!ready || !G || !Tone || muted) return;
  G.bell.triggerAttackRelease("A5", "32n", Tone.now() + 0.01, 0.25);
}

/** The method flow diagram: each step lights up with the next note of a rising scale. */
export function methodNote(i: number) {
  if (!ready || !G || !Tone || muted) return;
  G.bell.triggerAttackRelease(note(i + 2, 4), "16n", Tone.now() + 0.01, 0.32);
  if (i === 7) G.pad.triggerAttackRelease(["D3", "A3", "F#4"], "1n", Tone.now() + 0.05, 0.35);
}
