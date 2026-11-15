// Calember Observatory sound design: synthesized with the Web Audio API (no audio files, no downloads).
// Everything is silent until the user turns sound on (top bar ♪); the first click creates the AudioContext.
// Vocabulary: a low ambient pad (night orbit), soft UI ticks, a lock-on chime when a place is targeted,
// a whoosh + deep "thunk" when the place is lifted out of the planet, a pentatonic rise when a station builds,
// a rising icy sweep when the raw 2012 cliff towers up and a falling sweep + thud when it collapses.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let wet: GainNode | null = null;
let pad: { stop: () => void } | null = null;
let enabled = false;

/** The viewer's sound choice, shared with the story. Sound is on by default; only an explicit "off" turns it off. */
export function soundPref(): boolean {
  try {
    return localStorage.getItem("calember.sound") !== "0";
  } catch {
    return true;
  }
}
export function saveSoundPref(on: boolean) {
  try {
    localStorage.setItem("calember.sound", on ? "1" : "0");
  } catch {
    /* storage is optional */
  }
}
// Browsers only start audio after a gesture: when sound was switched on before one (the choice carried over
// from the story), the first click, tap or key press wakes the context up.
if (typeof window !== "undefined") {
  const wake = () => {
    if (ctx && ctx.state === "suspended") void ctx.resume();
  };
  for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, wake, { capture: true, passive: true });
  // every button, link and switch in the HUD answers with a soft tick (the big moments have their own sounds)
  window.addEventListener(
    "click",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.("button, a, [role=radio], [role=option], summary");
      if (el && el.closest(".obs") && !el.hasAttribute("data-nosfx")) sfx.tick();
    },
    { capture: true, passive: true },
  );
}

const PENTA = [0, 2, 4, 7, 9];
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

function ensure(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    master.connect(comp).connect(ctx.destination);
    // a generated "space" reverb: decaying stereo noise impulse
    const len = ctx.sampleRate * 2.6;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    wet = ctx.createGain();
    wet.gain.value = 0.32;
    wet.connect(conv).connect(master);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function out(node: AudioNode, reverb = 0.5) {
  if (!master || !wet || !ctx) return;
  node.connect(master);
  if (reverb > 0) {
    const g = ctx.createGain();
    g.gain.value = reverb;
    node.connect(g).connect(wet);
  }
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; at?: number; glideTo?: number; reverb?: number; attack?: number } = {}) {
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + (opts.at ?? 0);
  const o = c.createOscillator();
  o.type = opts.type ?? "sine";
  o.frequency.setValueAtTime(freq, t);
  if (opts.glideTo) o.frequency.exponentialRampToValueAtTime(opts.glideTo, t + dur);
  const g = c.createGain();
  const a = opts.attack ?? 0.006;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(opts.gain ?? 0.15, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  out(g, opts.reverb ?? 0.4);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(dur: number, opts: { from: number; to: number; q?: number; gain?: number; at?: number; reverb?: number }) {
  const c = ensure();
  if (!c) return;
  const t = c.currentTime + (opts.at ?? 0);
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = opts.q ?? 1.2;
  f.frequency.setValueAtTime(opts.from, t);
  f.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(opts.gain ?? 0.2, t + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g);
  out(g, opts.reverb ?? 0.5);
  src.start(t);
}

function startPad() {
  const c = ensure();
  if (!c || pad) return;
  const g = c.createGain();
  g.gain.value = 0;
  g.gain.linearRampToValueAtTime(0.05, c.currentTime + 3);
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420;
  const lfo = c.createOscillator();
  const lfoG = c.createGain();
  lfo.frequency.value = 0.05;
  lfoG.gain.value = 180;
  lfo.connect(lfoG).connect(lp.frequency);
  const oscs = [hz(38), hz(45), hz(50), hz(57.03)].map((f, i) => {
    const o = c.createOscillator();
    o.type = i % 2 ? "triangle" : "sine";
    o.frequency.value = f;
    o.detune.value = (i - 1.5) * 6;
    o.connect(lp);
    o.start();
    return o;
  });
  lp.connect(g);
  out(g, 0.8);
  lfo.start();
  pad = {
    stop: () => {
      const t = c.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.8);
      window.setTimeout(() => {
        oscs.forEach((o) => o.stop());
        lfo.stop();
      }, 900);
    },
  };
}

export const sfx = {
  setEnabled(on: boolean) {
    enabled = on;
    if (on) {
      ensure();
      startPad();
      tone(hz(81), 0.5, { gain: 0.08, type: "triangle" });
      tone(hz(88), 0.6, { gain: 0.07, type: "triangle", at: 0.09 });
    } else {
      pad?.stop();
      pad = null;
    }
  },
  /** soft UI tick (buttons, toggles) */
  tick() {
    tone(2100, 0.05, { gain: 0.045, reverb: 0.15 });
  },
  /** a new year passes while the timeline plays: a soft, high chime */
  year() {
    tone(hz(93), 0.18, { gain: 0.03, type: "triangle", reverb: 0.6 });
  },
  /** barely-there hover */
  hover() {
    tone(1500, 0.03, { gain: 0.018, reverb: 0 });
  },
  /** palette open / search result change */
  blip(up = true) {
    tone(up ? 880 : 660, 0.08, { gain: 0.05, type: "triangle", glideTo: up ? 1100 : 520 });
  },
  /** a place is targeted on the globe */
  lock() {
    tone(hz(76), 0.35, { gain: 0.08, type: "triangle" });
    tone(hz(83), 0.5, { gain: 0.07, type: "triangle", at: 0.08 });
    noise(0.25, { from: 4000, to: 9000, gain: 0.03, q: 4 });
  },
  /** the place is lifted out of the planet (acquisition sequence, ≈3 s) */
  acquire(nSats: number) {
    noise(1.5, { from: 180, to: 2400, gain: 0.16, q: 0.8 }); // whoosh of the camera flight
    for (let i = 0; i < Math.min(5, nSats); i++) tone(hz(84 + PENTA[i] ), 0.5, { gain: 0.05, at: 0.35 + i * 0.12, reverb: 0.8 }); // every satellite looks
    tone(62, 1.1, { gain: 0.32, at: 1.25, glideTo: 34, attack: 0.01, reverb: 0.3 }); // the lift: a deep thunk
    noise(0.6, { from: 900, to: 140, gain: 0.08, at: 1.25 });
    tone(hz(69), 1.4, { gain: 0.05, type: "triangle", at: 2.1, reverb: 1 }); // the stage settles
    tone(hz(76), 1.4, { gain: 0.04, type: "triangle", at: 2.25, reverb: 1 });
  },
  /** a station builds itself: pentatonic rise */
  station(i: number) {
    const base = 69 + (i % 3) * 2;
    for (let k = 0; k < 4; k++) tone(hz(base + PENTA[k] + (k > 2 ? 12 : 0)), 0.42, { gain: 0.045, at: k * 0.07, type: "triangle", reverb: 0.7 });
    noise(0.5, { from: 600, to: 3000, gain: 0.03 });
  },
  /** raw sensors: the 2012 cliff towers up (icy, rising) / collapses back (falling + thud) */
  cliff(up: boolean) {
    if (up) {
      tone(220, 1.0, { type: "sawtooth", gain: 0.035, glideTo: 880, attack: 0.05, reverb: 0.7 });
      tone(hz(88), 0.9, { gain: 0.05, at: 0.35, reverb: 1 });
      noise(1.0, { from: 2000, to: 9000, gain: 0.05, q: 2 });
    } else {
      tone(700, 0.8, { type: "sawtooth", gain: 0.03, glideTo: 140, reverb: 0.5 });
      tone(70, 0.6, { gain: 0.25, at: 0.45, glideTo: 40 });
      noise(0.5, { from: 800, to: 120, gain: 0.07, at: 0.45 });
    }
  },
  /** count ⇄ vs normal, flatten */
  sweep() {
    noise(0.6, { from: 500, to: 5000, gain: 0.05, q: 2.5 });
  },
  /** satellite card */
  satellite(modis: boolean) {
    tone(modis ? hz(79) : hz(86), 0.6, { gain: 0.06, type: "sine", reverb: 1 });
    tone(modis ? hz(86) : hz(93), 0.6, { gain: 0.04, at: 0.1, reverb: 1 });
  },
  /** arcs launch to the twins */
  twins(n: number) {
    for (let i = 0; i < n; i++) {
      noise(0.9, { from: 300, to: 3000, gain: 0.03, at: 0.3 + i * 0.28 });
      tone(hz(81 + PENTA[i % 5]), 0.6, { gain: 0.05, at: 1.5 + i * 0.28, reverb: 1 });
    }
  },
  /** the globe unrolls into the flat map: a dive, a sweep of rising partials and a soft landing */
  unroll() {
    noise(0.8, { from: 300, to: 3200, gain: 0.12, q: 0.9 });
    tone(110, 2.2, { type: "sawtooth", gain: 0.03, glideTo: 440, attack: 0.3, reverb: 0.8, at: 0.3 });
    for (let k = 0; k < 6; k++) tone(hz(74 + PENTA[k % 5] + (k > 4 ? 12 : 0)), 0.5, { gain: 0.04, type: "triangle", at: 0.6 + k * 0.22, reverb: 0.9 });
    noise(1.2, { from: 6000, to: 1200, gain: 0.04, q: 3, at: 1.2 });
    tone(hz(57), 1.6, { gain: 0.12, at: 2.2, reverb: 1 });
  },
  /** the map rolls back up into the globe */
  rollup() {
    tone(440, 1.4, { type: "sawtooth", gain: 0.03, glideTo: 110, reverb: 0.8 });
    for (let k = 5; k >= 0; k--) tone(hz(74 + PENTA[k % 5]), 0.4, { gain: 0.035, type: "triangle", at: (5 - k) * 0.15, reverb: 0.9 });
    noise(1.0, { from: 3000, to: 250, gain: 0.1, at: 0.9 });
  },
  /** two places meet (compare): an amber note and an ice note glide toward each other, then settle together */
  compare() {
    noise(0.9, { from: 400, to: 3600, gain: 0.06, q: 1.2 });
    tone(hz(67), 0.9, { gain: 0.05, type: "triangle", glideTo: hz(69), reverb: 0.8, at: 0.25 });
    tone(hz(88), 0.9, { gain: 0.03, type: "sine", glideTo: hz(81), reverb: 0.9, at: 0.25 });
    tone(hz(74), 1.3, { gain: 0.04, type: "triangle", at: 1.4, reverb: 1 });
    tone(hz(81), 1.3, { gain: 0.025, type: "sine", at: 1.48, reverb: 1 });
  },
  /** leaving the area: reverse whoosh */
  close() {
    noise(1.0, { from: 2400, to: 200, gain: 0.1 });
  },
};

if (typeof window !== "undefined") {
  // play a tick on any button press while sound is on (keeps UI feedback consistent everywhere)
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!enabled) return;
      const el = (e.target as HTMLElement | null)?.closest("button, a, [role=radio], [role=option]");
      if (el) sfx.tick();
    },
    true,
  );
}
