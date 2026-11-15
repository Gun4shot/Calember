"""Daily harmonized counts per r5 cell (Guideline §4.8: daily raw counts x the cell-month factor h_count / raw_basis_n).
Basis sensor per month (the same one the product's raw_basis_n counts): T Terra; M Terra + Aqua; B/V S-NPP, or NOAA-20 in the
months listed in data/products/work/refsrc.json; N NOAA-20. Cleaning = product cleaning (type 0 or NRT null, MODIS conf >= 30,
VIIRS n/h, static mask v1). 2026 comes from the FIRMS API files (SP until its last day, NRT after).
Cell-months whose harmonized mass has no basis detection (the no-detection model) are not spread over days; their share is
reported in daily_meta.json.
Outputs: data/products/daily/cell_day_YYYY.parquet (r5, date, n, h), data/products/api/cell_day_by_cell.parquet (sorted),
         data/products/api/agg_day.parquet (unit, date, h) for WORLD / ISO-xxx / BIOME-n, data/products/daily/daily_meta.json
Usage: python -P pipeline/build_daily.py <repo>
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import duckdb
import polars as pl
import yaml

repo = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
cfg = yaml.safe_load((repo / "config/ember.yaml").read_text(encoding="utf-8"))
prod = repo / cfg["paths"]["products"]; out = prod / "daily"; out.mkdir(parents=True, exist_ok=True); api = prod / "api"
raw = (repo / "data/interim/firms_raw").as_posix(); apid = repo / "data/interim/firms_api"
refsrc = json.loads((prod / "work/refsrc.json").read_text(encoding="utf-8"))
t0 = time.time()
con = duckdb.connect()
con.execute(f"LOAD h3; SET memory_limit='1500MB'; SET threads=2; SET preserve_insertion_order=false; SET temp_directory='{(repo / 'data/tmp_duckdb').as_posix()}'")
con.execute(f"CREATE TABLE mask AS SELECT r7 FROM '{(repo / 'data/interim/explore/static_mask_r7.parquet').as_posix()}'")
SAT = "CASE satellite WHEN 'Terra' THEN 'TERRA' WHEN 'Aqua' THEN 'AQUA' ELSE satellite END"
MCONF = "try_cast(confidence AS INT) >= 30"; VCONF = "confidence IN ('n','h')"


def regime(m: str) -> str:
    return "T" if m <= "2002-06" else "M" if m <= "2011-12" else "B" if m <= "2019-12" else "V" if m <= "2026-07" else "N"


def basis(m: str) -> set[str]:
    r = regime(m)
    if r == "T":
        return {"TERRA"}
    if r == "M":
        return {"TERRA", "AQUA"}
    return {"NOAA20"} if (r == "N" or refsrc.get(m) == "NOAA20") else {"SNPP"}


def api_src(stem: str) -> str | None:
    """2026: SP rows up to the SP file's last day, NRT after."""
    sp, nrt = apid / f"{stem}_SP.parquet", apid / f"{stem}_NRT.parquet"
    parts = []
    last_sp = None
    if sp.exists():
        last_sp = con.execute(f"SELECT max(acq_date) FROM '{sp.as_posix()}'").fetchone()[0]
        parts.append(f"SELECT * FROM read_parquet('{sp.as_posix()}', union_by_name=true)")
    if nrt.exists():
        cond = f"WHERE acq_date > '{last_sp}'" if last_sp else ""
        parts.append(f"SELECT * FROM read_parquet('{nrt.as_posix()}', union_by_name=true) {cond}")
    return " UNION ALL BY NAME ".join(parts) if parts else None


meta = {"years": {}}
YEARS = [int(a) for a in sys.argv[2].split(",")] if len(sys.argv) > 2 else list(range(2000, 2027))
for y in YEARS:
    t1 = time.time()
    months = [f"{y}-{k:02d}" for k in range(1, 13) if "2000-11" <= f"{y}-{k:02d}" <= "2026-11"]
    need = {}
    for m in months:
        for s in basis(m):
            need.setdefault(s, []).append(m)
    queries = []
    for s, ms in need.items():
        mlist = ",".join(f"'{m}'" for m in ms)
        if s in ("TERRA", "AQUA"):
            src = f"read_parquet('{raw}/product=modis/year={y}/*.parquet')" if y <= 2025 else (f"({api_src('MODIS')})" if api_src("MODIS") else None)
            filt = f"({SAT}) = '{s}' AND type = 0 AND {MCONF}"
        else:
            prodname = {"SNPP": "viirs-snpp", "NOAA20": "viirs-jpss1"}[s]
            stem = {"SNPP": "VIIRS_SNPP", "NOAA20": "VIIRS_NOAA20"}[s]
            src = f"read_parquet('{raw}/product={prodname}/year={y}/*.parquet')" if y <= 2025 else (f"({api_src(stem)})" if api_src(stem) else None)
            filt = f"(type = 0 OR type IS NULL) AND {VCONF}"
            if y <= 2025 and not (repo / f"data/interim/firms_raw/product={prodname}/year={y}").exists():
                src = None
        if src is None:
            continue
        queries.append(f"""SELECT h3_latlng_to_cell(latitude, longitude, 5) AS r5, h3_latlng_to_cell(latitude, longitude, 7) AS r7,
                                  CAST(acq_date AS DATE) AS date FROM {src} WHERE substr(CAST(acq_date AS VARCHAR), 1, 7) IN ({mlist}) AND {filt}""")
    if not queries:
        continue
    q = f"""COPY (SELECT r5, date, count(*)::USMALLINT AS n FROM ({' UNION ALL '.join(queries)}) d ANTI JOIN mask USING (r7) GROUP BY 1, 2)
            TO '{(out / f"_n_{y}.parquet").as_posix()}' (FORMAT parquet)"""
    con.execute(q)
    # attach the cell-month factor
    fac = pl.from_arrow(con.sql(f"""SELECT h3_r5_u64 AS r5, month, factor, raw_basis_n, h_count FROM '{(prod / 'harmonized_cell_month.parquet').as_posix()}'
                                    WHERE month LIKE '{y}-%'""").to_arrow_table())
    d = pl.read_parquet(out / f"_n_{y}.parquet").with_columns(pl.col("r5").cast(pl.UInt64), month=pl.col("date").dt.strftime("%Y-%m"))
    chk = d.group_by("r5", "month").agg(nd=pl.col("n").cast(pl.Int64).sum()).join(fac.select("r5", "month", "raw_basis_n"), on=["r5", "month"], how="left")
    match = float((chk["nd"] == chk["raw_basis_n"].fill_null(-1)).mean())
    d = d.join(fac.select("r5", "month", "factor"), on=["r5", "month"], how="left").with_columns(h=(pl.col("n") * pl.col("factor").fill_null(0.0)).cast(pl.Float32))
    d.select("r5", "date", pl.col("n").cast(pl.UInt16), "h").sort("r5", "date").write_parquet(out / f"cell_day_{y}.parquet")
    (out / f"_n_{y}.parquet").unlink()
    h_month = float(fac["h_count"].sum()); h_day = float(d["h"].sum())
    meta["years"][y] = {"cell_days": d.height, "h_monthly": round(h_month, 1), "h_daily": round(h_day, 1),
                        "share_spread_to_days": round(h_day / h_month, 4) if h_month else None, "basis_count_match": round(match, 4)}
    print(f"{y}: {d.height:,} cell-days, daily/monthly mass {h_day / max(h_month, 1):.3f}, basis-count match {match:.3f} ({time.time()-t1:.0f}s)", flush=True)
    del d, fac, chk

# sorted API copy + unit aggregates
files = ",".join(f"'{p.as_posix()}'" for p in sorted(out.glob("cell_day_*.parquet")))
con.execute(f"COPY (SELECT * FROM read_parquet([{files}]) ORDER BY r5, date) TO '{(api / 'cell_day_by_cell.parquet').as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)")
cells = pl.read_parquet(api / "cells_r5.parquet").select("r5", "iso3", "biome_id")
con.register("cells", cells.to_arrow())
q = f"""SELECT 'WORLD' AS unit, date, sum(h) AS h FROM read_parquet([{files}]) GROUP BY 1, 2
        UNION ALL SELECT 'ISO-' || c.iso3, d.date, sum(d.h) FROM read_parquet([{files}]) d JOIN cells c USING (r5) WHERE c.iso3 IS NOT NULL GROUP BY 1, 2
        UNION ALL SELECT 'BIOME-' || CAST(c.biome_id AS VARCHAR), d.date, sum(d.h) FROM read_parquet([{files}]) d JOIN cells c USING (r5) WHERE c.biome_id IS NOT NULL GROUP BY 1, 2"""
con.execute(f"COPY ({q} ORDER BY 1, 2) TO '{(api / 'agg_day.parquet').as_posix()}' (FORMAT parquet, COMPRESSION zstd)")
tot_m = sum(v["h_monthly"] for v in meta["years"].values()); tot_d = sum(v["h_daily"] for v in meta["years"].values())
meta["share_spread_to_days_all"] = round(tot_d / tot_m, 4)
(out / "daily_meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
print(f"DONE build_daily: daily mass covers {tot_d / tot_m:.1%} of the harmonized total ({time.time()-t0:.0f}s)")
