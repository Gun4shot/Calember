"""Product build step 2 (13 Nov night): per-year feature tables for 2012-01 .. 2026-11, Bridge v2 (H1E1g) feature set.
VIIRS reference sensor per month: S-NPP, except S-NPP outage months {2022-07, 2022-08, 2024-07, 2024-11} and all months
>= 2026-08 (S-NPP ended 2026-11-02; NRT period) -> NOAA-20 counts / 0.985 (measured NOAA-20/S-NPP ratio, D-010).
Outputs (gitignored): data/products/work/feat_YYYY.parquet (model rows: ref n > 0), data/products/work/raw_YYYY.parquet
(per r5-month raw counts: modis T+A, terra, aqua (+day), snpp, noaa20, noaa21 and the reference n), refsrc.json.
Usage: python -P build_features.py <repo>
"""
import gc
import json
import sys
import zlib
from pathlib import Path

import h3
import numpy as np
import polars as pl

repo = Path(sys.argv[1]); ex = repo / "data/interim/explore"; arc = ex / "cm_long_m1"; api = ex / "cm_long_api"
import os
PROD = repo / os.environ.get("PRODUCTS_DIR", "data/products")
work = PROD / "work"; work.mkdir(parents=True, exist_ok=True)
OUTAGE = {"2022-07", "2022-08", "2024-07", "2024-11"}
# 14 Nov: data-driven extension (fill_prep.py sensor_month_L): from 2020-01, use NOAA-20 where S-NPP lost >= 5 % of its input
# and NOAA-20 lost at most half as much. Keeps 2012-2019 unchanged (cross-fit and training rows identical).
_L = pl.read_parquet(ex / "sensor_month_L.parquet").pivot(on="sensor", index="month", values="L").fill_null(0.0)
OUTAGE |= set(_L.filter((pl.col("month") >= "2020-01") & (pl.col("SNPP") >= 0.05) & (pl.col("NOAA20") <= 0.5 * pl.col("SNPP")))["month"].to_list())
print(f"S-NPP -> NOAA-20 months: {sorted(OUTAGE)}", flush=True)
N20_TO_SNPP = 1.0 / 0.985
STAT = ["n", "n_day", "frp_sum", "frp_p50", "frp_p90", "scan_mean", "lowfrp_n", "fire_days", "fcp"]
SCALE = ["n", "n_day", "frp_sum", "lowfrp_n", "fcp"]


def load_sat(sat, years):
    """sat stats from archive (<=2025) + API (2026, and NOAA-21 2023->)."""
    parts = []
    files = {"TERRA": "modis", "AQUA": "modis", "SNPP": "viirs-snpp", "NOAA20": "viirs-jpss1"}
    for y in years:
        f = arc / f"{files.get(sat, 'none')}_{y}.parquet"
        if y <= 2025 and f.exists():
            parts.append(pl.read_parquet(f).filter(pl.col("sat") == sat).select(pl.col("r5").cast(pl.UInt64), "month", *STAT))
    apat = {"TERRA": "MODIS_*", "AQUA": "MODIS_*", "SNPP": "VIIRS_SNPP_*", "NOAA20": "VIIRS_NOAA20_*", "NOAA21": "VIIRS_NOAA21_*"}[sat]
    for f in sorted(api.glob(apat + ".parquet")):
        t = pl.read_parquet(f).filter(pl.col("sat") == sat)
        if sat != "NOAA21":
            t = t.filter(pl.col("month").str.slice(0, 4).cast(pl.Int32) >= 2026)
        t = t.filter(pl.col("month").str.slice(0, 4).cast(pl.Int32).is_in(list(years)))
        parts.append(t.select(pl.col("r5").cast(pl.UInt64), "month", *STAT))
    if os.environ.get("SMOKE"):
        parts = [p.filter(pl.col("r5").cast(pl.UInt64).hash(11) % 50 == 0) for p in parts]
    if not parts:
        return pl.DataFrame(schema={"r5": pl.UInt64, "month": pl.Utf8, **{c: pl.Float32 for c in STAT}})
    return pl.concat([p.with_columns([pl.col(c).cast(pl.Float32) for c in STAT]) for p in parts])


lk = pl.read_parquet(repo / "data/interim/aux/h3r5_lookup.parquet").select(pl.col("h3_r5_u64").alias("r5"), "lat", pl.col("biome_id").fill_null(0))
YEARS = list(range(2012, 2027))
# ---- reference sensor table, all months 2012-01..2026-11
sn = load_sat("SNPP", YEARS); n20 = load_sat("NOAA20", YEARS)
use_n20 = lambda m: (m in OUTAGE) or (m >= "2026-08")
months_all = sorted(set(sn["month"].unique().to_list()) | set(n20["month"].unique().to_list()))
months_all = [m for m in months_all if "2012-01" <= m <= "2026-11"]
refsrc = {m: ("NOAA20" if use_n20(m) else "SNPP") for m in months_all}
n20s = n20.with_columns([(pl.col(c) * N20_TO_SNPP).cast(pl.Float32) for c in SCALE])
ref = pl.concat([sn.filter(~pl.col("month").map_elements(use_n20, return_dtype=pl.Boolean)),
                 n20s.filter(pl.col("month").map_elements(use_n20, return_dtype=pl.Boolean))])
ref = ref.filter(pl.col("month").is_between(pl.lit("2012-01"), pl.lit("2026-11")))
(work / "refsrc.json").write_text(json.dumps(refsrc, indent=0))
print(f"reference table: {ref.height:,} cell-months; NOAA-20 months: {[m for m, s in refsrc.items() if s == 'NOAA20']}", flush=True)
# ---- raw counts (contract columns) and MODIS target
modis_parts = []
for sat in ("TERRA", "AQUA"):
    m = load_sat(sat, YEARS)
    modis_parts.append(m.select("r5", "month", pl.col("n").alias(f"{sat.lower()}_n"), pl.col("n_day").alias(f"{sat.lower()}_day_n")))
modis = modis_parts[0].join(modis_parts[1], on=["r5", "month"], how="full", coalesce=True).fill_null(0)
n21 = load_sat("NOAA21", YEARS).select("r5", "month", pl.col("n").alias("raw_noaa21_n"))
# memory-safe (14 Nov): slim per-sensor tables, joined per year below instead of one global 5-way full join
sn_n = sn.select("r5", "month", pl.col("n").alias("raw_snpp_n")); n20_n = n20.select("r5", "month", pl.col("n").alias("raw_noaa20_n"))
refn = ref.select("r5", "month", pl.col("n").alias("ref_n"))
del modis_parts, sn, n20, n20s; gc.collect()


def raw_for(months):
    flt = lambda t: t.filter(pl.col("month").is_in(months))
    return (flt(modis).join(flt(sn_n), on=["r5", "month"], how="full", coalesce=True)
                .join(flt(n20_n), on=["r5", "month"], how="full", coalesce=True)
                .join(flt(n21), on=["r5", "month"], how="full", coalesce=True)
                .join(flt(refn), on=["r5", "month"], how="full", coalesce=True).fill_null(0))


# ---- cell history from 2012-2019 (target = MODIS T+A, input = reference n)
hy = (raw_for([m for m in months_all if m <= "2019-12"]).with_columns(year=pl.col("month").str.slice(0, 4).cast(pl.Int32))
         .group_by("r5", "year").agg(Yc=(pl.col("terra_n") + pl.col("aqua_n")).sum().cast(pl.Float64), Sc=pl.col("ref_n").sum().cast(pl.Float64)))
ht = hy.group_by("r5").agg(Yt=pl.col("Yc").sum(), St=pl.col("Sc").sum())
G = ht["Yt"].sum() / ht["St"].sum()
print(f"history ratio G = {G:.4f}", flush=True)
# ---- neighbour pairs and r3 parents for all reference cells
cells = ref["r5"].unique().to_list()
nb = pl.DataFrame([(c, h3.str_to_int(n)) for c in cells for n in h3.grid_ring(h3.int_to_str(c), 1)], schema=["r5", "nbr"], orient="row")
p3 = pl.DataFrame({"r5": cells, "p3": [h3.str_to_int(h3.cell_to_parent(h3.int_to_str(c), 3)) for c in cells]})
fold = pl.DataFrame({"r5": cells, "fold": [zlib.crc32(f"{h3.str_to_int(h3.cell_to_parent(h3.int_to_str(c), 2))}-2026".encode()) % 5 for c in cells]},
                    schema={"r5": pl.UInt64, "fold": pl.Int8})
mi = lambda m: int(m[:4]) * 12 + int(m[5:7])
ref = ref.with_columns(mi=pl.col("month").map_elements(mi, return_dtype=pl.Int32))
for yr in YEARS:
    ms = [m for m in months_all if m.startswith(str(yr))]
    if not ms:
        continue
    cur = ref.filter(pl.col("month").is_in(ms)); raw = raw_for(ms)
    ctx = ref.filter(pl.col("mi").is_between(min(mi(m) for m in ms) - 1, max(mi(m) for m in ms) + 1)).select("r5", "mi", "n")
    nsum = (nb.join(cur.select(pl.col("r5").alias("nbr"), "month", "n", "fcp"), on="nbr")
              .group_by("r5", "month").agg(nb_snpp_n=pl.col("n").sum(), nb_snpp_fcp=pl.col("fcp").sum()))
    reg = (cur.join(p3, on="r5").group_by("p3", "month").agg(_s=pl.col("n").sum(), _f=pl.col("fcp").sum(), _q=pl.col("frp_sum").sum())
              .with_columns(reg_log=pl.col("_s").log1p(), reg_mult=pl.col("_s") / (pl.col("_f") + 1), reg_frp_per=pl.col("_q") / (pl.col("_s") + 1))
              .select("p3", "month", "reg_log", "reg_mult", "reg_frp_per"))
    f = (cur.filter(pl.col("n") > 0)
            .join(ctx.select("r5", (pl.col("mi") + 1).alias("mi"), pl.col("n").alias("snpp_prev")), on=["r5", "mi"], how="left")
            .join(ctx.select("r5", (pl.col("mi") - 1).alias("mi"), pl.col("n").alias("snpp_next")), on=["r5", "mi"], how="left")
            .join(nsum, on=["r5", "month"], how="left").join(p3, on="r5", how="left").join(reg, on=["p3", "month"], how="left")
            .join(lk, on="r5", how="left").join(fold, on="r5", how="left")
            .join(hy.filter(pl.col("year") == yr).select("r5", "Yc", "Sc"), on="r5", how="left").join(ht, on="r5", how="left")
            .join(raw.select("r5", "month", "terra_n", "aqua_n", "terra_day_n", "aqua_day_n"), on=["r5", "month"], how="left")
            .with_columns([pl.col(c).fill_null(0) for c in ("snpp_prev", "snpp_next", "nb_snpp_n", "nb_snpp_fcp", "Yc", "Sc", "Yt", "St",
                                                            "terra_n", "aqua_n", "terra_day_n", "aqua_day_n")])
            .with_columns(pl.col("lat").fill_null(0.0), pl.col("biome_id").fill_null(0))
            .with_columns(Yh=pl.col("Yt") - (pl.col("Yc") if yr <= 2019 else 0.0), Sh=pl.col("St") - (pl.col("Sc") if yr <= 2019 else 0.0))
            .with_columns(nyh=pl.lit(7.0 if yr <= 2019 else 8.0))
            .select("r5", "month", pl.lit(yr).alias("year"), pl.col("month").str.slice(5, 2).cast(pl.Int32).alias("mon"), "fold", "biome_id", "p3",
                    pl.col("n").alias("snpp_n"), pl.col("n_day").alias("snpp_day_n"), (pl.col("n") - pl.col("n_day")).alias("snpp_night_n"),
                    pl.col("fcp").alias("snpp_fcp"), pl.col("frp_sum").alias("snpp_frp_sum"), pl.col("frp_p50").alias("snpp_frp_p50"),
                    pl.col("frp_p90").alias("snpp_frp_p90"), pl.col("scan_mean").alias("snpp_scan_mean"),
                    (pl.col("lowfrp_n") / pl.col("n")).alias("snpp_lowfrp_frac"), pl.col("fire_days").alias("snpp_fire_days"),
                    pl.when(pl.col("fcp") > 0).then(pl.col("n") / pl.col("fcp")).otherwise(None).alias("snpp_mult"),
                    "nb_snpp_n", "nb_snpp_fcp", "lat",
                    np.sin(2 * np.pi * pl.col("month").str.slice(5, 2).cast(pl.Int32) / 12).alias("msin"),
                    np.cos(2 * np.pi * pl.col("month").str.slice(5, 2).cast(pl.Int32) / 12).alias("mcos"),
                    "snpp_prev", "snpp_next",
                    ((pl.col("Yh") + 20 * G) / (pl.col("Sh") + 20)).alias("hist_ratio"),
                    (pl.col("Sh") / pl.col("nyh")).log1p().alias("hist_logS"), (pl.col("Yh") / pl.col("nyh")).log1p().alias("hist_logY"),
                    "reg_log", "reg_mult", "reg_frp_per",
                    "terra_n", "aqua_n", "terra_day_n", "aqua_day_n", (pl.col("terra_n") + pl.col("aqua_n")).alias("y")))
    f = f.with_columns([pl.col(c).cast(pl.Float32) for c, t in f.schema.items() if t in (pl.Float64, pl.Int64, pl.UInt32) and c not in ("year",)])
    f.write_parquet(work / f"feat_{yr}.parquet")
    raw.select("r5", "month", "terra_n", "terra_day_n", "aqua_n", "aqua_day_n", "raw_snpp_n", "raw_noaa20_n", "raw_noaa21_n", "ref_n").write_parquet(work / f"raw_{yr}.parquet")
    print(f"{yr}: {f.height:,} model rows ({sum(1 for m in ms if refsrc.get(m) == 'NOAA20')} NOAA-20 months)", flush=True)
    del cur, ctx, nsum, reg, f, raw; gc.collect()
print("DONE features")
