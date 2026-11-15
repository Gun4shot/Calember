// The descent: a layer of soft clouds between orbit and the Punjab field. The camera passes
// through them while the globe hands over to the ground, so the change of scale reads as one
// continuous dive (no flash, no cut). Clouds are camera-facing quads with an fbm shader,
// cool on top and lit orange from below by the fire.

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { HASH } from "./glsl";
import { hash01, ramp } from "./math";
import { film } from "./store";

const N = 26;

const VS = /* glsl */ `
  attribute vec3 aCenter; attribute float aSize; attribute float aSeed;
  varying vec2 vUv; varying float vSeed; varying float vY; varying float vCam;
  void main() {
    vUv = uv; vSeed = aSeed; vY = aCenter.y;
    // billboard: offset in view space
    vec4 mv = viewMatrix * vec4(aCenter, 1.0);
    mv.xy += position.xy * aSize;
    vCam = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const FS = /* glsl */ `
  ${HASH}
  uniform float uA; uniform float uTime;
  varying vec2 vUv; varying float vSeed; varying float vY; varying float vCam;
  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float n = fbm(vUv * 3.0 + vSeed * 17.0 + vec2(uTime * 0.02, 0.0));
    float d = smoothstep(1.0, 0.15, r + (n - 0.5) * 0.9);
    // fade when the camera is about to pass through (avoids a hard clip plane)
    float near = smoothstep(1.5, 7.0, vCam);
    float a = d * uA * near * 0.55;
    // lit from below by the fire: warm undersides, cool tops
    float under = smoothstep(0.35, -0.4, p.y) * (1.0 - smoothstep(10.0, 30.0, vY));
    vec3 cool = vec3(0.32, 0.38, 0.5);
    vec3 warm = vec3(0.95, 0.45, 0.18);
    vec3 c = mix(cool, warm, under * 0.75) * (0.55 + 0.6 * n);
    gl_FragColor = vec4(c, a);
  }
`;

export function cloudVisibility(t: number) {
  return Math.min(ramp(0.268, 0.282, t), 1 - ramp(0.298, 0.31, t));
}

export function Clouds() {
  const { mesh, mat } = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    const center = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // a loose layer around the camera's descent path (x≈0, y 12→30, z 6→16)
      center[3 * i] = (hash01(i * 3.1) - 0.5) * 26;
      center[3 * i + 1] = 11 + hash01(i * 7.7) * 20;
      center[3 * i + 2] = -4 + hash01(i * 5.3) * 24;
      size[i] = 7 + hash01(i * 9.9) * 9;
      seed[i] = hash01(i * 1.7);
    }
    geo.setAttribute("aCenter", new THREE.InstancedBufferAttribute(center, 3));
    geo.setAttribute("aSize", new THREE.InstancedBufferAttribute(size, 1));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = N;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: { uA: { value: 0 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    return { mesh, mat };
  }, []);

  useFrame((state) => {
    const a = cloudVisibility(film.t);
    mesh.visible = a > 0.002;
    mat.uniforms.uA.value = a;
    mat.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return <primitive object={mesh} />;
}
