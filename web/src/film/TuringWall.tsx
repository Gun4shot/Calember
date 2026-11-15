// Act 5 · the Sensor Turing Test. A wall of 1,356 tiles: one per 24-month province record the
// classifier judged (678 MODIS + 678 candidates). For each method, the share of tiles that turn
// amber ("spotted") equals the classifier's accuracy; dark blue tiles fooled it. A gold coin
// stands for blind guessing (50 %). Tiles flip on the new-act clock u, so it rewinds cleanly.

import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Coin } from "./Coin";
import type { StoryData } from "./data";
import { hash01, ramp } from "./math";
import { film } from "./store";
import { U, inActsAt } from "./timeline";
import monoFont from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff?url";

export const WALL_POS = new THREE.Vector3(34, 7, -10);
const COLS = 52;
const STEP = 0.28;

export function wallVisibility(u: number, inActs: boolean) {
  return inActs ? Math.min(ramp(0.575, 0.61, u), 1 - ramp(0.875, 0.92, u)) : 0;
}

const VS = /* glsl */ `
  attribute float aRank; attribute float aCol; attribute float aRow;
  uniform float uIn; uniform float uP1; uniform float uP2; uniform float uP3;
  uniform float uA1; uniform float uA2; uniform float uA3;
  varying vec3 vCol; varying float vA; varying vec3 vN; varying float vFlash;
  float ease(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
  float local(float p) { return clamp(p * 1.7 - aCol / ${COLS.toFixed(1)} * 0.7, 0.0, 1.0); }
  void main() {
    float c1 = step(aRank, uA1), c2 = step(aRank, uA2), c3 = step(aRank, uA3);
    float l1 = local(uP1), l2 = local(uP2), l3 = local(uP3);
    float ang = 3.14159 * (ease(l1) + abs(c2 - c1) * ease(l2) + abs(c3 - c2) * ease(l3));
    float st = l3 > 0.5 ? c3 : l2 > 0.5 ? c2 : l1 > 0.5 ? c1 : -1.0;
    // a tile flashes while it is being judged (flipping)
    vFlash = 4.0 * l1 * (1.0 - l1) + abs(c2 - c1) * 4.0 * l2 * (1.0 - l2) + abs(c3 - c2) * 4.0 * l3 * (1.0 - l3);
    vec3 neutral = vec3(0.16, 0.18, 0.24);
    vec3 caught = vec3(1.0, 0.55, 0.2) * 1.35;
    vec3 fooled = vec3(0.12, 0.22, 0.48);
    vCol = st < -0.5 ? neutral : (st > 0.5 ? caught : fooled);
    // appear: tiles rise in from the bottom row, column-staggered
    float kin = ease(uIn * 1.6 - aRow / 27.0 * 0.6);
    vA = kin;
    vec3 p = position;
    float cs = cos(ang), sn = sin(ang);
    p = vec3(p.x * cs + p.z * sn, p.y, -p.x * sn + p.z * cs);
    vN = vec3(sn, 0.0, cs);
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    wp.y -= (1.0 - kin) * 1.5;
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;
const FS = /* glsl */ `
  uniform float uVis;
  varying vec3 vCol; varying float vA; varying vec3 vN; varying float vFlash;
  void main() {
    float l = 0.6 + 0.4 * abs(vN.z);
    vec3 c = vCol * l + vec3(1.0, 0.92, 0.75) * vFlash * 0.9;
    gl_FragColor = vec4(c, vA * uVis);
  }
`;


export function TuringWall({ data }: { data: StoryData }) {
  const group = useRef<THREE.Group>(null);
  const scan = useRef<THREE.Group>(null);
  const coinVis = useRef(0);
  const legend = useRef<THREE.Group>(null);
  const tu = data.results.turing;
  const N = tu.n_regions * 2;

  const { mesh, mat } = useMemo(() => {
    const geo = new THREE.BoxGeometry(STEP * 0.84, STEP * 0.84, 0.05);
    const mesh = new THREE.InstancedMesh(geo, undefined as unknown as THREE.Material, N);
    const rows = Math.ceil(N / COLS);
    // fixed random ranks → the caught share is exactly the accuracy
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => hash01(a * 2.71 + 0.3) - hash01(b * 2.71 + 0.3));
    const rank = new Float32Array(N);
    order.forEach((idx, k) => (rank[idx] = (k + 0.5) / N));
    const col = new Float32Array(N);
    const row = new Float32Array(N);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      const c = i % COLS;
      const r = Math.floor(i / COLS);
      m4.makeTranslation((c - (COLS - 1) / 2) * STEP, (rows / 2 - r) * STEP, 0);
      mesh.setMatrixAt(i, m4);
      col[i] = c;
      row[i] = r;
    }
    geo.setAttribute("aRank", new THREE.InstancedBufferAttribute(rank, 1));
    geo.setAttribute("aCol", new THREE.InstancedBufferAttribute(col, 1));
    geo.setAttribute("aRow", new THREE.InstancedBufferAttribute(row, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: {
        uIn: { value: 0 },
        uP1: { value: 0 },
        uP2: { value: 0 },
        uP3: { value: 0 },
        uA1: { value: tu.raw_viirs },
        uA2: { value: tu.sota_style },
        uA3: { value: tu.ember },
        uVis: { value: 0 },
      },
      transparent: true,
    });
    mesh.material = mat;
    mesh.frustumCulled = false;
    return { mesh, mat };
  }, [N, tu]);


  useFrame(() => {
    const u = film.u;
    const inActs = inActsAt(film.s);
    const vis = wallVisibility(u, inActs);
    if (group.current) group.current.visible = vis > 0.002;
    if (vis <= 0.002) return;
    const m = mat.uniforms;
    m.uVis.value = vis;
    m.uIn.value = ramp(U.rule[0], U.rule[0] + 0.035, u);
    m.uP1.value = ramp(U.flipRaw[0], U.flipRaw[1], u);
    m.uP2.value = ramp(U.flipSota[0], U.flipSota[1], u);
    m.uP3.value = ramp(U.flipEmber[0], U.flipEmber[1], u);
    coinVis.current = vis;
    // the classifier: a light bar sweeps across the wall with each judgment pass
    if (scan.current) {
      const ps = [m.uP1.value, m.uP2.value, m.uP3.value];
      let x = -1;
      for (const pp of ps) if (pp > 0 && pp < 1) x = Math.min(1, Math.max(0, (pp * 1.7 - 0.5) / 0.7 + 0.15));
      scan.current.visible = x >= 0;
      if (x >= 0) {
        const W = COLS * STEP;
        scan.current.position.x = (x - 0.5) * W;
        for (const o of scan.current.children) {
          const mm = (o as THREE.Mesh).material as THREE.Material & { opacity?: number };
          if (mm && "opacity" in mm) mm.opacity = vis * (o.userData.op ?? 1);
          const tx = o as THREE.Object3D & { fillOpacity?: number };
          if ("fillOpacity" in tx) tx.fillOpacity = vis;
        }
      }
    }
    if (legend.current) {
      const a = vis * ramp(U.flipRaw[0], U.flipRaw[1], u);
      for (const o of legend.current.children) (o as THREE.Object3D & { fillOpacity?: number }).fillOpacity = a;
    }
  });

  const rows = Math.ceil(N / COLS);
  return (
    <group ref={group} position={WALL_POS} visible={false}>
      <primitive object={mesh} />
      <Coin position={[-11.2, -0.2, 2.5]} visRef={coinVis} />
      <group ref={scan} visible={false}>
        <mesh position={[0, 0, 0.12]} userData={{ op: 0.9 }}>
          <planeGeometry args={[0.07, rows * STEP + 0.8]} />
          <meshBasicMaterial color="#dff0ff" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <mesh position={[-0.35, 0, 0.1]} userData={{ op: 0.18 }}>
          <planeGeometry args={[0.7, rows * STEP + 0.8]} />
          <meshBasicMaterial color="#9ec9ff" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <Text font={monoFont} fontSize={0.26} position={[0, (rows * STEP) / 2 + 0.7, 0.12]} anchorX="center" anchorY="bottom" color="#dff0ff">
          classifier judging…
        </Text>
      </group>
      <group ref={legend}>
        <Text font={monoFont} fontSize={0.32} position={[-11.2, -2.6, 2.5]} anchorX="center" anchorY="top" color="#ffd27a">
          blind guess = 50 %
        </Text>
        <Text font={monoFont} fontSize={0.3} position={[-((COLS - 1) / 2) * STEP, -(rows / 2 + 1) * STEP, 0]} anchorX="left" anchorY="top" color="#ff9a4d">
          ■ spotted by the machine
        </Text>
        <Text font={monoFont} fontSize={0.3} position={[-((COLS - 1) / 2) * STEP + 4.4, -(rows / 2 + 1) * STEP, 0]} anchorX="left" anchorY="top" color="#6f8fd8">
          ■ fooled it
        </Text>
        <Text font={monoFont} fontSize={0.3} position={[((COLS - 1) / 2) * STEP, -(rows / 2 + 1) * STEP, 0]} anchorX="right" anchorY="top" color="#8b93a7">
          {`${N.toLocaleString("en-US")} tiles = ${tu.n_regions} provinces × 2 records`}
        </Text>
      </group>
    </group>
  );
}
