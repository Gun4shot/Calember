// Reader for the "CAL2" binary tiles (pipeline/build_region_tiles.py, pipeline/build_hotspot_parts.py):
// gzip of  "CAL2" | u32 header length | header JSON | pad to 4 | columns (each n values, padded to 4 bytes).

type Typed = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array;
export interface Cal2<H = Record<string, unknown>> {
  header: H & { n: number; cols: [string, string][] };
  col: Record<string, Typed>;
}

const CTORS: Record<string, { new (b: ArrayBuffer, o: number, n: number): Typed; BYTES_PER_ELEMENT: number }> = {
  u1: Uint8Array,
  u2: Uint16Array,
  u4: Uint32Array,
  i4: Int32Array,
  f4: Float32Array,
};

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf);
  // a host may already have removed the gzip layer (Content-Encoding); only decompress real gzip data
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export function parseCal2<H>(buf: ArrayBuffer): Cal2<H> {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "CAL2") throw new Error("Not a Calember tile.");
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))) as Cal2<H>["header"];
  let off = 8 + hl;
  off += (4 - (off % 4)) % 4;
  const col: Record<string, Typed> = {};
  for (const [name, t] of header.cols) {
    const C = CTORS[t];
    if (!C) throw new Error(`Unknown column type ${t}`);
    col[name] = new C(buf, off, header.n);
    const bytes = header.n * C.BYTES_PER_ELEMENT;
    off += bytes + ((4 - (bytes % 4)) % 4);
  }
  return { header, col };
}

/** Fetch and parse a tile; null when the host has no such file (a region without data). Retries transient failures. */
export async function fetchCal2<H>(url: string, tries = 3): Promise<Cal2<H> | null> {
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return parseCal2<H>(await gunzip(await r.arrayBuffer()));
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 400 * (i + 1) ** 2));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Run `fn` over items with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
