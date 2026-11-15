"""E6 conformal 90% intervals for area-month totals (scorecard S5).
Mondrian split-conformal on log residuals s = |log((y+1)/(p+1))|, stratified by predicted-level bin, CROSS-FITTED over
5 region groups (crc32 of the unit id): the quantile for group g is computed from the other groups only.
Interval = [max(0,(p+1)e^-q - 1), (p+1)e^q - 1]. Reports empirical coverage and width for adm1-month and country-month.
Usage: python -P conformal.py <repo> <oof_tag> <model_col> [alpha=0.10]
"""
import json
import sys
import zlib
from pathlib import Path

import numpy as np
import polars as pl

repo, tag, col = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
alpha = float(sys.argv[4]) if len(sys.argv) > 4 else 0.10
ex = repo / "data/interim/explore"
o = pl.read_parquet(ex / f"bench_oof_{tag}.parquet", columns=["month", "y", "adm1_code", "iso3", col])
BINS = [0.3, 1, 3, 10, 30, 100, 300, 1000, 10000]
res = {"tag": tag, "model": col, "alpha": alpha}
for scale, key in (("adm1", "adm1_code"), ("country", "iso3")):
    a = o.filter(pl.col(key).is_not_null()).group_by(key, "month").agg(y=pl.col("y").sum(), p=pl.col(col).sum())
    a = a.with_columns(s=((pl.col("y") + 1) / (pl.col("p") + 1)).log().abs(),
                       b=pl.col("p").cut(BINS, labels=[str(i) for i in range(len(BINS) + 1)]).cast(pl.Utf8),
                       g=pl.col(key).map_elements(lambda v: zlib.crc32(v.encode()) % 5, return_dtype=pl.Int8))
    out = []
    for gk in range(5):
        cal = a.filter(pl.col("g") != gk)
        n = cal.group_by("b").agg(q=pl.col("s").quantile(1 - alpha, "higher"), n=pl.len())
        qall = float(cal["s"].quantile(1 - alpha, "higher"))
        t = a.filter(pl.col("g") == gk).join(n, on="b", how="left").with_columns(pl.col("q").fill_null(qall))
        out.append(t)
    t = pl.concat(out).with_columns(lo=((pl.col("p") + 1) * (-pl.col("q")).exp() - 1).clip(0, None), hi=(pl.col("p") + 1) * pl.col("q").exp() - 1)
    t = t.with_columns(cov=((pl.col("y") >= pl.col("lo")) & (pl.col("y") <= pl.col("hi"))).cast(pl.Float64),
                       relw=(pl.col("hi") - pl.col("lo")) / (pl.col("p") + 1))
    byb = t.group_by("b").agg(n=pl.len(), coverage=pl.col("cov").mean(), median_rel_width=pl.col("relw").median(),
                              median_pred=pl.col("p").median()).sort("median_pred")
    res[scale] = dict(n=t.height, coverage=float(t["cov"].mean()), median_rel_width=float(t["relw"].median()),
                      by_bin=byb.to_dicts())
    print(f"{scale}: n={t.height:,} coverage={t['cov'].mean():.3f} (target {1-alpha:.2f}); median relative width {t['relw'].median():.2f}")
    print(byb.to_pandas().round(3).to_string(index=False))
(ex / f"conformal_{tag}_{col}.json").write_text(json.dumps(res, indent=1, default=float))
