"""persistent-hotspot (static) mask per Guideline 4.11 + D-009.
Rule A: H3 r7 cell where S-NPP (any confidence, any type) detects in >= 50% of months of 2013-2024 AND in >= 8 distinct years.
Rule B: r7 cell with >= 3 detections of type in {1,2} (any product).
Also reports what the mask removes, and checks known industrial regions.
Usage: python -P static_mask.py <repo>  -> data/interim/explore/static_mask_r7.parquet
"""
import sys
import time
from pathlib import Path

import duckdb

repo = Path(sys.argv[1])
raw = repo / "data/interim/firms_raw"
ex = repo / "data/interim/explore"
con = duckdb.connect()
con.execute(f"LOAD h3; SET memory_limit='5GB'; SET threads=8; SET temp_directory='{(repo/'data/tmp_duckdb').as_posix()}';")
t0 = time.time()
con.execute("CREATE TABLE rm (r7 UBIGINT, month VARCHAR)")
con.execute("CREATE TABLE t12 (r7 UBIGINT, n BIGINT)")
for f in sorted(raw.glob("product=*/year=*/part.parquet")):
    product = f.parent.parent.name.split("=")[1]; year = int(f.parent.name.split("=")[1])
    p = f.as_posix()
    if product == "viirs-snpp" and 2013 <= year <= 2024:
        con.execute(f"INSERT INTO rm SELECT DISTINCT h3_latlng_to_cell(latitude, longitude, 7), substr(acq_date,1,7) FROM '{p}'")
    con.execute(f"INSERT INTO t12 SELECT h3_latlng_to_cell(latitude, longitude, 7), count(*) FROM '{p}' WHERE type IN (1,2) GROUP BY 1")
    print(f"{product} {year} {time.time()-t0:.0f}s", flush=True)
con.execute("""CREATE TABLE mask AS
WITH a AS (SELECT r7, count(*) AS n_months, count(DISTINCT substr(month,1,4)) AS n_years FROM rm GROUP BY r7),
     ra AS (SELECT r7, n_months, n_years FROM a WHERE n_months >= 0.5*144 AND n_years >= 8),
     rb AS (SELECT r7, sum(n) AS n12 FROM t12 GROUP BY r7 HAVING sum(n) >= 3)
SELECT coalesce(ra.r7, rb.r7) AS r7, ra.r7 IS NOT NULL AS rule_a, rb.r7 IS NOT NULL AS rule_b,
       coalesce(ra.n_months,0) AS n_months, coalesce(ra.n_years,0) AS n_years, coalesce(rb.n12,0) AS n_type12
FROM ra FULL JOIN rb ON ra.r7 = rb.r7""")
con.execute(f"COPY mask TO '{(ex/'static_mask_r7.parquet').as_posix()}' (FORMAT parquet)")
print(con.sql("SELECT count(*) cells, sum(rule_a::INT) rule_a, sum(rule_b::INT) rule_b, sum((rule_a AND NOT rule_b)::INT) a_only, sum((rule_b AND NOT rule_a)::INT) b_only FROM mask").fetchall())
# known industrial regions: share of type-0 S-NPP 2019 detections removed by the mask
boxes = {"Niger Delta": (4, 6.5, 5, 8), "Persian Gulf": (24, 31, 47, 56), "Khanty-Mansiysk": (59, 64, 65, 80), "Algeria Hassi": (28, 33, 3, 10),
         "Punjab (control)": (29.5, 32.5, 73.5, 77), "Amazon arc (control)": (-12, -6, -60, -50)}
s19 = (raw / "product=viirs-snpp/year=2019/part.parquet").as_posix()
for name, (la0, la1, lo0, lo1) in boxes.items():
    r = con.sql(f"""SELECT count(*) n, avg((h3_latlng_to_cell(latitude,longitude,7) IN (SELECT r7 FROM mask))::INT) frac_masked
                    FROM '{s19}' WHERE type=0 AND latitude BETWEEN {la0} AND {la1} AND longitude BETWEEN {lo0} AND {lo1}""").fetchone()
    print(f"{name:22s} S-NPP 2019 type-0 detections={r[0]:>8,}  masked={r[1]:.3f}")
print(con.sql(f"""SELECT avg((h3_latlng_to_cell(latitude,longitude,7) IN (SELECT r7 FROM mask))::INT) FROM '{s19}' WHERE type=0""").fetchone(), "global share of S-NPP 2019 type-0 detections masked")
