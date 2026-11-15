"""Product build step 3: Bridge v2 (H1E1g tuned) training and prediction.
- Cross-fit (5 spatial folds) on 2012-2019 model rows -> work/pred_cf.parquet (used for regime B and uncertainty stats).
- Final models on all 2012-2019 -> data/products/models/{aqua,terra}.txt; predictions 2020..2026 -> work/pred_final_YYYY.parquet.
Usage: python -P train_predict.py <repo>
"""
import gc
import json
import sys
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import polars as pl

repo = Path(sys.argv[1]); import os
PROD = repo / os.environ.get("PRODUCTS_DIR", "data/products")
work = PROD / "work"; mdir = PROD / "models"; mdir.mkdir(parents=True, exist_ok=True)
FEATS = ["snpp_n", "snpp_day_n", "snpp_night_n", "snpp_fcp", "snpp_frp_sum", "snpp_frp_p50", "snpp_frp_p90", "snpp_scan_mean",
         "snpp_lowfrp_frac", "snpp_fire_days", "snpp_mult", "nb_snpp_n", "nb_snpp_fcp", "lat", "msin", "mcos", "biome_id",
         "snpp_prev", "snpp_next", "hist_ratio", "hist_logS", "hist_logY", "reg_log", "reg_mult", "reg_frp_per"]
MONO = {"snpp_n": 1, "snpp_day_n": 1, "snpp_night_n": 1, "snpp_fcp": 1, "snpp_frp_sum": 1, "snpp_fire_days": 1}
PARAMS = dict(objective="tweedie", tweedie_variance_power=1.2, learning_rate=0.05, num_leaves=63, min_data_in_leaf=50,
              feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, seed=2026, verbose=-1, num_threads=8,
              monotone_constraints=[MONO.get(f, 0) for f in FEATS], monotone_constraints_method="advanced")
ROUNDS = {"aqua_n": 1400, "terra_n": 1500}


def fit(tr, target):
    ds = lgb.Dataset(tr.select(FEATS).to_numpy().astype(np.float32), tr[target].to_numpy().astype(np.float32),
                     feature_name=FEATS, categorical_feature=["biome_id"], free_raw_data=True)
    m = lgb.train(PARAMS, ds, num_boost_round=ROUNDS[target]); del ds; gc.collect()
    return m


def pred(m_a, m_t, df):
    X = df.select(FEATS).to_numpy().astype(np.float32)
    return np.maximum(m_a.predict(X), 0) + np.maximum(m_t.predict(X), 0)


train = pl.concat([pl.read_parquet(work / f"feat_{y}.parquet") for y in range(2012, 2020)])
print(f"training rows {train.height:,}", flush=True)
cf = []
for k in range(5):
    t0 = time.time()
    tr = train.filter(pl.col("fold") != k); te = train.filter(pl.col("fold") == k)
    ma, mt = fit(tr, "aqua_n"), fit(tr, "terra_n")
    cf.append(te.select("r5", "month").with_columns(p_model=pl.Series(pred(ma, mt, te)).cast(pl.Float32)))
    del tr, te, ma, mt; gc.collect()
    print(f"cross-fit fold {k} ({time.time()-t0:.0f}s)", flush=True)
pl.concat(cf).write_parquet(work / "pred_cf.parquet"); del cf; gc.collect()
t0 = time.time()
ma, mt = fit(train, "aqua_n"), fit(train, "terra_n")
ma.save_model(str(mdir / "aqua.txt")); mt.save_model(str(mdir / "terra.txt"))
imp = {"aqua": dict(zip(FEATS, ma.feature_importance("gain").round(1).tolist())), "terra": dict(zip(FEATS, mt.feature_importance("gain").round(1).tolist()))}
(mdir / "feature_importance.json").write_text(json.dumps(imp, indent=1))
print(f"final models trained ({time.time()-t0:.0f}s)", flush=True)
del train; gc.collect()
for y in range(2020, 2027):
    f = pl.read_parquet(work / f"feat_{y}.parquet")
    f.select("r5", "month").with_columns(p_model=pl.Series(pred(ma, mt, f)).cast(pl.Float32)).write_parquet(work / f"pred_final_{y}.parquet")
    print(f"predicted {y}: {f.height:,} rows", flush=True)
print("DONE train_predict")
