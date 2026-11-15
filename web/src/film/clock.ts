// Scroll → playheads. Native scroll (accessible, keyboard works) smoothed by Lenis, then a
// critically damped follower so wheel jitter becomes a smooth camera move.
// v2: the smoothed scroll progress s drives two clocks: the legacy playhead t (acts 1–2, 6–7)
// and the new-act clock u (data & method, scorecard, Turing test). See timeline.ts.

import Lenis from "lenis";
import { film } from "./store";
import { mToS, sToM, sToT, sToU, sToV, tToS, uToS, vToS } from "./timeline";

let lenis: Lenis | null = null;

export function startScroll(): Lenis {
  if (lenis) return lenis;
  film.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  lenis = new Lenis({
    lerp: film.reducedMotion ? 1 : 0.085,
    wheelMultiplier: 0.55, // less sensitive: each wheel notch moves the film ~40 % less
    touchMultiplier: 0.9,
  });
  const read = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    film.target = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  };
  lenis.on("scroll", read);
  window.addEventListener("resize", read);
  const raf = (time: number) => {
    lenis?.raf(time);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  read();
  return lenis;
}

export function stopScroll(lock: boolean) {
  if (!lenis) return;
  if (lock) lenis.stop();
  else lenis.start();
}

/** Scroll to a scroll position s ∈ [0,1] (Skip, chapter ticks, keyboard). */
export function scrollToS(s: number, immediate = false) {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const y = Math.max(0, Math.min(1, s)) * max;
  if (lenis) lenis.scrollTo(y, { immediate, duration: immediate ? 0 : 1.6 });
  else window.scrollTo(0, y);
  if (immediate) {
    film.target = s;
    film.s = s;
    film.t = sToT(s);
    film.u = sToU(s);
    film.sv = sToV(s);
    film.sm = sToM(s);
  }
}
/** Scroll to a legacy playhead position t. */
export const scrollToT = (t: number, immediate = false) => scrollToS(tToS(t), immediate);

if (import.meta.env.DEV) {
  Object.assign(window, {
    __film: film,
    __seek: (t: number) => scrollToT(t, true),
    __seekS: (s: number) => scrollToS(s, true),
    __seekU: (u: number) => scrollToS(uToS(u), true),
    __seekV: (v: number) => scrollToS(vToS(v), true),
    __seekM: (m: number) => scrollToS(mToS(m), true),
  });
}

/** Called once per frame by the canvas: advances the smoothed scroll and both clocks. */
export function tickPlayhead(dt: number) {
  const k = film.reducedMotion ? 1 : 1 - Math.exp(-dt * 5.5);
  const prev = film.s;
  film.s += (film.target - film.s) * k;
  if (Math.abs(film.target - film.s) < 1e-6) film.s = film.target;
  film.t = sToT(film.s);
  film.u = sToU(film.s);
  film.sv = sToV(film.s);
  film.sm = sToM(film.s);
  film.v = dt > 0 ? (film.s - prev) / dt : 0;
}
