// Act I/II and the ending: a night Earth made of land dots, with one glowing hex column
// per H3 r3 fire cell. Heights come from the real monthly files (harmonized or raw).

import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { StoryData } from "./data";
import { HASH, INFERNO } from "./glsl";
import { clamp, latLonToVec, ramp } from "./math";
import { film } from "./store";
import { EYES, T, globeMonthS } from "./timeline";
import { GLOBE_CENTER, GLOBE_Q, R } from "./world";

/** Real-Earth swipe mask shared by every globe layer (one globe in the scene). */
const MASK_U = { uLo: { value: -999 }, uHi: { value: -999 }, uViewLon: { value: 0 } };

export function globeVisibility(t: number) {
  return clamp(1 - ramp(0.278, 0.298, t) + ramp(0.918, 0.95, t));
}
/** 0 = harmonized, 1 = raw sensors summed */
export function rawMixAt(t: number) {
  return ramp(T.rawOn[0], T.rawOn[1], t) * (1 - ramp(0.91, 0.925, t));
}

const COLUMN_VS = /* glsl */ `
  attribute float aH0; attribute float aH1; attribute float aR0; attribute float aR1; attribute float aSeed;
  uniform float uFrac; uniform float uRaw; uniform float uAlpha; uniform float uTime; uniform float uShrink;
  varying float vV; varying float vTop; varying float vRaw;

  uniform float uLo; uniform float uHi; uniform float uViewLon;
  float dLon(vec3 dir) { return mod(degrees(atan(dir.x, dir.z)) - uViewLon + 540.0, 360.0) - 180.0; }
  float realMask(vec3 dir) { float d = dLon(dir); return smoothstep(uLo - 0.6, uLo + 0.6, d) * smoothstep(uHi + 0.6, uHi - 0.6, d); }

  void main() {
    float h = mix(aH0, aH1, uFrac);
    float r = mix(aR0, aR1, uFrac);
    float v = mix(h, r, uRaw);
    vV = v; vRaw = uRaw * clamp((r - h) * 3.0, 0.0, 1.0);
    float height = pow(max(v, 0.0), 1.8) * ${(R * 0.16).toFixed(2)} * uShrink + 0.001;
    vec3 p = position;
    vTop = p.y; // geometry spans y ∈ [0,1]
    p.y *= height;
    p.xz *= mix(0.35, 1.0, smoothstep(0.0, 0.25, v));
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    if (v < 0.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // cull empty cells
    if (realMask(normalize(instanceMatrix[3].xyz)) > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // real Earth here
  }
`;
const COLUMN_FS = /* glsl */ `
  ${INFERNO}
  uniform float uAlpha;
  varying float vV; varying float vTop; varying float vRaw;
  void main() {
    vec3 c = inferno(0.42 + 0.56 * vV);
    c = mix(c, vec3(0.62, 0.8, 1.0) * 0.9, vRaw * 0.35); // excess from VIIRS reads icy-white
    c *= 0.35 + 1.25 * vTop;  // glowing tops
    c *= 0.6 + 1.3 * vV * vV;
    gl_FragColor = vec4(c, uAlpha);
  }
`;

const SPHERE_VS = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec3 vLocal;
  void main() {
    vLocal = normalize(position);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const SPHERE_FS = /* glsl */ `
  uniform float uAlpha; uniform sampler2D uNight; uniform float uHasTex;
  varying vec3 vN; varying vec3 vV; varying vec3 vLocal;
  void main() {
    float f = pow(clamp(1.0 - max(dot(vN, vV), 0.0), 0.0, 1.0), 3.0);
    vec3 c = vec3(0.012, 0.018, 0.035) + vec3(0.08, 0.16, 0.32) * f;
    if (uHasTex > 0.5) {
      // equirectangular lookup from the local direction (same convention as latLonToVec)
      float lon = atan(vLocal.x, vLocal.z);
      float lat = asin(clamp(vLocal.y, -1.0, 1.0));
      vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.1415927 + 0.5);
      vec3 tx = texture2D(uNight, uv).rgb;
      float lum = dot(tx, vec3(0.299, 0.587, 0.114));
      vec3 land = tx * vec3(0.35, 0.45, 0.7) * 0.55;                 // dark blue land/sea relief
      vec3 lights = vec3(0.62, 0.72, 0.92) * smoothstep(0.25, 0.9, lum) * 0.55; // cities: cool, not fire
      c += land + lights;
    }
    gl_FragColor = vec4(c, uAlpha);
  }
`;
// v3.2 "two eyes": one real day (22 Aug 2019) of Aqua MODIS and of S-NPP VIIRS wrapped on the globe
// (NASA Worldview snapshots, equirectangular 4096×2048). MODIS's gaps between orbits are tinted dark red
// ("never seen"); fire layers glow; a scan line sweeps VIIRS across the visible hemisphere.
const EYES_FS = /* glsl */ `
  uniform sampler2D uTcM; uniform sampler2D uTcV; uniform sampler2D uPM; uniform sampler2D uPV;
  uniform float uImg; uniform float uSweep; uniform float uSweepW; uniform float uEdge; uniform float uFocus;
  uniform float uGapHi; uniform float uTime;
  varying vec3 vN; varying vec3 vV; varying vec3 vLocal;

  uniform float uLo; uniform float uHi; uniform float uViewLon;
  float dLon(vec3 dir) { return mod(degrees(atan(dir.x, dir.z)) - uViewLon + 540.0, 360.0) - 180.0; }
  float realMask(vec3 dir) { float d = dLon(dir); return smoothstep(uLo - 0.6, uLo + 0.6, d) * smoothstep(uHi + 0.6, uHi - 0.6, d); }

  // Worldview close-ups of Punjab (EPSG:4326): lat 26.6–33.6, lon 72.8–78.7
  const vec4 PB = vec4(26.6, 72.8, 33.6, 78.7);
  void main() {
    float lonR = atan(vLocal.x, vLocal.z);
    float latR = asin(clamp(vLocal.y, -1.0, 1.0));
    float lat = degrees(latR); float lon = degrees(lonR);
    vec2 uv = vec2(lonR / 6.2831853 + 0.5, latR / 3.1415927 + 0.5);
    float d = dLon(vLocal);
    // MODIS → VIIRS sweep, scaled to what is on screen (whole hemisphere far away, a few degrees in the dive)
    float b = uSweep >= 0.999 ? 999.0 : mix(-uSweepW, uSweepW, uSweep);
    float isV = smoothstep(b + uSweepW * 0.012, b - uSweepW * 0.012, d);
    vec3 m = texture2D(uTcM, uv).rgb;
    vec3 v = texture2D(uTcV, uv).rgb;
    // the close-ups replace the 10 km global pixels inside their box
    vec2 pv = vec2((lon - PB.y) / (PB.w - PB.y), (lat - PB.x) / (PB.z - PB.x));
    float inP = smoothstep(0.0, 0.03, pv.x) * smoothstep(1.0, 0.97, pv.x) * smoothstep(0.0, 0.03, pv.y) * smoothstep(1.0, 0.97, pv.y);
    if (inP > 0.0) {
      m = mix(m, texture2D(uPM, pv).rgb, inP);
      v = mix(v, texture2D(uPV, pv).rgb, inP);
    }
    // MODIS's gaps between orbits (not the polar night) read as "never seen"
    float gap = (1.0 - smoothstep(0.012, 0.045, dot(m, vec3(0.333)))) * step(abs(lat), 62.0);
    float hatch = step(0.5, fract((vLocal.x * 0.7 + vLocal.y) * 120.0));
    m = mix(m, vec3(0.05, 0.06, 0.08) + vec3(0.05, 0.06, 0.08) * hatch, gap); // no data: neutral dark hatch, not fire-red
    // "look closer": the gaps are marked as no-data on purpose, with a slow ice-blue hatch that drifts and breathes
    float flow = step(0.55, fract((vLocal.x * 0.7 + vLocal.y) * 60.0 - uTime * 0.5));
    float breathe = 0.7 + 0.3 * sin(uTime * 2.4);
    m = mix(m, vec3(0.34, 0.58, 0.92) * (0.3 + 0.7 * flow), gap * uGapHi * 0.6 * breathe);
    vec3 c = mix(m, v, isV) * 0.62;
    // in the dive, the blurry 10 km global pixels around the sharp close-up step back
    c *= mix(1.0, 0.45 + 0.55 * inP, uFocus);
    float ndv = max(dot(vN, vV), 0.0);
    c *= 0.3 + 0.8 * pow(max(ndv, 0.0), 0.55);
    // glowing scan lines at the swipe edges and the sweep
    float edge = exp(-pow(abs((d - uHi) / 1.1), 2.0)) + exp(-pow(abs((d - uLo) / 1.1), 2.0));
    float line = exp(-pow(abs((d - b) / max(0.06, uSweepW * 0.01)), 2.0)) * step(0.002, uSweep) * step(uSweep, 0.998);
    c += vec3(0.55, 0.82, 1.0) * (edge * uEdge + line) * 2.2;
    float a = realMask(vLocal) * uImg;
    a = max(a, edge * uEdge * uImg * 0.9);
    gl_FragColor = vec4(c, a);
  }
`;

// real detections of the dive day, drawn as squares at their true pixel size (MODIS orange, VIIRS red)
const PTS_VS = /* glsl */ `
  attribute float aKm; attribute float aKind; attribute float aSeed;
  uniform float uFocal; uniform float uSweep; uniform float uSweepW; uniform float uModis; uniform float uViirs;
  varying float vA; varying float vKind;

  uniform float uLo; uniform float uHi; uniform float uViewLon;
  float dLon(vec3 dir) { return mod(degrees(atan(dir.x, dir.z)) - uViewLon + 540.0, 360.0) - 180.0; }
  float realMask(vec3 dir) { float d = dLon(dir); return smoothstep(uLo - 0.6, uLo + 0.6, d) * smoothstep(uHi + 0.6, uHi - 0.6, d); }

  void main() {
    vec3 dir = normalize(position);
    float d = dLon(dir);
    float b = uSweep >= 0.999 ? 999.0 : mix(-uSweepW, uSweepW, uSweep);
    float isV = smoothstep(b + uSweepW * 0.012, b - uSweepW * 0.012, d);
    float pop = aKind < 0.5 ? clamp(uModis * 1.6 - aSeed * 0.6, 0.0, 1.0) : clamp(uViirs * 1.6 - aSeed * 0.6, 0.0, 1.0);
    vA = (aKind < 0.5 ? 1.0 - isV : isV) * pop * realMask(dir);
    vKind = aKind;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aKm * ${(R / 6371).toFixed(6)} * uFocal / -mv.z, 2.0, 64.0) * (1.0 + 0.8 * (1.0 - pop));
    gl_Position = projectionMatrix * mv;
    if (vA < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const PTS_FS = /* glsl */ `
  uniform float uA;
  varying float vA; varying float vKind;
  void main() {
    vec2 q = abs(gl_PointCoord - 0.5);
    float edge = smoothstep(0.5, 0.36, max(q.x, q.y));
    vec3 c = vKind < 0.5 ? vec3(1.0, 0.5, 0.1) : vec3(1.0, 0.18, 0.14);
    gl_FragColor = vec4(c * (0.75 + 0.35 * edge), vA * uA * (0.7 + 0.3 * edge));
  }
`;

const ATMO_FS = /* glsl */ `
  uniform float uAlpha;
  varying vec3 vN; varying vec3 vV;
  void main() {
    // back faces of a shell at 1.06 R: d = 0 at the shell's edge, ≈ -0.33 at the planet's limb
    float d = dot(vN, vV);
    float f = smoothstep(0.0, -0.33, d);
    f = f * f;
    gl_FragColor = vec4(vec3(0.22, 0.45, 0.95) * f * 0.75, f * uAlpha);
  }
`;
const DOTS_VS = /* glsl */ `
  uniform float uPx;
  varying float vFace;

  uniform float uLo; uniform float uHi; uniform float uViewLon;
  float dLon(vec3 dir) { return mod(degrees(atan(dir.x, dir.z)) - uViewLon + 540.0, 360.0) - 180.0; }
  float realMask(vec3 dir) { float d = dLon(dir); return smoothstep(uLo - 0.6, uLo + 0.6, d) * smoothstep(uHi + 0.6, uHi - 0.6, d); }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(wp.xyz - ${`vec3(${GLOBE_CENTER.x.toFixed(1)}, ${GLOBE_CENTER.y.toFixed(1)}, ${GLOBE_CENTER.z.toFixed(1)})`});
    vFace = dot(n, normalize(cameraPosition - wp.xyz));
    vec4 mv = viewMatrix * wp;
    gl_PointSize = clamp(uPx * (260.0 / -mv.z), 1.0, 7.0);
    gl_Position = projectionMatrix * mv;
    if (realMask(normalize(position)) > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const DOTS_FS = /* glsl */ `
  uniform float uAlpha;
  varying float vFace;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    if (dot(d, d) > 0.25) discard;
    float a = smoothstep(-0.05, 0.35, vFace) * uAlpha;
    gl_FragColor = vec4(vec3(0.26, 0.36, 0.56), a * 0.35);
  }
`;
const STARS_FS = /* glsl */ `
  ${HASH}
  uniform float uAlpha;
  varying float vFace;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.25, 0.0, dot(d, d));
    gl_FragColor = vec4(vec3(0.75, 0.82, 1.0), a * 0.55 * uAlpha);
  }
`;

export function Globe({ data }: { data: StoryData }) {
  const gl = useThree((st) => st.gl);
  const g = data.globe;
  const nCells = g.meta.n_cells;
  const nMonths = g.meta.n_months;
  const switchIdx = g.months.indexOf("2012-01");
  const group = useRef<THREE.Group>(null);
  const lastMonth = useRef(-1);

  const { columns, colMat, attrs } = useMemo(() => {
    const geo = new THREE.CylinderGeometry(0.26, 0.26, 1, 6, 1, false);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, nCells);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const seed = new Float32Array(nCells);
    for (let i = 0; i < nCells; i++) {
      const v = latLonToVec(g.lat[i], g.lon[i]);
      n.set(v[0], v[1], v[2]);
      p.copy(n).multiplyScalar(R * 1.0015);
      q.setFromUnitVectors(up, n);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      seed[i] = (i * 0.618) % 1;
    }
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(nCells), 1).setUsage(THREE.DynamicDrawUsage);
    const attrs = { aH0: mk(), aH1: mk(), aR0: mk(), aR1: mk() };
    for (const [k, a] of Object.entries(attrs)) geo.setAttribute(k, a);
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    const colMat = new THREE.ShaderMaterial({
      vertexShader: COLUMN_VS,
      fragmentShader: COLUMN_FS,
      uniforms: { uFrac: { value: 0 }, uRaw: { value: 0 }, uAlpha: { value: 1 }, uTime: { value: 0 }, uShrink: { value: 1 }, ...MASK_U },
      transparent: true,
      depthWrite: true,
    });
    mesh.material = colMat;
    mesh.frustumCulled = false;
    return { columns: mesh, colMat, attrs };
  }, [g, nCells]);

  const { sphereMat, atmoMat, dots, dotsMat, stars, starsMat } = useMemo(() => {
    const sphereMat = new THREE.ShaderMaterial({
      vertexShader: SPHERE_VS,
      fragmentShader: SPHERE_FS,
      uniforms: { uAlpha: { value: 1 }, uNight: { value: null }, uHasTex: { value: 0 } },
      transparent: true,
    });
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: SPHERE_VS,
      fragmentShader: ATMO_FS,
      uniforms: { uAlpha: { value: 1 } },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const nLand = data.land.length / 2;
    const pos = new Float32Array(nLand * 3);
    for (let i = 0; i < nLand; i++) {
      const v = latLonToVec(data.land[2 * i], data.land[2 * i + 1]);
      pos[3 * i] = v[0] * R * 1.001;
      pos[3 * i + 1] = v[1] * R * 1.001;
      pos[3 * i + 2] = v[2] * R * 1.001;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const dotsMat = new THREE.ShaderMaterial({
      vertexShader: DOTS_VS,
      fragmentShader: DOTS_FS,
      uniforms: { uAlpha: { value: 1 }, uPx: { value: 1.4 }, ...MASK_U },
      transparent: true,
      depthWrite: false,
    });
    const dots = new THREE.Points(dg, dotsMat);
    dots.frustumCulled = false;
    // stars on a far shell (world space, not rotated with the globe)
    const nS = 2500;
    const sp = new Float32Array(nS * 3);
    for (let i = 0; i < nS; i++) {
      const u = Math.sin(i * 12.9898) * 43758.5453;
      const w = Math.sin(i * 78.233) * 12543.123;
      const a = (u - Math.floor(u)) * Math.PI * 2;
      const z = (w - Math.floor(w)) * 2 - 1;
      const r = Math.sqrt(1 - z * z);
      sp[3 * i] = Math.cos(a) * r * 900;
      sp[3 * i + 1] = z * 900;
      sp[3 * i + 2] = Math.sin(a) * r * 900;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    const starsMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying float vFace;
        void main(){ vFace = 1.0; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = 1.6 + 1.4 * fract(sin(dot(position.xy, vec2(12.9,78.2))) * 437.5);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: STARS_FS,
      uniforms: { uAlpha: { value: 1 } },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const stars = new THREE.Points(sg, starsMat);
    stars.frustumCulled = false;
    // NASA Black Marble 2016 (public domain; credits in public/static/textures/CREDITS.md)
    new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}static/textures/black_marble_2016_3600.jpg`, (tex) => {
      tex.colorSpace = THREE.NoColorSpace; // shader treats values as display colours
      tex.generateMipmaps = false; // per-pixel lon/lat UVs would make a mip seam at the date line
      tex.minFilter = THREE.LinearFilter;
      tex.anisotropy = 4;
      sphereMat.uniforms.uNight.value = tex;
      sphereMat.uniforms.uHasTex.value = 1;
    });
    return { sphereMat, atmoMat, dots, dotsMat, stars, starsMat };
  }, [data.land]);

  // two-eyes: one real day (7 Nov 2016) — global Aqua MODIS and S-NPP VIIRS true colour plus sharp Punjab close-ups
  const eyesMat = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SPHERE_VS,
      fragmentShader: EYES_FS,
      uniforms: {
        uTcM: { value: null },
        uTcV: { value: null },
        uPM: { value: null },
        uPV: { value: null },
        uImg: { value: 0 },
        uSweep: { value: 0 },
        uSweepW: { value: 118 },
        uEdge: { value: 0 },
        uFocus: { value: 0 },
        uGapHi: { value: 0 },
        uTime: { value: 0 },
        ...MASK_U,
      },
      transparent: true,
      depthWrite: false,
    });
    const base = `${import.meta.env.BASE_URL}static/textures/`;
    const load = (file: string, key: string, mips: boolean) =>
      new THREE.TextureLoader().load(base + file, (tex) => {
        tex.colorSpace = THREE.NoColorSpace;
        tex.generateMipmaps = mips; // global maps: no mips (per-pixel lon/lat UVs would seam at the date line)
        tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        tex.anisotropy = 8;
        mat.uniforms[key].value = tex;
        mat.userData.loaded = (mat.userData.loaded ?? 0) + 1;
        if (key === "uTcM") mat.userData.gaps = findGaps(tex.image as CanvasImageSource);
        gl.initTexture(tex); // upload now, not on the first frame of the swipe
      });
    load("modis_aqua_truecolor_2016-11-07.jpg", "uTcM", false);
    load("viirs_snpp_truecolor_2016-11-07.jpg", "uTcV", false);
    load("punjab_modis_aqua_tc_2016-11-07.jpg", "uPM", true);
    load("punjab_viirs_snpp_tc_2016-11-07.jpg", "uPV", true);
    return mat;
  }, [gl]);
  // the dive day's real detections (story_extras.json → globe_dive)
  const { pts, ptsMat } = useMemo(() => {
    const gd = data.extras.globe_dive;
    const all = [...gd.modis.map((r) => [...r, 0]), ...gd.viirs.map((r) => [...r, 1])];
    const n = all.length;
    const pos = new Float32Array(n * 3);
    const km = new Float32Array(n);
    const kind = new Float32Array(n);
    const seed = new Float32Array(n);
    all.forEach((r, i) => {
      const v = latLonToVec(r[0], r[1]);
      pos[3 * i] = v[0] * R * 1.0015;
      pos[3 * i + 1] = v[1] * R * 1.0015;
      pos[3 * i + 2] = v[2] * R * 1.0015;
      km[i] = Math.max(r[2], r[3]);
      kind[i] = r[4];
      seed[i] = (i * 0.6180339) % 1;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aKm", new THREE.BufferAttribute(km, 1));
    g.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const ptsMat = new THREE.ShaderMaterial({
      vertexShader: PTS_VS,
      fragmentShader: PTS_FS,
      uniforms: {
        uFocal: { value: 800 },
        uSweep: eyesMat.uniforms.uSweep,
        uSweepW: eyesMat.uniforms.uSweepW,
        uModis: { value: 0 },
        uViirs: { value: 0 },
        uA: { value: 0 },
        ...MASK_U,
      },
      transparent: true,
      depthWrite: false,
    });
    const pts = new THREE.Points(g, ptsMat);
    pts.frustumCulled = false;
    return { pts, ptsMat };
  }, [data.extras.globe_dive, eyesMat]);
  const eyesMesh = useRef<THREE.Mesh>(null);
  const gapAnchor = useRef<THREE.Group>(null);
  const gapTag = useRef<HTMLDivElement>(null);
  const gapPick = useRef<GapPt | null>(null);
  const tmpV = useMemo(() => new THREE.Vector3(), []);
  const invQ = useMemo(() => GLOBE_Q.clone().invert(), []);

  useFrame((state) => {
    const t = film.t;
    // two-eyes: swipe from the synthetic Earth to the real day, dive to Punjab, swipe back
    const sv = film.sv;
    const live = sv > 0 && sv < 1 && (eyesMat.userData.loaded ?? 0) >= 4;
    const img = live ? 1 : 0;
    const W = 118;
    const kIn = ramp(EYES.synIn[0], EYES.synIn[1], sv);
    const kOut = ramp(EYES.synOut[0], EYES.synOut[1], sv);
    MASK_U.uHi.value = !live ? -999 : kIn >= 0.999 ? 999 : -W + 2 * W * kIn;
    MASK_U.uLo.value = !live || kOut <= 0.001 ? -999 : -W + 2 * W * kOut;
    eyesMat.uniforms.uEdge.value = (kIn > 0 && kIn < 1) || (kOut > 0 && kOut < 1) ? 1 : 0;
    eyesMat.uniforms.uImg.value = img;
    eyesMat.uniforms.uSweep.value = ramp(EYES.sweep[0], EYES.sweep[1], sv);
    eyesMat.uniforms.uFocus.value = ramp(EYES.dive[0] + 0.08, EYES.dive[1], sv) * (1 - ramp(EYES.out[0], EYES.out[0] + 0.08, sv));
    tmpV.copy(state.camera.position).sub(GLOBE_CENTER);
    const dist = tmpV.length();
    tmpV.applyQuaternion(invQ);
    MASK_U.uViewLon.value = (Math.atan2(tmpV.x, tmpV.z) * 180) / Math.PI;
    // the gaps between MODIS passes: highlighted, with a callout pinned on one real stripe, while the planet is shown whole
    const gapHi = live ? ramp(EYES.synIn[0] + 0.05, EYES.synIn[1], sv) * (1 - ramp(EYES.dive[0] - 0.01, EYES.dive[0] + 0.015, sv)) : 0;
    eyesMat.uniforms.uGapHi.value = gapHi;
    eyesMat.uniforms.uTime.value = state.clock.elapsedTime;
    let tagA = 0;
    const gaps = eyesMat.userData.gaps as GapPt[] | undefined;
    if (gapHi > 0.001 && gaps?.length && gapAnchor.current) {
      // the stripe a little left of and above the centre of the view, so the card never sits on the caption
      const view = MASK_U.uViewLon.value;
      const dl = (lon: number) => ((lon - view + 540) % 360) - 180;
      let best: GapPt | null = null;
      let bestScore = Infinity;
      for (const g of gaps) {
        const d = dl(g.lon);
        if (Math.abs(d) > 45) continue;
        const sc = Math.abs(d + 16) + 0.6 * Math.abs(g.lat - 16);
        if (sc < bestScore) {
          bestScore = sc;
          best = g;
        }
      }
      if (best) {
        if (gapPick.current !== best) {
          gapPick.current = best;
          const v = latLonToVec(best.lat, best.lon);
          gapAnchor.current.position.set(v[0] * R * 1.003, v[1] * R * 1.003, v[2] * R * 1.003);
        }
        // only once the swipe has revealed that stripe
        const revealed = MASK_U.uHi.value > dl(best.lon) + 4 ? 1 : 0;
        tagA = gapHi * revealed;
      }
    }
    if (gapTag.current) {
      const a = tagA.toFixed(3);
      if (gapTag.current.style.opacity !== a) {
        gapTag.current.style.opacity = a;
        gapTag.current.style.visibility = tagA > 0.001 ? "visible" : "hidden";
      }
    }
    // sweep width ≈ half of what is on screen (a hemisphere far away, a few degrees in the dive)
    const cam = state.camera as THREE.PerspectiveCamera;
    const half = (((dist - R) * Math.tan(((cam.fov / 2) * Math.PI) / 180) * cam.aspect) / R) * (180 / Math.PI) * 1.1;
    eyesMat.uniforms.uSweepW.value = Math.min(W, Math.max(2, half));
    ptsMat.uniforms.uFocal.value = (state.size.height * state.viewport.dpr) / (2 * Math.tan(((cam.fov / 2) * Math.PI) / 180));
    ptsMat.uniforms.uModis.value = ramp(EYES.modis[0], EYES.modis[1], sv);
    ptsMat.uniforms.uViirs.value = ramp(EYES.sweep[0] + 0.02, EYES.sweep[1] + 0.03, sv);
    ptsMat.uniforms.uA.value = live ? ramp(EYES.dive[0] + 0.06, EYES.dive[1], sv) * (1 - ramp(EYES.out[0], EYES.out[0] + 0.07, sv)) : 0;
    pts.visible = ptsMat.uniforms.uA.value > 0.002;
    if (eyesMesh.current) eyesMesh.current.visible = img > 0.002;
    const vis = globeVisibility(t);
    if (group.current) group.current.visible = vis > 0.002;
    starsMat.uniforms.uAlpha.value = clamp(0.25 + 0.75 * vis);
    if (vis <= 0.002) return;
    const mf = globeMonthS(film.s, nMonths, switchIdx);
    const m0 = Math.max(0, Math.min(nMonths - 1, Math.floor(mf)));
    const m1 = Math.min(nMonths - 1, m0 + 1);
    if (m0 !== lastMonth.current) {
      lastMonth.current = m0;
      const o0 = m0 * nCells;
      const o1 = m1 * nCells;
      const h0 = attrs.aH0.array as Float32Array;
      const h1 = attrs.aH1.array as Float32Array;
      const r0 = attrs.aR0.array as Float32Array;
      const r1 = attrs.aR1.array as Float32Array;
      for (let i = 0; i < nCells; i++) {
        h0[i] = g.harm[o0 + i] / 255;
        h1[i] = g.harm[o1 + i] / 255;
        r0[i] = g.raw[o0 + i] / 255;
        r1[i] = g.raw[o1 + i] / 255;
      }
      attrs.aH0.needsUpdate = attrs.aH1.needsUpdate = attrs.aR0.needsUpdate = attrs.aR1.needsUpdate = true;
    }
    colMat.uniforms.uFrac.value = mf - m0;
    colMat.uniforms.uRaw.value = rawMixAt(t);
    colMat.uniforms.uTime.value = state.clock.elapsedTime;
    colMat.uniforms.uAlpha.value = vis;
    // columns sink into the surface as the camera dives (they would tower over the field)
    colMat.uniforms.uShrink.value = 1 - ramp(0.26, 0.288, t) + ramp(0.93, 0.96, t);
    sphereMat.uniforms.uAlpha.value = vis;
    atmoMat.uniforms.uAlpha.value = vis;
    dotsMat.uniforms.uAlpha.value = vis;
    dotsMat.uniforms.uPx.value = 1.4 * Math.min(2, state.viewport.dpr);
  });

  return (
    <>
      <primitive object={stars} />
      <group ref={group} position={GLOBE_CENTER} quaternion={GLOBE_Q}>
        {/* draw order: planet first (writes depth, hides the far side), then dots, columns, glow */}
        <mesh material={sphereMat} renderOrder={-2}>
          <sphereGeometry args={[R, 96, 64]} />
        </mesh>
        <mesh material={atmoMat} scale={1.06} renderOrder={3}>
          <sphereGeometry args={[R, 64, 48]} />
        </mesh>
        <mesh ref={eyesMesh} material={eyesMat} scale={1.0008} renderOrder={-1} visible={false}>
          <sphereGeometry args={[R, 160, 96]} />
        </mesh>
        <primitive object={dots} renderOrder={1} />
        <primitive object={pts} renderOrder={4} />
        <primitive object={columns} renderOrder={2} />
        <group ref={gapAnchor}>
          <Html zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
            <div ref={gapTag} className="gap-tag" style={{ opacity: 0, visibility: "hidden" }} aria-hidden="true">
              <i className="gap-ring" />
              <i className="gap-line" />
              <div className="gap-card">
                <b>Not a glitch</b>
                <span>A gap between MODIS&rsquo;s passes. It never saw this strip that day.</span>
              </div>
            </div>
          </Html>
        </group>
      </group>
    </>
  );
}

interface GapPt {
  lat: number;
  lon: number;
}
/** Centres of MODIS's no-data stripes along a few latitudes, read from the day's true-colour image (the same
 *  "near black" rule as the shader). Used to pin the "not a glitch" callout on a real stripe. */
function findGaps(img: CanvasImageSource): GapPt[] {
  try {
    const W = 1024, H = 512;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    if (!cx) return [];
    cx.drawImage(img, 0, 0, W, H);
    const out: GapPt[] = [];
    for (const lat of [-8, 0, 8, 16, 24, 32]) {
      const row = Math.round((0.5 - lat / 180) * H);
      const px = cx.getImageData(0, row, W, 1).data;
      let start = -1;
      for (let x = 0; x <= W; x++) {
        const dark = x < W && (px[4 * x] + px[4 * x + 1] + px[4 * x + 2]) / 3 < 0.03 * 255;
        if (dark && start < 0) start = x;
        if (!dark && start >= 0) {
          const w = x - start;
          if (w >= 4 && w <= 80) out.push({ lat, lon: ((start + w / 2) / W - 0.5) * 360 });
          start = -1;
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
