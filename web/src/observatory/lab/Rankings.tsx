// Country rankings: every country for a chosen month against its own normal (same rules as the area calendar),
// or all time (mean hotspots per year, density, busiest month on record). Click a country to open it.
import { useEffect, useMemo, useState } from "react";
import { ApiFailure, api } from "../../app/api";
import { CATEGORY_LABEL, MONTHS_LONG, fmt, monthLabel } from "../../app/format";
import type { CountryRank, Rankings as R } from "../../app/types";
import { loadAdmin0 } from "../data";
import { centerOf, polysOf } from "../geo";
import { CAT_GLYPH, ordinal } from "../hud/glyphs";
import { type Candidate, useObs } from "../store";
import { flyTo } from "../world/camera";

type Mode = "month" | "all";
type SortKey = "h_count" | "ratio" | "pct" | "mean" | "density" | "record";

const CAT_ORDER = { record: 6, much_above: 5, above: 4, normal: 3, below: 2, much_below: 1 } as const;

export function Rankings() {
  const [data, setData] = useState<R | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("month");
  const [sort, setSort] = useState<SortKey>("h_count");
  const [q, setQ] = useState("");
  const [onlyRecords, setOnlyRecords] = useState(false);
  useEffect(() => {
    setData(null);
    api.rankings(month ?? undefined).then(setData, (e) => setErr(e instanceof ApiFailure ? e.message : String(e)));
  }, [month]);
  useEffect(() => setSort(mode === "month" ? "h_count" : "mean"), [mode]);

  const rows = useMemo(() => {
    if (!data) return [];
    const nq = q.trim().toLowerCase();
    const val = (c: CountryRank): number => {
      switch (sort) {
        case "h_count": return c.h_count;
        case "ratio": return c.ratio_to_median ?? -1;
        case "pct": return (c.category ? CAT_ORDER[c.category] * 1000 : 0) + (c.pct_rank ?? 0) + (c.ratio_to_median ?? 0) / 1000;
        case "mean": return c.mean_annual ?? 0;
        case "density": return c.per_1000km2_yr ?? 0;
        case "record": return c.record_value;
      }
    };
    return data.countries
      .filter((c) => (!nq || c.name.toLowerCase().includes(nq)) && (!onlyRecords || c.category === "record"))
      .sort((a, b) => val(b) - val(a));
  }, [data, sort, q, onlyRecords]);

  const records = data?.countries.filter((c) => c.category === "record" && c.h_count >= 50) ?? [];
  const mName = data ? MONTHS_LONG[Number(data.month.slice(5, 7)) - 1] : "";
  const maxH = Math.max(1, ...rows.map((r) => (mode === "month" ? r.h_count : r.mean_annual ?? 0)));

  const open = async (c: CountryRank) => {
    const list = await loadAdmin0();
    const it = list.find((x) => x.id === c.admin_id);
    const polys = it ? polysOf(it.f.geometry) : [];
    const cand: Candidate = { name: c.name, kind: "Country", polys, center: polys.length ? centerOf(polys) : [0, 15], request: () => api.areaByAdmin(c.admin_id), linkId: c.admin_id };
    window.location.hash = "/";
    useObs.getState().set({ view: "globe" });
    flyTo(cand.center[1], cand.center[0], 26, 1.2);
    window.setTimeout(() => void useObs.getState().acquire(cand), 300);
  };
  const th = (k: SortKey, label: string, title: string) => (
    <th scope="col" aria-sort={sort === k ? "descending" : "none"}>
      <button type="button" className={sort === k ? "on" : ""} onClick={() => setSort(k)} title={title}>
        {label} {sort === k ? "▾" : ""}
      </button>
    </th>
  );

  return (
    <section className="ranks glass" aria-label="Country rankings">
      <a className="icon-btn arena-x" href="#/" aria-label="Back to the globe">
        ✕
      </a>
      <header className="ranks-head">
        <p className="kicker">Rankings · 224 countries</p>
        <h1>{mode === "month" ? `Who is burning in ${data ? monthLabel(data.month) : "…"}?` : "Who burns the most, all time?"}</h1>
        {mode === "month" && data && data.countries[0]?.provisional && (
          <p className="ranks-prov">{monthLabel(data.month)} is provisional: near-real-time data, final values can still change slightly.</p>
        )}
        {mode === "month" && data && records.length > 0 && (
          <p className="ranks-lead">
            <span className="cat-record">★</span> <b>{records.length}</b> {records.length === 1 ? "country has" : "countries have"} their highest {mName} since 2003:{" "}
            {records
              .slice()
              .sort((a, b) => b.h_count - a.h_count)
              .slice(0, 5)
              .map((r) => r.name)
              .join(", ")}
            {records.length > 5 ? "…" : "."}
          </p>
        )}
        <div className="ranks-ctl">
          <div className="seg2" role="radiogroup" aria-label="Ranking">
            <button type="button" role="radio" aria-checked={mode === "month"} onClick={() => setMode("month")}>
              One month
            </button>
            <button type="button" role="radio" aria-checked={mode === "all"} onClick={() => setMode("all")}>
              All time
            </button>
          </div>
          {mode === "month" && (
            <label className="ranks-month">
              month
              <input
                type="month"
                min="2001-01"
                max={data?.month_to_date ?? "2026-11"}
                value={month ?? data?.month ?? ""}
                onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)}
              />
            </label>
          )}
          <input className="ranks-search" placeholder="Filter countries…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter countries" />
          {mode === "month" && (
            <label className="ranks-chk">
              <input type="checkbox" checked={onlyRecords} onChange={(e) => setOnlyRecords(e.target.checked)} /> records only
            </label>
          )}
        </div>
      </header>
      {err && <p className="warn">{err}</p>}
      {!data && !err && <p className="loading-line">Ranking 224 countries…</p>}
      {data && (
        <div className="ranks-scroll">
          <table className="ranks-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Country</th>
                {mode === "month" ? (
                  <>
                    {th("h_count", "Hotspots", `Hotspots (MODIS-equivalent) in ${data ? monthLabel(data.month) : ""}`)}
                    {th("ratio", "× typical", `Compared with the median ${mName} of ${data.baseline[0]}–${data.baseline[1]}`)}
                    {th("pct", "vs normal", "Category and percentile among the same month in the baseline years")}
                  </>
                ) : (
                  <>
                    {th("mean", "Per year", "Mean hotspots per year, 2001–2025")}
                    {th("density", "Per 1,000 km²", "Mean hotspots per year per 1,000 km² of the country")}
                    {th("record", "Busiest month", "The single busiest month on record, 2000–2026")}
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={c.admin_id} onClick={() => void open(c)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && void open(c)} title={`Open ${c.name}`}>
                  <td className="rk-n">{i + 1}</td>
                  <th scope="row" className="rk-name">
                    {c.name}
                  </th>
                  {mode === "month" ? (
                    <>
                      <td className="rk-bar">
                        <span className="bar" style={{ width: `${(100 * c.h_count) / maxH}%` }} />
                        <b>{fmt(c.h_count)}</b>
                      </td>
                      <td className="rk-ratio">{c.ratio_to_median !== null ? `${c.ratio_to_median >= 10 ? Math.round(c.ratio_to_median) : c.ratio_to_median.toFixed(1)}×` : "–"}</td>
                      <td className={`rk-cat cat-${c.category ?? "normal"}`}>
                        {c.category ? (
                          <>
                            <span className="chip">
                              {CAT_GLYPH[c.category]} {c.category === "record" ? `record ${mName}` : CATEGORY_LABEL[c.category]}
                            </span>
                            {c.pct_rank !== null && <i>{ordinal(c.pct_rank)} pct</i>}
                          </>
                        ) : (
                          "–"
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="rk-bar">
                        <span className="bar" style={{ width: `${(100 * (c.mean_annual ?? 0)) / maxH}%` }} />
                        <b>{fmt(c.mean_annual)}</b>
                      </td>
                      <td className="rk-ratio">{c.per_1000km2_yr !== null ? c.per_1000km2_yr.toFixed(c.per_1000km2_yr < 10 ? 1 : 0) : "–"}</td>
                      <td className="rk-rec">
                        {monthLabel(c.record_month)} <i>{fmt(c.record_value)}</i>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="fine ranks-foot">
            Hotspots are MODIS-equivalent (harmonized). "vs normal" compares each country with the same month in {data.baseline[0]}–{data.baseline[1]} (excluding the month itself);
            a record means the highest such month in that period. Months from Aug 2026 are provisional. Click a country to open it.
          </p>
        </div>
      )}
    </section>
  );
}
