"""seamlessness tests (Guideline 4.6 #2, scorecard S2).
Series per unit (showcase countries, biomes >= 1% of MODIS fire, global), monthly 2003-01..2025-12:
  modis   : MODIS T+A observed (masked) -- continuous instrument, the reference
  raw_sum : T+A + S-NPP + NOAA-20 (masked)  -- what a naive merge gives
  H0      : MODIS before break, global ratio x S-NPP after (ratio from 2012-2019)
  harm    : MODIS before break, cross-fitted Bridge prediction after (spliced at the break)
Breaks: 2012-01 (real M->B transition), 2015-01 and 2017-01 (placebo dates, both sides inside the 2012-2019 overlap), 2020-01 (B->V handover, drift era).
For each: deseasonalize log1p(series) by monthly means (whole series), Mann-Whitney on +-36 months (24 for 2020),
step % = 100*(exp(median_after - median_before) - 1). ARTIFACT = step(series) - step(modis) (pp).
Pettitt test p on the window. A seamless series has artifact ~0 and MW p > 0.05 where modis also shows no step.
Usage: python -P seam2.py <repo> <crossfit_agg_tag> <col in c_z2|h_z2|h_z3>
"""
import json
import sys
from pathlib import Path

import numpy as np
import polars as pl
from scipy import stats

repo, tag, col = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
ex = repo / "data/interim/explore"
lk = pl.read_parquet(repo / "data/interim/aux/h3r5_lookup.parquet").select(pl.col("h3_r5_u64").alias("r5"), "iso3", "biome_id", "biome_name")
L = (pl.scan_parquet(ex / "cm_long_m1/*.parquet").filter(pl.col("month") >= "2003-01")
       .group_by("r5", "month", "sat").agg(n=pl.col("n").sum()).collect().with_columns(pl.col("r5").cast(pl.UInt64))
       .join(lk, on="r5", how="left"))
cf = pl.read_parquet(ex / f"crossfit_agg_{tag}.parquet").select("iso3", "biome_id", "month", pl.col(col))
BN = dict(lk.select("biome_id", "biome_name").unique("biome_id").iter_rows())
cf = cf.with_columns(biome_name=pl.col("biome_id").replace_strict(BN, default=None, return_dtype=pl.Utf8))
SHOW = {"NPL": "Nepal", "IND": "India", "BRA": "Brazil", "AUS": "Australia", "CAN": "Canada"}
tot = L.filter(pl.col("sat").is_in(["TERRA", "AQUA"])).group_by("biome_name").agg(n=pl.col("n").sum())
big_biomes = tot.filter(pl.col("n") / pl.col("n").sum() >= 0.01)["biome_name"].drop_nulls().to_list()
months = [f"{y}-{m:02d}" for y in range(2003, 2026) for m in range(1, 13)]
mi = {m: i for i, m in enumerate(months)}
G = None


def series(unit_filter):
    l = L.filter(unit_filter)
    s = l.group_by("month", "sat").agg(n=pl.col("n").sum()).pivot(on="sat", index="month", values="n").fill_null(0)
    out = {k: np.zeros(len(months)) for k in ("modis", "snpp", "raw_sum")}
    for r in s.iter_rows(named=True):
        if r["month"] not in mi:
            continue
        i = mi[r["month"]]; t = r.get("TERRA", 0) + r.get("AQUA", 0)
        out["modis"][i] = t; out["snpp"][i] = r.get("SNPP", 0); out["raw_sum"][i] = t + r.get("SNPP", 0) + r.get("NOAA20", 0)
    c = cf.filter(unit_filter).group_by("month").agg(p=pl.col(col).sum())
    out["pred"] = np.full(len(months), np.nan)
    for m, p in c.iter_rows():
        if m in mi:
            out["pred"][mi[m]] = p
    return out


def deseason(x):
    lx = np.log1p(x); mon = np.arange(len(x)) % 12
    return lx - np.array([np.nanmean(lx[mon == k]) for k in range(12)])[mon]


def pettitt(x):
    n = len(x); U = np.array([sum(np.sign(x[i] - x[j]) for i in range(t) for j in range(t, n)) for t in range(1, n)])
    K = np.abs(U).max(); return float(min(1.0, 2 * np.exp(-6 * K ** 2 / (n ** 3 + n ** 2))))


def test(x, b, w):
    d = deseason(x); i = mi[b]; lo, hi = max(0, i - w), min(len(x), i + w)
    a, c = d[lo:i], d[i:hi]
    a, c = a[~np.isnan(a)], c[~np.isnan(c)]
    if len(a) < 12 or len(c) < 12:
        return None
    p = stats.mannwhitneyu(a, c).pvalue
    return dict(step_pct=float(100 * (np.exp(np.median(c) - np.median(a)) - 1)), p_mw=float(p), p_pettitt=pettitt(np.concatenate([a, c])))


units = [("GLOBAL", pl.lit(True))] + [(k, pl.col("iso3") == k) for k in SHOW] + [(b, pl.col("biome_name") == b) for b in big_biomes]
glob = series(pl.lit(True)); i0, i1 = mi["2012-01"], mi["2019-12"] + 1
G = glob["modis"][i0:i1].sum() / glob["snpp"][i0:i1].sum()
rows = []
for name, flt in units:
    s = series(flt)
    gr = s["modis"][i0:i1].sum() / max(s["snpp"][i0:i1].sum(), 1)
    for b, w in [("2012-01", 36), ("2017-01", 36), ("2015-01", 36), ("2020-01", 24)]:
        ib = mi[b]
        spl_h0 = np.where(np.arange(len(months)) < ib, s["modis"], G * s["snpp"])
        spl_h = np.where(np.arange(len(months)) < ib, s["modis"], s["pred"])
        ref = test(s["modis"], b, w)
        for sname, x in [("modis", s["modis"]), ("raw_sum", s["raw_sum"]), ("H0", spl_h0), ("harm", spl_h)]:
            if b in ("2017-01",) and sname in ("raw_sum",):
                continue
            r = test(x, b, w)
            if r is None or ref is None:
                continue
            rows.append(dict(unit=name, breakpoint=b, series=sname, **r, artifact_pp=r["step_pct"] - ref["step_pct"]))
df = pl.DataFrame(rows)
df.write_csv(ex / f"seam2_{tag}_{col}.csv")
pd = df.to_pandas()
for b in ("2012-01", "2017-01", "2015-01", "2020-01"):
    t = pd[pd.breakpoint == b].pivot(index="unit", columns="series", values="artifact_pp").round(1)
    pv = pd[pd.breakpoint == b].pivot(index="unit", columns="series", values="p_mw").round(3)
    print(f"\n=== break {b}: ARTIFACT (step % minus MODIS-only step %)\n", t.to_string(), f"\n--- MW p-values at {b}\n", pv.to_string())
summ = {}
for b in ("2012-01", "2017-01", "2015-01", "2020-01"):
    for sname in ("raw_sum", "H0", "harm"):
        q = pd[(pd.breakpoint == b) & (pd.series == sname)]
        if len(q):
            summ[f"{b}|{sname}"] = dict(median_abs_artifact_pp=float(q.artifact_pp.abs().median()), frac_units_abs_artifact_lt5=float((q.artifact_pp.abs() < 5).mean()), n=int(len(q)))
print("\nSUMMARY", json.dumps(summ, indent=1))
(ex / f"seam2_{tag}_{col}_summary.json").write_text(json.dumps(summ, indent=1))
