// "The method in one picture": a 3D flow diagram that holds between the data act and the scorecard (clock m).
// Eight glass steps light up in order as you scroll; VIIRS (ice blue) flows through every step, MODIS (amber) runs
// alongside through cleaning and gridding and then arcs into "learn" as the answer key for the overlap years. The last
// step draws the finished record. Deliberately high level: what goes in, what is held out, what comes out (the model's
// full method is in the README and harmonization/). Every number comes from results.json / the ridge.
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { methodNote } from "./audio";
import type { StoryData } from "./data";
import { fmt, ramp } from "./math";
import { film } from "./store";

/** Visible height (world units) at the diagram's depth: the distance follows the camera's field of view, so the
 *  layout is the same size on screen whatever lens the camera rig is using at that moment. */
const VH = 7.34;
const distFor = (fovDeg: number) => VH / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)));

/** How much the method diagram is on screen (0..1); other scenes step back by this much. */
export function methodPresence() {
  const m = film.sm;
  return m > 0 && m < 1 ? ramp(0, 0.05, m) * (1 - ramp(0.95, 1, m)) : 0;
}

type Kind = "both" | "viirs" | "learn" | "test" | "record";
const COLOR: Record<Kind, string> = { both: "#dfe6f5", viirs: "#7fd8ff", learn: "#ffd08a", test: "#8ef0c0", record: "#ffa64d" };
const ICE = new THREE.Color("#7fd8ff");
const AMBER = new THREE.Color("#ffb347");

interface Step {
  title: string;
  line1: string;
  line2?: string;
  kind: Kind;
}

/** When each step lights up (clock m). */
const ON = (i: number) => 0.09 + i * 0.066;

// ---- glass card: a rounded rectangle with a glowing rim and a scan line that sweeps once when it lights ----
const CARD_VS = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const CARD_FS = /* glsl */ `
  uniform vec3 uC; uniform float uA; uniform float uOn; uniform float uScan; uniform vec2 uSize; uniform float uBack;
  varying vec2 vUv;
  float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    vec2 p = (vUv - 0.5) * uSize;
    float d = sdRound(p, uSize * 0.5 - 0.03, 0.1);
    if (d > 0.03) discard;
    float fill = smoothstep(0.004, -0.008, d);
    if (uBack > 0.5) { gl_FragColor = vec4(uC * 0.05 * uOn, fill * 0.9 * uA); return; } // the card's dark "thickness"
    float rim = smoothstep(0.026, 0.0, abs(d + 0.013));
    float sx = vUv.x - (uScan * 1.4 - 0.2);
    float scan = (1.0 - step(0.999, uScan)) * step(0.001, uScan) * exp(-sx * sx * 120.0);
    vec3 base = vec3(0.03, 0.045, 0.085) + uC * (0.05 + 0.1 * (1.0 - vUv.y)) * uOn;
    vec3 c = base * fill + uC * rim * (0.28 + 1.5 * uOn) + uC * scan * 1.2 * fill;
    gl_FragColor = vec4(c, max(fill * 0.9, rim) * uA);
  }
`;

// ---- pipes: tubes that grow along the path, with light pulses travelling through them ----
const PIPE_VS = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const PIPE_FS = /* glsl */ `
  uniform vec3 uC; uniform float uProg; uniform float uTime; uniform float uA; uniform float uLen;
  varying vec2 vUv;
  void main() {
    if (vUv.x > uProg) discard;
    float dash = pow(max(0.5 + 0.5 * sin((vUv.x * uLen * 1.4 - uTime * 1.8) * 6.2831), 0.0), 6.0);
    float head = smoothstep(0.035, 0.0, uProg - vUv.x) * (1.0 - step(0.999, uProg));
    float core = 0.45 + 0.55 * pow(abs(sin(vUv.y * 3.14159)), 0.6);
    vec3 c = uC * (0.32 + 0.9 * dash + 2.4 * head) * core;
    gl_FragColor = vec4(c, uA * (0.5 + 0.5 * dash));
  }
`;

// ---- particles riding the pipes ----
const DOT_VS = /* glsl */ `
  attribute float aA; attribute vec3 aC;
  uniform float uPx;
  varying float vA; varying vec3 vC;
  void main() {
    vA = aA; vC = aC;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uPx * 0.11 / -mv.z * 100.0;
    gl_Position = projectionMatrix * mv;
  }
`;
const DOT_FS = /* glsl */ `
  uniform float uA;
  varying float vA; varying vec3 vC;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.25, 0.0, dot(d, d)) * vA * uA;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vC * 1.6, a);
  }
`;

function cardMat(color: string, back = false) {
  return new THREE.ShaderMaterial({
    vertexShader: CARD_VS,
    fragmentShader: CARD_FS,
    uniforms: { uC: { value: new THREE.Color(color) }, uA: { value: 0 }, uOn: { value: 0 }, uScan: { value: 0 }, uSize: { value: new THREE.Vector2(1, 1) }, uBack: { value: back ? 1 : 0 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}
function pipeMat(c: THREE.Color, len: number) {
  return new THREE.ShaderMaterial({
    vertexShader: PIPE_VS,
    fragmentShader: PIPE_FS,
    uniforms: { uC: { value: c.clone() }, uProg: { value: 0 }, uTime: { value: 0 }, uA: { value: 0 }, uLen: { value: len } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Piecewise-linear map of x through (xs → ys). */
function pw(x: number, xs: number[], ys: number[]) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + ((x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1)) * (ys[i] - ys[i - 1]);
  return ys[ys.length - 1];
}

const N_MAIN = 120;
const N_KEY = 40;

export function MethodFlow({ data }: { data: StoryData }) {
  const D = data.results.data;
  const hero = data.ridge.regions[data.derived.heroIndex];
  const size = useThree((s) => s.size);
  const outer = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  const scrim = useRef<THREE.Mesh>(null);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const keyTag = useRef<HTMLDivElement>(null);
  const spark = useRef<SVGPathElement>(null);
  const lastLit = useRef(-1);
  const bodyFlag = useRef("");

  const steps: Step[] = useMemo(
    () => [
      { title: "Five satellites", line1: `${(D.raw_rows_total / 1e6).toFixed(0)} M detections · NASA FIRMS`, kind: "both" },
      { title: "Clean", line1: `${fmt(D.mask_cells)} fixed flares and volcanoes out`, kind: "both" },
      { title: "One grid", line1: `${fmt(D.r5_land_cells)} hexagons of ≈ ${D.r5_cell_km2} km², monthly`, kind: "both" },
      { title: "Describe", line1: "VIIRS in each cell, its neighbours, its past", kind: "viirs" },
      { title: "Learn", line1: `${D.train_years}, while both sensors flew`, kind: "learn" },
      { title: "Translate", line1: "VIIRS → MODIS-equivalent, with a 90 % range", kind: "viirs" },
      { title: "Prove", line1: `${D.folds} unseen region folds + a sealed 2020`, kind: "test" },
      { title: "One record", line1: `${(D.product_rows / 1e6).toFixed(1)} M cell-months`, kind: "record" },
    ],
    [D],
  );

  // layout: a snake of 4 × 2 on wide screens (right of the caption column), 2 × 4 on narrow ones (above the caption)
  const L = useMemo(() => {
    const aspect = size.width / Math.max(1, size.height);
    const vh = VH;
    const vw = vh * aspect;
    const wide = size.width >= 760;
    const cols = wide ? 4 : 2;
    const rows = 8 / cols;
    const cw = 1.98, ch = wide ? 1.42 : 1.26;
    const sx = cw + (wide ? 0.34 : 0.22), sy = ch + (wide ? 0.62 : 0.26);
    const spanW = (cols - 1) * sx + cw, spanH = (rows - 1) * sy + ch;
    let cx: number, cy: number, k: number;
    if (wide) {
      // right of the caption column and clear of its dark gradient
      const left = -vw / 2 + vw * 0.455, right = vw / 2 - vw * 0.025;
      k = Math.min(1.08, ((right - left) * 0.94) / spanW, (vh * 0.6) / spanH);
      // the camera rig already slides the image 21 % of the width to the right in the split layout (CameraRig)
      cx = (left + right) / 2 - 0.21 * vw;
      cy = vh * 0.035;
    } else {
      // between the header (top 15 %) and the caption (from about 62 % down); the rig lifts the image 14 % here
      k = Math.min(1, (vw * 0.94) / spanW, (vh * 0.46) / spanH);
      cx = 0;
      cy = vh / 2 - vh * 0.155 - (spanH * k) / 2 - 0.14 * vh;
    }
    const pos: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) {
      const r = Math.floor(i / cols);
      const c0 = i % cols;
      const c = r % 2 === 0 ? c0 : cols - 1 - c0;
      pos.push(new THREE.Vector3(-((cols - 1) * sx) / 2 + c * sx, ((rows - 1) * sy) / 2 - r * sy, 0));
    }
    return { pos, cw, ch, k, cx, cy, px: (size.height / vh) * k, wide };
  }, [size]);

  // geometry: the VIIRS path through every step, the MODIS lane through the first three and its arc into "learn"
  const G = useMemo(() => {
    const z = -0.05;
    const lane = (p: THREE.Vector3, dy: number) => new THREE.Vector3(p.x, p.y + dy, z);
    const main = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < 7; i++) main.add(new THREE.LineCurve3(lane(L.pos[i], i < 3 ? 0.13 : 0), lane(L.pos[i + 1], i + 1 < 3 ? 0.13 : 0)));
    const key = new THREE.CurvePath<THREE.Vector3>();
    key.add(new THREE.LineCurve3(lane(L.pos[0], -0.13), lane(L.pos[1], -0.13)));
    key.add(new THREE.LineCurve3(lane(L.pos[1], -0.13), lane(L.pos[2], -0.13)));
    const a = lane(L.pos[2], -0.13), b = lane(L.pos[4], -0.13);
    const mid = a.clone().lerp(b, 0.5);
    key.add(new THREE.CubicBezierCurve3(a, a.clone().lerp(mid, 0.6).add(new THREE.Vector3(0, 0, 0.9)), b.clone().lerp(mid, 0.6).add(new THREE.Vector3(0, 0, 0.9)), b));
    const mainLen = main.getLength(), keyLen = key.getLength();
    // arc-length fraction at each step, so the pipe's head reaches a card exactly when it lights
    const lens = main.getCurveLengths();
    const fr = [0, ...lens.map((l) => l / mainLen)];
    const keyLens = key.getCurveLengths();
    const kfr = [0, ...keyLens.map((l) => l / keyLen)];
    const tube = (c: THREE.Curve<THREE.Vector3>, segs: number) => new THREE.TubeGeometry(c, segs, 0.034, 8, false);
    return {
      main,
      key,
      fr,
      kfr,
      mainGeo: tube(main, 420),
      keyGeo: tube(key, 260),
      mainMat: pipeMat(ICE, mainLen),
      keyMat: pipeMat(AMBER, keyLen),
      keyMid: key.getPointAt(0.82).clone().add(new THREE.Vector3(0, 0.32, 0)),
    };
  }, [L]);

  const cards = useMemo(
    () =>
      steps.map((s) => {
        const face = cardMat(COLOR[s.kind]);
        const back = cardMat(COLOR[s.kind], true);
        face.uniforms.uSize.value.set(L.cw, L.ch);
        back.uniforms.uSize.value.set(L.cw, L.ch);
        return { face, back };
      }),
    [steps, L],
  );

  const dots = useMemo(() => {
    const n = N_MAIN + N_KEY;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(n), 1));
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) (i < N_MAIN ? ICE : AMBER).toArray(col, i * 3);
    geo.setAttribute("aC", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: DOT_VS,
      fragmentShader: DOT_FS,
      uniforms: { uPx: { value: 1 }, uA: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const seeds = Float32Array.from({ length: n }, (_, i) => (i * 0.6180339887) % 1);
    return { geo, mat, seeds };
  }, []);

  // the finished record, drawn on the last card
  const sparkD = useMemo(() => {
    const v = hero.product ?? hero.harmonized;
    const mx = Math.max(1, ...v);
    return v.map((x, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * 100).toFixed(2)},${(22 - (x / mx) * 20).toFixed(2)}`).join("");
  }, [hero]);

  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame((st) => {
    const m = film.sm;
    const p = methodPresence();
    const vis = p > 0.002;
    if (outer.current) {
      outer.current.visible = vis;
      outer.current.position.copy(st.camera.position);
      outer.current.quaternion.copy(st.camera.quaternion);
    }
    const flag = vis ? "1" : "0";
    if (flag !== bodyFlag.current) {
      bodyFlag.current = flag;
      document.body.dataset.method = flag;
    }
    if (!vis) {
      labels.current.forEach((el) => el && (el.style.opacity = "0"));
      if (keyTag.current) keyTag.current.style.opacity = "0";
      if (m <= 0) lastLit.current = -1;
      return;
    }
    const now = st.clock.elapsedTime;
    if (inner.current) {
      inner.current.position.set(L.cx, L.cy, -distFor((st.camera as THREE.PerspectiveCamera).fov ?? 34));
      const s = L.k * (0.94 + 0.06 * p);
      inner.current.scale.setScalar(s);
      // slow parallax: the diagram turns a little as it builds, so the layers read as depth
      inner.current.rotation.set(-0.06 + 0.04 * m, (L.wide ? 0.2 : 0.1) - 0.3 * m * (L.wide ? 1 : 0.5), 0);
      inner.current.position.y += Math.sin(now * 0.6) * 0.03;
    }
    if (scrim.current) (scrim.current.material as THREE.MeshBasicMaterial).opacity = 0.84 * p;

    // steps
    let lit = -1;
    steps.forEach((_, i) => {
      const on = ramp(ON(i), ON(i) + 0.03, m);
      if (m >= ON(i)) lit = i;
      const c = cards[i];
      c.face.uniforms.uA.value = p * (0.35 + 0.65 * ramp(ON(i) - 0.05, ON(i), m));
      c.back.uniforms.uA.value = c.face.uniforms.uA.value;
      c.face.uniforms.uOn.value = on;
      c.back.uniforms.uOn.value = on;
      c.face.uniforms.uScan.value = ramp(ON(i), ON(i) + 0.045, m);
      const el = labels.current[i];
      if (el) {
        el.style.opacity = (p * (0.28 + 0.72 * on)).toFixed(3);
        el.style.transform = `translateY(${((1 - on) * 6).toFixed(1)}px)`;
      }
    });
    if (lit > lastLit.current && lastLit.current >= -1 && lit >= 0 && st.clock.elapsedTime > 0) {
      for (let i = lastLit.current + 1; i <= lit; i++) if (lit - lastLit.current <= 2) methodNote(i);
    }
    lastLit.current = lit;

    // pipes: the head reaches step i+1 when it lights
    const xs = steps.map((_, i) => ON(i));
    const prog = pw(m, xs, G.fr);
    G.mainMat.uniforms.uProg.value = prog;
    G.mainMat.uniforms.uTime.value = now;
    G.mainMat.uniforms.uA.value = p;
    const kprog = pw(m, [ON(0), ON(1), ON(2), ON(4)], G.kfr);
    G.keyMat.uniforms.uProg.value = kprog;
    G.keyMat.uniforms.uTime.value = now;
    G.keyMat.uniforms.uA.value = p;
    if (keyTag.current) keyTag.current.style.opacity = (p * ramp(ON(4) - 0.02, ON(4) + 0.03, m)).toFixed(3);

    // particles travel the revealed part of each path
    const pos = dots.geo.attributes.position as THREE.BufferAttribute;
    const aA = dots.geo.attributes.aA as THREE.BufferAttribute;
    for (let i = 0; i < N_MAIN + N_KEY; i++) {
      const isKey = i >= N_MAIN;
      const pr = isKey ? kprog : prog;
      const f = (dots.seeds[i] + now * (isKey ? 0.07 : 0.045)) % 1;
      const ff = f * Math.max(0.0001, pr);
      (isKey ? G.key : G.main).getPointAt(Math.min(0.9999, ff), tmp);
      pos.setXYZ(i, tmp.x, tmp.y, tmp.z + 0.02);
      aA.setX(i, pr > 0.002 ? 0.35 + 0.65 * Math.sin(Math.PI * f) : 0);
    }
    pos.needsUpdate = true;
    aA.needsUpdate = true;
    dots.mat.uniforms.uA.value = p;
    dots.mat.uniforms.uPx.value = st.size.height / 760;

    // the last card draws the record
    if (spark.current) spark.current.style.strokeDashoffset = (100 * (1 - ramp(ON(7) + 0.02, ON(7) + 0.2, m))).toFixed(2);
  });

  const w = Math.round(L.cw * L.px - 18);
  const h = Math.round(L.ch * L.px - 14);
  return (
    <group ref={outer} visible={false}>
      {/* the scene behind steps back */}
      <mesh ref={scrim} position={[0, 0, -30]} renderOrder={50}>
        <planeGeometry args={[120, 80]} />
        <meshBasicMaterial color="#04060b" transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
      <group ref={inner}>
        <mesh geometry={G.mainGeo} material={G.mainMat} renderOrder={60} />
        <mesh geometry={G.keyGeo} material={G.keyMat} renderOrder={60} />
        <points geometry={dots.geo} material={dots.mat} renderOrder={61} frustumCulled={false} />
        {steps.map((s, i) => (
          <group key={s.title} position={L.pos[i]}>
            <mesh position={[0.07, -0.08, -0.12]} material={cards[i].back} renderOrder={62}>
              <planeGeometry args={[L.cw, L.ch]} />
            </mesh>
            <mesh material={cards[i].face} renderOrder={63}>
              <planeGeometry args={[L.cw, L.ch]} />
            </mesh>
            <Html center zIndexRange={[5, 1]} style={{ pointerEvents: "none" }}>
              <div ref={(el) => (labels.current[i] = el)} className={`mf-node mf-${s.kind}`} style={{ width: w, height: h, opacity: 0 }}>
                <span className="mf-i">{String(i + 1).padStart(2, "0")}</span>
                <b className="mf-t">{s.title}</b>
                <span className="mf-l">{s.line1}</span>
                {s.kind === "record" ? (
                  <svg className="mf-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
                    <path ref={spark} d={sparkD} pathLength={100} />
                  </svg>
                ) : (
                  s.line2 && <span className="mf-l2">{s.line2}</span>
                )}
              </div>
            </Html>
          </group>
        ))}
        <Html position={G.keyMid} center zIndexRange={[5, 1]} style={{ pointerEvents: "none" }}>
          <div ref={keyTag} className="mf-tag" style={{ opacity: 0 }}>
            MODIS {D.train_years} · the answer key
          </div>
        </Html>
      </group>
    </group>
  );
}
