// Sonification of the calendar (F21): one note per month, pitch = log(hotspots) on a pentatonic scale, silence = no fire,
// a soft tick at each new year. Starts only on a user click (browsers require it).
import type { CalendarMonth } from "../types";

const SCALE = [0, 2, 4, 7, 9]; // major pentatonic
let stopFn: (() => void) | null = null;

export async function playCalendar(months: CalendarMonth[], onStep: (i: number) => void, onEnd: () => void, speed = 2.44): Promise<void> {
  stopCalendar();
  const Tone = await import("tone");
  await Tone.start();
  const synth = new Tone.Synth({ oscillator: { type: "triangle" }, envelope: { attack: 0.005, decay: 0.08, sustain: 0.2, release: 0.12 } }).toDestination();
  synth.volume.value = -10;
  const tick = new Tone.MembraneSynth({ volume: -24 }).toDestination();
  const vmax = Math.log1p(Math.max(1, ...months.map((m) => m.h_count)));
  const step = 0.11 / Math.max(0.2, speed); // speed 1 ≈ 34 s for 26 years; the classic view keeps its 14 s default
  const t0 = Tone.now() + 0.1;
  months.forEach((m, i) => {
    const t = t0 + i * step;
    if (m.month.endsWith("-01")) tick.triggerAttackRelease("C2", 0.03, t);
    if (m.h_count >= 1) {
      const level = Math.log1p(m.h_count) / vmax; // 0..1
      const k = Math.round(level * 14); // 3 octaves of pentatonic steps
      const midi = 52 + 12 * Math.floor(k / 5) + SCALE[k % 5];
      synth.triggerAttackRelease(Tone.Frequency(midi, "midi").toFrequency(), step * 0.9, t);
    }
  });
  let i = 0;
  const timer = window.setInterval(() => {
    onStep(i++);
    if (i >= months.length) finish();
  }, step * 1000);
  const finish = () => {
    window.clearInterval(timer);
    synth.dispose();
    tick.dispose();
    stopFn = null;
    onEnd();
  };
  stopFn = () => {
    Tone.getTransport().cancel();
    synth.triggerRelease();
    finish();
  };
}

export function stopCalendar() {
  stopFn?.();
}
