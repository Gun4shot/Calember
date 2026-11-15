// The planet: Black Marble night lights, a soft day side lit by the (spinning) sun, an atmosphere rim and stars.
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { sunDir } from "../sats/orbit";
import { SIM_DAY_S } from "../sats/satData";
import { fx } from "../store";
import { R } from "../geo";
import { HASH } from "../world/shaders";

const SPHERE_VS = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec3 vLocal; varying vec3 vW;
  void main() {
    vLocal = normalize(position);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const EARTH_FS = /* glsl */ `
  ${HASH}
  uniform sampler2D uNight; uniform float uHasTex; uniform vec3 uSun; uniform float uDim; uniform float uTime;
  varying vec3 vN; varying vec3 vV; varying vec3 vLocal; varying vec3 vW;
  void main() {
    float lon = atan(vLocal.x, vLocal.z);
    float lat = asin(clamp(vLocal.y, -1.0, 1.0));
    vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.1415927 + 0.5);
    vec3 tx = uHasTex > 0.5 ? texture2D(uNight, uv).rgb : vec3(0.0);
    float lum = dot(tx, vec3(0.299, 0.587, 0.114));
    float sun = dot(vLocal, uSun);
    float day = smoothstep(-0.12, 0.35, sun);
    float twilight = exp(-pow(abs(sun / 0.09), 2.0));
    float ndv = max(dot(vN, vV), 0.0);
    float fres = pow(clamp(1.0 - ndv, 0.0, 1.0), 3.0);
    // base: deep ocean blue-black, land relief from the texture
    vec3 c = vec3(0.010, 0.016, 0.032);
    vec3 land = tx * vec3(0.26, 0.36, 0.66) * 0.42;
    c += land;
    // day side: a cold, desaturated glow so fire stays the hero
    c += vec3(0.016, 0.03, 0.062) * day * (0.4 + 0.6 * smoothstep(0.02, 0.2, lum));
    // city lights only at night (cool, so they never read as fire)
    c += vec3(0.62, 0.72, 0.95) * smoothstep(0.28, 0.9, lum) * 0.55 * (1.0 - day);
    // terminator warmth + rim
    c += vec3(0.95, 0.45, 0.2) * twilight * 0.05;
    c += vec3(0.06, 0.13, 0.32) * fres * (0.35 + 0.5 * day);
    // faint latitude/longitude graticule every 15°
    float g = max(smoothstep(0.985, 1.0, cos(lat * 12.0 * 2.0)), smoothstep(0.985, 1.0, cos(lon * 12.0 * 2.0)));
    c += vec3(0.25, 0.4, 0.7) * g * 0.025;
    c *= 1.0 - 0.72 * uDim;
    gl_FragColor = vec4(c, 1.0);
  }
`;
const ATMO_FS = /* glsl */ `
  uniform vec3 uSun; uniform float uDim;
  varying vec3 vN; varying vec3 vV; varying vec3 vLocal; varying vec3 vW;
  void main() {
    float d = dot(vN, vV);
    float f = smoothstep(0.0, -0.36, d);
    f = f * f * f;
    float lit = 0.45 + 0.75 * smoothstep(-0.4, 0.6, dot(normalize(vW), uSun));
    vec3 col = mix(vec3(0.16, 0.36, 0.95), vec3(0.45, 0.7, 1.0), lit - 0.45);
    gl_FragColor = vec4(col * f * 0.55 * lit, f * (1.0 - 0.6 * uDim));
  }
`;

export function Earth() {
  const { earthMat, atmoMat, stars } = useMemo(() => {
    const earthMat = new THREE.ShaderMaterial({
      vertexShader: SPHERE_VS,
      fragmentShader: EARTH_FS,
      uniforms: { uNight: { value: null }, uHasTex: { value: 0 }, uSun: { value: new THREE.Vector3(0, 0, 1) }, uDim: { value: 0 }, uTime: { value: 0 } },
    });
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: SPHERE_VS,
      fragmentShader: ATMO_FS,
      uniforms: { uSun: earthMat.uniforms.uSun, uDim: earthMat.uniforms.uDim },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}static/textures/black_marble_2016_3600.jpg`, (tex) => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.anisotropy = 8;
      earthMat.uniforms.uNight.value = tex;
      earthMat.uniforms.uHasTex.value = 1;
    });
    // stars: a far shell with a faint galactic band (deterministic)
    const n = 6000;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const tint = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const h1 = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(i * 78.233) * 12543.123) % 1;
      const h3 = Math.abs(Math.sin(i * 39.425) * 24634.6345) % 1;
      let a = h1 * Math.PI * 2;
      let z = h2 * 2 - 1;
      if (i % 3 === 0) {
        // band: squeeze toward a tilted great circle
        z = (z * 0.18);
        a += 0.4;
      }
      const r = Math.sqrt(1 - z * z);
      const v = new THREE.Vector3(Math.cos(a) * r, z, Math.sin(a) * r).applyAxisAngle(new THREE.Vector3(1, 0, 0.3).normalize(), 1.05).multiplyScalar(900);
      pos.set([v.x, v.y, v.z], i * 3);
      size[i] = 0.6 + 2.2 * Math.pow(h3, 6);
      tint[i] = h3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aTint", new THREE.BufferAttribute(tint, 1));
    const sm = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aTint; uniform float uTime; varying float vT; varying float vA;
        void main(){ vT = aTint; vec4 mv = modelViewMatrix * vec4(position,1.0);
          vA = 0.55 + 0.45 * sin(uTime * (0.6 + aTint * 2.0) + aTint * 40.0);
          gl_PointSize = aSize * 1.6; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        varying float vT; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.25, 0.0, dot(d,d));
          vec3 c = mix(vec3(0.7,0.8,1.0), vec3(1.0,0.86,0.7), step(0.7, vT));
          gl_FragColor = vec4(c, a * (0.35 + 0.5 * vA)); }`,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
    });
    const stars = new THREE.Points(g, sm);
    stars.frustumCulled = false;
    return { earthMat, atmoMat, stars };
  }, []);

  useFrame((state) => {
    const mNum = 1 + (Math.floor(fx.monthF + 10) % 12); // months start at 2000-11
    sunDir(fx.simT, SIM_DAY_S, mNum, earthMat.uniforms.uSun.value as THREE.Vector3);
    earthMat.uniforms.uDim.value = fx.globeDim;
    (stars.material as THREE.ShaderMaterial).uniforms.uTime.value = state.clock.elapsedTime;
    // stars sit around the camera so they never parallax off
    stars.position.copy(state.camera.position);
  });

  return (
    <>
      <primitive object={stars} />
      <mesh material={earthMat} renderOrder={-2} name="earth">
        <sphereGeometry args={[R, 128, 96]} />
      </mesh>
      <mesh material={atmoMat} scale={1.045} renderOrder={5}>
        <sphereGeometry args={[R, 64, 48]} />
      </mesh>
    </>
  );
}
