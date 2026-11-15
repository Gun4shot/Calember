// The Punjab field (illustration) and the pixel beat: a 1 km MODIS grid and a 375 m
// VIIRS grid lower onto the same burning field. 1 world unit ≈ 1 km here.

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { HASH, SPRING } from "./glsl";
import { clamp, ramp } from "./math";
import { film } from "./store";
import { T } from "./timeline";
import { FIRE_RECT } from "./world";

export function groundVisibility(t: number) {
  return clamp(ramp(0.284, 0.304, t) * (1 - ramp(0.93, 0.965, t)));
}

const GROUND_VS = /* glsl */ `
  varying vec2 vXZ; varying float vDist;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz; vDist = length(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const GROUND_FS = /* glsl */ `
  ${HASH}
  uniform float uAlpha; uniform float uTime; uniform float uFire;
  uniform vec4 uRect;
  varying vec2 vXZ; varying float vDist;
  void main() {
    // long rectangular fields, slightly rotated grid like Punjab's consolidated plots
    vec2 p = vXZ;
    vec2 cell = vec2(0.42, 0.11);
    vec2 id = floor(p / cell);
    vec2 f = fract(p / cell);
    float h = hash12(id);
    float border = smoothstep(0.0, 0.04, f.x) * smoothstep(1.0, 0.96, f.x) * smoothstep(0.0, 0.12, f.y) * smoothstep(1.0, 0.88, f.y);
    vec3 stubble = mix(vec3(0.075, 0.06, 0.035), vec3(0.13, 0.1, 0.05), h);
    vec3 green = vec3(0.03, 0.055, 0.035);
    vec3 c = mix(green, stubble, step(0.35, h));
    c = mix(c * 0.45, c, border);
    // scattered faint burn scars (other fields burned earlier)
    c = mix(c, vec3(0.02), step(0.93, h) * 0.8);
    // the burning field
    vec2 q = (p - uRect.xy) / (uRect.zw - uRect.xy); // 0..1 inside the fire rectangle
    float inside = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
    if (inside > 0.5) { // noise only where the fire is (cheap everywhere else)
      float front = 0.55 + 0.25 * sin(uTime * 0.35) + 0.08 * (fbm(vec2(q.y * 6.0, uTime * 0.6)) - 0.5);
      float burnt = smoothstep(front + 0.02, front - 0.08, q.x);
      float flame = exp(-pow(abs((q.x - front) * 14.0), 2.0)) * (0.6 + 0.8 * fbm(vec2(q.x * 9.0 + uTime * 2.0, q.y * 7.0 - uTime * 3.0)));
      vec3 fireCol = vec3(1.0, 0.45, 0.08) * flame * 4.0 + vec3(1.0, 0.85, 0.5) * pow(max(flame, 0.0), 3.0) * 3.0;
      c = mix(c, vec3(0.012, 0.01, 0.01), burnt) + fireCol * uFire;
    }
    // ember glow spill around the fire
    vec2 cen = (uRect.xy + uRect.zw) * 0.5;
    float spill = exp(-dot(p - cen, p - cen) * 0.9) * 0.55 * uFire;
    c += vec3(1.0, 0.4, 0.1) * spill;
    float fog = exp(-vDist * 0.035);
    c *= fog;
    gl_FragColor = vec4(c, uAlpha);
  }
`;


// ---------------------------------------------------------------------------------------
// Pixel beat. Three layers, each simple on purpose so nothing flickers:
//  1. grid: flat rim-only cells, landing as a ripple from the centre (no overshoot into the ground)
//  2. lit pixels: opaque glowing columns (depth-correct, no transparency sorting)
//  3. MODIS footprint: an amber 1 km outline that stays while the VIIRS pixels light inside it
// ---------------------------------------------------------------------------------------

const GRID_VS = /* glsl */ `
  attribute float aDist;
  uniform float uDrop;
  varying vec2 vUv; varying float vFade;
  void main() {
    vUv = uv;
    // ripple: centre cells land first; ease-out cubic, never below the ground
    float k = clamp(uDrop * 1.25 - aDist * 0.28, 0.0, 1.0);
    float e = 1.0 - pow(clamp(1.0 - k, 0.0, 1.0), 3.0);
    vFade = (1.0 - smoothstep(1.2, 2.6, aDist)) * smoothstep(0.0, 0.25, k);
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    wp.y += 0.025 + (1.0 - e) * 3.0;
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;
const GRID_FS = /* glsl */ `
  uniform vec3 uColor; uniform float uAlpha; uniform float uFlash;
  varying vec2 vUv; varying float vFade;
  void main() {
    vec2 d = abs(vUv - 0.5);
    float e = max(d.x, d.y);
    float rim = smoothstep(0.43, 0.49, e);
    float a = (0.05 + rim * 0.85) * vFade * uAlpha;
    vec3 c = uColor * (0.25 + rim * (0.9 + uFlash));
    gl_FragColor = vec4(c, a);
  }
`;

const COL_VS = /* glsl */ `
  ${SPRING}
  attribute float aDelay; attribute float aAmt;
  uniform float uPop; uniform float uColH; uniform float uLitFade;
  varying vec3 vLocal; varying vec3 vN;
  void main() {
    float k = springK(uPop - aDelay, 15.0, 0.34) * uLitFade;
    vLocal = position;
    vN = normal;
    vec3 p = position;                  // unit box, y in [0,1]
    p.y *= max(0.0001, k) * uColH * (0.35 + 0.65 * aAmt);
    p.xz *= mix(0.6, 1.0, clamp(k, 0.0, 1.0));
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    wp.y += 0.03;
    gl_Position = projectionMatrix * modelViewMatrix * wp;
    if (k < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;
const COL_FS = /* glsl */ `
  uniform vec3 uHot; uniform vec3 uEdge;
  varying vec3 vLocal; varying vec3 vN;
  void main() {
    // edges of each face glow; top face brightest; sides darken toward the base
    vec3 q = abs(vLocal - vec3(0.0, 0.5, 0.0));
    float ex = smoothstep(0.42, 0.5, q.x), ez = smoothstep(0.42, 0.5, q.z), ey = smoothstep(0.44, 0.5, q.y);
    float edge = max(max(ex * ez, ex * ey), ez * ey);
    float top = step(0.5, vN.y);
    vec3 c = uHot * mix(0.25 + 0.55 * vLocal.y, 1.25, top);
    c = mix(c, uEdge * 1.8, edge);
    gl_FragColor = vec4(c, 1.0);
  }
`;

type Plate = { grid: THREE.InstancedMesh; cols: THREE.InstancedMesh; nLit: number };

function makePlate(
  cell: number,
  n: number,
  colGap: number,
  cover: (ix: number, iz: number) => number,
  color: THREE.Color,
  hot: THREE.Color,
  edge: THREE.Color,
  colH: number,
): Plate {
  const half = Math.floor(n / 2);
  const gGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const grid = new THREE.InstancedMesh(
    gGeo,
    new THREE.ShaderMaterial({
      vertexShader: GRID_VS,
      fragmentShader: GRID_FS,
      uniforms: { uDrop: { value: 0 }, uAlpha: { value: 0 }, uFlash: { value: 0 }, uColor: { value: color } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    n * n,
  );
  const dist = new Float32Array(n * n);
  const m = new THREE.Matrix4();
  const lit: { x: number; z: number; f: number }[] = [];
  let k = 0;
  for (let ix = -half; ix <= half; ix++) {
    for (let iz = -half; iz <= half; iz++) {
      const cx = (ix + 0.5) * cell;
      const cz = (iz + 0.5) * cell;
      m.makeScale(cell * 0.97, 1, cell * 0.97).setPosition(cx, 0, cz);
      grid.setMatrixAt(k, m);
      dist[k] = Math.hypot(cx - 0.5, cz - 0.4); // distance from the fire (km)
      const f = cover(ix, iz);
      if (f > 0) lit.push({ x: cx, z: cz, f });
      k++;
    }
  }
  gGeo.setAttribute("aDist", new THREE.InstancedBufferAttribute(dist, 1));
  grid.frustumCulled = false;
  grid.renderOrder = 2;

  const cGeo = new THREE.BoxGeometry(1, 1, 1);
  cGeo.translate(0, 0.5, 0);
  const cols = new THREE.InstancedMesh(
    cGeo,
    new THREE.ShaderMaterial({
      vertexShader: COL_VS,
      fragmentShader: COL_FS,
      uniforms: { uPop: { value: 0 }, uColH: { value: colH }, uLitFade: { value: 1 }, uHot: { value: hot }, uEdge: { value: edge } },
    }),
    Math.max(1, lit.length),
  );
  const delay = new Float32Array(lit.length);
  const amt = new Float32Array(lit.length);
  // pop order: biggest coverage first, so the count reads as a deliberate sequence
  lit.sort((a, b) => b.f - a.f);
  lit.forEach((c, i) => {
    m.makeScale(cell * colGap, 1, cell * colGap).setPosition(c.x, 0, c.z);
    cols.setMatrixAt(i, m);
    delay[i] = i * T.viirsStepSpring;
    amt[i] = c.f;
  });
  cGeo.setAttribute("aDelay", new THREE.InstancedBufferAttribute(delay, 1));
  cGeo.setAttribute("aAmt", new THREE.InstancedBufferAttribute(amt, 1));
  cols.frustumCulled = false;
  return { grid, cols, nLit: lit.length };
}

/** Number of lit VIIRS cells (drives the counter and the sounds). */
export const VIIRS_LIT = 6;

export function Ground() {
  const R = FIRE_RECT;
  /** fraction of the cell covered by the fire rectangle (relative to the most-covered cell) */
  const cover = (x0: number, x1: number, z0: number, z1: number) => {
    const ox = Math.max(0, Math.min(x1, R.x1) - Math.max(x0, R.x0));
    const oz = Math.max(0, Math.min(z1, R.z1) - Math.max(z0, R.z0));
    return Math.min(1, (ox * oz) / ((x1 - x0) * (z1 - z0)) / 0.6);
  };

  const { groundMat, modis, viirs } = useMemo(() => {
    const groundMat = new THREE.ShaderMaterial({
      vertexShader: GROUND_VS,
      fragmentShader: GROUND_FS,
      uniforms: {
        uAlpha: { value: 0 },
        uTime: { value: 0 },
        uFire: { value: 1 },
        uRect: { value: new THREE.Vector4(R.x0, R.z0, R.x1, R.z1) },
      },
      transparent: true,
      depthWrite: true,
    });
    const M = 1.0;
    const V = 0.375;
    const modis = makePlate(
      M, 5, 0.86,
      (ix, iz) => cover(ix * M, (ix + 1) * M, iz * M, (iz + 1) * M),
      new THREE.Color(1.0, 0.56, 0.24), new THREE.Color(1.0, 0.42, 0.1), new THREE.Color(1.0, 0.8, 0.45), 0.6,
    );
    const viirs = makePlate(
      V, 11, 0.8,
      (ix, iz) => cover(ix * V, (ix + 1) * V, iz * V, (iz + 1) * V),
      new THREE.Color(0.55, 0.75, 1.0), new THREE.Color(0.25, 0.5, 0.95), new THREE.Color(0.8, 0.92, 1.0), 0.5,
    );
    viirs.grid.position.y = 0.006;
    return { groundMat, modis, viirs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plane = useRef<THREE.Mesh>(null);
  const footprint = useRef<THREE.Group>(null);
  useFrame((state) => {
    const t = film.t;
    const vis = groundVisibility(t);
    groundMat.uniforms.uAlpha.value = vis;
    if (plane.current) plane.current.visible = vis > 0.002;
    groundMat.uniforms.uTime.value = state.clock.elapsedTime;
    groundMat.uniforms.uFire.value = 1 - 0.6 * ramp(0.43, 0.5, t);
    const S = T.springSpeed;
    const out = 1 - ramp(T.platesOut[0], T.platesOut[1], t);
    const viirsIn = ramp(T.viirsPlate - 0.004, T.viirsPlate + 0.01, t);
    const mg = modis.grid.material as THREE.ShaderMaterial;
    const vg = viirs.grid.material as THREE.ShaderMaterial;
    const mc = modis.cols.material as THREE.ShaderMaterial;
    const vc = viirs.cols.material as THREE.ShaderMaterial;
    mg.uniforms.uDrop.value = (t - T.modisPlate) * S * 2.6;
    mg.uniforms.uAlpha.value = ramp(T.modisPlate - 0.004, T.modisPlate + 0.006, t) * out * (1 - viirsIn);
    mg.uniforms.uFlash.value = Math.max(0, 1 - Math.abs((t - T.modisPop) * 120));
    mc.uniforms.uPop.value = (t - T.modisPop) * S;
    mc.uniforms.uLitFade.value = 1 - viirsIn;
    vg.uniforms.uDrop.value = (t - T.viirsPlate) * S * 2.6;
    vg.uniforms.uAlpha.value = viirsIn * out;
    vg.uniforms.uFlash.value = Math.max(0, 1 - Math.abs((t - T.viirsPop) * 120));
    vc.uniforms.uPop.value = (t - T.viirsPop) * S;
    vc.uniforms.uLitFade.value = out;
    modis.grid.visible = mg.uniforms.uAlpha.value > 0.001;
    modis.cols.visible = t > T.modisPop && viirsIn < 0.999 && out > 0;
    viirs.grid.visible = vg.uniforms.uAlpha.value > 0.001;
    viirs.cols.visible = t > T.viirsPop && out > 0.001;
    // the MODIS 1 km footprint stays as an outline once VIIRS arrives
    if (footprint.current) {
      const a = ramp(T.modisPop, T.modisPop + 0.01, t) * out;
      footprint.current.visible = a > 0.01;
      for (const o of footprint.current.children) {
        const mat = (o as THREE.Mesh).material as THREE.Material;
        mat.opacity = a;
      }
    }
  });

  const sq: [number, number, number][] = [
    [0.02, 0.07, 0.02],
    [0.98, 0.07, 0.02],
    [0.98, 0.07, 0.98],
    [0.02, 0.07, 0.98],
    [0.02, 0.07, 0.02],
  ];
  return (
    <group>
      <mesh ref={plane} material={groundMat} rotation-x={-Math.PI / 2} renderOrder={-1} visible={false}>
        <planeGeometry args={[90, 90, 1, 1]} />
      </mesh>
      <primitive object={modis.grid} />
      <primitive object={modis.cols} />
      <primitive object={viirs.grid} />
      <primitive object={viirs.cols} />
      <group ref={footprint} visible={false}>
        <Line points={sq} color="#ffa04a" lineWidth={4.5} transparent opacity={0} depthTest={false} renderOrder={4} />
      </group>
    </group>
  );
}
