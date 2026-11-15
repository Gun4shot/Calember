"""scorecard items computable from benchmark OOF predictions.
 S3  Sensor Turing Test = classifier two-sample test (C2ST, Lopez-Paz & Oquab 2017):
     per adm1 region, the held-out 24-month window 2018-01..2019-12; class A = MODIS observed,
     class B = model prediction (harmonized set) or raw S-NPP count (raw set). LightGBM on 12 series features,
     GroupKFold by region (both classes of a region in the same fold). Accuracy, Wilson 95% CI, binomial p vs 0.5.
 S4  Calendar agreement: per adm1 month 2018-2019, Guideline 4.7 category of MODIS-observed vs model, both against
     the same baseline = MODIS observed same calendar month 2012-2017. Exact agreement, within-one, Cohen kappa
     (weighted linear too).
Usage: python -P scorecard_oof.py <repo> <oof_tag> <model_col> [min_mean=10]
"""
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import polars as pl
from scipy import stats
from sklearn.metrics import cohen_kappa_score
from sklearn.model_selection import GroupKFold

repo, tag, col = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
min_mean = float(sys.argv[4]) if len(sys.argv) > 4 else 10.0
ex = repo / "data/interim/explore"
o = pl.read_parquet(ex / f"bench_oof_{tag}.parquet", columns=["r5", "month", "y", "snpp_n", "adm1_code", col])
# ---- predictive draw (Tweedie compound Poisson-gamma, p=1.4); dispersion phi per mean-decile, CROSS-FITTED:
# phi for spatial fold k is estimated from the OOF residuals of the other folds only.
import zlib, h3 as _h3
P = 1.4
cells = o["r5"].unique().to_list()
fmap = {c: zlib.crc32(f"{_h3.str_to_int(_h3.cell_to_parent(_h3.int_to_str(c), 2))}-2026".encode()) % 5 for c in cells}
o = o.with_columns(fold=pl.col("r5").replace_strict(fmap, return_dtype=pl.Int8), mu=pl.col(col).clip(1e-6, None))
o = o.with_columns(dec=(pl.col("mu").log().rank("ordinal") * 10 // (o.height + 1)).cast(pl.Int8))
o = o.with_columns(pr=(pl.col("y") - pl.col("mu")) ** 2 / pl.col("mu") ** P)
rng = np.random.default_rng(2026)
parts = []
for k in range(5):
    phi = o.filter(pl.col("fold") != k).group_by("dec").agg(phi=pl.col("pr").mean())
    t = o.filter(pl.col("fold") == k).join(phi, on="dec", how="left")
    mu = t["mu"].to_numpy(); ph = t["phi"].to_numpy()
    lam = mu ** (2 - P) / (ph * (2 - P)); alpha = (2 - P) / (P - 1); theta = ph * (P - 1) * mu ** (P - 1)
    N = rng.poisson(lam)
    draw = np.where(N > 0, rng.gamma(np.maximum(N, 1) * alpha, theta), 0.0)
    parts.append(t.select("r5", "month", "y", "snpp_n", "adm1_code", col).with_columns(draw=pl.Series(draw)))
o = pl.concat(parts)
a = (o.filter(pl.col("adm1_code").is_not_null()).group_by("adm1_code", "month")
       .agg(obs=pl.col("y").sum(), mod=pl.col(col).sum(), raw=pl.col("snpp_n").sum().cast(pl.Float64),
            draw=pl.col("draw").sum()).sort("adm1_code", "month"))
regions = (a.group_by("adm1_code").agg(m=pl.col("obs").mean(), n=pl.len()).filter((pl.col("m") >= min_mean) & (pl.col("n") == 24)))["adm1_code"]
a = a.filter(pl.col("adm1_code").is_in(regions.implode()))
print(f"regions with 24 test months and mean MODIS >= {min_mean}/month: {len(regions)}")
# ---- spatially correlated draw: shared log-normal factor per region-month, sigma cross-fitted over 5 region groups,
# estimated on region-months with prediction >= 200 (Poisson part negligible): sigma^2 = var(log(obs/pred)) - mean(1/pred)
_all = (o.filter(pl.col("adm1_code").is_not_null()).group_by("adm1_code", "month").agg(obs=pl.col("y").sum(), mod=pl.col(col).sum()))
_all = _all.with_columns(grp=pl.col("adm1_code").map_elements(lambda s: zlib.crc32(s.encode()) % 5, return_dtype=pl.Int8))
sig = {}
for gk in range(5):
    q = _all.filter((pl.col("grp") != gk) & (pl.col("mod") >= 200) & (pl.col("obs") > 0))
    lr = np.log(q["obs"].to_numpy() / q["mod"].to_numpy())
    sig[gk] = float(np.sqrt(max(lr.var() - np.mean(1.0 / q["mod"].to_numpy()), 0.0)))
print("cross-fitted region-month sigma by group:", {k: round(v, 3) for k, v in sig.items()})
rng2 = np.random.default_rng(2027)
a = a.with_columns(grp=pl.col("adm1_code").map_elements(lambda s: zlib.crc32(s.encode()) % 5, return_dtype=pl.Int8))
sg = np.array([sig[g] for g in a["grp"].to_list()])
a = a.with_columns(draw_corr=pl.Series(a["draw"].to_numpy() * np.exp(sg * rng2.standard_normal(a.height) - sg ** 2 / 2)))
a.write_parquet(ex / f"c2st_series_{tag}_{col}.parquet")


def feats(x: np.ndarray) -> list[float]:
    x = np.asarray(x, float); m = x.mean(); s = x.std()
    clim = x.reshape(2, 12).mean(0)
    def ac(k):
        return float(np.corrcoef(x[:-k], x[k:])[0, 1]) if x[:-k].std() > 0 and x[k:].std() > 0 else 0.0
    f = np.abs(np.fft.rfft(x - m)) ** 2
    return [np.log1p(m), s / (m + 1e-9), (x == 0).mean(), clim.max() / (clim.mean() + 1e-9), ac(1), ac(12),
            float(np.argmax(clim)), float(stats.skew(x)) if s > 0 else 0.0, f[2] / (f.sum() + 1e-9),
            np.log1p(x.max()), np.log1p(np.median(x)), float(np.mean(np.abs(np.diff(x)))) / (m + 1e-9)]


def c2st(bcol: str):
    X, yl, g = [], [], []
    for reg, gdf in a.group_by("adm1_code", maintain_order=True):
        X.append(feats(gdf["obs"].to_numpy())); yl.append(0); g.append(reg[0])
        X.append(feats(gdf[bcol].to_numpy())); yl.append(1); g.append(reg[0])
    X, yl, g = np.array(X), np.array(yl), np.array(g)
    pred = np.zeros_like(yl)
    for tr, te in GroupKFold(5).split(X, yl, g):
        m = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.05, num_leaves=15, min_child_samples=20, random_state=2026, verbose=-1)
        m.fit(X[tr], yl[tr]); pred[te] = m.predict(X[te])
    n = len(yl); k = int((pred == yl).sum()); acc = k / n
    lo, hi = stats.binomtest(k, n).proportion_ci(0.95, method="wilson")
    p = stats.binomtest(k, n, 0.5).pvalue
    return dict(accuracy=acc, ci95=[lo, hi], n=n, p_vs_chance=p)


res = {"tag": tag, "model": col, "n_regions": len(regions), "turing": {"raw": c2st("raw"), "harmonized": c2st("mod"), "harmonized_draw": c2st("draw"), "harmonized_draw_corr": c2st("draw_corr")}}

# ---- S4 calendar agreement
cm = pl.scan_parquet(ex / "cm_long_m1/*.parquet") if (ex / "cm_long_m1").exists() and "B2" in tag else pl.scan_parquet(ex / "cm_long/*.parquet")
lk = pl.read_parquet(repo / "data/interim/aux/h3r5_lookup.parquet").select(pl.col("h3_r5_u64").alias("r5"), "adm1_code")
hist = (cm.filter(pl.col("sat").is_in(["TERRA", "AQUA"]) & pl.col("month").str.slice(0, 4).cast(pl.Int32).is_between(2012, 2017))
          .group_by("r5", "month").agg(n=pl.col("n").sum()).collect().with_columns(pl.col("r5").cast(pl.UInt64))
          .join(lk, on="r5").group_by("adm1_code", "month").agg(n=pl.col("n").sum())
          .with_columns(mon=pl.col("month").str.slice(5, 2).cast(pl.Int32), yr=pl.col("month").str.slice(0, 4).cast(pl.Int32)))
# dense baseline: missing (region, month) = 0
grid = pl.DataFrame({"adm1_code": regions}).join(pl.DataFrame({"yr": list(range(2012, 2018))}), how="cross").join(pl.DataFrame({"mon": list(range(1, 13))}), how="cross")
hist = grid.join(hist.select("adm1_code", "yr", "mon", "n"), on=["adm1_code", "yr", "mon"], how="left").with_columns(pl.col("n").fill_null(0))
B = {}
for r, m, v in hist.group_by("adm1_code", "mon").agg(pl.col("n")).iter_rows():
    B[(r, m)] = np.array(v, float)


def cat(x, S):
    if x > S.max():
        return 5
    pr = 100 * ((S < x).sum() + 0.5 * (S == x).sum()) / len(S)
    return 0 if pr < 10 else 1 if pr < 25 else 2 if pr <= 75 else 3 if pr <= 90 else 4


co, cmod, craw = [], [], []
for reg, month, obs, mod in a.select("adm1_code", "month", "obs", "mod").iter_rows():
    S = B[(reg, int(month[5:7]))]
    co.append(cat(obs, S)); cmod.append(cat(mod, S))
co, cmod = np.array(co), np.array(cmod)
res["calendar_agreement"] = dict(
    n=int(len(co)), exact=float((co == cmod).mean()), within_one=float((np.abs(co - cmod) <= 1).mean()),
    kappa=float(cohen_kappa_score(co, cmod)), kappa_linear=float(cohen_kappa_score(co, cmod, weights="linear")),
    obs_category_dist=np.bincount(co, minlength=6).tolist(), mod_category_dist=np.bincount(cmod, minlength=6).tolist())
print(json.dumps(res, indent=1, default=float))
(ex / f"scorecard_{tag}_{col}.json").write_text(json.dumps(res, indent=1, default=float))
