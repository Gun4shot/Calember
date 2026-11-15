// BLAKE2b (RFC 7693) for short messages, as 32-bit word pairs. Used for the hotspot det_id, which the API computes as
// int.from_bytes(blake2b(msg, digest_size=8).digest(), "big").

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
const SIGMA = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3, 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6,
  7, 1, 9, 4, 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8, 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13, 2, 12, 6, 10, 0, 11, 8, 3, 4,
  13, 7, 5, 15, 14, 1, 9, 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11, 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10, 6, 15, 14, 9,
  11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5, 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
].map((x) => x * 2);

const v = new Uint32Array(32);
const m = new Uint32Array(32);
const h = new Uint32Array(16);
const block = new Uint8Array(128);

function add64(a: number, b: number) {
  const o0 = v[a] + v[b];
  let o1 = v[a + 1] + v[b + 1];
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}
function add64c(a: number, b0: number, b1: number) {
  const o0 = v[a] + b0;
  let o1 = v[a + 1] + b1;
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}
function G(a: number, b: number, c: number, d: number, ix: number, iy: number) {
  const x0 = m[ix], x1 = m[ix + 1], y0 = m[iy], y1 = m[iy + 1];
  add64(a, b);
  add64c(a, x0, x1);
  let xo0 = v[d] ^ v[a], xo1 = v[d + 1] ^ v[a + 1];
  v[d] = xo1;
  v[d + 1] = xo0;
  add64(c, d);
  xo0 = v[b] ^ v[c];
  xo1 = v[b + 1] ^ v[c + 1];
  v[b] = (xo0 >>> 24) ^ (xo1 << 8);
  v[b + 1] = (xo1 >>> 24) ^ (xo0 << 8);
  add64(a, b);
  add64c(a, y0, y1);
  xo0 = v[d] ^ v[a];
  xo1 = v[d + 1] ^ v[a + 1];
  v[d] = (xo0 >>> 16) ^ (xo1 << 16);
  v[d + 1] = (xo1 >>> 16) ^ (xo0 << 16);
  add64(c, d);
  xo0 = v[b] ^ v[c];
  xo1 = v[b + 1] ^ v[c + 1];
  v[b] = (xo1 >>> 31) ^ (xo0 << 1);
  v[b + 1] = (xo0 >>> 31) ^ (xo1 << 1);
}

/** BLAKE2b with an 8-byte digest of an ASCII message of at most 128 bytes; returns the digest as an unsigned big-endian integer (decimal). */
export function blake2b64(msg: string): string {
  const n = msg.length;
  if (n > 128) throw new Error("message too long");
  h.set(IV);
  h[0] ^= 0x01010000 ^ 8;
  block.fill(0);
  for (let i = 0; i < n; i++) block[i] = msg.charCodeAt(i);
  for (let i = 0; i < 32; i++) m[i] = block[4 * i] ^ (block[4 * i + 1] << 8) ^ (block[4 * i + 2] << 16) ^ (block[4 * i + 3] << 24);
  for (let i = 0; i < 16; i++) {
    v[i] = h[i];
    v[i + 16] = IV[i];
  }
  v[24] ^= n;
  v[28] = ~v[28];
  v[29] = ~v[29];
  for (let i = 0; i < 12; i++) {
    const s = i * 16;
    G(0, 8, 16, 24, SIGMA[s], SIGMA[s + 1]);
    G(2, 10, 18, 26, SIGMA[s + 2], SIGMA[s + 3]);
    G(4, 12, 20, 28, SIGMA[s + 4], SIGMA[s + 5]);
    G(6, 14, 22, 30, SIGMA[s + 6], SIGMA[s + 7]);
    G(0, 10, 20, 30, SIGMA[s + 8], SIGMA[s + 9]);
    G(2, 12, 22, 24, SIGMA[s + 10], SIGMA[s + 11]);
    G(4, 14, 16, 26, SIGMA[s + 12], SIGMA[s + 13]);
    G(6, 8, 18, 28, SIGMA[s + 14], SIGMA[s + 15]);
  }
  // first 8 output bytes = h[0], h[1] little-endian, then read big-endian
  const w0 = (h[0] ^ v[0] ^ v[16]) >>> 0, w1 = (h[1] ^ v[1] ^ v[17]) >>> 0;
  const bytes = [w0 & 255, (w0 >>> 8) & 255, (w0 >>> 16) & 255, w0 >>> 24, w1 & 255, (w1 >>> 8) & 255, (w1 >>> 16) & 255, w1 >>> 24];
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x.toString();
}
