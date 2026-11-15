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
import os as _os
TM = int(_os.environ.get('TRAIN_MAX', '2017')); YMAX = int(_os.environ.get('YMAX', '2019'))
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
    s = (pl.scan_parquet(SRC).filter((pl.col("sat") == sat) & pl.col("month").str.slice(0, 4).cast(pl.Int32).is_between(2012, YMAX))
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
        .filter(pl.col("year").is_between(2012, YMAX))
        .join(lk, on="r5", how="left"))
del cm; gc.collect()
df = df.with_columns(pl.col("adm1_code").cast(pl.Categorical), pl.col("iso3").cast(pl.Categorical))
num_cols = [c for c in df.columns if c.endswith(("_n", "_fcp", "_sum", "_p50", "_p90", "_mean", "_days", "_max", "_day"))]
df = df.with_columns([pl.col(c).fill_null(0) for c in num_cols])
df = df.with_columns(
    biome_id=pl.col("biome_id").fill_null(0),
    lat=pl.col("lat").fill_null(0.0),
    y=(pl.col("terra_n") + pl.col("aqua_n")).cast(pl.Float32),
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
for _yr in range(2012, YMAX + 1):  # per year to bound the join size (crash fix 13 Nov)
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
df = df.with_columns(mi=(pl.col("year") * 12 + pl.col("mon")).cast(pl.Int32))
# narrow-table feature construction (memory fix 13 Nov 21:35): build E9 features on (r5, mi, year) and join once
_k = df.select("r5", "mi", "year", "y", "snpp_n")
_ctx = (_k.select("r5", "mi", "year")
          .join(_k.select("r5", (pl.col("mi") + 1).alias("mi"), pl.col("snpp_n").alias("snpp_prev")), on=["r5", "mi"], how="left")
          .join(_k.select("r5", (pl.col("mi") - 1).alias("mi"), pl.col("snpp_n").alias("snpp_next")), on=["r5", "mi"], how="left"))
hy = _k.filter(pl.col("year") <= TM).group_by("r5", "year").agg(Yc=pl.col("y").sum().cast(pl.Float64), Sc=pl.col("snpp_n").sum().cast(pl.Float64))
ht = hy.group_by("r5").agg(Yt=pl.col("Yc").sum(), St=pl.col("Sc").sum())
G = ht["Yt"].sum() / ht["St"].sum()
_ctx = (_ctx.join(hy, on=["r5", "year"], how="left").join(ht, on="r5", how="left")
          .with_columns([pl.col(c).fill_null(0.0) for c in ("Yc", "Sc", "Yt", "St")])
          .with_columns(Yh=pl.col("Yt") - pl.when(pl.col("year") <= TM).then(pl.col("Yc")).otherwise(0.0),
                        Sh=pl.col("St") - pl.when(pl.col("year") <= TM).then(pl.col("Sc")).otherwise(0.0),
                        nyh=pl.when(pl.col("year") <= TM).then(float(TM - 2012)).otherwise(float(TM - 2011)))
          .select("r5", "mi", pl.col("snpp_prev").fill_null(0).cast(pl.Float32), pl.col("snpp_next").fill_null(0).cast(pl.Float32),
                  ((pl.col("Yh") + 20 * G) / (pl.col("Sh") + 20)).cast(pl.Float32).alias("hist_ratio"),
                  (pl.col("Sh") / pl.col("nyh")).log1p().cast(pl.Float32).alias("hist_logS"),
                  (pl.col("Yh") / pl.col("nyh")).log1p().cast(pl.Float32).alias("hist_logY")))
del _k, hy, ht; gc.collect()
df = df.join(_ctx, on=["r5", "mi"], how="left"); del _ctx; gc.collect()
prev = nxt = None
print(f"E9 features added; global hist ratio {G:.4f}", flush=True)
KEEP = list(dict.fromkeys(["r5", "month", "year", "mon", "fold", "biome_id", "adm1_code", "iso3", "y", "aqua_n", "terra_n", "aqua_day_n", "terra_day_n"] + FEATS_H_PRE))
df = df.select(KEEP)
df = df.with_columns([pl.col(c).cast(pl.Float32) for c, t in df.schema.items() if t in (pl.Float64, pl.Int64, pl.UInt32, pl.Int32) and c not in ("year", "mon", "r5")])
df = df.with_columns(pl.col("adm1_code").cast(pl.Categorical), pl.col("iso3").cast(pl.Categorical))
nsum = nsum.filter(pl.col("nb_snpp_n") > 0).select("r5", "month").with_columns(nbflag=pl.lit(True))
del nb, pairs; gc.collect()
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


TW_POWER = float(os.environ.get("TW_POWER", "1.4")); LEAVES = int(os.environ.get("LEAVES", "127"))
ROUNDS = {"aqua_n": int(os.environ.get("ROUNDS_A", "600")), "terra_n": int(os.environ.get("ROUNDS_T", "600"))}


def gbm(tr, te, target, power=None, feats=None, leaves=None, rounds=None):
    feats = feats or FEATS
    power = power or TW_POWER
    params = dict(objective="tweedie", tweedie_variance_power=power, learning_rate=0.05, num_leaves=leaves or LEAVES,
                  min_data_in_leaf=50, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1,
                  lambda_l2=1.0, seed=SEED, verbose=-1, num_threads=8,
                  monotone_constraints=[MONO.get(f, 0) for f in feats], monotone_constraints_method="advanced")
    X = tr.select(feats).cast(pl.Float32).to_numpy(); yv = tr[target].cast(pl.Float32).to_numpy()
    ds = lgb.Dataset(X, yv, feature_name=feats, categorical_feature=["biome_id"], free_raw_data=True)
    m = lgb.train(params, ds, num_boost_round=rounds or ROUNDS[target])
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




if os.environ.get("SMOKE"):
    df = df.filter(pl.col("r5").hash(7) % 20 == 0); nsum = nsum.filter(pl.col("r5").hash(7) % 20 == 0)
    print(f"SMOKE subsample: {df.height:,} rows", flush=True)
# ================= bench7: E11 (current-month regional features) + E12 (nested aggregate recalibration) =================
# All on protocol B2; zero model = v2 (biome x nbflag x regional-activity bin). Memory-safe (month-by-month grid).
TAG = os.environ.get("BENCH_TAG", "B2_E12")
p3map = {c: h3.str_to_int(h3.cell_to_parent(h3.int_to_str(c), 3)) for c in df["r5"].unique().to_list()}
df = df.with_columns(p3=pl.col("r5").replace_strict(p3map, return_dtype=pl.UInt64))
REGF = (df.group_by("p3", "month").agg(reg_snpp=pl.col("snpp_n").sum(), reg_fcp=pl.col("snpp_fcp").sum(), reg_frp=pl.col("snpp_frp_sum").sum())
          .with_columns(reg_log=pl.col("reg_snpp").log1p().cast(pl.Float32),
                        reg_mult=(pl.col("reg_snpp") / (pl.col("reg_fcp") + 1)).cast(pl.Float32),
                        reg_frp_per=(pl.col("reg_frp") / (pl.col("reg_snpp") + 1)).cast(pl.Float32)))
df = df.join(REGF.select("p3", "month", "reg_log", "reg_mult", "reg_frp_per"), on=["p3", "month"], how="left")
REG = REGF.select("p3", "month", "reg_snpp"); del REGF
FEATS_G = FEATS_H + ["reg_log", "reg_mult", "reg_frp_per"]
Ucell = df.filter(pl.col("year") <= TM).select("r5", "fold", "biome_id", "p3").unique("r5")
geo = df.select("r5", "adm1_code", "iso3", "biome_id").unique("r5")
S = df.select("r5", "month", "y", "snpp_n")
months = sorted(df["month"].unique().to_list())
zst, d17, testd = [], [], []
for mth in months:
    yr, mo = int(mth[:4]), int(mth[5:7])
    d = (Ucell.join(S.filter(pl.col("month") == mth).drop("month"), on="r5", how="left")
              .join(nsum.filter(pl.col("month") == mth).drop("month"), on="r5", how="left")
              .join(REG.filter(pl.col("month") == mth).drop("month"), on="p3", how="left")
              .with_columns(pl.col("y").fill_null(0.0), pl.col("snpp_n").fill_null(0.0), pl.col("nbflag").fill_null(False),
                            rbin=pl.col("reg_snpp").fill_null(0).cast(pl.Float64).log1p().floordiv(1.5).clip(0, 6).cast(pl.Int8),
                            mon=pl.lit(mo, pl.Int32), year=pl.lit(yr, pl.Int32), month=pl.lit(mth)))
    z = d.filter(pl.col("snpp_n") == 0)
    zst.append(z.group_by("fold", "biome_id", "nbflag", "rbin", "year").agg(Y=pl.col("y").sum(), N=pl.len()))
    keep = d.select("r5", "p3", "month", "y", "snpp_n", "nbflag", "rbin", "biome_id", "fold")
    if yr == TM:
        d17.append(keep)
    elif yr > TM:
        testd.append(keep)
    del d, z
zst = pl.concat(zst); d17 = pl.concat(d17); testd = pl.concat(testd)
del S; gc.collect()
print(f"grids: test {testd.height:,} rows, inner-2017 {d17.height:,} rows", flush=True)


def z2_table(k, ymax, k0=200.0):
    t = zst.filter((pl.col("fold") != k) & (pl.col("year") <= ymax))
    g = t["Y"].sum() / t["N"].sum()
    p = t.group_by("nbflag", "rbin").agg(Yp=pl.col("Y").sum(), Np=pl.col("N").sum()).with_columns(prate=(pl.col("Yp") + k0 * g) / (pl.col("Np") + k0))
    v2 = (t.group_by("biome_id", "nbflag", "rbin").agg(pl.col("Y").sum(), pl.col("N").sum()).join(p, on=["nbflag", "rbin"])
            .with_columns(z2=(pl.col("Y") + k0 * pl.col("prate")) / (pl.col("N") + k0)).select("biome_id", "nbflag", "rbin", "z2"))
    return v2, g


BINS = [0.0, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000]


def assemble(grid, pr, ztab, g):
    """grid rows (dense U + extra) with model preds pr (r5, month, cols...) and zero-model z2 -> per-row totals."""
    u = (grid.join(ztab, on=["biome_id", "nbflag", "rbin"], how="left").with_columns(pl.col("z2").fill_null(g))
             .with_columns(z2=pl.when(pl.col("snpp_n") > 0).then(0.0).otherwise(pl.col("z2"))))
    return u.join(pr, on=["r5", "month"], how="left").with_columns([pl.col(c).fill_null(0.0) for c in pr.columns if c not in ("r5", "month")])


def calib_curve(a):
    """a: per (p3, month) obs O and pred P (inner OOF). Ratio-of-sums per log-pred bin, shrunk to 1."""
    a = a.with_columns(b=pl.col("P").cut(BINS[1:], labels=[str(i) for i in range(len(BINS))]).cast(pl.Utf8))
    return a.group_by("b").agg(O=pl.col("O").sum(), P=pl.col("P").sum(), n=pl.len()).with_columns(gfac=(pl.col("O") + 20) / (pl.col("P") + 20))


def apply_curve(rows, pcol, curve):
    agg = rows.group_by("p3", "month").agg(P=pl.col(pcol).sum()).with_columns(
        b=pl.col("P").cut(BINS[1:], labels=[str(i) for i in range(len(BINS))]).cast(pl.Utf8)).join(curve.select("b", "gfac"), on="b", how="left")
    return rows.join(agg.select("p3", "month", "gfac"), on=["p3", "month"], how="left").with_columns(pl.col("gfac").fill_null(1.0))



QS = np.linspace(0.005, 0.995, 199)


def qm_curve(ag):
    """ag: per (p3, month) O (obs) and P (pred) on the INNER year. Map log1p(P) quantiles onto log1p(O) quantiles."""
    xs = np.quantile(np.log1p(ag["P"].to_numpy()), QS); ys = np.quantile(np.log1p(ag["O"].to_numpy()), QS)
    xs = np.maximum.accumulate(xs); ys = np.maximum.accumulate(ys)
    return xs, ys


def apply_qm(rows, pcol, xs, ys):
    agg = rows.group_by("p3", "month").agg(P=pl.col(pcol).sum())
    P = agg["P"].to_numpy(); lp = np.log1p(P)
    mapped = np.expm1(np.interp(lp, xs, ys))
    hi = lp > xs[-1]
    mapped[hi] = P[hi] * (np.expm1(ys[-1]) / max(np.expm1(xs[-1]), 1e-9))
    fac = np.where(P > 0, np.clip(mapped / np.maximum(P, 1e-9), 0.0, 5.0), 1.0)
    agg = agg.with_columns(qfac=pl.Series(fac))
    return rows.join(agg.select("p3", "month", "qfac"), on=["p3", "month"], how="left").with_columns(pl.col("qfac").fill_null(1.0))


VARIANTS = ["H0", "H0b", "H1E1", "H1E1g_z2", "H1E1g_z2_cal", "H1E1g_z2_qm"] if _os.environ.get("BASELINES") else ["H1E1g_z2", "H1E1g_z2_cal", "H1E1g_z2_qm"]
oof, curves = [], {}
for k in range(5):
    t0 = time.time()
    tr = df.filter((pl.col("fold") != k) & (pl.col("year") <= TM) & (pl.col("snpp_n") > 0))
    te = df.filter((pl.col("fold") == k) & (pl.col("year") > TM) & (pl.col("snpp_n") > 0))
    ga, _ = gbm(tr, te, "aqua_n", feats=FEATS_G); gt, _ = gbm(tr, te, "terra_n", feats=FEATS_G)
    pr = te.select("r5", "month").with_columns(mg=(ga + gt).cast(pl.Float32))
    if "H1E1" in VARIANTS:
        ba, _ = gbm(tr, te, "aqua_n", feats=FEATS, power=1.4, leaves=127, rounds=600); bt, _ = gbm(tr, te, "terra_n", feats=FEATS, power=1.4, leaves=127, rounds=600)
        pr = pr.with_columns(mb=(ba + bt).cast(pl.Float32), m0=h0(tr, te).cast(pl.Float32), m0b=h0b(tr, te).cast(pl.Float32))
    del tr; gc.collect()
    # ---- E12 inner: train folds!=k <= 2016, predict folds!=k 2017 (no outer-test data touched)
    itr = df.filter((pl.col("fold") != k) & (pl.col("year") <= TM - 1) & (pl.col("snpp_n") > 0))
    ite = df.filter((pl.col("fold") != k) & (pl.col("year") == TM) & (pl.col("snpp_n") > 0))
    ia, _ = gbm(itr, ite, "aqua_n", feats=FEATS_G); it_, _ = gbm(itr, ite, "terra_n", feats=FEATS_G)
    ipr = ite.select("r5", "month").with_columns(mh=(ia + it_).cast(pl.Float32))
    del itr, ite; gc.collect()
    zin, gin = z2_table(k, TM - 1)
    inner = assemble(d17.filter(pl.col("fold") != k), ipr, zin, gin).with_columns(tot=pl.col("mh") + pl.col("z2"))
    curve = calib_curve(inner.group_by("p3", "month").agg(O=pl.col("y").sum(), P=pl.col("tot").sum()))
    curves[k] = curve.sort("b").to_dicts()
    # ---- outer test assembly
    zout, gout = z2_table(k, TM)
    extra = (df.filter((pl.col("fold") == k) & (pl.col("year") > TM) & ((pl.col("snpp_n") > 0) | (pl.col("y") > 0)))
               .join(Ucell.select("r5"), on="r5", how="anti")
               .select("r5", "p3", "month", "y", "snpp_n", pl.lit(False).alias("nbflag"), pl.lit(0, pl.Int8).alias("rbin"), "biome_id", "fold"))
    grid = pl.concat([testd.filter(pl.col("fold") == k), extra.select(testd.columns)], how="vertical_relaxed")
    u = assemble(grid, pr, zout, gout).with_columns(H1E1g_z2=pl.col("mg") + pl.col("z2"))
    u = apply_curve(u, "H1E1g_z2", calib_curve(inner.group_by("p3", "month").agg(O=pl.col("y").sum(), P=pl.col("tot").sum()))).rename({"gfac": "gg"})
    u = u.with_columns(H1E1g_z2_cal=pl.col("H1E1g_z2") * pl.col("gg"))
    _ag = inner.group_by("p3", "month").agg(O=pl.col("y").sum(), P=pl.col("tot").sum())
    _xs, _ys = qm_curve(_ag)
    u = apply_qm(u, "H1E1g_z2", _xs, _ys).with_columns(H1E1g_z2_qm=pl.col("H1E1g_z2") * pl.col("qfac"))
    if "H1E1" in VARIANTS:
        u = u.with_columns(H1E1=pl.col("mb") + pl.col("z2"), H0=pl.col("m0") + pl.col("z2"), H0b=pl.col("m0b") + pl.col("z2"))
    oof.append(u.select("r5", "month", "y", "snpp_n", *VARIANTS))
    del pr, ipr, inner, grid, extra, u; gc.collect()
    print(f"fold {k} done ({time.time()-t0:.0f}s); curve: " + ", ".join(f"{c['b']}:{c['gfac']:.2f}" for c in curves[k]), flush=True)
oof = pl.concat(oof).join(geo, on="r5", how="left").with_columns(pl.col("adm1_code").cast(pl.Utf8), pl.col("iso3").cast(pl.Utf8))
if os.environ.get("EXCLUDE_SMOKE"):  # B3: drop the 5% cells seen in the smoke test (hash(7) % 20 == 0)
    _n0 = oof.height; oof = oof.filter(pl.col("r5").hash(7) % 20 != 0); print(f"EXCLUDE_SMOKE: {_n0 - oof.height:,} rows removed", flush=True)
oof.write_parquet(repo / f"data/interim/explore/bench_oof_{TAG}.parquet")
report = {m: score(oof, m) for m in VARIANTS}
(repo / f"data/interim/explore/bench_report_{TAG}.json").write_text(json.dumps({"report": report, "curves": curves}, indent=1, default=float))
for m in VARIANTS:
    r = report[m]; L = r["secondary_logkge_adm1"]
    print(f"\n{m}: PRIMARY {r['primary']:.4f} | adm1 {r['adm1']['kge']:.4f} country {r['country']['kge']:.4f} biome {r['biome']['kge']:.4f} "
          f"r5 {r['r5']['kge']:.4f} | bias {r['adm1']['bias_pct']:+.2f}% | logKGE adm1 {L['kge']:.4f} (r {L['r']:.3f} beta {L['beta']:.3f} gamma {L['gamma']:.3f})")
