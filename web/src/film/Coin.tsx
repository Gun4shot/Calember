// The coin for "blind guess = 50 %": MODIS on one face, EMBER on the other. Embossed
// guilloche rings, ring lettering and a reeded edge, shaded as polished gold with a moving
// highlight. Faces are drawn once into canvas textures; relief comes from the texture
// gradient (bump), so it stays a single cheap mesh.

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { film } from "./store";

function face(label: string, icon: "sat" | "flame", mirror: boolean): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  if (mirror) {
    g.translate(S, 0);
    g.scale(-1, 1);
  }
  const R = S / 2;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);
  g.translate(R, R);
  // raised rim and inner ring
  g.strokeStyle = "#fff";
  g.lineWidth = 18;
  g.beginPath();
  g.arc(0, 0, R - 12, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 5;
  g.beginPath();
  g.arc(0, 0, R - 70, 0, Math.PI * 2);
  g.stroke();
  // guilloche: modulated rings
  g.lineWidth = 1.4;
  g.strokeStyle = "rgba(255,255,255,0.55)";
  for (let k = 0; k < 9; k++) {
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.01) {
      const r = 60 + k * 13 + Math.sin(a * 18 + k * 0.7) * 6;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (a === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // ring lettering
  const ring = "THE SENSOR TURING TEST · 50 / 50 · ";
  g.fillStyle = "#fff";
  g.font = "600 30px 'JetBrains Mono', monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const chars = (ring + ring).split("");
  chars.forEach((ch, i) => {
    const a = (i / chars.length) * Math.PI * 2 - Math.PI / 2;
    g.save();
    g.rotate(a + Math.PI / 2);
    g.fillText(ch, 0, -(R - 42));
    g.restore();
  });
  // centre plate
  g.fillStyle = "#000";
  g.beginPath();
  g.arc(0, 0, 112, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#fff";
  g.lineWidth = 4;
  g.stroke();
  // icon
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  if (icon === "sat") {
    g.fillRect(-14, -66, 28, 22);
    g.fillRect(-58, -62, 36, 14);
    g.fillRect(22, -62, 36, 14);
  } else {
    g.beginPath();
    g.moveTo(0, -78);
    g.bezierCurveTo(26, -52, 22, -34, 0, -28);
    g.bezierCurveTo(-22, -34, -26, -52, 0, -78);
    g.fill();
  }
  g.font = "700 64px 'Fraunces', Georgia, serif";
  g.fillText(label, 0, 20);
  g.font = "500 22px 'JetBrains Mono', monospace";
  g.fillText(icon === "sat" ? "HEADS" : "TAILS", 0, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

const VS = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vL;
  void main() {
    vUv = uv; vL = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const FS_FACE = /* glsl */ `
  uniform sampler2D uTex; uniform float uA; uniform vec3 uLight;
  varying vec3 vN; varying vec3 vV; varying vec2 vUv;
  void main() {
    float e = 1.0 / 512.0;
    float h = texture2D(uTex, vUv).r;
    float hx = texture2D(uTex, vUv + vec2(e, 0.0)).r - texture2D(uTex, vUv - vec2(e, 0.0)).r;
    float hy = texture2D(uTex, vUv + vec2(0.0, e)).r - texture2D(uTex, vUv - vec2(0.0, e)).r;
    vec3 n = normalize(vN + vec3(hx, 0.0, hy) * 2.2);
    vec3 L = normalize(uLight);
    float d = max(dot(n, L), 0.0);
    float s = pow(max(dot(reflect(-L, n), vV), 0.0), 28.0);
    vec3 gold = mix(vec3(0.62, 0.42, 0.14), vec3(1.0, 0.8, 0.38), h);
    vec3 c = gold * (0.32 + 0.85 * d) + vec3(1.0, 0.95, 0.82) * s * (0.9 + h);
    gl_FragColor = vec4(c, uA);
  }
`;
const FS_EDGE = /* glsl */ `
  uniform float uA; uniform vec3 uLight;
  varying vec3 vN; varying vec3 vV; varying vec3 vL;
  void main() {
    float a = atan(vL.z, vL.x);
    float reed = 0.5 + 0.5 * sin(a * 140.0);
    vec3 n = normalize(vN + vec3(0.0, 0.0, 0.0) + normalize(vec3(vL.x, 0.0, vL.z)) * (reed - 0.5) * 0.6);
    vec3 L = normalize(uLight);
    float d = max(dot(n, L), 0.0);
    float s = pow(max(dot(reflect(-L, n), vV), 0.0), 20.0);
    vec3 c = vec3(0.85, 0.62, 0.26) * (0.3 + 0.8 * d) * (0.75 + 0.25 * reed) + vec3(1.0, 0.92, 0.7) * s;
    gl_FragColor = vec4(c, uA);
  }
`;

export function Coin({ position, visRef }: { position: [number, number, number]; visRef: { current: number } }) {
  const spin = useRef<THREE.Group>(null);
  const mats = useMemo(() => {
    const light = { value: new THREE.Vector3(0.4, 0.8, 0.6) };
    const mk = (tex: THREE.Texture) =>
      new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS_FACE, uniforms: { uTex: { value: tex }, uA: { value: 0 }, uLight: light }, transparent: true });
    const edge = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS_EDGE, uniforms: { uA: { value: 0 }, uLight: light }, transparent: true });
    return { edge, top: mk(face("MODIS", "sat", false)), bottom: mk(face("EMBER", "flame", true)), light };
  }, []);

  useFrame((state) => {
    const a = visRef.current;
    mats.edge.uniforms.uA.value = a;
    mats.top.uniforms.uA.value = a;
    mats.bottom.uniforms.uA.value = a;
    const tm = state.clock.elapsedTime;
    if (spin.current) {
      const still = film.reducedMotion;
      spin.current.rotation.y = still ? 0.4 : tm * 2.2;
      spin.current.rotation.z = still ? 0 : Math.sin(tm * 0.9) * 0.18;
      spin.current.position.y = still ? 0 : Math.sin(tm * 1.3) * 0.15;
    }
    // the highlight wanders, so the relief catches light as it turns
    mats.light.value.set(Math.cos(tm * 0.7) * 0.6, 0.8, 0.6 + Math.sin(tm * 0.7) * 0.3);
  });

  return (
    <group position={position}>
      <group ref={spin}>
        <mesh rotation-x={Math.PI / 2} material={[mats.edge, mats.top, mats.bottom]}>
          <cylinderGeometry args={[1.7, 1.7, 0.18, 96, 1]} />
        </mesh>
      </group>
    </group>
  );
}
