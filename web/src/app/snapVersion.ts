// Data files are cached for a day; each deploy stamps their URLs with its own version (VITE_SNAP_V, set by
// scripts/deploy.sh), so a browser never mixes in a file cached from an older deploy.
const V = (import.meta.env.VITE_SNAP_V as string | undefined) ?? "";
export const withVersion = (url: string) => (V ? `${url}${url.includes("?") ? "&" : "?"}v=${V}` : url);
