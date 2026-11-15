"""Re-predict 2020..2026 with the saved final models (after a reference-sensor change in build_features). Same FEATS as train_predict.py.
Usage: python -P predict_final.py <repo>"""
import sys, os
from pathlib import Path
import lightgbm as lgb, numpy as np, polars as pl
repo = Path(sys.argv[1]); PROD = repo / os.environ.get("PRODUCTS_DIR", "data/products"); work = PROD / "work"; mdir = PROD / "models"
FEATS = ["snpp_n", "snpp_day_n", "snpp_night_n", "snpp_fcp", "snpp_frp_sum", "snpp_frp_p50", "snpp_frp_p90", "snpp_scan_mean",
         "snpp_lowfrp_frac", "snpp_fire_days", "snpp_mult", "nb_snpp_n", "nb_snpp_fcp", "lat", "msin", "mcos", "biome_id",
         "snpp_prev", "snpp_next", "hist_ratio", "hist_logS", "hist_logY", "reg_log", "reg_mult", "reg_frp_per"]
ma = lgb.Booster(model_file=str(mdir / "aqua.txt")); mt = lgb.Booster(model_file=str(mdir / "terra.txt"))
assert ma.feature_name() == FEATS
for y in range(2020, 2027):
    f = pl.read_parquet(work / f"feat_{y}.parquet"); X = f.select(FEATS).to_numpy().astype(np.float32)
    p = np.maximum(ma.predict(X), 0) + np.maximum(mt.predict(X), 0)
    f.select("r5", "month").with_columns(p_model=pl.Series(p).cast(pl.Float32)).write_parquet(work / f"pred_final_{y}.parquet")
    print(f"predicted {y}: {f.height:,} rows, sum {p.sum():,.0f}", flush=True)
print("DONE predict_final")
