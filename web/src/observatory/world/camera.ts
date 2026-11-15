// Camera director. Two sources of pose: the globe orbit (spherical coords around the planet) and the area stage
// (a pose supplied every frame by the stage). Switching sources blends from a snapshot of the current pose, and
// globe-to-globe moves are great-circle flights in spherical space, so the camera never cuts through the planet.
import * as THREE from "three";
import { R, latLonToVec, wrapLon } from "../geo";

export interface Pose {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
}

const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export const cam = {
  mode: "globe" as "globe" | "stage",
  lat: 18,
  lon: 70,
  dist: innerWidth < 640 ? R * 4.1 : R * 3.85, // opening view: the whole planet with a margin of space around it
  vLat: 0,
  vLon: 0,
  lastInteract: 0,
  fly: null as null | { t0: number; dur: number; from: { lat: number; lon: number; dist: number }; to: { lat: number; lon: number; dist: number }; bump: number },
  blend: null as null | { t0: number; dur: number; from: Pose },
  stage: { pos: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) } as Pose,
  // user orbit offsets while on the stage
  sAz: 0,
  sEl: 0,
  sZoom: 1,
  reduced: false,
};

export const MIN_DIST = R * 1.22;
export const MAX_DIST = R * 5.2;

/** Great-circle flight of the globe camera. */
export function flyTo(lat: number, lon: number, dist: number, dur = 1.6) {
  const now = performance.now() / 1000;
  const dLon = wrapLon(lon - cam.lon);
  const ang = Math.hypot(dLon * Math.cos((lat * Math.PI) / 180), lat - cam.lat);
  cam.fly = {
    t0: now,
    dur: cam.reduced ? 0.001 : dur,
    from: { lat: cam.lat, lon: cam.lon, dist: cam.dist },
    to: { lat, lon: cam.lon + dLon, dist },
    bump: Math.min(R * 1.4, (ang / 180) * R * 3),
  };
  cam.vLat = cam.vLon = 0;
  cam.lastInteract = now;
}

/** Switch pose source with a blend from the current camera. */
export function setMode(mode: "globe" | "stage", camera: THREE.Camera, dur = 1.5) {
  if (cam.mode === mode) return;
  const up = camera.up.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  // target: keep a sensible distance in front of the camera
  const target = camera.position.clone().add(dir.multiplyScalar(camera.position.length() * 0.6));
  cam.blend = { t0: performance.now() / 1000, dur: cam.reduced ? 0.001 : dur, from: { pos: camera.position.clone(), target, up } };
  cam.mode = mode;
  if (mode === "globe") {
    // continue the orbit from where the camera is now
    const n = camera.position.clone().normalize();
    cam.lat = (Math.asin(n.y) * 180) / Math.PI;
    cam.lon = (Math.atan2(n.x, n.z) * 180) / Math.PI;
    cam.dist = THREE.MathUtils.clamp(camera.position.length(), MIN_DIST, MAX_DIST);
  }
  cam.sAz = cam.sEl = 0;
  cam.sZoom = 1;
}

const tmpPose: Pose = { pos: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };

export function globePose(out: Pose = tmpPose): Pose {
  latLonToVec(cam.lat, cam.lon, cam.dist, out.pos);
  out.target.set(0, 0, 0);
  // close to the surface, look a little ahead toward the horizon
  const close = THREE.MathUtils.clamp((R * 2.2 - cam.dist) / (R * 0.9), 0, 1);
  if (close > 0) {
    const north = latLonToVec(Math.min(89, cam.lat + 25), cam.lon, R * 0.55 * close);
    out.target.add(north);
  }
  out.up.set(0, 1, 0);
  return out;
}

/** Advance the director; writes the pose into the camera. */
export function stepCamera(camera: THREE.PerspectiveCamera, dt: number, idleSpin: boolean) {
  const now = performance.now() / 1000;
  if (cam.fly) {
    const f = cam.fly;
    const k = Math.min(1, (now - f.t0) / f.dur);
    const e = easeInOut(k);
    cam.lat = f.from.lat + (f.to.lat - f.from.lat) * e;
    cam.lon = f.from.lon + (f.to.lon - f.from.lon) * e;
    cam.dist = f.from.dist + (f.to.dist - f.from.dist) * e + f.bump * Math.sin(Math.PI * e);
    if (k >= 1) cam.fly = null;
  } else if (cam.mode === "globe") {
    // inertia, then a slow idle spin
    cam.lon += cam.vLon * dt;
    cam.lat = THREE.MathUtils.clamp(cam.lat + cam.vLat * dt, -75, 80);
    const damp = Math.exp(-dt * 3.2);
    cam.vLon *= damp;
    cam.vLat *= damp;
    if (idleSpin && !cam.reduced && now - cam.lastInteract > 6) cam.lon += dt * 2.2;
  }
  const pose = cam.mode === "globe" ? globePose() : cam.stage;
  let pos = pose.pos, target = pose.target, up = pose.up;
  if (cam.blend) {
    const b = cam.blend;
    const k = Math.min(1, (now - b.t0) / b.dur);
    const e = easeInOut(k);
    pos = b.from.pos.clone().lerp(pose.pos, e);
    // keep the camera outside the planet during the blend
    const minR = R * 1.04;
    if (pos.length() < minR) pos.setLength(minR);
    target = b.from.target.clone().lerp(pose.target, e);
    up = b.from.up.clone().lerp(pose.up, e).normalize();
    if (k >= 1) cam.blend = null;
  }
  camera.position.copy(pos);
  camera.up.copy(up);
  camera.lookAt(target);
}
