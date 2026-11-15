"""Precomputed monthly totals for large units (countries, biomes, the whole world) and r3 cells.
Lets the API answer areas too large for a cell query (Brazil, Russia, the world) instantly, with the same uncertainty
rule as ember_science.area_monthly: sd^2 = sum_biomes (sum h_sd_sys)^2 + sum h_sd_rand^2.
Outputs (data/products/api/):
  agg_month.parquet   unit, month, h_count, sys2, rand2, raw_modis_n, raw_snpp_n, raw_noaa20_n, raw_noaa21_n, provisional, modis_outage, filled
  agg_units.parquet   unit, kind (world|country|biome), name, n_cells_r5, area_km2
  r3_month.parquet    r3 (UINT64), month, h  (input to Fire Twins)
Usage: python -P pipeline/build_aggregates.py <repo>
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import duckdb
import h3
import polars as pl
import yaml

repo = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
cfg = yaml.safe_load((repo / "config/ember.yaml").read_text(encoding="utf-8"))
api = repo / cfg["paths"]["products"] / "api"
src = (repo / cfg["paths"]["products"] / "harmonized_cell_month.parquet").as_posix()
t0 = time.time()
con = duckdb.connect()
con.execute(f"SET memory_limit='2GB'; SET threads=4; SET temp_directory='{(repo / 'data/tmp_duckdb').as_posix()}'")

cells = pl.read_parquet(api / "cells_r5.parquet").select("r5", "r3", "iso3", "country_name", "biome_id")
lk = pl.read_parquet(repo / cfg["paths"]["h3_lookup"]).select(pl.col("h3_r5_u64").alias("r5"), "iso3", "country_name", "biome_id", "biome_name")
con.register("cells", cells.select("r5", "r3", "iso3").to_arrow())

# per (unit, month, biome) partial sums -> per (unit, month)
UNITS = {"world": "'WORLD'", "country": "'ISO-' || c.iso3", "biome": "'BIOME-' || CAST(p.biome_id AS VARCHAR)"}
parts = []
for kind, expr in UNITS.items():
    where = "WHERE c.iso3 IS NOT NULL" if kind == "country" else ""
    q = f"""
      WITH b AS (
        SELECT {expr} AS unit, p.month, p.biome_id,
               sum(p.h_count) AS h, sum(p.h_sd_sys) AS sys_b, sum(p.h_sd_rand * p.h_sd_rand) AS rand2,
               sum(p.raw_modis_n) AS m, sum(p.raw_snpp_n) AS s, sum(p.raw_noaa20_n) AS n20, sum(p.raw_noaa21_n) AS n21,
               bool_or(p.provisional) AS prov, bool_or(p.modis_outage) AS outg, sum(p.h_count * p.fill_frac) AS filled
        FROM '{src}' p LEFT JOIN cells c ON p.h3_r5_u64 = c.r5 {where}
        GROUP BY 1, 2, 3)
      SELECT unit, month, sum(h) AS h_count, sum(sys_b * sys_b) AS sys2, sum(rand2) AS rand2,
             sum(m) AS raw_modis_n, sum(s) AS raw_snpp_n, sum(n20) AS raw_noaa20_n, sum(n21) AS raw_noaa21_n,
             bool_or(prov) AS provisional, bool_or(outg) AS modis_outage, sum(filled) AS filled
      FROM b GROUP BY 1, 2"""
    parts.append(pl.from_arrow(con.sql(q).to_arrow_table()))
    print(f"{kind}: {parts[-1]['unit'].n_unique()} units ({time.time()-t0:.0f}s)", flush=True)
agg = pl.concat(parts).sort("unit", "month")
agg.write_parquet(api / "agg_month.parquet")

# unit table with names and sizes (all land cells, active or not)
lk2 = lk.with_columns(area=pl.Series([h3.cell_area(h3.int_to_str(int(c)), "km^2") for c in lk["r5"].to_list()]))
u_country = (lk2.drop_nulls("iso3").group_by("iso3").agg(name=pl.col("country_name").first(), n_cells_r5=pl.len(), area_km2=pl.col("area").sum())
               .select(pl.concat_str(pl.lit("ISO-"), "iso3").alias("unit"), pl.lit("country").alias("kind"), "name", "n_cells_r5", "area_km2"))
u_biome = (lk2.drop_nulls("biome_id").group_by("biome_id").agg(name=pl.col("biome_name").first(), n_cells_r5=pl.len(), area_km2=pl.col("area").sum())
             .select(pl.concat_str(pl.lit("BIOME-"), pl.col("biome_id").cast(pl.String)).alias("unit"), pl.lit("biome").alias("kind"), "name", "n_cells_r5", "area_km2"))
u_world = pl.DataFrame({"unit": ["WORLD"], "kind": ["world"], "name": ["The whole world"], "n_cells_r5": [lk2.height], "area_km2": [float(lk2["area"].sum())]})
units = pl.concat([u_world, u_country, u_biome], how="vertical_relaxed").filter(pl.col("unit").is_in(agg["unit"].unique().implode()))
units.write_parquet(api / "agg_units.parquet")
print(f"units: {units.height} ({time.time()-t0:.0f}s)", flush=True)

# r3 monthly totals (Fire Twins input)
r3 = pl.from_arrow(con.sql(f"SELECT c.r3, p.month, sum(p.h_count) AS h FROM '{src}' p JOIN cells c ON p.h3_r5_u64 = c.r5 GROUP BY 1, 2").to_arrow_table())
r3.sort("r3", "month").write_parquet(api / "r3_month.parquet")
print(f"r3_month: {r3.height:,} rows, {r3['r3'].n_unique():,} cells ({time.time()-t0:.0f}s)")
print("DONE build_aggregates")

# add the world and biomes to the static place search (countries and provinces come from build_static)
import json  # noqa: E402
sp = repo / cfg["paths"]["static_out"] / "search_index.json"
if sp.exists():
    idx = [e for e in json.loads(sp.read_text(encoding="utf-8")) if e.get("kind") not in ("world", "biome")]
    extra = [{"admin_id": "WORLD", "name": "The whole world", "country": "", "country_iso3": "", "bbox": [-180, -60, 180, 80], "kind": "world"}]
    for r in units.filter(pl.col("kind") == "biome").iter_rows(named=True):
        extra.append({"admin_id": r["unit"], "name": r["name"], "country": "Biome", "country_iso3": "", "bbox": [-180, -60, 180, 80], "kind": "biome"})
    sp.write_text(json.dumps(extra + idx, ensure_ascii=False), encoding="utf-8")
    print(f"search index: +{len(extra)} entries (world, biomes)")
