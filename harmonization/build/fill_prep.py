"""Input-completeness preparation for the product (fix for sensor data losses; validated by sim_fill.py).
1. Daily global counts per sensor (TERRA, AQUA, SNPP, NOAA20) from firms_raw (2000-2025) + firms_api (2026; SP preferred over NRT),
   cleaned like the product inputs (MODIS conf>=30, VIIRS conf n/h, type 0 or null). Missing days inside a sensor's first month
   (before the record start) count as lost.
2. Day loss share: share_d = 1 - n_d/med_d if n_d < 0.5*med_d else 0 (med = centred 61-day rolling median, min 20 samples).
   Month lost fraction L = sum(share*med) / (sum n + sum(share*med)) -> sensor_month_L.parquet (sensor, month, L).
3. MODIS paired fill for months 2002-07..2019-12 where a satellite has L >= 0.02: for each lost day the other satellite's
   detections in the cell (only if the other satellite's own share that day < 0.5) times share_d times the biome ratio
   sat/other on days where both are complete (shrunk k=200 to the month's global ratio) -> modis_fill.parquet (r5, month, est_t, est_a).
   Detections are cleaned and static-mask filtered exactly like cm_long_m1.
Usage: python -P fill_prep.py <repo>
"""
import sys
import time
from pathlib import Path

import duckdb
import polars as pl

repo = Path(sys.argv[1]); ex = repo / "data/interim/explore"; raw = repo / "data/interim/firms_raw"; api = repo / "data/interim/firms_api"
con = duckdb.connect()
con.execute(f"LOAD h3; SET memory_limit='1500MB'; SET threads=2; SET enable_progress_bar=false; SET temp_directory='{(repo/'data/tmp_duckdb').as_posix()}'")
t0 = time.time()
MCONF = "try_cast(confidence AS INT) >= 30"; VCONF = "confidence IN ('n','h')"
SAT = "CASE satellite WHEN 'Terra' THEN 'TERRA' WHEN 'Aqua' THEN 'AQUA' WHEN 'N' THEN 'SNPP' WHEN 'N20' THEN 'NOAA20' WHEN 'NOAA-20' THEN 'NOAA20' WHEN '1' THEN 'NOAA20' ELSE satellite END"
parts = []
for prod, conf in (("modis", MCONF), ("viirs-snpp", VCONF), ("viirs-jpss1", VCONF)):
    sx = SAT if prod == "modis" else {"viirs-snpp": "'SNPP'", "viirs-jpss1": "'NOAA20'"}[prod]
    q = f"""SELECT {sx} AS sensor, acq_date, count(*) n FROM read_parquet('{(raw / f'product={prod}').as_posix()}/**/*.parquet', hive_partitioning=true, union_by_name=true)
            WHERE (type = 0 OR type IS NULL) AND {conf} GROUP BY ALL"""
    parts.append(pl.DataFrame(con.execute(q).fetchall(), schema=["sensor", "acq_date", "n"], orient="row"))
fixed = {"viirs-snpp": "SNPP", "viirs-jpss1": "NOAA20"}
d = pl.concat(parts).with_columns(pl.col("acq_date").cast(pl.Utf8))
print("raw sensors:", d["sensor"].unique().to_list(), flush=True)
ap = []
for f in sorted(api.glob("*.parquet")):
    if "NOAA21" in f.stem:
        continue
    conf = MCONF if f.stem.startswith("MODIS") else VCONF; kind = 0 if f.stem.endswith("SP") else 1
    q = f"SELECT {SAT} AS sensor, acq_date, count(*) n FROM '{f.as_posix()}' WHERE (type = 0 OR type IS NULL) AND {conf} AND acq_date >= '2026-01-01' GROUP BY ALL"
    ap.append(pl.DataFrame(con.execute(q).fetchall(), schema=["sensor", "acq_date", "n"], orient="row").with_columns(kind=pl.lit(kind)))
ap = pl.concat(ap).with_columns(pl.col("acq_date").cast(pl.Utf8)).sort("kind").group_by("sensor", "acq_date").agg(pl.col("n").first())
d = pl.concat([d.filter(pl.col("acq_date") < "2026-01-01"), ap.select("sensor", "acq_date", "n")]).filter(pl.col("sensor").is_in(["TERRA", "AQUA", "SNPP", "NOAA20"]))
d = d.with_columns(pl.col("acq_date").str.to_date(), pl.col("n").cast(pl.Int64))
full = []
for s in ["TERRA", "AQUA", "SNPP", "NOAA20"]:
    x = d.filter(pl.col("sensor") == s)
    first = x["acq_date"].min(); last = x["acq_date"].max(); start = first.replace(day=1)
    # series ends: S-NPP ended 2026-11-02; everything else month-to-date 2026-11-12
    rng = pl.date_range(start, last, "1d", eager=True)
    full.append(pl.DataFrame({"acq_date": rng}).join(x.drop("sensor"), on="acq_date", how="left")
                  .with_columns(pre=pl.col("acq_date") < first, n=pl.col("n").fill_null(0), sensor=pl.lit(s)))
d = pl.concat(full).sort("sensor", "acq_date")
d = d.with_columns(med=pl.when(~pl.col("pre")).then(pl.col("n")).otherwise(None).cast(pl.Float64)
                   .rolling_median(61, center=True, min_samples=20).over("sensor"))
d = d.with_columns(med=pl.col("med").fill_null(strategy="backward").over("sensor"))
d = d.with_columns(share=pl.when(pl.col("pre")).then(1.0).when(pl.col("n") < 0.5 * pl.col("med")).then(1 - pl.col("n") / pl.col("med")).otherwise(0.0),
                   month=pl.col("acq_date").dt.strftime("%Y-%m"))
d.write_parquet(ex / "sensor_daily.parquet")
L = (d.group_by("sensor", "month").agg(lost=(pl.col("share") * pl.col("med")).sum(), obs=pl.col("n").sum(), days=pl.len())
      .with_columns(L=pl.col("lost") / (pl.col("obs") + pl.col("lost"))).sort("sensor", "month"))
L.write_parquet(ex / "sensor_month_L.parquet")
pl.Config.set_tbl_rows(80); pl.Config.set_tbl_formatting("ASCII_MARKDOWN")
print(L.filter(pl.col("L") >= 0.02).select("sensor", "month", "days", pl.col("L").round(4)), flush=True)

# ---- MODIS paired fill
todo = L.filter(pl.col("sensor").is_in(["TERRA", "AQUA"]) & (pl.col("L") >= 0.02) & pl.col("month").is_between(pl.lit("2002-07"), pl.lit("2019-12")))
months = sorted(set(todo["month"].to_list()))
print(f"paired-fill months: {len(months)}", flush=True)
con.execute(f"CREATE TABLE mask AS SELECT r7 FROM '{(ex / 'static_mask_r7.parquet').as_posix()}'")
lk = pl.read_parquet(repo / "data/interim/aux/h3r5_lookup.parquet").select(pl.col("h3_r5_u64").alias("r5"), pl.col("biome_id").fill_null(0))
sh = d.filter(pl.col("sensor").is_in(["TERRA", "AQUA"])).select("sensor", "acq_date", "share").pivot(on="sensor", index="acq_date", values="share")
out = []
for m in months:
    y = m[:4]
    det = con.execute(f"""WITH k AS (SELECT {SAT} AS sensor, acq_date, h3_latlng_to_cell(latitude, longitude, 5) AS r5, h3_latlng_to_cell(latitude, longitude, 7) AS r7
              FROM read_parquet('{(raw / f'product=modis/year={y}').as_posix()}/*.parquet') WHERE substr(acq_date,1,7) = '{m}' AND type = 0 AND {MCONF})
              SELECT sensor, acq_date, r5, count(*) n FROM k ANTI JOIN mask USING (r7) GROUP BY ALL""").fetchall()
    x = (pl.DataFrame(det, schema=["sensor", "acq_date", "r5", "n"], orient="row").with_columns(pl.col("acq_date").str.to_date(), pl.col("r5").cast(pl.UInt64))
           .join(sh, on="acq_date", how="left").with_columns(pl.col("TERRA").fill_null(1.0), pl.col("AQUA").fill_null(1.0)))
    x = x.join(lk, on="r5", how="left").with_columns(pl.col("biome_id").fill_null(0))
    res = {}
    for s, o in (("TERRA", "AQUA"), ("AQUA", "TERRA")):
        if todo.filter((pl.col("month") == m) & (pl.col("sensor") == s)).height == 0:
            continue
        both = x.filter((pl.col(s) == 0) & (pl.col(o) == 0))
        cnt = both.group_by("biome_id").agg(S=pl.col("n").filter(pl.col("sensor") == s).sum(), O=pl.col("n").filter(pl.col("sensor") == o).sum())
        rg = cnt["S"].sum() / max(cnt["O"].sum(), 1)
        rb = cnt.with_columns(rb=(pl.col("S") + 200 * rg) / (pl.col("O") + 200)).select("biome_id", "rb")
        # also days before the sat's record start (share 1) are filled from the other satellite
        don = x.filter((pl.col("sensor") == o) & (pl.col(s) > 0) & (pl.col(o) < 0.5))
        est = (don.join(rb, on="biome_id", how="left").with_columns(pl.col("rb").fill_null(rg))
                  .group_by("r5").agg(est=(pl.col("n") * pl.col(s) * pl.col("rb")).sum()))
        res[s] = est
        print(f"{m} {s}: global ratio {rg:.3f}, filled {est['est'].sum():,.0f} (obs {x.filter(pl.col('sensor') == s)['n'].sum():,})", flush=True)
    e = None
    for s_, col in (("TERRA", "est_t"), ("AQUA", "est_a")):
        t = res[s_].rename({"est": col}) if s_ in res else pl.DataFrame(schema={"r5": pl.UInt64, col: pl.Float64})
        e = t if e is None else e.join(t, on="r5", how="full", coalesce=True)
    out.append(e.with_columns(pl.col("r5").cast(pl.UInt64), pl.col("est_t").fill_null(0.0), pl.col("est_a").fill_null(0.0), month=pl.lit(m)))
f = pl.concat([o.select("r5", "month", pl.col("est_t").cast(pl.Float32), pl.col("est_a").cast(pl.Float32)) for o in out])
f.write_parquet(ex / "modis_fill.parquet")
print(f"modis_fill: {f.height:,} rows, total {f['est_t'].sum() + f['est_a'].sum():,.0f} ({time.time()-t0:.0f}s)")
print("DONE fill_prep")
