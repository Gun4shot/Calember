"""Fire Twins index + regime atlas (Guideline §4.9; CONTRACTS §3.4) -> data/products/
twins_index.parquet: h3_r3, lat, lon, name, area_km2, total_meh, features (standardized, weighted), shape12, peak_month, regime_id
twins_scaler.json, regimes.json (also copied to web/public/static/).
Units: r3 cells with >= twins.min_hotspots harmonized hotspots over the record. Baseline: config baseline_years.
Usage: python -P pipeline/build_twins.py <repo>
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import h3
import numpy as np
import polars as pl
import yaml
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

repo = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
sys.path.insert(0, str(repo / "science"))
from ember_science.twins import Scaler, features, months_text, regime_name  # noqa: E402

cfg = yaml.safe_load((repo / "config/ember.yaml").read_text(encoding="utf-8"))
prod = repo / cfg["paths"]["products"]; api = prod / "api"
tw = cfg["twins"]; b0, b1 = cfg["baseline_years"]
W = tw["weights"]
t0 = time.time()

r3m = pl.read_parquet(api / "r3_month.parquet").with_columns(year=pl.col("month").str.slice(0, 4).cast(pl.Int32), mon=pl.col("month").str.slice(5, 2).cast(pl.Int32))
tot = r3m.group_by("r3").agg(total=pl.col("h").sum()).filter(pl.col("total") >= tw["min_hotspots"]).sort("r3")  # sorted: deterministic k-means
base = r3m.filter(pl.col("year").is_between(b0, b1) & pl.col("r3").is_in(tot["r3"].implode()))
# night share from VIIRS S-NPP 2012-2025 (day/night counts in the masked cell-month archive)
cells = pl.read_parquet(api / "cells_r5.parquet").select("r5", "r3", "adm1_name", "country_name", "tot")
vn = pl.concat([pl.read_parquet(f, columns=["sat", "r5", "n", "n_day"]).filter(pl.col("sat") == "SNPP")
                for f in sorted((repo / "data/interim/explore/cm_long_m1").glob("viirs-snpp_*.parquet"))])
night = (vn.join(cells.select("r5", "r3"), on="r5").group_by("r3").agg(n=pl.col("n").sum(), d=pl.col("n_day").sum())
           .with_columns(night=(1 - pl.col("d") / pl.col("n")).cast(pl.Float64)))
nmap = dict(night.select("r3", "night").iter_rows())
# names: the admin-1 region holding most of the cell's fire
nm = (cells.drop_nulls("country_name").group_by("r3", "adm1_name", "country_name").agg(t=pl.col("tot").sum())
           .sort("t", descending=True).unique("r3", keep="first"))
names = {r: (f"{a}, {c}" if a else c) for r, a, c, _ in nm.iter_rows()}

F, ids = [], []
grid = {r: np.zeros((b1 - b0 + 1, 12)) for r in tot["r3"].to_list()}
for r, y, k, h in base.select("r3", "year", "mon", "h").iter_rows():
    grid[r][y - b0, k - 1] += h
for r, g in grid.items():
    hx = h3.int_to_str(int(r))
    f = features({b0 + i: g[i] for i in range(g.shape[0])}, h3.cell_area(hx, "km^2"), nmap.get(r))
    if f is not None:
        F.append(f); ids.append(r)
sc = Scaler.fit(F, W)
X = np.array([sc.vector(f) for f in F])
print(f"units: {len(F):,} r3 cells with >= {tw['min_hotspots']} hotspots ({time.time()-t0:.0f}s)", flush=True)

# regime atlas: k-means, k by silhouette (sampled)
rng = np.random.default_rng(2026)
samp = rng.choice(len(X), size=min(4000, len(X)), replace=False)
# the atlas groups places mainly by WHEN they burn: the season-shape block counts SHAPE_BOOST^2 times more than in twin matching
SHAPE_BOOST = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
Xc = X.copy(); Xc[:, :12] *= SHAPE_BOOST
best = None
for k in range(10, 15):
    km = KMeans(n_clusters=k, n_init=10, random_state=2026).fit(Xc)
    s = silhouette_score(Xc[samp], km.labels_[samp])
    print(f"k={k}: silhouette {s:.3f}", flush=True)
    if best is None or s > best[0]:
        best = (s, k, km)
_, K, km = best
lab = km.labels_
# order regimes by size, ids 1..K
order = [c for c, _ in sorted(((c, int((lab == c).sum())) for c in range(K)), key=lambda t: -t[1])]
remap = {c: i + 1 for i, c in enumerate(order)}
regimes = []
tot_map = dict(tot.iter_rows())
for c in order:
    mem = [i for i in range(len(F)) if lab[i] == c]
    name, desc = regime_name([F[i] for i in mem])
    shape = np.median(np.array([F[i].shape12 for i in mem]), axis=0); shape = shape / shape.sum()
    ex = sorted(mem, key=lambda i: -tot_map[ids[i]])[:3]
    # timing coherence: members whose own peak month lies within one month of the regime's peak months (>= 60 % of the regime peak)
    pm = {i for i in range(12) if shape[i] >= 0.6 * shape.max()}
    near = {(i + d) % 12 for i in pm for d in (-1, 0, 1)}
    coh = float(np.mean([int(np.argmax(F[i].shape12)) in near for i in mem]))
    regimes.append({"regime_id": remap[c], "name": name, "description": desc, "timing_coherence": round(coh, 3), "shape12": [round(float(v), 4) for v in shape],
                    "n_units": len(mem), "example_units": [h3.int_to_str(int(ids[i])) for i in ex],
                    "example_names": [names.get(ids[i], "") for i in ex]})
print(f"regimes: k={K} (silhouette {best[0]:.3f})", flush=True)
for r in regimes:
    print(f"  {r['regime_id']:2d} {r['n_units']:5d}  coherence {r['timing_coherence']:.2f}  {r['name']}", flush=True)

rows = []
for i, (r, f) in enumerate(zip(ids, F)):
    hx = h3.int_to_str(int(r)); lat, lon = h3.cell_to_latlng(hx)
    rows.append({"h3_r3": hx, "lat": round(lat, 4), "lon": round(lon, 4), "name": names.get(r, f"{lat:.1f}, {lon:.1f}"),
                 "area_km2": round(h3.cell_area(hx, "km^2"), 1), "total_meh": round(float(tot_map[r]), 1),
                 "features": X[i].astype(np.float32).tolist(), "shape12": f.shape12.astype(np.float32).tolist(),
                 "peak_month": int(np.argmax(f.shape12)) + 1, "regime_id": remap[lab[i]],
                 "R": round(f.R, 4), "density": round(f.density, 4), "cv": round(f.cv, 4), "trend": round(f.trend, 2),
                 "bimodal": bool(f.bimodal), "night": None if f.night is None else round(f.night, 4), "mean_annual": round(f.mean_annual, 2)})
idx = pl.DataFrame(rows, schema_overrides={"features": pl.List(pl.Float32), "shape12": pl.List(pl.Float32), "peak_month": pl.Int8, "regime_id": pl.Int8})
idx.write_parquet(prod / "twins_index.parquet")
(prod / "twins_scaler.json").write_text(json.dumps(sc.d, indent=1), encoding="utf-8")
(prod / "regimes.json").write_text(json.dumps(regimes, indent=1, ensure_ascii=False), encoding="utf-8")
shutil.copyfile(prod / "regimes.json", repo / cfg["paths"]["static_out"] / "regimes.json")
print(f"DONE build_twins ({time.time()-t0:.0f}s)")
# static map layer: regime per r3 unit (the web colours units by regime)
(repo / cfg["paths"]["static_out"] / "regime_map_r3.json").write_text(
    json.dumps({"cells": idx["h3_r3"].to_list(), "regime_id": [int(v) for v in idx["regime_id"].to_list()]}), encoding="utf-8")
print("regime_map_r3.json written")
