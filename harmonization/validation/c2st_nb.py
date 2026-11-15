"""C2ST with a region-level negative-binomial predictive draw.
Region-month total ~ Poisson(Z * P), Z ~ Gamma(shape 1/v, scale v), so Var = P + v P^2. The overdispersion v per
predicted-level bin is estimated by moments, CROSS-FITTED over 5 region groups (group g uses only the other groups).
Reuses scorecard_oof's 12 series features and grouped-CV LightGBM classifier.
Usage: python -P c2st_nb.py <repo> <tag> <col>
"""
import json, sys, zlib
from pathlib import Path
import lightgbm as lgb, numpy as np, polars as pl
from scipy import stats
from sklearn.model_selection import GroupKFold
repo, tag, col = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
SEED = int(sys.argv[4]) if len(sys.argv) > 4 else 2026; ZI = len(sys.argv) > 5 and sys.argv[5] == "zi"
ex = repo / "data/interim/explore"
o = pl.read_parquet(ex / f"bench_oof_{tag}.parquet", columns=["month", "y", "adm1_code", col])
allr = o.filter(pl.col("adm1_code").is_not_null()).group_by("adm1_code", "month").agg(obs=pl.col("y").sum(), P=pl.col(col).sum())
allr = allr.with_columns(grp=pl.col("adm1_code").map_elements(lambda s: zlib.crc32(s.encode()) % 5, return_dtype=pl.Int8),
                         b=pl.col("P").clip(1e-6, None).log10().floordiv(0.5).clip(-4, 9).cast(pl.Int8))
vt, zt = {}, {}
for g in range(5):
    zt[g] = {int(b): float(z) for b, z in allr.filter(pl.col("grp") != g).group_by("b").agg(z=(pl.col("obs") == 0).mean()).iter_rows()}
    t = allr.filter(pl.col("grp") != g).group_by("b").agg(v=(((pl.col("obs") - pl.col("P")) ** 2 - pl.col("P")) / pl.col("P") ** 2).mean())
    vt[g] = {int(b): (min(max(float(v), 1e-4), 1e3) if v == v and abs(v) != float("inf") else 1.0) for b, v in t.iter_rows()}
reg = allr.group_by("adm1_code").agg(m=pl.col("obs").mean(), n=pl.len()).filter((pl.col("m") >= 50) & (pl.col("n") == 24))["adm1_code"]
a = allr.filter(pl.col("adm1_code").is_in(reg.implode())).sort("adm1_code", "month")
rng = np.random.default_rng(SEED)
v = np.array([vt[g].get(b, 0.05) for g, b in zip(a["grp"].to_list(), a["b"].to_list())])
P = a["P"].to_numpy().astype(float); pi = np.zeros_like(P)
if ZI:
    z0 = np.array([zt[g].get(b, 0.0) for g, b in zip(a["grp"].to_list(), a["b"].to_list())])
    for _ in range(50):  # fixed point for pi given target zero prob z0 and NB(mean P/(1-pi), disp v)
        mu = P / np.maximum(1 - pi, 1e-6); p0nb = (1 + v * mu) ** (-1 / v)
        pi = np.clip((z0 - p0nb) / np.maximum(1 - p0nb, 1e-9), 0, 0.95)
mu = P / np.maximum(1 - pi, 1e-6)
Z = rng.gamma(1 / v, v); draw = rng.poisson(mu * Z).astype(float) * (rng.random(len(P)) >= pi)
a = a.with_columns(nb=pl.Series(draw))
def feats(x):
    x = np.asarray(x, float); m = x.mean(); s = x.std(); clim = x.reshape(2, 12).mean(0)
    ac = lambda k: float(np.corrcoef(x[:-k], x[k:])[0, 1]) if x[:-k].std() > 0 and x[k:].std() > 0 else 0.0
    f = np.abs(np.fft.rfft(x - m)) ** 2
    return [np.log1p(m), s / (m + 1e-9), (x == 0).mean(), clim.max() / (clim.mean() + 1e-9), ac(1), ac(12), float(np.argmax(clim)),
            float(stats.skew(x)) if s > 0 else 0.0, f[2] / (f.sum() + 1e-9), np.log1p(x.max()), np.log1p(np.median(x)), float(np.mean(np.abs(np.diff(x)))) / (m + 1e-9)]
X, yl, gg = [], [], []
for r, g in a.group_by("adm1_code", maintain_order=True):
    X.append(feats(g["obs"].to_numpy())); yl.append(0); gg.append(r[0]); X.append(feats(g["nb"].to_numpy())); yl.append(1); gg.append(r[0])
X, yl, gg = np.array(X), np.array(yl), np.array(gg); pred = np.zeros_like(yl)
for tr, te in GroupKFold(5).split(X, yl, gg):
    m = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.05, num_leaves=15, min_child_samples=20, random_state=2026, verbose=-1)
    m.fit(X[tr], yl[tr]); pred[te] = m.predict(X[te])
k = int((pred == yl).sum()); n = len(yl); lo, hi = stats.binomtest(k, n).proportion_ci(0.95, method="wilson")
zero_obs, zero_nb = float((a["obs"] == 0).mean()), float((a["nb"] == 0).mean())
print(json.dumps(dict(tag=tag, model=col, seed=SEED, zi=ZI, n=n, c2st=round(k / n, 4), ci95=[round(lo, 3), round(hi, 3)], zero_months_obs=round(zero_obs, 3), zero_months_draw=round(zero_nb, 3))))
