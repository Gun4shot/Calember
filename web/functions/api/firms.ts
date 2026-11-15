// Cloudflare Pages Function: GET /api/firms?bbox=west,south,east,north
// Live VIIRS near-real-time detections (NOAA-20 and NOAA-21, last 7 days) from the NASA FIRMS area API, for the
// Observatory's "right now" answer. The MAP_KEY stays a server-side secret (Pages project setting FIRMS_MAP_KEY).
// The response is the FIRMS CSVs passed through with a "#source=<product>" line before each one; the browser parses
// and filters them (this function does no per-row work, so it stays within the free plan's CPU budget).
// Cached at the edge for 15 minutes per bounding box.

interface Env {
  FIRMS_MAP_KEY: string;
}

const FIRMS = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"];

export const onRequestGet = async (ctx: { request: Request; env: Env; waitUntil: (p: Promise<unknown>) => void }) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const nums = (url.searchParams.get("bbox") ?? "").split(",").map(Number);
  if (nums.length !== 4 || nums.some((v) => !Number.isFinite(v))) return new Response("bbox=west,south,east,north required", { status: 400 });
  if (!env.FIRMS_MAP_KEY) return new Response("FIRMS_MAP_KEY is not configured", { status: 503 });
  // a small margin, clamped to the globe, rounded so nearby requests share the cache
  const [w, s, e, n] = [Math.max(-180, nums[0] - 0.1), Math.max(-90, nums[1] - 0.1), Math.min(180, nums[2] + 0.1), Math.min(90, nums[3] + 0.1)].map((v) => v.toFixed(2));
  const cacheKey = new Request(`${url.origin}/api/firms?bbox=${w},${s},${e},${n}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // the area API serves at most 5 days per call: the last 7 days as two dated chunks
  const day = (k: number) => new Date(Date.now() - k * 864e5).toISOString().slice(0, 10);
  const chunks: [string, number][] = [
    [day(6), 5],
    [day(1), 2],
  ];
  const parts = await Promise.all(
    SOURCES.flatMap((src) =>
      chunks.map(async ([start, span]) => {
        try {
          const r = await fetch(`${FIRMS}/${env.FIRMS_MAP_KEY}/${src}/${w},${s},${e},${n}/${span}/${start}`);
          const t = (await r.text()).trimStart();
          return r.ok && t.startsWith("latitude") ? `#source=${src}\n${t}` : "";
        } catch {
          return "";
        }
      }),
    ),
  );
  const body = parts.filter(Boolean).join("\n");
  const res = new Response(body, {
    status: body ? 200 : 502,
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "public, max-age=900", "access-control-allow-origin": "*" },
  });
  if (body) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
};
