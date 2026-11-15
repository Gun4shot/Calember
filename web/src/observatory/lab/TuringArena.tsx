// The Sensor Turing Test arena: 10 rounds (5 raw VIIRS, then 5 Calember). Two 24-month series draw themselves;
// pick the real MODIS one (keys 1 / 2). The reveal ignites the real one amber and labels the other.
import { useEffect, useMemo, useState } from "react";
import { api, statics } from "../../app/api";
import { MONTHS_SHORT, fmt } from "../../app/format";
import type { TuringRound, ValidationReport } from "../../app/types";
import { sfx } from "../sfx";

/** answers needed before the crowd's accuracy is shown */
const MIN_CROWD = 20;

const PER_SET = 5;

function Series({ v, max, state, start, label }: { v: number[]; max: number; state: "idle" | "real" | "fake-raw" | "fake-ember"; start: string; label: string }) {
  const W = 420, H = 190, L = 40, B = 24, T = 14;
  const x = (i: number) => L + (i / (v.length - 1)) * (W - L - 10);
  const y = (p: number) => H - B - (p / max) * (H - B - T);
  const d = v.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join("");
  const ticks = [0, max / 2, max];
  const m0 = Number(start.slice(5, 7)) - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`series s-${state}`} role="img" aria-label={`${label}: ${v.map((p) => fmt(p)).join(", ")}`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - 10} y1={y(t)} y2={y(t)} className="s-grid" />
          <text x={L - 6} y={y(t) + 3} textAnchor="end" className="s-axis">
            {t >= 1000 ? `${(t / 1000).toFixed(1)}k` : Math.round(t)}
          </text>
        </g>
      ))}
      {v.map((_, i) =>
        (m0 + i) % 12 === 0 ? (
          <text key={i} x={x(i)} y={H - 6} className="s-axis" textAnchor="middle">
            {MONTHS_SHORT[0]} {Number(start.slice(0, 4)) + Math.floor((m0 + i) / 12)}
          </text>
        ) : null,
      )}
      <path d={`${d}L${x(v.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} className="s-area" />
      <path d={d} className="s-line" pathLength={1} />
    </svg>
  );
}

export function TuringArena() {
  const [pool, setPool] = useState<TuringRound[] | null>(null);
  const [v, setV] = useState<ValidationReport | null>(null);
  const [stats, setStats] = useState<Record<"raw" | "harmonized", { n: number; accuracy: number | null }> | null>(null);
  const [i, setI] = useState(-1); // -1 = intro
  const [picked, setPicked] = useState<"a" | "b" | null>(null);
  const [score, setScore] = useState({ raw: 0, harmonized: 0 });
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  useEffect(() => {
    statics.turing().then((t) => setPool(t.rounds), () => setPool([]));
    statics.validation().then(setV, () => undefined);
  }, []);
  const rounds = useMemo(() => {
    if (!pool) return [];
    let s = seed;
    const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const pick = (set: string) => [...pool.filter((r) => r.set === set)].sort(() => rnd() - 0.5).slice(0, PER_SET);
    return [...pick("raw"), ...pick("harmonized")];
  }, [pool, seed]);
  const r = i >= 0 ? rounds[i] : undefined;
  const done = i >= rounds.length && rounds.length > 0;
  useEffect(() => {
    if (done) api.turingStats().then(setStats, () => undefined);
  }, [done]);

  const choose = (c: "a" | "b") => {
    if (picked || !r) return;
    setPicked(c);
    const ok = c === r.modis_is;
    if (ok) setScore((s) => ({ ...s, [r.set]: s[r.set as "raw" | "harmonized"] + 1 }));
    ok ? sfx.lock() : sfx.cliff(false);
    api.turingAnswer(r.id, c).catch(() => undefined);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (i < 0 && (e.key === "Enter" || e.key === " ")) setI(0);
      else if (r && !picked && (e.key === "1" || e.key === "2")) choose(e.key === "1" ? "a" : "b");
      else if (picked && (e.key === "Enter" || e.key === " " || e.key === "ArrowRight")) next();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
  const next = () => {
    setPicked(null);
    setI((k) => k + 1);
  };
  const T = v?.turing as Record<string, { accuracy: number }> | undefined;
  const total = score.raw + score.harmonized;
  return (
    <section className="arena glass" aria-label="Sensor Turing Test">
      <a className="icon-btn arena-x" href="#/" aria-label="Back to the globe">
        ✕
      </a>
      {i < 0 && (
        <div className="arena-intro">
          <p className="kicker">Sensor Turing Test</p>
          <h1>Can you tell real MODIS from the other one?</h1>
          <p>
            Ten rounds. Each shows two 24-month fire series for the same place and time. One is real NASA MODIS. In rounds 1–5 the other is <b className="viirs">raw VIIRS</b>; in rounds 6–10 it is{" "}
            <b className="ember">Calember</b>, VIIRS translated into MODIS-equivalent hotspots.
          </p>
          <p className="muted">If harmonization works, the second half should feel like a coin flip.</p>
          <button type="button" className="btn-hot" onClick={() => setI(0)} disabled={!rounds.length}>
            Start <kbd>↵</kbd>
          </button>
        </div>
      )}
      {r && (
        <div className="arena-round" key={r.id}>
          <div className="arena-head">
            <p className="kicker">
              Round {i + 1} of {rounds.length} · {r.set === "raw" ? "MODIS vs raw VIIRS" : "MODIS vs Calember"}
            </p>
            <h2>
              {r.region_name} · from {r.start}
            </h2>
            <div className="pips" aria-hidden="true">
              {rounds.map((_, k) => (
                <span key={k} className={k < i ? "done" : k === i ? "now" : ""} />
              ))}
            </div>
          </div>
          <div className="pair">
            {(["a", "b"] as const).map((k, n) => {
              const max = Math.max(1, ...r.a, ...r.b) * 1.08;
              const real = r.modis_is === k;
              const state = !picked ? "idle" : real ? "real" : r.set === "raw" ? "fake-raw" : "fake-ember";
              return (
                <button key={k} type="button" className={`choice ${picked === k ? "picked" : ""} ${state}`} onClick={() => choose(k)} disabled={!!picked} aria-keyshortcuts={String(n + 1)}>
                  <span className="choice-head">
                    <span className="choice-k">{n + 1}</span>
                    series {n + 1}
                    {picked && <span className="choice-tag">{real ? "Real MODIS" : r.set === "raw" ? "Raw VIIRS" : "Calember"}</span>}
                  </span>
                  <Series v={r[k]} max={max} state={state} start={r.start} label={`Series ${n + 1}`} />
                </button>
              );
            })}
          </div>
          <div className="arena-foot">
            {!picked ? (
              <p className="muted">Which one is real MODIS? Click or press 1 / 2.</p>
            ) : (
              <>
                <p className={picked === r.modis_is ? "ok" : "bad"}>
                  {picked === r.modis_is ? "Correct." : "Not this time."}{" "}
                  {r.set === "raw" ? "Raw VIIRS gives itself away by sheer volume." : "Calember's shape follows MODIS closely; it is genuinely hard."}
                </p>
                <button type="button" className="btn-hot" onClick={next}>
                  {i + 1 < rounds.length ? "Next round" : "See your score"} <kbd>↵</kbd>
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {done && (
        <div className="arena-end">
          <p className="kicker">Your result</p>
          <h1>
            <span className="viirs">{score.raw}/5</span> against raw VIIRS · <span className="ember">{score.harmonized}/5</span> against Calember
          </h1>
          <p>
            {score.harmonized <= 3 ? "Against Calember you were close to a coin flip. That is the point: the sensor of origin no longer shows." : "Sharp eyes. Across many players and our machine test, Calember sits close to a coin flip."}
          </p>
          <div className="end-grid">
            {T?.harmonized && (
              <div className="fact big">
                <span className="fk">our machine vs Calember</span>
                <span className="fv">{Math.round(T.harmonized.accuracy * 100)} %</span>
                <span className="fine">raw VIIRS: {Math.round((T.raw?.accuracy ?? 0) * 100)} % · coin flip 50 %</span>
              </div>
            )}
            {stats && (
              <div className="fact big">
                <span className="fk">humans so far vs Calember</span>
                {/* a handful of answers is noise: show the share only once there is a crowd behind it */}
                <span className="fv">{stats.harmonized.accuracy !== null && stats.harmonized.n >= MIN_CROWD ? `${Math.round(stats.harmonized.accuracy * 100)} %` : "–"}</span>
                <span className="fine">
                  {stats.harmonized.n >= MIN_CROWD
                    ? `${fmt(stats.harmonized.n)} answers · vs raw ${stats.raw.accuracy !== null && stats.raw.n >= MIN_CROWD ? `${Math.round(stats.raw.accuracy * 100)} %` : "–"}`
                    : `${fmt(stats.harmonized.n)} answer${stats.harmonized.n === 1 ? "" : "s"} so far; shown from ${MIN_CROWD}`}
                </span>
              </div>
            )}
          </div>
          <div className="ctl-row">
            <button
              type="button"
              className="btn-hot"
              onClick={() => {
                setSeed(Math.floor(Math.random() * 1e9));
                setScore({ raw: 0, harmonized: 0 });
                setI(0);
              }}
            >
              Play again
            </button>
            <button type="button" className="btn-ghost" onClick={() => void navigator.clipboard?.writeText(`Calember Sensor Turing Test: ${score.raw}/5 vs raw VIIRS, ${score.harmonized}/5 vs Calember (${total}/10).`)}>
              Copy my result
            </button>
            <a className="btn-ghost" href="#/lab">
              See the proof →
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
