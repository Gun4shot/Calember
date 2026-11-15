import { scaleLinear } from "d3";
import { useEffect, useState } from "react";
import { statics } from "../api";
import { fmt } from "../format";
import { useApp } from "../store";
import type { Drift, ValidationReport } from "../types";

type Acc = { accuracy: number; ci95?: number[]; n?: number; seeds?: number[] };

function Bars({ rows, max = 1, min = 0, fmtV, label }: { rows: Array<{ k: string; v: number; hi?: boolean; note?: string }>; max?: number; min?: number; fmtV: (v: number) => string; label: string }) {
  return (
    <div className="bars" role="list" aria-label={label}>
      {rows.map((r) => (
        <div key={r.k} className={`bar-row ${r.hi ? "bar-hi" : ""}`} role="listitem" aria-label={`${r.k}: ${fmtV(r.v)}`}>
          <span className="bar-k">{r.k}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${Math.max(2, (100 * (r.v - min)) / (max - min))}%` }} />
          </span>
          <span className="bar-v">{fmtV(r.v)}</span>
          {r.note && <span className="bar-note">{r.note}</span>}
        </div>
      ))}
    </div>
  );
}

function DriftChart({ d }: { d: Drift }) {
  const W = 560, H = 200, L = 40, R = 12, T = 14, B = 24;
  const sats = ["AQUA", "TERRA"] as const;
  const pts = (s: string) => d.overpass.filter((o) => o.satellite === s && o.n >= 2000);
  const toX = (m: string) => Number(m.slice(0, 4)) + (Number(m.slice(5, 7)) - 0.5) / 12;
  const x = scaleLinear().domain([2000.8, 2026.9]).range([L, W - R]);
  const y = scaleLinear().domain([8.5, 15.2]).range([H - B, T]);
  const path = (s: string) => pts(s).map((p, i) => `${i ? "L" : "M"}${x(toX(p.month)).toFixed(1)},${y(p.median_local_hour).toFixed(1)}`).join("");
  const hh = (v: number) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Median overpass time of MODIS fire detections, 2000 to 2026. ${d.summary}`}>
      {[9, 10, 11, 12, 13, 14, 15].map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#232830" />
          <text x={L - 6} y={y(t) + 3} className="cal-axis" textAnchor="end">
            {t}:00
          </text>
        </g>
      ))}
      {[2005, 2010, 2015, 2020, 2025].map((v) => (
        <text key={v} x={x(v)} y={H - 6} className="cal-axis" textAnchor="middle">
          {v}
        </text>
      ))}
      <path d={path("AQUA")} fill="none" stroke="#ffc45c" strokeWidth={1.6} />
      <path d={path("TERRA")} fill="none" stroke="#8bd3ff" strokeWidth={1.6} />
      {sats.map((s) => {
        const p = pts(s).at(-1);
        return p ? (
          <text key={s} x={x(toX(p.month)) - 4} y={y(p.median_local_hour) + (s === "AQUA" ? 16 : -8)} textAnchor="end" className="cal-num">
            {s === "AQUA" ? "Aqua" : "Terra"} {hh(p.median_local_hour)}
          </text>
        ) : null;
      })}
    </svg>
  );
}

export function LabPage() {
  const [v, setV] = useState<ValidationReport | null>(null);
  const [d, setD] = useState<Drift | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const setRoute = useApp((s) => s.setRoute);
  useEffect(() => {
    Promise.all([statics.validation(), statics.drift()]).then(([a, b]) => {
      setV(a);
      setD(b);
    }, (e) => setErr(String(e)));
  }, []);
  if (err) return <main className="page"><p role="alert">Could not load the validation report. {err}</p></main>;
  if (!v || !d) return <main className="page"><p role="status">Loading the validation report…</p></main>;

  const P = v.skill.primary;
  const names = v.skill.level_names;
  const S = v.skill.by_scale;
  const h3 = v.holdout_2020;
  const ex = h3.excluding_aqua_outage as unknown as Record<string, { primary: number; bias_pct: number }>;
  const T = v.turing as Record<string, Acc>;
  const g = (region: string, series: string) => v.seamlessness.find((s) => s.region === region && s.series === series && s.breakpoint === "2012-01");
  const regions = ["GLOBAL", "IND", "BRA", "AUS", "CAN", "NPL"];
  const rname: Record<string, string> = { GLOBAL: "Whole world", IND: "India", BRA: "Brazil", AUS: "Australia", CAN: "Canada", NPL: "Nepal" };
  const kge = (x: number) => x.toFixed(3);
  const pv = ["2015-01", "2017-01", "2020-01"].map((d) => v.seam_summary[`${d}|harmonized`]?.median_abs_artifact_pp).filter((x): x is number => x !== undefined);
  const placebo = [Math.min(...pv), Math.max(...pv)];

  return (
    <main className="page lab" id="main">
      <header className="page-head">
        <p className="kicker">The Lab</p>
        <h1>How do we know the translation is right?</h1>
        <p className="lede">
          We never claim “100 %”. We run three tests on regions and years the model never saw, and we publish every number, including where it struggles.
        </p>
      </header>

      <section className="lab-sec" aria-labelledby="t1">
        <h2 id="t1">
          <span className="num">1</span> Does it reproduce MODIS where we can check?
        </h2>
        <p>
          {v.skill.test}. Score: {v.skill.primary_metric} (KGE, 1 = perfect). Higher is better.
        </p>
        <Bars
          label="Skill by method"
          min={0.9}
          max={1}
          fmtV={kge}
          rows={v.skill.levels.map((k) => ({ k: names[k] ?? k, v: P[k].primary_kge, hi: k === "H1" }))}
        />
        <div className="stat-grid">
          {(["admin1", "country", "biome"] as const).map((s) => (
            <div key={s} className="stat">
              <div className="stat-v">{S[s].H1.r2.toFixed(3)}</div>
              <div className="stat-k">R² at {s === "admin1" ? "province" : s} scale</div>
              <div className="stat-s">bias {S[s].H1.bias_pct > 0 ? "+" : ""}{S[s].H1.bias_pct.toFixed(1)} %</div>
            </div>
          ))}
        </div>
        <div className="callout">
          <h3>The sealed 2020 test</h3>
          <p>
            Written down before it was run, run once: train on 2012–2019, predict 2020 for unseen regions. Calember scores <strong>{kge(h3.levels.H1.primary_kge)}</strong> vs{" "}
            {kge(h3.levels.H0b.primary_kge)} for the GFED5-NRT-style method. In August 2020 the Aqua satellite lost most of its data, so the MODIS reference itself is
            incomplete; without those two months Calember scores <strong>{kge(ex.H1.primary)}</strong> (bias {ex.H1.bias_pct} %) vs {kge(ex.H0b.primary)}.
          </p>
        </div>
      </section>

      <section className="lab-sec" aria-labelledby="t2">
        <h2 id="t2">
          <span className="num">2</span> Is there a seam when VIIRS arrives in 2012?
        </h2>
        <p>
          The jump in the yearly level at January 2012 (24 months on each side), compared with MODIS's own change over the same years. A good translation shows no jump of
          its own.
        </p>
        <table className="data-table seam-table">
          <caption className="sr-only">Step change at January 2012 by region</caption>
          <thead>
            <tr>
              <th scope="col">Region</th>
              <th scope="col">Raw sensors summed</th>
              <th scope="col">Calember</th>
              <th scope="col">MODIS itself</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r}>
                <th scope="row">{rname[r]}</th>
                <td className="bad">+{fmt(g(r, "raw_sum")?.step_pct)} %</td>
                <td>
                  {(g(r, "harmonized")?.step_pct ?? 0) > 0 ? "+" : ""}
                  {fmt(g(r, "harmonized")?.step_pct, 1)} %
                </td>
                <td className="muted">
                  {(g(r, "modis")?.step_pct ?? 0) > 0 ? "+" : ""}
                  {fmt(g(r, "modis")?.step_pct, 1)} %
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fine">
          Across {v.seam_summary["2012-01|harmonized"].n_units} countries and biomes the median leftover artefact is{" "}
          {v.seam_summary["2012-01|harmonized"].median_abs_artifact_pp.toFixed(1)} percentage points (raw: {fmt(v.seam_summary["2012-01|raw_sum"].median_abs_artifact_pp)}). Placebo
          dates with no sensor change give {placebo[0].toFixed(1)}–{placebo[1].toFixed(1)} points, the same size. Nepal is our hardest region: tiny counts and monsoon zeros.
        </p>
      </section>

      <section className="lab-sec" aria-labelledby="t3">
        <h2 id="t3">
          <span className="num">3</span> The Sensor Turing Test
        </h2>
        <p>
          A machine is shown two-year series for {fmt(T.raw.n ? T.raw.n / 2 : null)} provinces it never trained on and must guess which one is real MODIS. 50 % means it cannot
          tell them apart.
        </p>
        <Bars
          label="Machine accuracy at telling sources apart"
          min={0.5}
          max={0.85}
          fmtV={(x) => `${(x * 100).toFixed(0)} %`}
          rows={[
            { k: "Raw VIIRS counts", v: T.raw.accuracy },
            { k: "GFED5-NRT-style method", v: T.sota_style_H0b.accuracy },
            { k: "Calember", v: T.harmonized.accuracy, hi: true, note: `2020 sealed test: ${(T.holdout_2020.accuracy * 100).toFixed(0)} %` },
          ]}
        />
        <p className="fine">
          How it is measured: provinces with at least 50 hotspots a month, from regions and years held out from training. Calember's series is a sample from its calibrated
          range of likely values (average of three runs), the same kind of record a real sensor produces. Compared with Calember's smooth monthly averages instead, the machine
          is right {(T.harmonized_expectation.accuracy * 100).toFixed(0)} % of the time: averages are smoother than any real record.
        </p>
        <button type="button" className="btn" onClick={() => setRoute("turing")}>
          Try to beat the machine yourself →
        </button>
      </section>

      <section className="lab-sec" aria-labelledby="t4">
        <h2 id="t4">Honest uncertainty</h2>
        <p>
          Every month carries a 90 % range. On held-out data the true value fell inside it <strong>{(v.coverage90.admin1 * 100).toFixed(1)} %</strong> of the time for
          provinces (target 90 %), and {(v.coverage90.holdout_2020_admin1 * 100).toFixed(1)} % in the sealed 2020 test.
        </p>
      </section>

      <section className="lab-sec" aria-labelledby="t5">
        <h2 id="t5">Drift Lab: MODIS is drifting</h2>
        <p>{d.summary}</p>
        <DriftChart d={d} />
        <p className="fine">Median local solar time of MODIS fire detections per month, measured from the detections themselves.</p>
        {d.case_punjab && (
          <div className="callout">
            <h3>Case study: Punjab's stubble burning</h3>
            <p>{d.case_punjab.summary}</p>
          </div>
        )}
      </section>

      <section className="lab-sec" aria-labelledby="t6">
        <h2 id="t6">Limitations</h2>
        <ul className="limits">
          {v.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
