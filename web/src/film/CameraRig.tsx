// One continuous camera. Keyframes on the playhead, interpolated with non-uniform
// Catmull-Rom (Hermite) splines so velocity stays continuous through every beat.
// Hand-authored instead of Theatre.js: zero runtime weight, and the agent can author it in code.

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { tickPlayhead } from "./clock";
import { ramp, smooth } from "./math";
import { film, useUI } from "./store";
import { EYES, T_HOLD, splitK } from "./timeline";
import { GLOBE_CENTER, NORTH, R, dirOf } from "./world";

interface Key {
  t: number;
  p: THREE.Vector3;
  l: THREE.Vector3; // look-at target
  up: THREE.Vector3;
  fov: number;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
// look-closer dive: into the densest 50 km fire window over Punjab (story_extras.json → globe_dive.focus)
const DIVE_DIR = new THREE.Vector3();
const DIVE_LOOK = new THREE.Vector3();
let diveReady = false;
function diveTarget() {
  if (diveReady) return true;
  const f = useUI.getState().data?.extras.globe_dive.focus;
  if (!f) return false;
  DIVE_DIR.copy(dirOf(f.lat - 0.16, f.lon)); // hover just south of the window, looking a little north
  DIVE_LOOK.copy(dirOf(f.lat, f.lon)).multiplyScalar(R).add(GLOBE_CENTER);
  diveReady = true;
  return true;
}
/** camera distance from the globe centre at the bottom of the dive (≈ 80 km above the ground) */
const DIVE_R = R * 1.0125;
const Y = V(0, 1, 0);
const orbit = (lat: number, lon: number, dist: number) => GLOBE_CENTER.clone().addScaledVector(dirOf(lat, lon), dist);

function buildKeys(aspect: number): Key[] {
  // narrow screens: pull back so the ridge fits
  const wide = Math.min(1, aspect / 1.6);
  const zr = 1 / Math.max(0.55, wide);
  const C = GLOBE_CENTER;
  // look slightly "below" the globe centre so the planet sits above the caption band
  const CL = C.clone().addScaledVector(NORTH, -R * 0.24);
  return [
    { t: 0.0, p: orbit(8, 14, R * 5.6), l: CL, up: NORTH, fov: 34 },
    { t: 0.08, p: orbit(3, 20, R * 4.6), l: CL, up: NORTH, fov: 34 },
    { t: 0.15, p: orbit(4, 30, R * 4.3), l: CL, up: NORTH, fov: 34 },
    { t: 0.205, p: orbit(14, 52, R * 4.0), l: CL, up: NORTH, fov: 34 },
    { t: 0.25, p: orbit(24, 70, R * 3.0), l: CL, up: NORTH, fov: 34 },
    // the descent: distance roughly halves every step (log-like), through the cloud layer
    { t: 0.266, p: orbit(28.5, 74, R * 1.9), l: C, up: NORTH, fov: 36 },
    { t: 0.28, p: V(0, 34, 15), l: V(0, 0, 0), up: Y, fov: 38 },
    { t: 0.292, p: V(0.3, 17, 11.5), l: V(0.4, 0, 1.6), up: Y, fov: 40 },
    { t: 0.305, p: V(0.4, 9.5, 10), l: V(0.5, 0, 1.6), up: Y, fov: 40 },
    { t: 0.325, p: V(0.45, 6.2, 7.8), l: V(0.5, 0, 1.1), up: Y, fov: 40 },
    { t: 0.35, p: V(0.5, 4.6, 5.8), l: V(0.5, 0, 0.95), up: Y, fov: 40 },
    { t: 0.395, p: V(0.6, 4.0, 4.4), l: V(0.55, 0, 0.85), up: Y, fov: 40 },
    { t: 0.425, p: V(-3, 7.5, 14), l: V(-4, -0.5, 0), up: Y, fov: 42 },
    { t: 0.47, p: V(-17.5, 3.8, 7.8 * zr), l: V(-11, -0.6, 0), up: Y, fov: 42 },
    { t: 0.505, p: V(-8.5, 3.2, 7.4 * zr), l: V(-2.5, 0.6, 0), up: Y, fov: 44 },
    { t: 0.54, p: V(-7.5, 1.8, 9.5 * zr), l: V(-1.0, 1.9, -0.5), up: Y, fov: 48 },
    { t: 0.575, p: V(-1, 8.5, 22 * zr), l: V(0, -2.2, -2), up: Y, fov: 42 },
    { t: 0.655, p: V(0.6, 8.0, 22 * zr), l: V(0.3, -2.0, -2), up: Y, fov: 42 },
    { t: 0.7, p: V(0, 1.8, 25 * zr), l: V(0, -1.0, 0), up: Y, fov: 46 },
    { t: 0.745, p: V(0, 1.8, 24.5 * zr), l: V(0, -0.9, 0), up: Y, fov: 46 },
    { t: 0.8, p: V(0, 1.8, 24 * zr), l: V(0, -0.8, 0), up: Y, fov: 46 },
    { t: 0.915, p: V(0.2, 1.9, 24 * zr), l: V(0.1, -0.8, 0), up: Y, fov: 46 },
    { t: 0.955, p: V(0, R * 0.9, R * 1.1), l: V(0, -R * 0.45, 0), up: Y, fov: 38 },
    { t: 1.0, p: orbit(20, 60, R * 4.4), l: CL, up: NORTH, fov: 34 },
  ];
}

/**
 * v2 acts: keys on the new-act clock u. The first and last key are the legacy pose at T_HOLD,
 * so the camera leaves the ridge and comes back to the same spot without a cut.
 * (world positions: data tower x −34, scatter wall z −16 behind the ridge, Turing wall x +34)
 */
function buildKeysU(aspect: number, hold: { p: THREE.Vector3; l: THREE.Vector3; fov: number }): Key[] {
  const wide = Math.min(1, aspect / 1.6);
  const zr = 1 / Math.max(0.55, wide);
  // on narrow screens pull the camera back along its view line
  const K = (t: number, p: THREE.Vector3, l: THREE.Vector3, fov: number): Key => ({ t, p: l.clone().add(p.clone().sub(l).multiplyScalar(zr)), l, up: Y, fov });
  return [
    { t: 0, p: hold.p.clone(), l: hold.l.clone(), up: Y, fov: hold.fov },
    K(0.045, V(-20, 10, 26), V(-34, 9, -4), 46),
    K(0.1, V(-23, 12, 21), V(-34, 9.5, -4), 48),
    K(0.14, V(-24, 9, 18), V(-34, 2.5, -4), 44),
    K(0.185, V(-21, 10, 23), V(-34, 3.2, -4), 44),
    K(0.235, V(-19.6, 10.5, 24), V(-34, 3.8, -4), 44),
    K(0.29, V(-19, 11, 25), V(-34, 3.8, -4), 44),
    // scorecard: frame the scatter (world y 2…15) and the error histogram below it (y ≈ −4…−1)
    K(0.335, V(0.8, 11.4, 13.5), V(0.8, 9.6, -16), 48),
    K(0.405, V(0.2, 11.6, 13), V(0.4, 9.7, -16), 48),
    K(0.452, V(-0.4, 11.4, 12.5), V(0.2, 9.6, -16), 48),
    // showdown: the grouped bar chart (world z −11, y 2…13), centred
    K(0.484, V(0, 8.0, 12), V(0, 6.2, -11), 46),
    K(0.502, V(0.4, 8.0, 11.5), V(0, 6.2, -11), 46),
    // evidence scenes (same stage): a low, slow dolly along the timeline
    K(0.53, V(-1.2, 6.6, 10.5), V(0.2, 5.4, -11), 44),
    K(0.552, V(0.6, 6.8, 11), V(0, 5.6, -11), 44),
    K(0.585, V(1.2, 7.2, 11.5), V(0, 5.8, -11), 44),
    K(0.62, V(28.5, 7.8, 15.5), V(30.5, 7.1, -10), 46),
    K(0.79, V(29.5, 7.6, 15), V(30.5, 7.0, -10), 46),
    K(0.87, V(29.5, 7.6, 15), V(30.5, 7.0, -10), 46),
    K(0.94, V(12, 6, 22), V(2, 0.5, 0), 46),
    { t: 1, p: hold.p.clone(), l: hold.l.clone(), up: Y, fov: hold.fov },
  ];
}

/** Evaluate a key track at x into pos/look/up and return the fov. */
function sample(keys: Key[], x: number, pos: THREE.Vector3, look: THREE.Vector3, up: THREE.Vector3): number {
  let i = 0;
  while (i < keys.length - 2 && x > keys[i + 1].t) i++;
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const s = Math.min(1, Math.max(0, (x - k1.t) / (k2.t - k1.t)));
  hermite(keys, "p", i, s, pos);
  hermite(keys, "l", i, s, look);
  const se = smooth(s);
  up.copy(k1.up).lerp(k2.up, se).normalize();
  return k1.fov + (k2.fov - k1.fov) * se;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Non-uniform Catmull-Rom (Hermite form) on vectors of keys[i].field. */
function hermite(keys: Key[], field: "p" | "l", i: number, s: number, out: THREE.Vector3) {
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(keys.length - 1, i + 2)];
  const dt = k2.t - k1.t;
  // tangents scaled to this segment's duration
  const m1 = tmpA.copy(k2[field]).sub(k0[field]).multiplyScalar(dt / Math.max(1e-6, k2.t - k0.t));
  const m2 = tmpB.copy(k3[field]).sub(k1[field]).multiplyScalar(dt / Math.max(1e-6, k3.t - k1.t));
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  out
    .copy(k1[field])
    .multiplyScalar(h00)
    .addScaledVector(m1, h10)
    .addScaledVector(k2[field], h01)
    .addScaledVector(m2, h11);
  return out;
}

export function CameraRig() {
  const { camera, size, pointer } = useThree();
  const keys = useMemo(() => buildKeys(size.width / size.height), [size.width, size.height]);
  const keysU = useMemo(() => {
    const p = new THREE.Vector3();
    const l = new THREE.Vector3();
    const up0 = new THREE.Vector3();
    const fov = sample(keys, T_HOLD, p, l, up0);
    return buildKeysU(size.width / size.height, { p, l, fov });
  }, [keys, size.width, size.height]);
  const pos = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  const up = useRef(new THREE.Vector3());
  const par = useRef(new THREE.Vector2());

  useFrame((_, dt) => {
    tickPlayhead(Math.min(dt, 0.05));
    const inActs = film.u > 0 && film.u < 1;
    const fov = inActs ? sample(keysU, film.u, pos.current, look.current, up.current) : sample(keys, film.t, pos.current, look.current, up.current);
    // two-eyes: dive from the held orbit to Punjab (the top of the globe) and back out
    if (!inActs && film.sv > 0 && film.sv < 1 && diveTarget()) {
      const k = smooth(ramp(EYES.dive[0], EYES.dive[1], film.sv)) * (1 - smooth(ramp(EYES.out[0], EYES.out[1], film.sv)));
      if (k > 0) {
        // direction slerps on the sphere, distance eases in log space, so the path arcs over the planet
        const d0 = tmpA.copy(pos.current).sub(GLOBE_CENTER);
        const r0 = d0.length();
        d0.normalize();
        const d1 = DIVE_DIR;
        const ang = Math.acos(Math.min(1, Math.max(-1, d0.dot(d1))));
        const axis = tmpB.crossVectors(d0, d1);
        if (axis.lengthSq() > 1e-8) d0.applyAxisAngle(axis.normalize(), ang * k);
        const r = Math.exp(Math.log(r0) + (Math.log(DIVE_R) - Math.log(r0)) * k);
        pos.current.copy(GLOBE_CENTER).addScaledVector(d0, r);
        look.current.lerp(DIVE_LOOK, k);
        up.current.lerp(NORTH, k).normalize();
      }
    }
    const cam = camera as THREE.PerspectiveCamera;
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    // gentle pointer parallax: the scene feels alive even when you stop scrolling
    if (!film.reducedMotion) {
      const kk = 1 - Math.exp(-dt * 2.5);
      par.current.x += (pointer.x - par.current.x) * kk;
      par.current.y += (pointer.y - par.current.y) * kk;
      const dist = pos.current.distanceTo(look.current);
      const amp = Math.min(0.6, dist * 0.018) * (film.lensActive ? 0.25 : 1);
      tmpA.set(1, 0, 0).applyQuaternion(cam.quaternion);
      pos.current.addScaledVector(tmpA, par.current.x * amp);
      pos.current.addScaledVector(up.current, par.current.y * amp * 0.6);
    }
    cam.position.copy(pos.current);
    cam.up.copy(up.current);
    cam.lookAt(look.current);
    // split layout: slide the rendered image so the subject sits right of the text column
    // (on narrow screens, above the captions)
    const k = splitK(film.u, inActs);
    if (k > 0.0005) {
      const wideScreen = size.width >= 760;
      const ox = wideScreen ? -0.21 * size.width * k : 0;
      const oy = wideScreen ? 0 : 0.14 * size.height * k;
      cam.setViewOffset(size.width, size.height, ox, oy, size.width, size.height);
    } else if (cam.view && cam.view.enabled) {
      cam.clearViewOffset();
    }
  });
  return null;
}
