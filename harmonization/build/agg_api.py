"""Product build step 1: FIRMS API parquet (2026 SP/NRT, NOAA-21 2023->) -> masked cell-month long format,
identical statistics to agg3.py (cm_long_m1). NRT has no `type`: treated as type 0, static mask v1 applies.
Output: data/interim/explore/cm_long_api/<SOURCE>.parquet with columns sat, r5, month, n, n_day, frp_*, scan_mean,
lowfrp_n, fire_days, fcp, fcp_day, src ('SP'|'NRT').
Usage: python -P agg_api.py <repo>
"""
import sys
import time
from pathlib import Path

import duckdb

repo = Path(sys.argv[1]); ex = repo / "data/interim/explore"; api = repo / "data/interim/firms_api"
out = ex / "cm_long_api"; out.mkdir(parents=True, exist_ok=True)
con = duckdb.connect()
con.execute(f"LOAD h3; SET memory_limit='1500MB'; SET threads=2; SET temp_directory='{(repo/'data/tmp_duckdb').as_posix()}'; SET preserve_insertion_order=false;")
con.execute(f"CREATE TABLE mask AS SELECT r7 FROM '{(ex/'static_mask_r7.parquet').as_posix()}'")
SAT = "CASE satellite WHEN 'Terra' THEN 'TERRA' WHEN 'Aqua' THEN 'AQUA' WHEN 'N' THEN 'SNPP' WHEN 'N20' THEN 'NOAA20' WHEN 'N21' THEN 'NOAA21' END"
jobs = []
for f in sorted(api.glob("*.parquet")):
    yrs = [r[0] for r in con.execute(f"SELECT DISTINCT substr(acq_date,1,7) FROM '{f.as_posix()}' ORDER BY 1").fetchall()]
    for yr in (yrs if len(yrs) > 1 else [None]):
        jobs.append((f, yr))
for f, yr in jobs:
    src = f.stem; modis = src.startswith("MODIS"); kind = "NRT" if src.endswith("NRT") else "SP"
    t0 = time.time(); p = f.as_posix(); dst = (out / (f"{src}_{yr}.parquet" if yr else f"{src}.parquet")).as_posix()
    if Path(dst).exists():
        continue
    yfilt = f"AND substr(acq_date,1,7) = '{yr}'" if yr else ""
    bad = con.execute(f"SELECT DISTINCT satellite FROM '{p}' WHERE ({SAT}) IS NULL").fetchall()
    if bad:
        raise SystemExit(f"unknown satellite in {src}: {bad}")
    conf = "try_cast(confidence AS INT) >= 30" if modis else "confidence IN ('n','h')"
    con.execute(f"""COPY (
      WITH d AS (SELECT {SAT} AS sat, substr(acq_date,1,7) AS month, acq_date,
                   (CAST(substr(lpad(acq_time,4,'0'),1,2) AS INT)*60 + CAST(substr(lpad(acq_time,4,'0'),3,2) AS INT)) AS tmin,
                   daynight = 'D' AS is_day, frp, scan,
                   h3_latlng_to_cell(latitude, longitude, 5) AS r5, h3_latlng_to_cell(latitude, longitude, 7) AS r7
                 FROM '{p}' WHERE (type = 0 OR type IS NULL) AND {conf} {yfilt}),
      k AS (SELECT d.* FROM d ANTI JOIN mask USING (r7)),
      fcp AS (SELECT sat, r5, month, count(*) fcp, count(*) FILTER (is_day) fcp_day
              FROM (SELECT DISTINCT sat, r5, r7, month, acq_date, tmin // 10 AS tb, is_day FROM k) GROUP BY ALL)
      SELECT a.*, coalesce(fcp.fcp,0) fcp, coalesce(fcp.fcp_day,0) fcp_day, '{kind}' AS src FROM (
        SELECT sat, r5, month, count(*) n, count(*) FILTER (is_day) n_day, sum(frp) frp_sum,
               quantile_cont(frp, 0.5) frp_p50, quantile_cont(frp, 0.9) frp_p90, max(frp) frp_max, avg(scan) scan_mean,
               count(*) FILTER (frp < 5) lowfrp_n, count(DISTINCT acq_date) fire_days
        FROM k GROUP BY ALL) a LEFT JOIN fcp USING (sat, r5, month)
    ) TO '{dst}' (FORMAT parquet, COMPRESSION zstd)""")
    r = con.execute(f"SELECT count(*), sum(n), min(month), max(month) FROM '{dst}'").fetchone()
    print(f"{src}: {r[0]:,} cell-months, {r[1]:,} detections, {r[2]}..{r[3]} ({time.time()-t0:.0f}s)", flush=True)
