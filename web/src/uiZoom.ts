// The Observatory and the classic view render their interface at 90 % on desktop screens (app.html / classic.html set
// `html { zoom: 0.9 }`); the 3D canvas and the maps are drawn at full scale (`--unzoom`) so picking stays exact.
// Mouse positions (clientX/Y) are screen pixels: divide by this before using them as CSS lengths.
export const uiZoom = (): number => {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom || "1");
  return Number.isFinite(z) && z > 0 ? z : 1;
};
