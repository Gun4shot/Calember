// The time ribbon: the world's monthly hotspots 2000 → now (from the WORLD calendar), the record's eras, satellite
// launch / end markers, a "ghost" future to 2030 where Terra and Aqua retire, and the draggable playhead.
import { useEffect, useMemo, useRef, useState } from "react";
import { fmt, monthLabel } from "../../app/format";
import type { Calendar } from "../../app/types";
import { SATS } from "../sats/satData";
import { sfx } from "../sfx";
import { useObs } from "../store";
import { TIMELINE_LEN } from "../world/World";

const W = 1000, H = 64, TOP = 14, BOT = 50;
const ERA: Record<string, { label: string; cls: string }> = {
  T: { label: "Terra only", cls: "era-T" },
  M: { label: "Terra + Aqua (measured)", cls: "era-M" },
  B: { label: "Blended with VIIRS", cls: "era-B" },
  V: { label: "Translated from VIIRS", cls: "era-V" },
  N: { label: "Provisional", cls: "era-N" },
};
export const idxOf = (m: string) => (Number(m.slice(0, 4)) - 2000) * 12 + Number(m.slice(5, 7)) - 11;
export const monthAt = (idx: number) => {
  const y = 2000 + Math.floor((idx + 10) / 12);
  const m = ((idx + 10) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
};

export function TimeRibbon({ world, recordLen }: { world: Calendar | null; recordLen: number }) {
  const monthIdx = useObs((s) => s.monthIdx);
  const playing = useObs((s) => s.playing);
  // while the record plays, each new year chimes softly (silent when sound is off)
  useEffect(
    () =>
      useObs.subscribe((s, prev) => {
        if (s.playing && s.monthIdx !== prev.monthIdx && monthAt(s.monthIdx).endsWith("-01")) sfx.year();
      }),
    [],
  );
  const set = useObs((s) => s.set);
  const view = useObs((s) => s.view);
  const areaCal = useObs((s) => s.calendar);
  const shape = useObs((s) => s.shape);
  const [typing, setTyping] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const x = (i: number) => (i / (TIMELINE_LEN - 1)) * W;

  const { area, line, eras } = useMemo(() => {
    if (!world) return { area: "", line: "", eras: [] as Array<{ r: string; a: number; b: number }> };
    const vals = world.months.map((m) => m.h_count);
    const max = Math.max(...vals) * 1.05;
    const y = (v: number) => BOT - (v / max) * (BOT - TOP);
    let line = "";
    world.months.forEach((m, i) => (line += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(m.h_count).toFixed(1)}`));
    const area = `${line}L${x(world.months.length - 1).toFixed(1)},${BOT}L0,${BOT}Z`;
    const eras: Array<{ r: string; a: number; b: number }> = [];
    world.months.forEach((m, i) => {
      const last = eras[eras.length - 1];
      if (last && last.r === m.regime) last.b = i;
      else eras.push({ r: m.regime, a: i, b: i });
    });
    return { area, line, eras };
  }, [world]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFromX = (clientX: number) => {
    const r = svg.current!.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    set({ monthIdx: Math.round(k * (TIMELINE_LEN - 1)), playing: false });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,[role=combobox]") || useObs.getState().paletteOpen) return;
      if (useObs.getState().view === "area" && useObs.getState().station === "calendar") return; // the calendar owns the arrows there
      const st = useObs.getState();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const d = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 12 : 1);
        st.set({ monthIdx: Math.max(0, Math.min(TIMELINE_LEN - 1, st.monthIdx + d)), playing: false });
      } else if (e.key === " " && st.view === "globe") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const togglePlay = () => {
    const st = useObs.getState();
    if (st.playing) st.set({ playing: false });
    else st.set({ playing: true, monthIdx: st.monthIdx >= TIMELINE_LEN - 2 ? 0 : st.monthIdx });
  };

  const cur = world?.months[Math.min(monthIdx, (world?.months.length ?? 1) - 1)];
  const future = monthIdx >= recordLen;
  const label = monthLabel(monthAt(monthIdx));
  const ghostX = x(recordLen - 1);
  if (view === "lab" || view === "turing" || view === "about" || view === "rankings") return null;

  return (
    <section className="ribbon glass" aria-label="Timeline">
      <button type="button" className="play-btn" onClick={togglePlay} aria-label={playing ? "Pause the timeline" : "Play the timeline"} aria-keyshortcuts="Space">
        {playing ? (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="5" y="4" width="3.5" height="12" rx="1" fill="currentColor" />
            <rect x="11.5" y="4" width="3.5" height="12" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M6 4l10 6-10 6z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="ribbon-read" aria-live="polite">
        {typing ? (
          <input
            className="ribbon-input"
            type="month"
            autoFocus
            min="2000-11"
            max="2030-12"
            defaultValue={monthAt(monthIdx)}
            aria-label="Go to month"
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d{4}-\d{2}$/.test(v) && v >= "2000-11" && v <= "2030-12") set({ monthIdx: idxOf(v), playing: false });
            }}
            onBlur={() => setTyping(false)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && setTyping(false)}
          />
        ) : (
          <button type="button" className="ribbon-month" onClick={() => setTyping(true)} title="Type or pick a month">
            {label}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        )}
        <div className="ribbon-val">
          {future
            ? "ghost MODIS · after the record"
            : view === "area" && areaCal
              ? (() => {
                  const am = areaCal.months.find((m) => m.month === monthAt(monthIdx));
                  return am ? `${fmt(am.h_count)} hotspots in ${shape?.name.split(",")[0] ?? "this area"}` : "outside this area's record";
                })()
              : cur
                ? `${fmt(cur.h_count)} hotspots worldwide`
                : "…"}
        </div>
      </div>
      <div className="ribbon-track">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="slider"
          tabIndex={0}
          aria-label="Month"
          aria-valuemin={0}
          aria-valuemax={TIMELINE_LEN - 1}
          aria-valuenow={monthIdx}
          aria-valuetext={label}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setFromX(e.clientX);
          }}
          onPointerMove={(e) => dragging.current && setFromX(e.clientX)}
          onPointerUp={() => (dragging.current = false)}
        >
          <defs>
            <linearGradient id="rb-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#ffb347" stopOpacity="0.55" />
              <stop offset="1" stopColor="#ff6a1f" stopOpacity="0.02" />
            </linearGradient>
            <pattern id="rb-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="transparent" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#9fb3d9" strokeOpacity="0.22" strokeWidth="2" />
            </pattern>
          </defs>
          {eras.map((e) => (
            <rect key={e.r + e.a} className={`era ${ERA[e.r]?.cls ?? ""}`} x={x(e.a)} y={BOT + 2} width={Math.max(1, x(e.b + 1) - x(e.a))} height={4}>
              <title>{`${ERA[e.r]?.label ?? e.r}: ${monthLabel(monthAt(e.a))} – ${monthLabel(monthAt(e.b))}`}</title>
            </rect>
          ))}
          <rect x={ghostX} y={TOP - 4} width={W - ghostX} height={BOT - TOP + 4} fill="url(#rb-hatch)" />
          <text x={(ghostX + W) / 2} y={TOP + 14} className="rb-ghost-label" textAnchor="middle">
            after MODIS
          </text>
          {area && <path d={area} fill="url(#rb-fill)" />}
          {line && <path d={line} fill="none" stroke="#ffd08a" strokeWidth="1.1" vectorEffect="non-scaling-stroke" />}
          {SATS.map((s) => (
            <g key={s.id} className={`rb-sat rb-${s.instrument.toLowerCase()}`}>
              <line x1={x(idxOf(s.start))} x2={x(idxOf(s.start))} y1={2} y2={BOT} vectorEffect="non-scaling-stroke" />
              {s.end && <line className="rb-end" x1={x(idxOf(s.end))} x2={x(idxOf(s.end))} y1={2} y2={BOT} vectorEffect="non-scaling-stroke" />}
            </g>
          ))}
          <line x1={x(monthIdx)} x2={x(monthIdx)} y1={0} y2={H} className="rb-head" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="ribbon-labels">
          {SATS.map((s) => (
            <span key={s.id} className={`rb-tag rb-${s.instrument.toLowerCase()}`} style={{ left: `${(idxOf(s.start) / (TIMELINE_LEN - 1)) * 100}%` }}>
              {s.name}
            </span>
          ))}
          {["2000", "2010", "2020", "2030"].map((y) => (
            <button
              key={y}
              type="button"
              tabIndex={-1}
              className={`rb-year ${Number(y) % 10 === 5 ? "minor" : ""}`}
              style={{ left: `${(Math.max(0, idxOf(`${y}-01`)) / (TIMELINE_LEN - 1)) * 100}%` }}
              onClick={() => set({ monthIdx: Math.max(0, idxOf(`${y}-${y === "2000" ? "11" : String(Number(monthAt(useObs.getState().monthIdx).slice(5, 7))).padStart(2, "0")}`)), playing: false })}
              title={`Jump to ${y}`}
            >
              {y}
            </button>
          ))}
          <span className="rb-head-dot" style={{ left: `${(monthIdx / (TIMELINE_LEN - 1)) * 100}%` }} />
        </div>
      </div>
    </section>
  );
}
