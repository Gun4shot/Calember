// CPU twin of the GLSL orbit model (world/shaders.ts ORBIT). Keep them identical.
import * as THREE from "three";

export function orbitPos(t: number, raan: number, incl: number, phase: number, period: number, day: number, out = new THREE.Vector3()) {
  const u = phase + (2 * Math.PI * t) / period;
  const nx = Math.sin(raan), nz = Math.cos(raan);
  const ex = Math.cos(raan), ez = -Math.sin(raan);
  const cu = Math.cos(u), su = Math.sin(u);
  const ci = Math.cos(incl), si = Math.sin(incl);
  const px = cu * nx + su * ci * ex;
  const py = su * si;
  const pz = cu * nz + su * ci * ez;
  const th = (2 * Math.PI * t) / day;
  const c = Math.cos(th), s = Math.sin(th);
  return out.set(px * c - pz * s, py, pz * c + px * s);
}

/** Sun direction in the Earth-fixed frame at sim time t (inertial sun at lon 0), with a seasonal declination. */
export function sunDir(t: number, day: number, monthNum: number, out = new THREE.Vector3()) {
  const th = (2 * Math.PI * t) / day;
  const decl = 23.44 * Math.sin((2 * Math.PI * ((monthNum - 0.5) * 30.4 - 80)) / 365) * (Math.PI / 180);
  const x = 0, z = 1; // lon 0
  const c = Math.cos(th), s = Math.sin(th);
  return out.set((x * c - z * s) * Math.cos(decl), Math.sin(decl), (z * c + x * s) * Math.cos(decl)).normalize();
}
