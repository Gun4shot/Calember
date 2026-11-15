// Sound for the fire intro, synthesized with the Web Audio API (no audio files).
// Everything is scheduled on the intro's own clock, so sound switched on halfway through (browsers block audio until
// the first click or key press) joins in sync: past one-shots are skipped and the beds start at their current level.
//
//   0.2  ignition thump        the ember catches
//   →    fire bed + crackles   grows with the flame, density follows its height
//   2.2  rising whoosh         the flame climbs
//   4.9  the flare             a deep boom, a burst of air, a high shimmer
//   →    space pad             open fifths in the dark while the Earth pulls back; the fire becomes distant
//   6.0  satellite pings       "Satellites have watched them…"
//   8.6  the pad sinks         "…going dark"
//   SHOW burn-away whoosh      everything fades as the story appears

export type IntroTimes = { flash: number; show: number; burn: number; lines: number[] };

type Pt = [number, number]; // [intro seconds, value]

/** Piecewise-linear value of an envelope at intro time t. */
function at(pts: Pt[], t: number): number {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i];
    const [t0, v0] = pts[i - 1];
    if (t <= t1) return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-6, t1 - t0);
  }
  return pts[pts.length - 1][1];
}

export class IntroSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private started = false;
  private crackleTimer = 0;
  private offset = 0; // ctx.currentTime - intro time
  private ended = false;
  muted = false;

  constructor(private readonly times: IntroTimes, private readonly clock: () => number) {}

  /** Creates the context (it may stay suspended until a user gesture). */
  init(): boolean {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    } catch {
      return false;
    }
    // start the moment the browser lets audio run (at once where autoplay is allowed, else after the first gesture)
    this.ctx.onstatechange = () => {
      if (this.ctx?.state === "running" && !this.started && !this.muted && !this.ended) {
        this.start();
        if (this.started) this.onStart?.();
      }
    };
    void this.ctx.resume().catch(() => undefined);
    return true;
  }

  /** Called when the score starts by itself. */
  onStart: (() => void) | null = null;

  get running(): boolean {
    return !!this.ctx && this.ctx.state === "running" && !this.muted;
  }

  /** Call from a user gesture: resumes the context and starts the score at the current intro time. */
  async unlock(): Promise<boolean> {
    if (!this.ctx) return false;
    this.muted = false;
    try {
      await this.ctx.resume();
    } catch {
      return false;
    }
    if (this.ctx.state !== "running") return false;
    if (!this.started) this.start();
    else if (this.master) this.master.gain.setTargetAtTime(0.9, this.ctx.currentTime, 0.15);
    return true;
  }

  mute() {
    this.muted = true;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  }

  /** Starts the score if the context is already allowed to run (no gesture needed on some browsers). */
  tryAutostart(): boolean {
    if (this.ctx && this.ctx.state === "running" && !this.started && !this.muted) {
      this.start();
      return true;
    }
    return false;
  }

  private start() {
    if (this.ended || this.started) return; // skipped before the sound was allowed, or already playing
    const ctx = this.ctx!;
    this.started = true;
    const T = this.times;
    const now = this.clock();
    this.offset = ctx.currentTime + 0.03 - now;
    const ct = (t: number) => t + this.offset; // intro time → context time

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.12);
    this.master.connect(comp);

    // a little room: two feedback delays, lowpassed, for space without a reverb file
    const room = ctx.createGain();
    room.gain.value = 0.32;
    for (const [dt, fb] of [
      [0.137, 0.42],
      [0.211, 0.38],
    ] as const) {
      const d = ctx.createDelay(1);
      d.delayTime.value = dt;
      const g = ctx.createGain();
      g.gain.value = fb;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 2400;
      room.connect(d);
      d.connect(lp);
      lp.connect(g);
      g.connect(d);
      lp.connect(this.master);
    }

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;

    const env = (p: AudioParam, pts: Pt[]) => {
      p.cancelScheduledValues(ctx.currentTime);
      p.setValueAtTime(at(pts, now), ctx.currentTime);
      for (const [t, v] of pts) if (t > now) p.linearRampToValueAtTime(v, ct(t));
    };
    const loopNoise = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.loopStart = Math.random();
      s.start(ctx.currentTime, Math.random() * 1.5);
      return s;
    };
    const end = T.show + T.burn + 0.6;

    // ---- the fire bed: a low roar and a mid hiss, following the flame (loud at the flare, distant on the planet)
    const roarPts: Pt[] = [[0, 0], [0.4, 0.05], [2.2, 0.1], [T.flash - 0.1, 0.55], [T.flash + 0.6, 0.3], [T.flash + 3, 0.08], [T.show, 0.06], [end, 0]];
    const roar = loopNoise();
    const roarLp = ctx.createBiquadFilter();
    roarLp.type = "lowpass";
    roarLp.frequency.value = 260;
    const roarG = ctx.createGain();
    roar.connect(roarLp).connect(roarG).connect(this.master);
    env(roarG.gain, roarPts);
    const hiss = loopNoise();
    const hissBp = ctx.createBiquadFilter();
    hissBp.type = "bandpass";
    hissBp.Q.value = 0.7;
    env(hissBp.frequency, [[0, 700], [T.flash, 1900], [T.flash + 3, 900]]);
    const hissG = ctx.createGain();
    hiss.connect(hissBp).connect(hissG).connect(this.master);
    env(hissG.gain, [[0, 0], [0.5, 0.012], [2.2, 0.03], [T.flash - 0.1, 0.16], [T.flash + 1.5, 0.03], [T.show, 0.015], [end, 0]]);
    roar.stop(ct(end) + 0.1);
    hiss.stop(ct(end) + 0.1);

    // ---- crackles: short pops scheduled a little ahead; their rate follows the flame
    const rate: Pt[] = [[0, 1], [0.5, 3], [2.2, 6], [T.flash, 26], [T.flash + 1.5, 7], [T.show, 3], [end, 0]];
    let next = Math.max(0.15, now);
    const pump = () => {
      if (this.ended || !this.ctx) return;
      const horizon = this.clock() + 0.25;
      while (next < horizon && next < end) {
        if (next > this.clock() - 0.02) this.crackle(ct(next), at(roarPts, next));
        const r = Math.max(0.5, at(rate, next));
        next += (-Math.log(1 - Math.random()) / r) * 0.9 + 0.012;
      }
      if (next < end) this.crackleTimer = window.setTimeout(pump, 60);
    };
    pump();

    // ---- one-shots (skipped when already in the past)
    const once = (t: number, fn: (when: number) => void) => {
      if (t >= now - 0.05) fn(Math.max(ctx.currentTime, ct(t)));
    };
    once(0.2, (w) => this.thump(w, 62, 34, 0.5, 0.9));
    once(2.2, (w) => this.sweep(w, T.flash - 2.2, 260, 2600, 0.22, "bandpass"));
    once(T.flash, (w) => {
      this.thump(w, 96, 26, 1.0, 2.8);
      this.burst(w, 1400, 0.55, 1.4);
      for (const [f, g] of [
        [1760, 0.05],
        [2637, 0.035],
        [3520, 0.02],
      ] as const)
        this.tone(w + 0.02, f, g, 0.01, 2.6, "sine", room);
    });
    // space pad: open fifths that swell as the planet appears and sink for "going dark"
    once(Math.max(T.flash + 0.1, now), (w) => {
      const pad = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 0.4;
      env(lp.frequency, [[T.flash, 500], [T.flash + 2.5, 1600], [T.lines[3], 1500], [T.lines[3] + 1.6, 380]]);
      pad.connect(lp);
      lp.connect(this.master!);
      lp.connect(room);
      env(pad.gain, [[T.flash, 0], [T.flash + 2.4, 0.075], [T.lines[3], 0.07], [T.show + 0.4, 0.05], [end, 0]]);
      const notes = [55, 82.41, 110, 164.81, 220];
      notes.forEach((f, i) => {
        for (const det of [-5, 5]) {
          const o = ctx.createOscillator();
          o.type = i < 2 ? "sawtooth" : "triangle";
          o.frequency.value = f;
          o.detune.value = det + (i === 4 ? 2 : 0);
          // the last two notes sink a semitone for "going dark"
          if (i >= 3) env(o.detune, [[T.lines[3], det], [T.lines[3] + 1.8, det - 100]]);
          const g = ctx.createGain();
          g.gain.value = i < 2 ? 0.16 : 0.22;
          o.connect(g).connect(pad);
          o.start(w);
          o.stop(ct(end) + 0.2);
        }
      });
    });
    // a soft low note under each line of text
    T.lines.forEach((t, i) => once(t, (w) => this.tone(w, [110, 130.81, 146.83, 98][i] ?? 110, 0.08, 0.04, 1.6, "sine", room)));
    // satellites: two faint pings for "Satellites have watched them…"
    once(T.lines[2] + 0.35, (w) => {
      this.tone(w, 1318.5, 0.045, 0.004, 0.18, "sine", room);
      this.tone(w + 0.42, 1318.5, 0.035, 0.004, 0.18, "sine", room);
      this.tone(w + 1.5, 1567.98, 0.03, 0.004, 0.18, "sine", room);
    });
    once(T.show, (w) => this.sweep(w, T.burn, 300, 7000, 0.3, "highpass"));
  }

  /** Skip: the burn-away whoosh now, and fade out. */
  skip(burn: number) {
    this.ended = true; // a score that has not started yet never will
    if (!this.ctx || !this.master || !this.started) return;
    const ctx = this.ctx;
    const w = ctx.currentTime;
    this.sweep(w, burn, 400, 7000, 0.32, "highpass");
    this.master.gain.cancelScheduledValues(w);
    this.master.gain.setValueAtTime(this.master.gain.value, w);
    this.master.gain.linearRampToValueAtTime(0.9, w + 0.05);
    this.master.gain.linearRampToValueAtTime(0, w + burn + 0.4);
    this.ended = true;
    window.clearTimeout(this.crackleTimer);
  }

  /** Releases the audio context a little after the end. */
  dispose() {
    this.ended = true;
    window.clearTimeout(this.crackleTimer);
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.master) this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    window.setTimeout(() => void ctx.close().catch(() => undefined), 1500);
  }

  // ---- voices
  private crackle(when: number, level: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = Math.random() < 0.7 ? "highpass" : "bandpass";
    hp.frequency.value = 1200 + Math.random() * 4200;
    const g = ctx.createGain();
    const dur = 0.004 + Math.random() * (Math.random() < 0.15 ? 0.05 : 0.016);
    const peak = (0.05 + Math.random() * 0.22) * (0.35 + level * 1.6);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 0.9;
    s.connect(hp).connect(g).connect(pan).connect(this.master!);
    s.start(when, Math.random() * 1.8, dur + 0.02);
  }

  private thump(when: number, f0: number, f1: number, gain: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f1, when + dur * 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    o.connect(g).connect(this.master!);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  private burst(when: number, cutoff: number, gain: number, dur: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(cutoff * 3, when);
    lp.frequency.exponentialRampToValueAtTime(cutoff * 0.25, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    s.connect(lp).connect(g).connect(this.master!);
    s.start(when, 0, dur + 0.05);
  }

  private sweep(when: number, dur: number, f0: number, f1: number, gain: number, type: BiquadFilterType) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = type === "bandpass" ? 1.4 : 0.7;
    f.frequency.setValueAtTime(f0, when);
    f.frequency.exponentialRampToValueAtTime(f1, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, when + dur + 0.25);
    s.connect(f).connect(g).connect(this.master!);
    s.start(when);
    s.stop(when + dur + 0.3);
  }

  private tone(when: number, f: number, gain: number, attack: number, dur: number, type: OscillatorType, send?: AudioNode) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    o.connect(g);
    g.connect(this.master!);
    if (send) g.connect(send);
    o.start(when);
    o.stop(when + dur + 0.05);
  }
}
