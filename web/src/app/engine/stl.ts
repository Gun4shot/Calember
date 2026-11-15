// Binary STL of a fire calendar (main.py _stl_calendar): base plate + one bar per month, newest year at the front.
export function stl(values: Map<string, number>, title: string): ArrayBuffer {
  const cell = 6, gap = 1, base = 3;
  const years = [...new Set([...values.keys()].map((m) => +m.slice(0, 4)))].sort((a, b) => b - a);
  const vmax = Math.max(1, ...values.values());
  const tris: number[][][] = [];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const [a, b, c] of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]) tris.push([v[a], v[b], v[c]]);
  };
  box(0, 0, 0, 12 * (cell + gap) + gap, years.length * (cell + gap) + gap, base);
  years.forEach((y, ri) => {
    for (let k = 0; k < 12; k++) {
      const v = values.get(`${y}-${String(k + 1).padStart(2, "0")}`) ?? 0;
      const h = v > 0 ? 2 + (28 * Math.log1p(v)) / Math.log1p(vmax) : 0.6;
      const x0 = gap + k * (cell + gap), y0 = gap + ri * (cell + gap);
      box(x0, y0, base, x0 + cell, y0 + cell, base + h);
    }
  });
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const head = `Calember fire calendar: ${title}`.slice(0, 79);
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < head.length ? head.charCodeAt(i) & 0x7f : 32);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0];
    const ln = Math.hypot(nx, ny, nz) || 1;
    for (const x of [nx / ln, ny / ln, nz / ln, ...a, ...b, ...c]) (dv.setFloat32(o, x, true), (o += 4));
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
