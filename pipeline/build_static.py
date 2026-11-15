"""build_static (CONTRACTS §4): web/public/static/* from the products, plus the API's cell-sorted product copy.
Outputs:
  data/products/api/cell_month_by_cell.parquet   product sorted by (cell, month), small row groups -> fast area queries
  data/products/api/cells_r5.parquet             r5 cell -> lat, lon, r3, biome, admin-1, country (cells with any activity)
  web/public/static/globe_cells_r3.json, globe_months.json, globe_r3_monthly.u8, globe_meta.json, coverage_r3.json
  web/public/static/map_r3_stats.json            (additive) per r3 cell: mean annual MEH 2003-2025, peak month, for the map layer
  web/public/static/admin0.geojson, admin1.geojson, search_index.json
  web/public/static/validation_report.json, drift.json, turing_rounds.json (copies)
Usage: python -P pipeline/build_static.py <repo>
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import geopandas as gpd
import h3
import numpy as np
import polars as pl
import yaml

repo = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
cfg = yaml.safe_load((repo / "config/ember.yaml").read_text())
prod = repo / cfg["paths"]["products"]; out = repo / cfg["paths"]["static_out"]; out.mkdir(parents=True, exist_ok=True)
api_dir = prod / "api"; api_dir.mkdir(parents=True, exist_ok=True)
src = prod / "harmonized_cell_month.parquet"
t0 = time.time()

# 1) API copy sorted by cell (DuckDB external sort, memory-capped)
con = duckdb.connect()
con.execute(f"SET memory_limit='2GB'; SET threads=2; SET preserve_insertion_order=true; SET temp_directory='{(repo / 'data/tmp_duckdb').as_posix()}'")
dst = repo / cfg["paths"]["api_cell_month"]
con.execute(f"COPY (SELECT * FROM '{src.as_posix()}' ORDER BY h3_r5_u64, month) TO '{dst.as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)")
print(f"api copy: {con.execute(f'SELECT count(*) FROM read_parquet(?)', [dst.as_posix()]).fetchone()[0]:,} rows ({time.time()-t0:.0f}s)", flush=True)

# 2) cell table (active r5 cells) with r3 parent, centre, admin, biome
lk = pl.read_parquet(repo / cfg["paths"]["h3_lookup"]).select(pl.col("h3_r5_u64").alias("r5"), "lat", "lon", "biome_id", "adm1_code", "adm1_name", "iso3", "country_name")
act = pl.DataFrame(con.execute(f"SELECT h3_r5_u64 AS r5, sum(h_count) AS tot FROM '{src.as_posix()}' GROUP BY 1").fetchall(), schema=["r5", "tot"], orient="row")
act = act.with_columns(pl.col("r5").cast(pl.UInt64))
cells = act["r5"].to_list()
r3 = [h3.str_to_int(h3.cell_to_parent(h3.int_to_str(c), 3)) for c in cells]
ll = [h3.cell_to_latlng(h3.int_to_str(c)) for c in cells]
ct = act.with_columns(r3=pl.Series(r3, dtype=pl.UInt64), clat=pl.Series([p[0] for p in ll]), clon=pl.Series([p[1] for p in ll]))
ct = ct.join(lk, on="r5", how="left").with_columns(pl.col("lat").fill_null(pl.col("clat")), pl.col("lon").fill_null(pl.col("clon"))).drop("clat", "clon")
ct.write_parquet(api_dir / "cells_r5.parquet")
print(f"cells: {ct.height:,} active r5 cells, {ct['r3'].n_unique():,} r3 parents", flush=True)

# 3) globe r3 monthly (u8, log1p-scaled)
r3map = ct.select("r5", "r3")
con.register("r3map", r3map.to_arrow())
g = pl.DataFrame(con.execute(f"""SELECT m.r3, p.month, sum(p.h_count) AS h FROM '{src.as_posix()}' p JOIN r3map m ON p.h3_r5_u64 = m.r5
                                 GROUP BY 1, 2""").fetchall(), schema=["r3", "month", "h"], orient="row")
months = sorted(g["month"].unique().to_list())
g3 = g.group_by("r3").agg(tot=pl.col("h").sum()).filter(pl.col("tot") > 0).sort("r3")
r3_cells = g3["r3"].to_list(); idx = {c: i for i, c in enumerate(r3_cells)}; midx = {m: i for i, m in enumerate(months)}
mat = np.zeros((len(months), len(r3_cells)), dtype=np.float32)
for c, m, h in g.iter_rows():
    if c in idx:
        mat[midx[m], idx[c]] = h
h_max = float(mat.max())
u8 = np.round(255 * np.log1p(mat) / np.log1p(h_max)).astype(np.uint8)
(out / "globe_r3_monthly.u8").write_bytes(u8.tobytes())
r3_hex = [h3.int_to_str(c) for c in r3_cells]
r3_ll = [h3.cell_to_latlng(c) for c in r3_hex]
(out / "globe_cells_r3.json").write_text(json.dumps({"cells": r3_hex, "lat": [round(p[0], 4) for p in r3_ll], "lon": [round(p[1], 4) for p in r3_ll]}), encoding="utf-8")
(out / "globe_months.json").write_text(json.dumps({"months": months}), encoding="utf-8")
(out / "coverage_r3.json").write_text(json.dumps(r3_hex), encoding="utf-8")
(out / "globe_meta.json").write_text(json.dumps({"h_max": h_max, "encoding": "log1p_u8", "coverage_tiers": ["A", "B", "C"],
                                                 "latest_month": cfg["product"]["latest_complete_month"], "month_to_date": cfg["product"]["month_to_date"],
                                                 "product_version": cfg["product"]["version"],
                                                 "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}))
# map layer stats: mean annual MEH over the baseline, peak calendar month
b0, b1 = cfg["baseline_years"]
yrs = [i for i, m in enumerate(months) if b0 <= int(m[:4]) <= b1]
base = mat[yrs]
mon = np.array([int(months[i][5:]) for i in yrs])
clim = np.stack([base[mon == k].mean(axis=0) for k in range(1, 13)])
mean_annual = base.sum(axis=0) / (b1 - b0 + 1)
(out / "map_r3_stats.json").write_text(json.dumps({"baseline": [b0, b1], "cells": r3_hex, "mean_annual_meh": [round(float(v), 1) for v in mean_annual],
                                                   "peak_month": [int(np.argmax(clim[:, i])) + 1 for i in range(len(r3_hex))]}))
print(f"globe: {len(months)} months x {len(r3_cells):,} r3 cells, h_max {h_max:,.0f} ({time.time()-t0:.0f}s)", flush=True)

# 4) admin boundaries (simplified) + search index; only admin-1 regions that contain grid cells
ne = repo / "data/raw/aux/ne"
a1 = gpd.read_file(ne / "ne_10m_admin_1_states_provinces.shp", columns=["adm1_code", "name", "name_en", "adm0_a3", "admin", "type_en"])
known = set(lk["adm1_code"].drop_nulls().unique().to_list())
a1 = a1[a1["adm1_code"].isin(known)].copy()
a1["geometry"] = a1.geometry.simplify(0.03, preserve_topology=True)
a1 = a1.rename(columns={"adm1_code": "admin_id", "adm0_a3": "country_iso3", "admin": "country_name"})
a1["name"] = a1["name"].fillna(a1["name_en"]).fillna(a1["admin_id"])
a1[["admin_id", "name", "country_iso3", "country_name", "geometry"]].to_file(out / "admin1.geojson", driver="GeoJSON", COORDINATE_PRECISION=3)
a0 = gpd.read_file(ne / "ne_10m_admin_0_countries.shp", columns=["ADM0_A3", "NAME", "ADMIN"])
a0["geometry"] = a0.geometry.simplify(0.05, preserve_topology=True)
a0 = a0.rename(columns={"ADM0_A3": "country_iso3", "NAME": "name"})
a0[["country_iso3", "name", "geometry"]].to_file(out / "admin0.geojson", driver="GeoJSON", COORDINATE_PRECISION=3)
search = [{"admin_id": r.admin_id, "name": r.name, "country": r.country_name, "country_iso3": r.country_iso3,
           "bbox": [round(v, 3) for v in r.geometry.bounds], "kind": "admin1"} for r in a1.itertuples()]
a0c = a0[a0["country_iso3"].isin(set(lk["iso3"].drop_nulls().unique().to_list()) | set(a1["country_iso3"]))]
search += [{"admin_id": f"ISO-{r.country_iso3}", "name": r.name, "country": r.name, "country_iso3": r.country_iso3,
            "bbox": [round(v, 3) for v in r.geometry.bounds], "kind": "country"} for r in a0c.itertuples()]
(out / "search_index.json").write_text(json.dumps(search, ensure_ascii=False), encoding="utf-8")
mb = lambda f: (out / f).stat().st_size / 1e6
print(f"admin1.geojson {mb('admin1.geojson'):.1f} MB ({len(a1)} regions), admin0.geojson {mb('admin0.geojson'):.1f} MB, search entries {len(search)}", flush=True)

# 5) copies of the science products
for f in ("validation_report.json", "drift.json", "turing_rounds.json"):
    if (prod / f).exists():
        shutil.copyfile(prod / f, out / f)
print(f"DONE build_static ({time.time()-t0:.0f}s)")
