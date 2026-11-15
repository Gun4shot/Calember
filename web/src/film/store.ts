import { create } from "zustand";
import type { StoryData } from "./data";

/**
 * Per-frame values live in this plain mutable object (read inside useFrame / rAF),
 * so scrolling never triggers React re-renders.
 */
export const film = {
  /** raw scroll progress 0..1 */
  target: 0,
  /** smoothed scroll progress 0..1 */
  s: 0,
  /** legacy playhead 0..1 (acts 1–2 and 6–7 render from it; holds during the new acts) */
  t: 0,
  /** new-act clock 0..1 (data & method, scorecard, Turing test) */
  u: 0,
  /** two-eyes interlude clock 0..1 (the real MODIS vs VIIRS day on the globe) */
  sv: 0,
  /** method flow-diagram clock 0..1 (holds u at 0.3, between the data act and the scorecard) */
  sm: 0,
  /** playhead velocity, for sound/motion accents */
  v: 0,
  /** lens position along the ridge in months (fractional index), -1 = hidden */
  lensMonth: -1,
  lensActive: false,
  /** the viewer has taken the lens (only then does it make sound: the idle sweep stays silent) */
  lensUser: false,
  /** lens speed 0..1 (for the whoosh) */
  lensSpeed: 0,
  /** displayed region index on the ridge (fractional during cross-fades) */
  region: 0,
  reducedMotion: false,
};

interface UIState {
  data: StoryData | null;
  error: string | null;
  started: boolean;
  sound: boolean;
  regionIdx: number;
  setData: (d: StoryData) => void;
  setError: (e: string) => void;
  start: (sound: boolean) => void;
  toggleSound: () => void;
  setRegion: (i: number) => void;
}

export const useUI = create<UIState>((set) => ({
  data: null,
  error: null,
  started: false,
  sound: false,
  regionIdx: 0,
  setData: (data) => set({ data, regionIdx: data.derived.heroIndex }),
  setError: (error) => set({ error }),
  start: (sound) => set({ started: true, sound }),
  toggleSound: () => set((s) => ({ sound: !s.sound })),
  setRegion: (regionIdx) => set({ regionIdx }),
}));
