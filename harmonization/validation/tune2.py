"""benchmark harness + baseline prototypes H0, H0b, H1-lite.

BENCHMARK DEFINITION (frozen before any results are seen):
- Data: r5 x month panel, months 2012-01..2019-12, rows where any sensor detected fire.
- Target y = terra_n + aqua_n (cleaned MODIS counts).
- Spatial folds: 5 folds by hash of the H3 res-2 parent of the r5 cell (deterministic, seed 2026).
- Strict split per fold k: TRAIN = folds != k AND year <= 2017; TEST = fold k AND year in {2018, 2019}.
  Every test row is unseen in space AND time. Predictions are pooled over the 5 folds (out-of-fold).
- Scores (on pooled OOF predictions), each after summing pred and obs per (unit, month):
  scales r5, adm1, country, biome. Metrics: KGE, R2, bias %, MAE, plus KGE components r, beta, gamma.
- Primary score = mean KGE over the {adm1, country, biome} scales (r5 reported but noisy).
Usage: python -P bench.py <repo> [models...]   (models: H0 H0b H1 H1E1 ; default all)
"""
import gc
import json
import os
import sys
import time
import zlib
from pathlib import Path

import h3
import lightgbm as lgb
import numpy as np
import polars as pl

SEED = 2026
repo = Path(sys.argv[1])
models = sys.argv[2:] or ["H0b", "H1E1", "H1E1c", "H1E1h"]
# memory-safe load (crash fix 13 Nov): one satellite at a time, only needed columns, Float32; NOAA-20 not needed here
SRC = repo / os.environ.get("CM_DIR", "data/interim/explore/cm_long") / "*.parquet"
NEED = {"TERRA": ["n", "n_day"], "AQUA": ["n", "n_day"],
        "SNPP": ["n", "n_day", "frp_sum", "frp_p50", "frp_p90", "scan_mean", "lowfrp_n", "fire_days", "fcp"]}
PFX = {"TERRA": "terra", "AQUA": "aqua", "SNPP": "snpp"}
cm = None
for sat, pf in PFX.items():
    s = (pl.scan_parquet(SRC).filter((pl.col("sat") == sat) & pl.col("month").str.slice(0, 4).cast(pl.Int32).is_between(2012, 2019))
           .select(pl.col("r5").cast(pl.UInt64), "month", *[pl.col(c).cast(pl.Float32).alias(f"{pf}_{c}") for c in NEED[sat]])
           .collect())
    cm = s if cm is None else cm.join(s, on=["r5", "month"], how="full", coalesce=True)
    del s; gc.collect()
cm = cm.rename({c: c.replace("_n_day", "_day_n") for c in cm.columns if c.endswith("_n_day")})
print(f"loaded cm: {cm.height:,} rows, ~{cm.estimated_size('mb'):.0f} MB", flush=True)
lk = pl.read_parquet(repo / "data/interim/aux/h3r5_lookup.parquet").select(
    pl.col("h3_r5_u64").alias("r5"), "lat", "biome_id", "iso3", "adm1_code")

df = (cm.with_columns(year=pl.col("month").str.slice(0, 4).cast(pl.Int32),
                      mon=pl.col("month").str.slice(5, 2).cast(pl.Int32))
        .filter(pl.col("year").is_between(2012, 2019))
        .join(lk, on="r5", how="left"))
del cm; gc.collect()
num_cols = [c for c in df.columns if c.endswith(("_n", "_fcp", "_sum", "_p50", "_p90", "_mean", "_days", "_max", "_day"))]
df = df.with_columns([pl.col(c).fill_null(0) for c in num_cols])
df = df.with_columns(
    biome_id=pl.col("biome_id").fill_null(0),
    lat=pl.col("lat").fill_null(0.0),
    y=(pl.col("terra_n") + pl.col("aqua_n")).cast(pl.Float64),
    snpp_night_n=pl.col("snpp_n") - pl.col("snpp_day_n"),
)
# deterministic spatial folds from res-2 parent
parents = {c: h3.str_to_int(h3.cell_to_parent(h3.int_to_str(c), 2)) for c in df["r5"].unique().to_list()}
fold_of = {c: zlib.crc32(f"{p}-{SEED}".encode()) % 5 for c, p in parents.items()}
df = df.with_columns(fold=pl.col("r5").replace_strict(fold_of, return_dtype=pl.Int8))

# neighbour (k=1 ring, excluding self) S-NPP sums per month -- E2
cells = df["r5"].unique().to_list()
pairs = [(c, h3.str_to_int(n)) for c in cells for n in h3.grid_ring(h3.int_to_str(c), 1)]
nb = pl.DataFrame(pairs, schema=["r5", "nbr"], orient="row")
_ns = []
for _yr in range(2012, 2020):  # per year to bound the join size (crash fix 13 Nov)
    _src = df.filter((pl.col("year") == _yr) & (pl.col("snpp_n") > 0)).select(pl.col("r5").alias("nbr"), "month", "snpp_n", "snpp_fcp")
    _ns.append(nb.join(_src, on="nbr").group_by("r5", "month").agg(nb_snpp_n=pl.col("snpp_n").sum(), nb_snpp_fcp=pl.col("snpp_fcp").sum()))
    del _src; gc.collect()
nsum = pl.concat(_ns); del _ns; gc.collect()
print(f"neighbour sums: {nsum.height:,} rows", flush=True)
df = df.join(nsum, on=["r5", "month"], how="left").with_columns(
    pl.col("nb_snpp_n").fill_null(0), pl.col("nb_snpp_fcp").fill_null(0))
df = df.with_columns(
    msin=np.sin(2 * np.pi * pl.col("mon") / 12), mcos=np.cos(2 * np.pi * pl.col("mon") / 12),
    snpp_lowfrp_frac=pl.when(pl.col("snpp_n") > 0).then(pl.col("snpp_lowfrp_n") / pl.col("snpp_n")).otherwise(None),
    snpp_mult=pl.when(pl.col("snpp_fcp") > 0).then(pl.col("snpp_n") / pl.col("snpp_fcp")).otherwise(None),
)
print(f"panel rows {df.height:,}, cells {len(cells):,}, y total {df['y'].sum():,.0f}, snpp total {df['snpp_n'].sum():,.0f}", flush=True)

# ---- E9: temporal context (inputs only) and cell history (leave-one-year-out, training years <= 2017 only)
FEATS_H_PRE = ["snpp_n", "snpp_day_n", "snpp_night_n", "snpp_fcp", "snpp_frp_sum", "snpp_frp_p50", "snpp_frp_p90",
               "snpp_scan_mean", "snpp_lowfrp_frac", "snpp_fire_days", "snpp_mult", "nb_snpp_n", "nb_snpp_fcp",
               "lat", "msin", "mcos", "snpp_prev", "snpp_next", "hist_ratio", "hist_logS", "hist_logY"]
df = df.with_columns(mi=pl.col("year") * 12 + pl.col("mon"))
prev = df.select("r5", (pl.col("mi") + 1).alias("mi"), pl.col("snpp_n").alias("snpp_prev"))
nxt = df.select("r5", (pl.col("mi") - 1).alias("mi"), pl.col("snpp_n").alias("snpp_next"))
df = df.join(prev, on=["r5", "mi"], how="left").join(nxt, on=["r5", "mi"], how="left").with_columns(
    pl.col("snpp_prev").fill_null(0), pl.col("snpp_next").fill_null(0))
hy = df.filter(pl.col("year") <= 2017).group_by("r5", "year").agg(Yc=pl.col("y").sum(), Sc=pl.col("snpp_n").sum().cast(pl.Float64))
ht = hy.group_by("r5").agg(Yt=pl.col("Yc").sum(), St=pl.col("Sc").sum())
G = ht["Yt"].sum() / ht["St"].sum()
df = (df.join(hy, on=["r5", "year"], how="left").join(ht, on="r5", how="left")
        .with_columns([pl.col(c).fill_null(0.0) for c in ("Yc", "Sc", "Yt", "St")])
        .with_columns(Yh=pl.col("Yt") - pl.when(pl.col("year") <= 2017).then(pl.col("Yc")).otherwise(0.0),
                      Sh=pl.col("St") - pl.when(pl.col("year") <= 2017).then(pl.col("Sc")).otherwise(0.0),
                      nyh=pl.when(pl.col("year") <= 2017).then(5.0).otherwise(6.0))
        .with_columns(hist_ratio=(pl.col("Yh") + 20 * G) / (pl.col("Sh") + 20),
                      hist_logS=(pl.col("Sh") / pl.col("nyh")).log1p(), hist_logY=(pl.col("Yh") / pl.col("nyh")).log1p())
        .drop("Yc", "Sc", "Yt", "St", "Yh", "Sh", "nyh"))
print(f"E9 features added; global hist ratio {G:.4f}", flush=True)
KEEP = list(dict.fromkeys(["r5", "month", "year", "mon", "fold", "biome_id", "adm1_code", "iso3", "y", "aqua_n", "terra_n"] + FEATS_H_PRE))
df = df.select(KEEP)
df = df.with_columns([pl.col(c).cast(pl.Float32) for c, t in df.schema.items() if t in (pl.Float64, pl.Int64, pl.UInt32, pl.Int32) and c not in ("year", "mon", "r5")])
df = df.with_columns(pl.col("adm1_code").cast(pl.Categorical), pl.col("iso3").cast(pl.Categorical))
nsum = nsum.filter(pl.col("nb_snpp_n") > 0).select("r5", "month").with_columns(nbflag=pl.lit(True))
del nb, pairs, prev, nxt, hy, ht; gc.collect()
print(f"compacted panel: {df.height:,} rows x {df.width} cols, ~{df.estimated_size('mb'):.0f} MB", flush=True)

FEATS = ["snpp_n", "snpp_day_n", "snpp_night_n", "snpp_fcp", "snpp_frp_sum", "snpp_frp_p50", "snpp_frp_p90",
         "snpp_scan_mean", "snpp_lowfrp_frac", "snpp_fire_days", "snpp_mult", "nb_snpp_n", "nb_snpp_fcp",
         "lat", "msin", "mcos", "biome_id"]
FEATS_C = FEATS + ["snpp_prev", "snpp_next"]
FEATS_H = FEATS_C + ["hist_ratio", "hist_logS", "hist_logY"]
MONO = {"snpp_n": 1, "snpp_day_n": 1, "snpp_night_n": 1, "snpp_fcp": 1, "snpp_frp_sum": 1, "snpp_fire_days": 1}


def h0(tr, te):
    r = tr["y"].sum() / tr["snpp_n"].sum()
    return te["snpp_n"] * r


def h0b(tr, te, k=50.0):
    g_day = tr["terra_day_n"].sum() + tr["aqua_day_n"].sum()
    g_r_day = g_day / tr["snpp_day_n"].sum()
    g_r_night = (tr["y"].sum() - g_day) / tr["snpp_night_n"].sum()
    t = (tr.with_columns(yd=pl.col("terra_day_n") + pl.col("aqua_day_n"))
           .with_columns(yn=pl.col("y") - pl.col("yd"))
           .group_by("biome_id", "mon").agg(yd=pl.col("yd").sum(), yn=pl.col("yn").sum(),
                                            sd=pl.col("snpp_day_n").sum(), sn=pl.col("snpp_night_n").sum())
           .with_columns(rd=(pl.col("yd") + k * g_r_day) / (pl.col("sd") + k),
                         rn=(pl.col("yn") + k * g_r_night) / (pl.col("sn") + k)))
    j = te.join(t.select("biome_id", "mon", "rd", "rn"), on=["biome_id", "mon"], how="left").with_columns(
        pl.col("rd").fill_null(g_r_day), pl.col("rn").fill_null(g_r_night))
    return j["rd"] * j["snpp_day_n"] + j["rn"] * j["snpp_night_n"]


def gbm(tr, te, target, power=1.4, feats=None):
    feats = feats or FEATS
    params = dict(objective="tweedie", tweedie_variance_power=power, learning_rate=0.05, num_leaves=127,
                  min_data_in_leaf=50, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1,
                  lambda_l2=1.0, seed=SEED, verbose=-1, num_threads=8,
                  monotone_constraints=[MONO.get(f, 0) for f in feats], monotone_constraints_method="advanced")
    X = tr.select(feats).cast(pl.Float32).to_numpy(); yv = tr[target].cast(pl.Float32).to_numpy()
    ds = lgb.Dataset(X, yv, feature_name=feats, categorical_feature=["biome_id"], free_raw_data=True)
    m = lgb.train(params, ds, num_boost_round=600)
    del X, yv, ds; gc.collect()
    Xt = te.select(feats).cast(pl.Float32).to_numpy()
    p = m.predict(Xt); del Xt
    return pl.Series(p), m


def kge(o, p):
    if o.std() == 0 or p.std() == 0:
        return dict(kge=np.nan, r=np.nan, beta=np.nan, gamma=np.nan)
    r = np.corrcoef(o, p)[0, 1]; beta = p.mean() / o.mean(); gamma = (p.std() / p.mean()) / (o.std() / o.mean())
    return dict(kge=1 - np.sqrt((r - 1) ** 2 + (beta - 1) ** 2 + (gamma - 1) ** 2), r=r, beta=beta, gamma=gamma)


def score(oof, col):
    res = {}
    for scale, key in [("r5", "r5"), ("adm1", "adm1_code"), ("country", "iso3"), ("biome", "biome_id")]:
        a = (oof.filter(pl.col(key).is_not_null()).group_by(key, "month")
                .agg(o=pl.col("y").sum(), p=pl.col(col).sum()))
        o, p = a["o"].to_numpy(), a["p"].to_numpy()
        ss = ((o - p) ** 2).sum(); st = ((o - o.mean()) ** 2).sum()
        res[scale] = dict(n=len(o), r2=1 - ss / st, bias_pct=100 * (p.sum() - o.sum()) / o.sum(),
                          mae=float(np.abs(o - p).mean()), **kge(o, p))
    res["primary"] = float(np.nanmean([res[s]["kge"] for s in ("adm1", "country", "biome")]))
    a = oof.filter(pl.col("adm1_code").is_not_null()).group_by("adm1_code", "month").agg(o=pl.col("y").sum(), p=pl.col(col).sum())
    res["secondary_logkge_adm1"] = kge(np.log1p(a["o"].to_numpy()), np.log1p(a["p"].to_numpy()))
    return res




# ---- E11 current-month regional features (inputs only), adopted 13 Nov (bench7: primary 0.9903)
_p3m = {c: h3.str_to_int(h3.cell_to_parent(h3.int_to_str(c), 3)) for c in df["r5"].unique().to_list()}
df = df.with_columns(p3=pl.col("r5").replace_strict(_p3m, return_dtype=pl.UInt64))
_R = (df.group_by("p3", "month").agg(_s=pl.col("snpp_n").sum(), _f=pl.col("snpp_fcp").sum(), _q=pl.col("snpp_frp_sum").sum())
        .with_columns(reg_log=pl.col("_s").log1p().cast(pl.Float32), reg_mult=(pl.col("_s") / (pl.col("_f") + 1)).cast(pl.Float32),
                      reg_frp_per=(pl.col("_q") / (pl.col("_s") + 1)).cast(pl.Float32)).select("p3", "month", "reg_log", "reg_mult", "reg_frp_per"))
df = df.join(_R, on=["p3", "month"], how="left").drop("p3"); del _R
FEATS_G = FEATS_H + ["reg_log", "reg_mult", "reg_frp_per"]
# ---------------- TUNING on an INNER split (never touches the B2 test: outer fold 0 regions and 2018-2019 excluded)
import itertools
OUTER = 0; INNER = 1
base = df.filter((pl.col("fold") != OUTER) & (pl.col("snpp_n") > 0))
itr = base.filter((pl.col("fold") != INNER) & (pl.col("year") <= 2016))
iva = base.filter((pl.col("fold") == INNER) & (pl.col("year") == 2017))
print(f"inner train {itr.height:,} inner val {iva.height:,}", flush=True)
feats = FEATS_G


def fit(target, power, leaves, mdl):
    params = dict(objective="tweedie", tweedie_variance_power=power, learning_rate=0.05, num_leaves=leaves,
                  min_data_in_leaf=mdl, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0,
                  seed=SEED, verbose=-1, num_threads=8,
                  monotone_constraints=[MONO.get(f, 0) for f in feats], monotone_constraints_method="advanced")
    dtr = lgb.Dataset(itr.select(feats).cast(pl.Float32).to_numpy(), itr[target].cast(pl.Float32).to_numpy(), feature_name=feats, categorical_feature=["biome_id"], free_raw_data=True)
    Xv = iva.select(feats).cast(pl.Float32).to_numpy()
    dva = lgb.Dataset(Xv, iva[target].cast(pl.Float32).to_numpy(), reference=dtr)
    m = lgb.train(params, dtr, num_boost_round=2500, valid_sets=[dva], callbacks=[lgb.early_stopping(100, verbose=False)])
    p = m.predict(Xv, num_iteration=m.best_iteration); bi = m.best_iteration
    del dtr, dva, Xv, m; gc.collect()
    return p, bi


def inner_score(p):
    o = iva.select("y", "month", "adm1_code", "iso3", "biome_id").with_columns(p=pl.Series(p))
    ks = []
    for key in ("adm1_code", "iso3", "biome_id"):
        a = o.filter(pl.col(key).is_not_null()).group_by(key, "month").agg(o=pl.col("y").sum(), p=pl.col("p").sum())
        ks.append(kge(a["o"].to_numpy(), a["p"].to_numpy())["kge"])
    return float(np.mean(ks)), ks


results = []
for power, leaves, mdl in itertools.product([1.2, 1.4, 1.6], [63, 255], [50, 300]):
    t0 = time.time()
    pa, ia = fit("aqua_n", power, leaves, mdl); pt, it = fit("terra_n", power, leaves, mdl)
    sc, ks = inner_score(pa + pt)
    r = dict(power=power, leaves=leaves, min_data=mdl, iters_aqua=ia, iters_terra=it, inner_primary=sc, kge_adm1=ks[0], kge_country=ks[1], kge_biome=ks[2])
    results.append(r); print(json.dumps(r), f"{time.time()-t0:.0f}s", flush=True)
best = max(results, key=lambda r: r["inner_primary"])
print("BEST", json.dumps(best))
(repo / "data/interim/explore/tuning_inner.json").write_text(json.dumps({"results": results, "best": best}, indent=1))
