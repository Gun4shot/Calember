import type { Category, Regime } from "./types";

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const nf0 = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export const fmt = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "–" : digits === 0 ? nf0.format(v) : nf1.format(v));
export const fmtPct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)} %`);
export const monthLabel = (m: string) => `${MONTHS_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export const REGIME_LABEL: Record<Regime, string> = {
  T: "Terra only, scaled to Terra + Aqua",
  M: "MODIS Terra + Aqua (observed)",
  B: "MODIS blended with the VIIRS bridge",
  V: "VIIRS translated to MODIS-equivalent",
  N: "NOAA-20 near-real-time (provisional)",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  much_below: "much below normal",
  below: "below normal",
  normal: "normal",
  above: "above normal",
  much_above: "much above normal",
  record: "record high",
};

// Diverging, colour-vision-deficiency safe (blue-grey-orange-red), tuned for a dark background.
export const CATEGORY_COLOR: Record<Category, string> = {
  much_below: "#2f6db3",
  below: "#6aa3d6",
  normal: "#3b4048",
  above: "#f0a35e",
  much_above: "#e0582f",
  record: "#ffe066",
};
export const CATEGORY_ORDER: Category[] = ["much_below", "below", "normal", "above", "much_above", "record"];
