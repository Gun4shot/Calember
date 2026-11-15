"""Validate the completeness correction (CC) by simulation on clean MODIS months.
For 36 clean months (2003-2011, both satellites lost_frac < 0.5%), delete a contiguous block of k days (3/9/16) of one
satellite, recompute the production lost-fraction estimate from the degraded global daily series (bad day = n < 0.5 x centred
61-day rolling median; lost = sum over bad days of med - n), and fill the degraded satellite as count / (1 - L).
Compares truth (T+A, all days) vs degraded vs filled at r5, adm1-month, biome-month. Seed 2026.
Usage: python -P sim_fill.py <repo>
"""
import json
import sys
from pathlib import Path

import duckdb
import numpy as np
import polars as pl

repo = Path(sys.argv[1]); ex = repo / "data/interim/explore"
rng = np.random.default_rng(2026)
L = pl.read_parquet(ex / "sensor_lost_frac.parquet")
daily = pl.read_parquet(ex / "modis_daily_counts.parquet").select("satellite", "acq_date", "n")
clean = (L.filter(pl.col("satellite").is_in(["Terra", "Aqua"]) & pl.col("month").is_between(pl.lit("2003-01"), pl.lit("2011-12")))
          .group_by("month").agg(mx=pl.col("lost_frac").max()).filter(pl.col("mx") < 0.005)["month"].sort().to_list())
months = sorted(rng.choice(clean, size=36, replace=False).tolist())
lk = pl.read_parquet(repo / "data/interim/aux/h3r5_lookup.parquet").select(pl.col("h3_r5_u64").alias("r5"), "adm1_code", "biome_id")
con = duckdb.connect(); con.execute("LOAD h3; SET memory_limit='1500MB'; SET threads=2; SET enable_progress_bar=false")
rows, scen = [], []
for i, m in enumerate(months):
    sat = ["Terra", "Aqua"][i % 2]; k = [3, 9, 16][(i // 2) % 3]
    y = int(m[:4]); dim = pl.date_range(pl.date(y, int(m[5:]), 1), pl.date(y, int(m[5:]), 1).dt.month_end(), "1d", eager=True) if False else None
    det = con.execute(f"""SELECT satellite, acq_date, h3_latlng_to_cell(latitude, longitude, 5) AS r5
        FROM read_parquet('{(repo / f'data/interim/firms_raw/product=modis/year={y}/*.parquet').as_posix()}')
        WHERE substr(acq_date,1,7) = '{m}' AND type = 0 AND try_cast(confidence AS INT) >= 30""").fetchall()
    d = pl.DataFrame(det, schema=["satellite", "acq_date", "r5"], orient="row").with_columns(pl.col("r5").cast(pl.UInt64), pl.col("acq_date").str.to_date())
    days = sorted(d["acq_date"].unique().to_list()); s0 = int(rng.integers(0, len(days) - k + 1)); drop = set(days[s0:s0 + k])
    lost_mask = (pl.col("satellite") == sat) & pl.col("acq_date").is_in(list(drop))
    # production-style L from the degraded global daily series
    ds = daily.filter(pl.col("satellite") == sat).with_columns(n=pl.when(pl.col("acq_date").is_in(list(drop))).then(0).otherwise(pl.col("n")))
    ds = ds.with_columns(med=pl.col("n").cast(pl.Float64).rolling_median(61, center=True, min_samples=20)).filter(pl.col("acq_date").dt.strftime("%Y-%m") == m)
    lost = float(ds.filter(pl.col("n") < 0.5 * pl.col("med")).select((pl.col("med") - pl.col("n")).sum()).item() or 0.0)
    Lest = lost / (float(ds["n"].sum()) + lost); c = 1 / (1 - Lest)
    true_lost = d.filter(lost_mask).height; true_L = true_lost / d.filter(pl.col("satellite") == sat).height
    t = d.group_by("r5").agg(truth=pl.len(), keep_other=((pl.col("satellite") != sat)).sum(),
                             keep_sat=((pl.col("satellite") == sat) & ~pl.col("acq_date").is_in(list(drop))).sum(),
                             o_drop=((pl.col("satellite") != sat) & pl.col("acq_date").is_in(list(drop))).sum(),
                             o_keep=((pl.col("satellite") != sat) & ~pl.col("acq_date").is_in(list(drop))).sum())
    t = t.with_columns(month=pl.lit(m), degraded=pl.col("keep_other") + pl.col("keep_sat"), filled=pl.col("keep_other") + pl.col("keep_sat") * c)
    # paired fill: other satellite's detections on the lost days x (sat/other) ratio on good days, per biome (shrunk k=200 to global)
    t = t.join(lk.select("r5", "biome_id"), on="r5", how="left").with_columns(pl.col("biome_id").fill_null(0))
    rg = t["keep_sat"].sum() / max(t["o_keep"].sum(), 1)
    rb = t.group_by("biome_id").agg(rb=(pl.col("keep_sat").sum() + 200 * rg) / (pl.col("o_keep").sum() + 200))
    t = t.join(rb, on="biome_id", how="left").with_columns(est=pl.col("o_drop") * pl.col("rb"))
    tot_cc = float(t["keep_sat"].sum()) * (c - 1); tot_p = max(float(t["est"].sum()), 1e-9)
    t = t.with_columns(paired=pl.col("degraded") + pl.col("est"), paired_norm=pl.col("degraded") + pl.col("est") * (tot_cc / tot_p))
    rows.append(t.select("r5", "month", "truth", "degraded", "filled", "paired", "paired_norm"))
    scen.append(dict(month=m, sat=sat, k=k, L_true=round(true_L, 4), L_est=round(Lest, 4)))
    print(f"{m} {sat} k={k}: L true {true_L:.3f} est {Lest:.3f}", flush=True)
a = pl.concat(rows).join(lk, on="r5", how="left")


def kge(y, p):
    r = np.corrcoef(y, p)[0, 1]; b = p.mean() / y.mean(); g = (p.std() / p.mean()) / (y.std() / y.mean())
    return float(1 - np.sqrt((r - 1) ** 2 + (b - 1) ** 2 + (g - 1) ** 2))


res = {"scenarios": scen}
for scale, key in (("r5", "r5"), ("adm1", "adm1_code"), ("biome", "biome_id")):
    g = a.filter(pl.col(key).is_not_null()).group_by(key, "month").agg(pl.col("truth", "degraded", "filled", "paired", "paired_norm").sum().cast(pl.Float64))
    y = g["truth"].to_numpy()
    out = {}
    for col in ("degraded", "filled", "paired", "paired_norm"):
        p = g[col].to_numpy()
        out[col] = dict(kge=round(kge(y, p), 4), bias_pct=round(100 * (p.sum() / y.sum() - 1), 2),
                        med_abs_rel_err=round(float(np.median(np.abs(p - y)[y >= 50] / y[y >= 50])), 4))
    # relative error of the filled part (units with >= 50 truly lost detections)
    F_true = g["truth"] - g["degraded"]; sel = (F_true >= 50).to_numpy()
    for col in ("filled", "paired", "paired_norm"):
        F_est = g[col] - g["degraded"]
        out[f"alpha_{col}"] = round(float(((F_est - F_true) ** 2).sum() / max(F_est.sum(), 1e-9)), 3)
        out[f"fill_part_rel_rmse_{col}"] = round(float(np.sqrt(np.mean(((F_est - F_true).to_numpy()[sel] / F_true.to_numpy()[sel]) ** 2))), 3) if sel.any() else None
    out["n"] = g.height; res[scale] = out
    print(scale, json.dumps(out), flush=True)
res["L_est_vs_true_mae"] = float(np.mean([abs(s["L_est"] - s["L_true"]) for s in scen]))
(ex / "sim_fill.json").write_text(json.dumps(res, indent=1))
print("DONE sim_fill")
