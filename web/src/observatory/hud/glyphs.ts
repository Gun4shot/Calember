import type { Category } from "../../app/types";

/** Redundant, colour-free cue for each anomaly category (Guideline §6.3). */
export const CAT_GLYPH: Record<Category, string> = {
  much_below: "▼▼",
  below: "▼",
  normal: "●",
  above: "▲",
  much_above: "▲▲",
  record: "★",
};

export const CAT_HEX: Record<Category, string> = {
  much_below: "#3b6fd6",
  below: "#7fa9dc",
  normal: "#8a8f99",
  above: "#f6a35f",
  much_above: "#f0602c",
  record: "#ffe58a",
};

export const ordinal = (n: number) => {
  const v = Math.round(n);
  const s = ["th", "st", "nd", "rd"];
  const k = v % 100;
  return `${v}${s[(k - 20) % 10] || s[k] || s[0]}`;
};

/** Numbers for small areas: one decimal below 10 (so 0.4 is not shown as "0"), whole numbers above. */
export const fmtS = (v: number | null | undefined) =>
  v === null || v === undefined ? "–" : Math.abs(v) < 10 && Math.abs(v % 1) > 0.05 ? v.toFixed(1) : Math.round(v).toLocaleString("en-US");
