// Derived views of the API calendar used by several stations (all numbers come from /calendar).
import type { Calendar, CalendarMonth } from "../../app/types";

export const rawTotal = (m: CalendarMonth) => m.raw.modis + m.raw.snpp + m.raw.noaa20 + m.raw.noaa21;

export interface Grid {
  years: number[];
  cells: Array<{ m: CalendarMonth; row: number; col: number }>;
  byMonth: Map<string, { m: CalendarMonth; row: number; col: number; i: number }>;
  vmaxH: number;
  vmaxR: number;
}

const cache = new WeakMap<Calendar, Grid>();
export function gridOf(cal: Calendar): Grid {
  const hit = cache.get(cal);
  if (hit) return hit;
  const years = [...new Set(cal.months.map((m) => Number(m.month.slice(0, 4))))].sort((a, b) => a - b);
  const cells: Grid["cells"] = [];
  const byMonth: Grid["byMonth"] = new Map();
  let vmaxH = 1, vmaxR = 1;
  for (const m of cal.months) {
    const row = years.indexOf(Number(m.month.slice(0, 4)));
    const col = Number(m.month.slice(5, 7)) - 1;
    byMonth.set(m.month, { m, row, col, i: cells.length });
    cells.push({ m, row, col });
    vmaxH = Math.max(vmaxH, m.h_count);
    vmaxR = Math.max(vmaxR, rawTotal(m));
  }
  const g = { years, cells, byMonth, vmaxH, vmaxR };
  cache.set(cal, g);
  return g;
}

/** The latest month with a "vs normal" answer (the verdict's default; may be provisional, and is labelled so). */
export function latestJudged(cal: Calendar): CalendarMonth | null {
  return [...cal.months].reverse().find((m) => m.category !== null && m.median_m !== null) ?? null;
}

/** The same calendar month in every year (for the line-up). */
export function sameMonth(cal: Calendar, month: string) {
  const mm = month.slice(5, 7);
  return cal.months.filter((m) => m.month.slice(5, 7) === mm);
}
