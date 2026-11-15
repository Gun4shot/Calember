// The one persistent canvas. Everything 3D lives here; routes only move the camera and swap DOM panels.
import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Suspense, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { NanGuard } from "../../app/NanGuard";
import type { GlobeData } from "../data";
import { Borders } from "../globe/Borders";
import { Earth } from "../globe/Earth";
import { FireLayer } from "../globe/FireLayer";
import { Pickers } from "../globe/Pickers";
import { Satellites } from "../sats/Satellites";
import { Stage } from "../stage/Stage";
import { fx, useObs } from "../store";
import { cam, stepCamera } from "./camera";

function Director() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const view = useObs((s) => s.view);
  const reduced = useObs((s) => s.reduced);
  useEffect(() => {
    cam.reduced = reduced;
  }, [reduced]);
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.2);
    // the orbital sim clock (illustrative speed-up); slower under reduced motion
    fx.simT += dt * (reduced ? 0.15 : 1);
    // timeline: playing advances ~6 months per second
    const st = useObs.getState();
    if (st.playing) {
      fx.monthF += dt * (view === "area" ? 1.5 : 6);
      const max = TIMELINE_LEN - 1;
      if (fx.monthF >= max) {
        fx.monthF = max;
        useObs.setState({ playing: false });
      }
      const mi = Math.floor(fx.monthF);
      if (mi !== st.monthIdx) useObs.setState({ monthIdx: mi });
    } else {
      // ease toward the selected month
      fx.monthF += (st.monthIdx - fx.monthF) * (1 - Math.exp(-dt * 10));
      if (Math.abs(st.monthIdx - fx.monthF) < 0.002) fx.monthF = st.monthIdx;
    }
    const dimTarget = view === "area" && st.station !== "twins" ? 1 : view === "lab" || view === "turing" || view === "about" || view === "rankings" ? 0.6 : 0;
    fx.globeDim += (dimTarget - fx.globeDim) * (1 - Math.exp(-dt * 2.5));
    stepCamera(camera, dt, view === "globe" && st.tool === "none" && !st.candidate);
  });
  return null;
}

/** Timeline: the record (2000-11 → 2026-11) plus a "ghost" future to 2030-12. */
export const RECORD_LEN = 313;
export const TIMELINE_LEN = RECORD_LEN + 49;

export function World({ g, inArea, paused = false }: { g: GlobeData | null; inArea: Uint8Array | null; paused?: boolean }) {
  const [dpr, setDpr] = useState(Math.min(2, window.devicePixelRatio || 1));
  const [fxOn, setFxOn] = useState(true);
  const step = useRef(0); // quality steps taken down (never back up)
  return (
    <Canvas
      className="world"
      dpr={dpr}
      frameloop={paused ? "never" : "always"}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
      camera={{ fov: 38, near: 0.06, far: 3000, position: [0, 8, 36] }}
      onCreated={({ gl, scene, camera }) => {
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__three = { gl, scene, camera };
        gl.setClearColor("#04060b");
        gl.toneMapping = THREE.NoToneMapping;
      }}
    >
      {/* Quality only ever steps DOWN, at most twice per visit: first the resolution, then the bloom. Raising it again
          when the frame rate recovered made it flip back and forth every few seconds on laptops (each flip resizes
          the canvas and the effect buffers: a visible flash), worst on 120/144 Hz screens in the heavy stations. */}
      <PerformanceMonitor
        onDecline={() => {
          if (step.current >= 2) return;
          step.current++;
          if (step.current === 1 && dpr > 1) setDpr(1);
          else {
            step.current = 2;
            setFxOn(false);
          }
        }}
      />
      <ambientLight intensity={0.5} />
      <directionalLight position={[20, 30, 10]} intensity={1.6} />
      <Director />
      <Suspense fallback={null}>
        <Earth />
        <Borders />
        {g && <FireLayer g={g} inArea={inArea} />}
        <Satellites />
        <Pickers />
        <Stage />
      </Suspense>
      {/* the composer always runs (it owns the final colour conversion); weak GPUs only lose the bloom */}
      {/* No MSAA: on Intel/D3D11 a multisampled half-float buffer renders every frame black. NanGuard must stay first:
          it scrubs non-finite pixels before the mipmap bloom can smear one over the whole frame (black flicker). */}
      <EffectComposer multisampling={0} ref={(c: unknown) => { if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__composer = c; }}>
        <NanGuard />
        <Bloom mipmapBlur intensity={fxOn ? 0.7 : 0} luminanceThreshold={0.62} luminanceSmoothing={0.25} radius={0.65} />
        <Vignette eskil={false} offset={0.22} darkness={0.75} />
      </EffectComposer>
    </Canvas>
  );
}
