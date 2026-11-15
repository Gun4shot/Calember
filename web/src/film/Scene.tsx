import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { NanGuard } from "../app/NanGuard";
import { useRef, useState } from "react";
import { audioTick, audioTickU, lensNote, lensWhoosh } from "./audio";
import { DataTower } from "./DataTower";
import { Evidence } from "./Evidence";
import { MethodFlow } from "./MethodFlow";
import { Scatter } from "./Scatter";
import { TuringWall } from "./TuringWall";
import { buzz } from "./haptics";
import { CameraRig } from "./CameraRig";
import { Clouds } from "./Clouds";
import type { StoryData } from "./data";
import { Globe, globeVisibility, rawMixAt } from "./Globe";
import { Ground, groundVisibility } from "./Ground";
import { clamp, ramp } from "./math";
import { Ridge, harmonizeK } from "./Ridge";
import { film, useUI } from "./store";
import { globeMonthS } from "./timeline";

function AudioDriver({ data }: { data: StoryData }) {
  const three = useThree();
  if (import.meta.env.DEV) Object.assign(window, { __three: three });
  const prev = useRef(0);
  const prevU = useRef(0);
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const lastLens = useRef(-1);
  const g = data.globe;
  const sw = g.months.indexOf("2012-01");
  const maxRaw = Math.max(...g.meta.monthly_total_raw);
  useFrame((_, dt) => {
    const t = film.t;
    let activity = 0.05;
    const gv = globeVisibility(t);
    if (gv > 0.01) {
      const m = Math.round(globeMonthS(film.s, g.meta.n_months, sw));
      const raw = rawMixAt(t);
      const tot = g.meta.monthly_total_harm[m] * (1 - raw) + g.meta.monthly_total_raw[m] * raw;
      activity = gv * Math.sqrt(tot / maxRaw);
    }
    activity = Math.max(activity, groundVisibility(t) * (0.55 - 0.4 * ramp(0.42, 0.5, t)));
    activity = Math.max(activity, 0.12 * (1 - harmonizeK(t)) * ramp(0.44, 0.5, t));
    const inActs = film.u > 0 && film.u < 1;
    if (inActs) activity = 0.08; // a quiet bed under the results acts
    audioTick(prev.current, t, dt, clamp(activity), 0);
    audioTickU(prevU.current, film.u, inActs);
    prev.current = t;
    prevU.current = film.u;
    // lens notes
    if (film.lensActive && film.lensUser) {
      const mi = Math.round(film.lensMonth);
      if (mi !== lastLens.current && lastLens.current >= 0) {
        const reg = data.ridge.regions[useUI.getState().regionIdx];
        let mx = 1;
        for (const v of reg.raw_sum) mx = Math.max(mx, v);
        lensNote(Math.sqrt(reg.raw_sum[mi] / mx), Math.sqrt(reg.harmonized[mi] / mx) * 2.2);
        if (coarse) buzz(4);
      }
      lensWhoosh(film.lensSpeed, dt);
      lastLens.current = mi;
    } else {
      lastLens.current = -1;
      lensWhoosh(0, dt);
    }
  });
  return null;
}

export function Scene({ data }: { data: StoryData }) {
  const [hq, setHq] = useState(true);
  const [dpr, setDpr] = useState(1.5);
  return (
    <Canvas
      className="film-canvas"
      dpr={dpr}
      gl={{ antialias: !hq ? true : false, powerPreference: "high-performance", alpha: false }}
      camera={{ fov: 34, near: 0.05, far: 2000, position: [0, 120, 160] }}
      onCreated={(s) => {
        s.gl.setClearColor("#05070d");
        if (import.meta.env.DEV) Object.assign(window, { __three: s });
      }}
      aria-hidden="true"
    >
      <PerformanceMonitor
        onDecline={() => {
          if (new URLSearchParams(location.search).has("hq")) return;
          if (dpr > 1) setDpr(1);
          else setHq(false);
        }}
        flipflops={3}
      />
      <CameraRig />
      <Globe data={data} />
      <Ground />
      <Clouds />
      <Ridge data={data} />
      <DataTower data={data} />
      <MethodFlow data={data} />
      <Scatter data={data} />
      <Evidence data={data} />
      <TuringWall data={data} />
      <AudioDriver data={data} />
      {hq && (
        <EffectComposer multisampling={0}>
          {/* first: scrubs non-finite pixels before the mipmap bloom can black out a frame (see app/NanGuard.tsx) */}
          <NanGuard />
          <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.42} luminanceSmoothing={0.25} radius={0.7} />
          <Vignette offset={0.25} darkness={0.75} />
          <Noise opacity={0.035} premultiply />
        </EffectComposer>
      )}
    </Canvas>
  );
}
