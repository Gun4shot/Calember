"""One pass per product-year Parquet file (bounded memory):
  - census (rows, type/conf/day-night mix, versions, exact duplicates)
  - drift: monthly median local solar time of daytime detections with |lat|<=10, per satellite
  - long cell-month aggregates per satellite (cleaned: MODIS conf>=30 & type 0; VIIRS conf n/h & type 0)
Pass proxy for fire-cell-passes: (sat, r7, acq_date, 10-minute bucket).
Usage: python -P agg2.py <repo>   -> data/interim/explore/{cm_long/, census.csv, drift.csv}
"""
import sys
import time
from pathlib import Path

import duckdb
import pandas as pd

repo = Path(sys.argv[1])
raw = repo / "data/interim/firms_raw"
out = repo / "data/interim/explore"
(out / "cm_long").mkdir(parents=True, exist_ok=True)
tmp = (repo / "data/tmp_duckdb").as_posix()
con = duckdb.connect()
con.execute(f"LOAD h3; SET memory_limit='5GB'; SET threads=8; SET temp_directory='{tmp}'; SET preserve_insertion_order=false;")
SAT = "CASE satellite WHEN 'Terra' THEN 'TERRA' WHEN 'Aqua' THEN 'AQUA' WHEN 'N' THEN 'SNPP' WHEN 'N20' THEN 'NOAA20' WHEN 'N21' THEN 'NOAA21' END"
census, drift = [], []
files = sorted(raw.glob("product=*/year=*/part.parquet"))
for f in files:
    product = f.parent.parent.name.split("=")[1]; year = int(f.parent.name.split("=")[1])
    dst = out / "cm_long" / f"{product}_{year}.parquet"
    t0 = time.time()
    p = f.as_posix()
    bad = con.sql(f"SELECT DISTINCT satellite FROM '{p}' WHERE ({SAT}) IS NULL").fetchall()
    if bad:
        raise SystemExit(f"unknown satellite codes in {f}: {bad}")
    con.execute(f"""CREATE OR REPLACE TEMP TABLE d AS SELECT
        {SAT} AS sat, substr(acq_date,1,7) AS month, acq_date,
        (CAST(substr(lpad(acq_time,4,'0'),1,2) AS INT)*60 + CAST(substr(lpad(acq_time,4,'0'),3,2) AS INT)) AS tmin,
        daynight='D' AS is_day, latitude AS lat, longitude AS lon, frp, scan, type, confidence, version,
        CASE WHEN '{product}'='modis' THEN try_cast(confidence AS INT) >= 30 ELSE confidence IN ('n','h') END AS conf_ok
      FROM '{p}'""")
    c = con.sql(f"""SELECT '{product}' AS product, {year} AS yr, sat, count(*) n,
        count(*) - count(DISTINCT (sat, acq_date, tmin, lat, lon)) exact_dups,
        avg((type=0)::INT) f_type0, avg((type=1)::INT) f_type1, avg((type=2)::INT) f_type2, avg((type=3)::INT) f_type3,
        avg((NOT is_day)::INT) f_night, avg((NOT conf_ok)::INT) f_lowconf, avg((frp<=0)::INT) f_frp_nonpos,
        min(acq_date) d0, max(acq_date) d1, string_agg(DISTINCT version, '|') versions
      FROM d GROUP BY sat""").df()
    census.append(c)
    drift.append(con.sql("""SELECT sat, month,
        median((((tmin/60.0) + lon/15.0) % 24 + 24) % 24) median_lst, count(*) n
      FROM d WHERE is_day AND abs(lat) <= 10 GROUP BY ALL""").df())
    con.execute(f"""COPY (
      WITH k AS (SELECT *, h3_latlng_to_cell(lat, lon, 5) r5, h3_latlng_to_cell(lat, lon, 7) r7
                 FROM d WHERE type = 0 AND conf_ok),
      fcp AS (SELECT sat, r5, month, count(*) fcp, count(*) FILTER (is_day) fcp_day
              FROM (SELECT DISTINCT sat, r5, r7, month, acq_date, tmin // 10 AS tb, is_day FROM k) GROUP BY ALL)
      SELECT a.*, coalesce(fcp.fcp,0) fcp, coalesce(fcp.fcp_day,0) fcp_day FROM (
        SELECT sat, r5, month, count(*) n, count(*) FILTER (is_day) n_day,
          sum(frp) frp_sum, quantile_cont(frp, 0.5) frp_p50, quantile_cont(frp, 0.9) frp_p90, max(frp) frp_max,
          avg(scan) scan_mean, count(*) FILTER (frp < 5) lowfrp_n, count(DISTINCT acq_date) fire_days
        FROM k GROUP BY ALL) a
      LEFT JOIN fcp USING (sat, r5, month)
    ) TO '{dst.as_posix()}' (FORMAT parquet, COMPRESSION zstd)""")
    print(f"{product} {year}: {int(c.n.sum()):,} rows, {time.time()-t0:.0f}s", flush=True)
pd.concat(census).to_csv(out / "census.csv", index=False)
pd.concat(drift).to_csv(out / "drift.csv", index=False)
print("DONE")
