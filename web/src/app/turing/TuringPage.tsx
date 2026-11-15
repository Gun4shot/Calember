import { scaleLinear } from "d3";
import { useEffect, useMemo, useState } from "react";
import { api, statics } from "../api";
import { fmt } from "../format";
import type { TuringRound, ValidationReport } from "../types";

const PER_SET = 5;

function Spark({ v, max, label }: { v: number[]; max: number; label: string }) {
  const W = 300, H = 110, L = 34, B = 16, T = 8;
  const x = scaleLinear().domain([0, v.length - 1]).range([L, W - 6]);
  const y = scaleLinear().domain([0, max]).range([H - B, T]);
  const d = v.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: 24 monthly values, ${v.map((p) => fmt(p)).join(", ")}`}>
      {y.ticks(3).map((t) => (
        <g key={t}>
          <line x1={L} x2={W - 6} y1={y(t)} y2={y(t)} stroke="#232830" />
          <text x={L - 4} y={y(t) + 3} textAnchor="end" className="cal-axis">
            {t >= 1000 ? `${t / 1000}k` : t}
          </text>
        </g>
      ))}
      <path d={`${d}L${x(v.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill="rgba(255,196,92,0.12)" />
      <path d={d} fill="none" stroke="#ffc45c" strokeWidth={1.8} />
    </svg>
  );
}

export function TuringPage() {
  const [pool, setPool] = useState<TuringRound[] | null>(null);
  const [v, setV] = useState<ValidationReport | null>(null);
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<"a" | "b" | null>(null);
  const [score, setScore] = useState({ raw: 0, harmonized: 0 });
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  useEffect(() => {
    statics.turing().then((t) => setPool(t.rounds), () => setPool([]));
    statics.validation().then(setV, () => setV(null));
  }, []);
  const rounds = useMemo(() => {
    if (!pool) return [];
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pick = (set: string) => [...pool.filter((r) => r.set === set)].sort(() => rnd() - 0.5).slice(0, PER_SET);
    return [...pick("raw"), ...pick("harmonized")];
  }, [pool, seed]);

  if (!pool) return <main className="page"><p role="status">Loading rounds…</p></main>;
  const done = i >= rounds.length;
  const r = rounds[i];
  const T = v?.turing as Record<string, { accuracy: number; n?: number }> | undefined;

  const choose = (c: "a" | "b") => {
    if (picked || !r) return;
    setPicked(c);
    const ok = c === r.modis_is;
    if (ok) setScore((s) => ({ ...s, [r.set]: s[r.set] + 1 }));
    api.turingAnswer(r.id, c).catch(() => undefined); // anonymous tally; works without the API too
  };
  const next = () => {
    setPicked(null);
    setI((n) => n + 1);
  };
  const restart = () => {
    setSeed(Math.floor(Math.random() * 1e9));
    setI(0);
    setPicked(null);
    setScore({ raw: 0, harmonized: 0 });
  };

  return (
    <main className="page turing" id="main">
      <header className="page-head">
        <p className="kicker">The Sensor Turing Test</p>
        <h1>Can you tell which line is real MODIS?</h1>
        <p className="lede">
          Each round shows two years of monthly fire counts for a real province. One line is what MODIS actually recorded. Rounds 1–{PER_SET} pit MODIS against{" "}
          <strong>raw VIIRS</strong>; rounds {PER_SET + 1}–{PER_SET * 2} against <strong>Calember</strong>.
        </p>
      </header>

      {!done && r && (
        <section className="round" aria-live="polite">
          <div className="round-meta">
            <span className="pill">
              Round {i + 1} / {rounds.length} · {r.set === "raw" ? "MODIS vs raw VIIRS" : "MODIS vs Calember"}
            </span>
            <span className="muted">
              {r.region_name} · from {r.start}
            </span>
          </div>
          <div className="pair">
            {(["a", "b"] as const).map((k) => {
              const vals = r[k];
              const max = Math.max(...r.a, ...r.b) * 1.05 || 1;
              const state = picked ? (k === r.modis_is ? "is-right" : picked === k ? "is-wrong" : "") : "";
              return (
                <figure key={k} className={`spark ${state}`}>
                  <figcaption>Line {k.toUpperCase()}</figcaption>
                  <Spark v={vals} max={max} label={`Line ${k.toUpperCase()}`} />
                  <button type="button" className="btn" disabled={!!picked} onClick={() => choose(k)}>
                    {k.toUpperCase()} is MODIS
                  </button>
                </figure>
              );
            })}
          </div>
          {picked && (
            <div className="verdict" role="status">
              <strong>{picked === r.modis_is ? "Correct." : "Not this time."}</strong> Line {r.modis_is?.toUpperCase()} was MODIS.{" "}
              {r.set === "raw" ? "Raw VIIRS counts are several times higher and spikier." : "Calember's line is a calibrated sample of what MODIS would have recorded."}
              <button type="button" className="btn btn-small" onClick={next} autoFocus>
                {i + 1 < rounds.length ? "Next round" : "See your score"}
              </button>
            </div>
          )}
        </section>
      )}

      {done && (
        <section className="result">
          <h2>Your score</h2>
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-v">
                {score.raw}/{PER_SET}
              </div>
              <div className="stat-k">MODIS vs raw VIIRS</div>
            </div>
            <div className="stat">
              <div className="stat-v">
                {score.harmonized}/{PER_SET}
              </div>
              <div className="stat-k">MODIS vs Calember</div>
            </div>
          </div>
          <p>
            A coin flip scores {PER_SET / 2} out of {PER_SET}.{" "}
            {T && (
              <>
                Our machine discriminator, tested on {fmt((T.raw.n ?? 0) / 2)} provinces, spots raw VIIRS <strong>{(T.raw.accuracy * 100).toFixed(0)} %</strong> of the time but Calember only{" "}
                <strong>{(T.harmonized.accuracy * 100).toFixed(0)} %</strong> (coin flip = 50 %).
              </>
            )}
          </p>
          <button type="button" className="btn" onClick={restart}>
            Play again
          </button>
        </section>
      )}
    </main>
  );
}
