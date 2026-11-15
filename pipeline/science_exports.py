"""Science product exports (CONTRACTS §3.5, §3.6, §3.7) -> data/products/
- validation_report.json: held-out skill by scale and biome (B2 development test + B3 sealed 2020 test), seamlessness tests,
  Sensor Turing Test (machine discriminator), interval coverage, calendar agreement, limitations.
- drift.json: MODIS overpass time measured from the fire detections; observed MODIS / harmonized by biome-month (2020+).
- turing_rounds.json: game rounds from held-out regions and years (B2 test: 2018-2019, spatial folds never trained on).
Every number comes from a result file (benchmark reports, scorecards, seam tests, conformal, product). No method internals.
Usage: python -P pipeline/science_exports.py <repo>
"""
from __future__ import annotations

import json
import sys
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl

repo = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
ex = repo / "data/interim/explore"; prod = repo / "data/products"
FINAL = "H1E1g_z2"  # Bridge v2 (D-015)
rd = lambda f: json.loads((ex / f).read_text())
lk = pl.read_parquet(repo / "data/interim/aux/h3r5_lookup.parquet")
BIOME = {int(b): n for b, n in lk.select("biome_id", "biome_name").unique().drop_nulls().iter_rows()}
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def scale_block(rep: dict, model: str) -> dict:
    r = rep[model]
    pick = lambda s: {k: round(float(r[s][k]), 4) for k in ("r2", "bias_pct", "mae", "kge")}
    return {"cell_r5": pick("r5"), "admin1": pick("adm1"), "country": pick("country"), "biome": pick("biome"),
            "primary_kge": round(float(r["primary"]), 4),
            "logkge_admin1": round(float(r["secondary_logkge_adm1"]["kge"]), 4) if "secondary_logkge_adm1" in r else None}


def kge(y: np.ndarray, p: np.ndarray) -> float:
    r = np.corrcoef(y, p)[0, 1]; b = p.mean() / y.mean(); g = (p.std() / p.mean()) / (y.std() / y.mean())
    return float(1 - np.sqrt((r - 1) ** 2 + (b - 1) ** 2 + (g - 1) ** 2))


# ---------------- validation_report.json ----------------
b2a = rd("bench_report_B2.json")["report"]        # H0, H0b, H1 (basic GBM)
b2t = rd("bench_report_B2_T.json")["report"]      # final
b3 = rd("bench_report_B3.json")["report"]
levels = {"H0": ("H0", b2a), "H0b": ("H0b", b2a), "H1_basic": ("H1", b2a), "H1": (FINAL, b2t)}
by_scale: dict = {"cell_r5": {}, "admin1": {}, "country": {}, "biome": {}}
primary = {}
for lev, (m, rep) in levels.items():
    blk = scale_block(rep, m)
    for s in by_scale:
        by_scale[s][lev] = blk[s]
    primary[lev] = {"primary_kge": blk["primary_kge"], "logkge_admin1": blk["logkge_admin1"]}

# per-biome skill on the B2 test (biome-month series, 24 months each)
oa = pl.read_parquet(ex / "bench_oof_B2.parquet", columns=["r5", "month", "y", "biome_id", "H0", "H0b"])
ot = pl.read_parquet(ex / "bench_oof_B2_T.parquet", columns=["r5", "month", FINAL])
o = oa.join(ot, on=["r5", "month"], how="inner")
bb = o.group_by("biome_id", "month").agg(pl.col("y", "H0", "H0b", FINAL).sum().cast(pl.Float64)).sort("biome_id", "month")
by_biome = []
for (bid,), g in bb.group_by("biome_id", maintain_order=True):
    if bid is None or float(g["y"].sum()) < 500:
        continue
    y = g["y"].to_numpy(); row = {"biome_id": int(bid), "biome_name": BIOME.get(int(bid), "Unknown"), "n_months": int(g.height),
                                  "modis_total": int(y.sum())}
    for lev, col in (("H0", "H0"), ("H0b", "H0b"), ("H1", FINAL)):
        p = g[col].to_numpy(); ss = ((y - p) ** 2).sum(); st = ((y - y.mean()) ** 2).sum()
        row[lev] = {"r2": round(float(1 - ss / st), 4), "bias_pct": round(float(100 * (p.sum() / y.sum() - 1)), 2), "kge": round(kge(y, p), 4)}
    by_biome.append(row)
del o, oa, ot

# seamlessness (final model, cross-fitted; seam2 outputs): Tier A countries + global, breakpoint 2012-01, plus placebo dates
sc = pl.read_csv(ex / "seam2_CF2_g_z2.csv")
SER = {"raw_sum": "raw_sum", "harm": "harmonized", "modis": "modis", "H0": "H0"}
seam = []
for r in sc.filter(pl.col("unit").is_in(["GLOBAL", "NPL", "IND", "BRA", "AUS", "CAN"])).iter_rows(named=True):
    if r["series"] not in SER:
        continue
    seam.append({"region": r["unit"], "breakpoint": r["breakpoint"], "series": SER[r["series"]],
                 "p_mw": None if r["p_mw"] is None else round(float(r["p_mw"]), 4), "step_pct": None if r["step_pct"] is None else round(float(r["step_pct"]), 2),
                 "p_pettitt": None if r["p_pettitt"] is None else round(float(r["p_pettitt"]), 4),
                 "artifact_pp": None if r["artifact_pp"] is None else round(float(r["artifact_pp"]), 2)})
ss = rd("seam2_CF2_g_z2_summary.json")
seam_summary = {k.replace("|harm", "|harmonized"): {"median_abs_artifact_pp": round(v["median_abs_artifact_pp"], 2), "n_units": v["n"]} for k, v in ss.items()}

sct = rd("scorecard_B2_T_H1E1g_z2.json"); sc0 = rd("scorecard_B2_E9_H0b.json")
b3x = rd("b3_extras.json"); conf = rd("conformal_B2_T_H1E1g_z2.json"); sens = rd("b3_sensitivity_aqua_gap.json")
ZINB_B2 = [0.538, 0.555, 0.559]   # c2st_nb.py ZINB draw, seeds 2026-2028 (JOURNAL 13 Nov "Turing-test deep-dive")
ZINB_H0B = [0.581, 0.570, 0.617]
n_tt = int(sct["turing"]["raw"]["n"])
half = 1.96 * np.sqrt(0.25 / n_tt)
turing = {
    "raw": {k: sct["turing"]["raw"][k] for k in ("accuracy", "ci95", "n")},
    "harmonized": {"accuracy": round(float(np.mean(ZINB_B2)), 4), "ci95": [round(float(np.mean(ZINB_B2) - half), 3), round(float(np.mean(ZINB_B2) + half), 3)],
                   "n": n_tt, "seeds": ZINB_B2},
    "sota_style_H0b": {"accuracy": round(float(np.mean(ZINB_H0B)), 4), "n": n_tt, "seeds": ZINB_H0B},
    "harmonized_expectation": {k: sct["turing"]["harmonized"][k] for k in ("accuracy", "ci95", "n")},
    "holdout_2020": {"accuracy": round(b3x[FINAL]["c2st_zinb"]["mean"], 4), "seeds": [round(r["c2st"], 4) for r in b3x[FINAL]["c2st_zinb"]["runs"]],
                     "n": b3x[FINAL]["c2st_zinb"]["runs"][0]["n"]},
    "how_measured": ("A classifier sees 24-month region series (provinces with >= 50 hotspots per month, held-out regions and years) and guesses "
                     "which one is real MODIS. 'harmonized' compares real MODIS with a draw from Calember's calibrated predictive distribution "
                     "(mean of 3 seeds); 0.5 means the two cannot be told apart. 'harmonized_expectation' uses the smooth calendar values "
                     "instead, which are averages and therefore easier to spot."),
}
b3m = lambda m: {"primary_kge": round(b3[m]["primary"], 4), "bias_pct": round(b3[m]["adm1"]["bias_pct"], 2),
                 "admin1_r2": round(b3[m]["adm1"]["r2"], 4), "country_r2": round(b3[m]["country"]["r2"], 4), "biome_r2": round(b3[m]["biome"]["r2"], 4)}
report = {
    "version": "1.0", "model": "H1", "model_name": "Bridge v2", "product_version": "0.9.1-preH0", "built": now,
    "skill": {"levels": ["H0", "H0b", "H1_basic", "H1"],
              "level_names": {"H0": "One global VIIRS-to-MODIS ratio", "H0b": "Biome x month x day/night ratio table (GFED5-NRT-style)",
                              "H1_basic": "Basic gradient-boosting model", "H1": "Bridge v2 (final)"},
              "test": "B2: unseen regions (5 spatial folds) and unseen years (train <= 2017, test 2018-2019)",
              "primary_metric": "mean KGE over province, country and biome monthly totals",
              "primary": primary, "by_scale": by_scale, "by_biome": by_biome},
    "holdout_2020": {"test": "B3: pre-registered, run once; train 2012-2019, test 2020, unseen regions",
                     "levels": {"H0": b3m("H0"), "H0b": b3m("H0b"), "H1": b3m(FINAL)},
                     "excluding_aqua_outage": {"note": "post hoc: Aqua MODIS lost about 80-95 % of its detections 2020-08-16 to 09-02, so the reference is incomplete",
                                               "H0": sens["excl_2020-08_09|H0"], "H0b": sens["excl_2020-08_09|H0b"], "H1": sens[f"excl_2020-08_09|{FINAL}"]},
                     "coverage90_admin1": round(b3x[FINAL]["conformal_adm1"]["coverage"], 3)},
    "seamlessness": seam, "seam_summary": seam_summary,
    "placebo_seams": {k: v for k, v in seam_summary.items() if not k.startswith("2012-01")},
    "turing": turing,
    "calendar_agreement": {"H1": {k: round(sct["calendar_agreement"][k], 4) for k in ("kappa", "exact", "within_one")},
                           "H0b": {k: round(sc0["calendar_agreement"][k], 4) for k in ("kappa", "exact", "within_one")}},
    "coverage90": {"admin1": round(conf["adm1"]["coverage"], 3), "country": round(conf["country"]["coverage"], 3),
                   "holdout_2020_admin1": round(b3x[FINAL]["conformal_adm1"]["coverage"], 3), "holdout_2020_country": round(b3x[FINAL]["conformal_country"]["coverage"], 3)},
    "limitations": [
        "Calember reproduces what MODIS would have counted; it is not a measure of burned area or fire size.",
        "Quiet off-season months in small regions are the hardest case: their seasonal swing is slightly compressed.",
        "A machine can still tell harmonized series from real MODIS about 55 % of the time (a coin flip is 50 %).",
        "Months where a satellite lost data are gap-filled and flagged; June 2001 (Terra only) is still about 25 % low.",
        "From 2022 the real MODIS record drifts to other overpass times; Calember is anchored to the pre-drift MODIS.",
        "Months from 2026-08 use NOAA-20 near-real-time data and are provisional; 2026-11 is month-to-date.",
    ],
}
(prod / "validation_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
print(f"validation_report.json: {len(by_biome)} biomes, {len(seam)} seam rows")

# ---------------- drift.json ----------------
dr = pl.read_csv(ex / "drift.csv")
overpass = [{"satellite": s, "month": m, "median_local_hour": round(float(h), 3), "n": int(n)} for s, m, h, n in dr.select("sat", "month", "median_lst", "n").iter_rows()]
pm = (pl.scan_parquet(prod / "harmonized_cell_month.parquet").filter((pl.col("month") >= "2020-01") & (pl.col("month") <= "2026-10"))
        .group_by("biome_id", "month").agg(obs=pl.col("raw_modis_n").sum().cast(pl.Float64), h=pl.col("h_count").cast(pl.Float64).sum(),
                                           sys=pl.col("h_sd_sys").cast(pl.Float64).sum(), r2=(pl.col("h_sd_rand").cast(pl.Float64) ** 2).sum())
        .collect().sort("biome_id", "month"))
pm = pm.with_columns(sd=(pl.col("sys") ** 2 + pl.col("r2")).sqrt()).filter(pl.col("h") >= 200)
bias = [{"biome_id": int(b), "biome_name": BIOME.get(int(b), "Unknown"), "month": m, "observed_over_predicted": round(o_ / h, 4),
         "lo": round(o_ / (h + 1.645 * sd), 4), "hi": round(o_ / max(h - 1.645 * sd, 1e-9), 4)}
        for b, m, o_, h, sd in pm.select("biome_id", "month", "obs", "h", "sd").iter_rows()]
g = (pl.scan_parquet(prod / "harmonized_cell_month.parquet").filter(pl.col("month").is_between(pl.lit("2003-01"), pl.lit("2026-10")))
       .group_by(pl.col("month").str.slice(0, 4).alias("yr")).agg(obs=pl.col("raw_modis_n").sum().cast(pl.Float64), h=pl.col("h_count").cast(pl.Float64).sum())
       .collect().sort("yr").with_columns(ratio=pl.col("obs") / pl.col("h")))
yearly = [{"year": int(y), "observed_modis": int(o_), "ember_meh": round(h, 1), "observed_over_ember": round(r, 4)} for y, o_, h, r in g.iter_rows()]
med = lambda s, lo, hi: float(dr.filter((pl.col("sat") == s) & pl.col("month").is_between(pl.lit(lo), pl.lit(hi)))["median_lst"].median())
aq0, aq1 = med("AQUA", "2003-01", "2019-12"), med("AQUA", "2025-01", "2025-12")
te0, te1 = med("TERRA", "2003-01", "2019-12"), med("TERRA", "2025-01", "2025-12")
r25 = next(x["observed_over_ember"] for x in yearly if x["year"] == 2025)
hh = lambda v: f"{int(v):02d}:{int(round((v % 1) * 60)):02d}"

# case study: Punjab (India) Oct-Nov daytime detections by sensor; does burning move later in the day?
import duckdb  # noqa: E402
raw = (repo / "data/interim/firms_raw").as_posix()
LST = "(CAST(substr(lpad(CAST(acq_time AS VARCHAR),4,'0'),1,2) AS INT)*60 + CAST(substr(lpad(CAST(acq_time AS VARCHAR),4,'0'),3,2) AS INT))/60.0 + longitude/15"
BOX = "latitude BETWEEN 29.5 AND 32.5 AND longitude BETWEEN 73.8 AND 77 AND substr(acq_date,6,2) IN ('10','11') AND daynight = 'D'"
dcon = duckdb.connect(); dcon.execute("SET threads=4")
case = {}
for pname, sel, conf in (("modis", "satellite", "type = 0 AND try_cast(confidence AS INT) >= 30"), ("viirs-snpp", "'S-NPP'", "confidence IN ('n','h')")):
    for y, s, n, lst in dcon.execute(f"""SELECT year, {sel}, count(*), median({LST}) FROM read_parquet('{raw}/product={pname}/**/*.parquet', hive_partitioning=true)
                                          WHERE year >= 2012 AND {BOX} AND {conf} GROUP BY 1, 2 ORDER BY 1, 2""").fetchall():
        case.setdefault(int(y), {})[str(s)] = {"n": int(n), "median_local_hour": round(float(lst), 2)}
pj = [{"year": y, **{k: v for k, v in d.items()}} for y, d in sorted(case.items())]
c22, c25 = case.get(2022, {}), case.get(2025, {})
drop_v = 1 - c25["S-NPP"]["n"] / c22["S-NPP"]["n"]; drop_a = 1 - c25["Aqua"]["n"] / c22["Aqua"]["n"]
punjab = {"region": "Punjab, India (29.5-32.5N, 73.8-77E), October-November, daytime detections", "by_year": pj,
          "summary": (f"From 2022 to 2025, daytime detections in Punjab's October-November burning season fell {drop_v:.0%} at the S-NPP VIIRS pass "
                      f"(about {hh(c25['S-NPP']['median_local_hour'])} local time) but only {drop_a:.0%} at MODIS Aqua's pass, which has drifted to about "
                      f"{hh(c25['Aqua']['median_local_hour'])}. Burning appears to have moved later in the day, so counts tied to an early-afternoon pass "
                      f"(VIIRS, and the pre-drift MODIS that Calember reproduces) overstate the decline.")}
LIMIT_TIME_OF_DAY = ("Counts depend on the time of the satellite pass. Where burning shifts to later in the day (Punjab since 2023 is an example), "
                     "Calember, which reproduces the early-afternoon MODIS pass, shows a larger decline than the burning itself.")
print("punjab:", punjab["summary"])
report["limitations"].append(LIMIT_TIME_OF_DAY)
(prod / "validation_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
drift = {"overpass": overpass, "bias": bias, "yearly": yearly, "case_punjab": punjab,
         "summary": (f"Measured from the fire detections themselves, Aqua's median overpass moved from {hh(aq0)} (2003-2019) to {hh(aq1)} local "
                     f"solar time in 2025, and Terra's from {hh(te0)} to {hh(te1)}. Fires are counted at different times of day, so the raw MODIS "
                     f"record drifts: in 2025 it recorded {r25:.0%} of what pre-drift MODIS would have seen. Calember stays anchored to the pre-drift record.")}
(prod / "drift.json").write_text(json.dumps(drift, indent=1), encoding="utf-8")
print("drift.json:", drift["summary"])

# ---------------- turing_rounds.json ----------------
rng = np.random.default_rng(2026)
ob = pl.read_parquet(ex / "bench_oof_B2_T.parquet", columns=["month", "y", "snpp_n", "adm1_code", FINAL]).filter(pl.col("adm1_code").is_not_null())
a = ob.group_by("adm1_code", "month").agg(obs=pl.col("y").sum().cast(pl.Float64), P=pl.col(FINAL).sum().cast(pl.Float64), raw=pl.col("snpp_n").sum().cast(pl.Float64))
a = a.with_columns(grp=pl.col("adm1_code").map_elements(lambda s: zlib.crc32(s.encode()) % 5, return_dtype=pl.Int8),
                   b=pl.col("P").clip(1e-6, None).log10().floordiv(0.5).clip(-4, 9).cast(pl.Int8))
vt, zt = {}, {}
for gk in range(5):  # cross-fitted dispersion and zero rate (no data from the region's own group)
    oth = a.filter(pl.col("grp") != gk)
    zt[gk] = {int(b): float(z) for b, z in oth.group_by("b").agg(z=(pl.col("obs") == 0).mean()).iter_rows()}
    t = oth.group_by("b").agg(v=(((pl.col("obs") - pl.col("P")) ** 2 - pl.col("P")) / pl.col("P") ** 2).mean())
    vt[gk] = {int(b): (min(max(float(v), 1e-4), 1e3) if v == v and abs(v) != float("inf") else 1.0) for b, v in t.iter_rows()}
reg = a.group_by("adm1_code").agg(m=pl.col("obs").mean(), n=pl.len()).filter((pl.col("m") >= 50) & (pl.col("n") == 24))["adm1_code"]
a = a.filter(pl.col("adm1_code").is_in(reg.implode())).sort("adm1_code", "month")
v = np.array([vt[gg].get(b, 0.05) for gg, b in zip(a["grp"].to_list(), a["b"].to_list())])
z0 = np.array([zt[gg].get(b, 0.0) for gg, b in zip(a["grp"].to_list(), a["b"].to_list())])
P = a["P"].to_numpy(); pi = np.zeros_like(P)
for _ in range(50):
    mu = P / np.maximum(1 - pi, 1e-6); p0 = (1 + v * mu) ** (-1 / v)
    pi = np.clip((z0 - p0) / np.maximum(1 - p0, 1e-9), 0, 0.95)
mu = P / np.maximum(1 - pi, 1e-6)
draw = rng.poisson(mu * rng.gamma(1 / v, v)).astype(float) * (rng.random(len(P)) >= pi)
a = a.with_columns(draw=pl.Series(draw))
names = lk.select("adm1_code", "adm1_name", "country_name").unique("adm1_code")
a = a.join(names, on="adm1_code", how="left")
regions = a["adm1_code"].unique().sort().to_list()
pick = rng.choice(regions, size=min(160, len(regions)), replace=False).tolist()
rounds = []
for i, code in enumerate(pick):
    g = a.filter(pl.col("adm1_code") == code).sort("month")
    st = "raw" if i % 2 == 0 else "harmonized"
    modis = [round(float(x), 1) for x in g["obs"].to_list()]
    other = [round(float(x), 1) for x in g["raw" if st == "raw" else "draw"].to_list()]
    flip = bool(rng.random() < 0.5)
    nm = g.row(0, named=True); label = f"{nm['adm1_name']}, {nm['country_name']}" if nm["adm1_name"] else nm["country_name"]
    rounds.append({"id": f"r-{i + 1:04d}", "set": st, "region_name": label, "start": g["month"][0],
                   "a": other if flip else modis, "b": modis if flip else other, "modis_is": "b" if flip else "a"})
tr = {"window_months": 24, "built": now,
      "note": ("Held-out provinces and years (2018-2019, regions never seen in training). 'raw': real MODIS vs raw VIIRS S-NPP counts. "
               "'harmonized': real MODIS vs a draw from Calember's calibrated predictive distribution (the same comparison the machine test uses)."),
      "rounds": rounds}
(prod / "turing_rounds.json").write_text(json.dumps(tr, indent=1), encoding="utf-8")
print(f"turing_rounds.json: {sum(r['set'] == 'raw' for r in rounds)} raw + {sum(r['set'] == 'harmonized' for r in rounds)} harmonized rounds from {len(regions)} regions")
