// Shared per-frame stage state (kept out of component files so Fast Refresh and import cycles never duplicate it).
import type { Station } from "../store";

/** Per-station presence 0..1 (eased), read by every station object each frame. */
export const presence: Record<Station, number> = { verdict: 0, terrain: 0, calendar: 0, season: 0, helix: 0, twins: 0, take: 0 };
export const stageClock = { lift: 0, t: 0 };
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__stage = { presence, stageClock };
