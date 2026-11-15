"""Product build step 4: assemble data/products/harmonized_cell_month.parquet (CONTRACTS 3.1) for 2000-11 .. 2026-11.
Regimes: T 2000-11..2002-06 | M 2002-07..2011-12 | B 2012-01..2019-12 | V 2020-01..2026-07 | N 2026-08..2026-11 (provisional).
Usage: python -P assemble.py <repo>
"""
import gc
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import h3
import numpy as np
import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq

repo = Path(sys.argv[1]); ex = repo / "data/interim/explore"; import os
PROD = repo / os.environ.get("PRODUCTS_DIR", "data/products")
work = PROD / "work"; prod = PROD
lk = pl.read_parquet(repo / "data/interim/aux/h3r5_lookup.parquet").select(pl.col("h3_r5_u64").alias("r5"), pl.col("biome_id").fill_null(0).cast(pl.Int8))
refsrc = json.loads((work / "refsrc.json").read_text())
K0, KT = 200.0, 50.0
# MODIS outage months (QA): a satellite has >=3 days with count < 25% of its centred 61-day rolling median (modis_daily_counts.parquet)
_od = pl.read_parquet(ex / "modis_daily_counts.parquet").with_columns(month=pl.col("acq_date").dt.strftime("%Y-%m"))
OUTM = set(_od.group_by("satellite", "month").agg(o=pl.col("out").sum()).filter(pl.col("o") >= 3)["month"].to_list())
print(f"MODIS outage months: {sorted(OUTM)}", flush=True)
# S-NPP incomplete months in regime B (>=3 days missing or below 25% of rolling median, incl. before the 2012-01-20 record start):
# the blend then uses MODIS only (wb = 0), since the model input is incomplete.
_vd = pl.read_parquet(ex / "viirs_daily_counts.parquet").filter((pl.col("sat") == "viirs-snpp") & ~pl.col("out"))
_vd = _vd.with_columns(month=pl.col("acq_date").dt.strftime("%Y-%m")).group_by("month").agg(good=pl.len(), dim=pl.col("acq_date").first().dt.month_end().dt.day())
SNPP_GAP = set(_vd.filter((pl.col("dim") - pl.col("good") >= 3) & (pl.col("month") <= "2019-12"))["month"].to_list())
print(f"S-NPP incomplete B months (MODIS-only blend): {sorted(SNPP_GAP)}", flush=True)
# Input-completeness correction (14 Nov; validated by sim_fill.py on 36 synthetic outages):
#  - sensor-month lost fraction L (fill_prep.py); applied where L >= 0.02
#  - MODIS with both satellites (M, B): paired fill from the other satellite on lost days (modis_fill.parquet);
#    error model var += A_PAIR * est (per cell), sys += S_PAIR * est (biome-correlated)
#  - Terra-only T and model regimes (B/V/N input): scale by c = 1/(1-L); var += A_CC * F, sys += S_CC * F (F = filled amount)
A_PAIR, S_PAIR, A_CC, S_CC, LMIN = 11.35, 0.24, 13.0, 0.68, 0.02
LM = {(r[0], r[1]): r[2] for r in pl.read_parquet(ex / "sensor_month_L.parquet").select("sensor", "month", "L").iter_rows()}
cfac = lambda sensor, m: 1.0 / (1.0 - LM[(sensor, m)]) if LM.get((sensor, m), 0.0) >= LMIN else 1.0
FILL = pl.read_parquet(ex / "modis_fill.parquet").with_columns(est=(pl.col("est_t") + pl.col("est_a")).cast(pl.Float64)).select("r5", "month", "est")
FILLM = set(FILL["month"].unique().to_list())
# B rule: when the model input (S-NPP) lost >= 5 % of a month and MODIS is complete (both satellites L < 5 %), use MODIS only
SNPP_GAP |= {mm for (sen, mm), v in LM.items() if sen == "SNPP" and v >= 0.05 and "2012-01" <= mm <= "2019-12"
             and LM.get(("TERRA", mm), 0.0) < 0.05 and LM.get(("AQUA", mm), 0.0) < 0.05}
print(f"B months using MODIS only (S-NPP incomplete): {sorted(SNPP_GAP)}", flush=True)
print(f"completeness: {len(FILLM)} paired-fill months; T scale months {[mm for mm in sorted({k[1] for k in LM}) if mm <= '2002-06' and cfac('TERRA', mm) > 1]}", flush=True)
t00 = time.time()

def regime(m):
    if m <= "2002-06": return "T"
    if m <= "2011-12": return "M"
    if m <= "2019-12": return "B"
    if m <= "2026-07": return "V"
    return "N"

# ---------------- MODIS 2000-2011 (T and M regimes) ----------------
mod = (pl.scan_parquet([str(ex / "cm_long_m1" / f"modis_{y}.parquet") for y in range(2000, 2012)])
         .filter(pl.col("sat").is_in(["TERRA", "AQUA"])).select(pl.col("r5").cast(pl.UInt64), "month", "sat", "n", "n_day").collect())
if os.environ.get("SMOKE"):
    mod = mod.filter(pl.col("r5").hash(11) % 50 == 0)
mw = (mod.pivot(on="sat", index=["r5", "month"], values=["n", "n_day"]).fill_null(0)
         .rename({"n_TERRA": "t", "n_AQUA": "a", "n_day_TERRA": "td", "n_day_AQUA": "ad"}))
for c in ("t", "a", "td", "ad"):
    if c not in mw.columns:
        mw = mw.with_columns(pl.lit(0).alias(c))
mw = mw.join(lk, on="r5", how="left").with_columns(pl.col("biome_id").fill_null(0), mon=pl.col("month").str.slice(5, 2).cast(pl.Int32))
# Terra -> Terra+Aqua factors per (biome, month-of-year, day/night) from 2003-2011, shrunk to the global ratio (k=50)
c = mw.filter(pl.col("month").is_between(pl.lit("2003-01"), pl.lit("2011-12"))).with_columns(tn=pl.col("t") - pl.col("td"), an=pl.col("a") - pl.col("ad"))
gd = (c["td"].sum() + c["ad"].sum()) / c["td"].sum(); gn = (c["tn"].sum() + c["an"].sum()) / max(c["tn"].sum(), 1)
TF = (c.group_by("biome_id", "mon").agg(TAd=(pl.col("td") + pl.col("ad")).sum(), Td=pl.col("td").sum(), TAn=(pl.col("tn") + pl.col("an")).sum(), Tn=pl.col("tn").sum())
        .with_columns(fd=(pl.col("TAd") + KT * gd) / (pl.col("Td") + KT), fn=(pl.col("TAn") + KT * gn) / (pl.col("Tn") + KT)))
# in-sample check of the T method on 2003-2011 biome-year totals -> systematic relative sd per biome
chk = (c.join(TF.select("biome_id", "mon", "fd", "fn"), on=["biome_id", "mon"]).with_columns(yr=pl.col("month").str.slice(0, 4))
         .group_by("biome_id", "yr").agg(o=(pl.col("t") + pl.col("a")).sum(), p=(pl.col("fd") * pl.col("td") + pl.col("fn") * pl.col("tn")).sum())
         .with_columns(rel=(pl.col("p") - pl.col("o")) / pl.col("o")).group_by("biome_id").agg(relT=pl.col("rel").std().fill_null(0.05)))
print(f"T factors: global day {gd:.3f}, night {gn:.3f}; T-method rel sd median {chk['relT'].median():.3f}", flush=True)

# ---------------- cross-fit statistics for B/V/N uncertainty ----------------
cfp = pl.read_parquet(work / "pred_cf.parquet")
rawB = pl.concat([pl.read_parquet(work / f"raw_{y}.parquet") for y in range(2012, 2020)]).with_columns(y=(pl.col("terra_n") + pl.col("aqua_n")).cast(pl.Float32))
# cell-level residual variance by predicted-level bin (model rows only; zero rows handled with their own Poisson-like term)
r = rawB.join(cfp, on=["r5", "month"], how="inner").with_columns(b=pl.col("p_model").clip(1e-4, None).log10().floordiv(0.25).cast(pl.Int16))
VB = r.group_by("b").agg(vtot=((pl.col("y") - pl.col("p_model")) ** 2).mean(), pm=pl.col("p_model").mean(), n=pl.len())
VB = VB.with_columns(vmod=(pl.col("vtot") - pl.col("pm")).clip(0.01 * pl.col("pm") ** 2, None))
# biome systematic: sd over years of annual relative error of biome totals (model rows), floor 0.005
SYS = (r.join(lk, on="r5", how="left").with_columns(yr=pl.col("month").str.slice(0, 4))
         .group_by("biome_id", "yr").agg(o=pl.col("y").sum(), p=pl.col("p_model").sum()).with_columns(rel=(pl.col("p") - pl.col("o")) / pl.col("o"))
         .group_by("biome_id").agg(rel_sys=pl.col("rel").std().fill_null(0.02).clip(0.005, None)))
print(f"uncertainty stats: {VB.height} pred bins; biome rel_sys median {SYS['rel_sys'].median():.3f}", flush=True)
del r; gc.collect()

# ---------------- zero model v2 statistics (2012-2019) ----------------
import zlib
U = rawB.filter((pl.col("y") > 0) | (pl.col("ref_n") > 0)).select("r5").unique()
cells = U["r5"].to_list()
info = pl.DataFrame({"r5": cells,
                     "p3": [h3.str_to_int(h3.cell_to_parent(h3.int_to_str(x), 3)) for x in cells],
                     "fold": [zlib.crc32(f"{h3.str_to_int(h3.cell_to_parent(h3.int_to_str(x), 2))}-2026".encode()) % 5 for x in cells]},
                    schema={"r5": pl.UInt64, "p3": pl.UInt64, "fold": pl.Int8}).join(lk, on="r5", how="left").with_columns(pl.col("biome_id").fill_null(0))
del rawB; gc.collect()


def month_grid(m, rawm):
    """dense U x month with ref n, MODIS y, nbflag, rbin."""
    act = rawm.filter(pl.col("ref_n") > 0).select("r5", "ref_n")
    ring = pl.DataFrame({"r5": [h3.str_to_int(nn) for x in act["r5"].to_list() for nn in h3.grid_ring(h3.int_to_str(x), 1)]}, schema={"r5": pl.UInt64}).unique()
    reg = act.join(info.select("r5", "p3"), on="r5", how="inner").group_by("p3").agg(rs=pl.col("ref_n").sum())
    return (info.join(rawm.select("r5", "ref_n", "terra_n", "aqua_n"), on="r5", how="left").fill_null(0)
                .join(ring.with_columns(nbflag=pl.lit(True)), on="r5", how="left").with_columns(pl.col("nbflag").fill_null(False))
                .join(reg, on="p3", how="left").with_columns(rbin=pl.col("rs").fill_null(0).cast(pl.Float64).log1p().floordiv(1.5).clip(0, 6).cast(pl.Int8),
                                                            y=(pl.col("terra_n") + pl.col("aqua_n")).cast(pl.Float32)))


zst = []
for y in range(2012, 2020):
    raw_y = pl.read_parquet(work / f"raw_{y}.parquet")
    for m in sorted(raw_y["month"].unique().to_list()):
        g = month_grid(m, raw_y.filter(pl.col("month") == m)).filter(pl.col("ref_n") == 0)
        zst.append(g.group_by("fold", "biome_id", "nbflag", "rbin").agg(Y=pl.col("y").sum(), N=pl.len()))
zst = pl.concat(zst)


def ztab(t):
    g = t["Y"].sum() / t["N"].sum()
    p = t.group_by("nbflag", "rbin").agg(Yp=pl.col("Y").sum(), Np=pl.col("N").sum()).with_columns(prate=(pl.col("Yp") + K0 * g) / (pl.col("Np") + K0))
    return (t.group_by("biome_id", "nbflag", "rbin").agg(pl.col("Y").sum(), pl.col("N").sum()).join(p, on=["nbflag", "rbin"])
              .with_columns(z=(pl.col("Y") + K0 * pl.col("prate")) / (pl.col("N") + K0)).select("biome_id", "nbflag", "rbin", "z"), g)


Z_ALL = ztab(zst)
Z_CF = {k: ztab(zst.filter(pl.col("fold") != k)) for k in range(5)}
print(f"zero model built ({time.time()-t00:.0f}s)", flush=True)

# ---------------- write product month by month ----------------
SCHEMA = pa.schema([("h3_r5_u64", pa.uint64()), ("month", pa.string()), ("regime", pa.string()), ("h_count", pa.float32()),
                    ("h_sd_rand", pa.float32()), ("h_sd_sys", pa.float32()), ("biome_id", pa.int8()), ("raw_modis_n", pa.uint32()),
                    ("raw_snpp_n", pa.uint32()), ("raw_noaa20_n", pa.uint32()), ("raw_noaa21_n", pa.uint32()), ("raw_basis_n", pa.uint32()),
                    ("factor", pa.float32()), ("provisional", pa.bool_()), ("modis_outage", pa.bool_()), ("fill_frac", pa.float32())])
out_path = prod / "harmonized_cell_month.parquet"
writer = pq.ParquetWriter(out_path, SCHEMA, compression="zstd")
qa = []


def emit(df):
    df = df.filter((pl.col("h_count") > 0) | (pl.col("raw_modis_n") > 0) | (pl.col("raw_snpp_n") > 0) | (pl.col("raw_noaa20_n") > 0) | (pl.col("raw_noaa21_n") > 0))
    df = df.with_columns(factor=pl.when(pl.col("raw_basis_n") > 0).then(pl.col("h_count") / pl.col("raw_basis_n")).otherwise(None),
                         fill_frac=pl.when(pl.col("h_count") > 0).then(((pl.col("h_count") - pl.col("h0")) / pl.col("h_count")).clip(0, 1)).otherwise(0.0))
    t = df.select(pl.col("r5").alias("h3_r5_u64"), "month", "regime", *[pl.col(c).cast(pl.Float32) for c in ("h_count", "h_sd_rand", "h_sd_sys")],
                  pl.col("biome_id").cast(pl.Int8), *[pl.col(c).cast(pl.Float64).round(0).cast(pl.UInt32) for c in ("raw_modis_n", "raw_snpp_n", "raw_noaa20_n", "raw_noaa21_n", "raw_basis_n")],
                  pl.col("factor").cast(pl.Float32), pl.col("provisional"), pl.col("modis_outage"), pl.col("fill_frac").cast(pl.Float32)).to_arrow().cast(SCHEMA)
    writer.write_table(t)
    qa.append(dict(month=df["month"][0] if df.height else None, regime=df["regime"][0] if df.height else None, rows=df.height,
                   h=float(df["h_count"].sum()), modis=float(df["raw_modis_n"].sum()), snpp=float(df["raw_snpp_n"].sum()),
                   n20=float(df["raw_noaa20_n"].sum()), sd_rand_sq=float((df["h_sd_rand"] ** 2).sum()), h0=float(df["h0"].sum())))


# T and M
for m in sorted(mw["month"].unique().to_list()):
    reg = regime(m); x = mw.filter(pl.col("month") == m); cT = cfac("TERRA", m)
    if reg == "T":
        x = (x.join(TF.select("biome_id", "mon", "fd", "fn"), on=["biome_id", "mon"], how="left").join(chk, on="biome_id", how="left")
               .with_columns(pl.col("fd").fill_null(gd), pl.col("fn").fill_null(gn), pl.col("relT").fill_null(0.05), tn=pl.col("t") - pl.col("td"))
               .with_columns(h0=pl.col("fd") * pl.col("td") + pl.col("fn") * pl.col("tn"))
               .with_columns(h_count=pl.col("h0") * cT)
               .with_columns(h_sd_rand=((pl.col("fd") ** 2 * pl.col("td") + pl.col("fn") ** 2 * pl.col("tn")) * cT ** 2 + A_CC * (pl.col("h_count") - pl.col("h0"))).sqrt())
               .with_columns(h_sd_sys=((pl.col("h_count") * pl.col("relT")) ** 2 + (S_CC * (pl.col("h_count") - pl.col("h0"))) ** 2).sqrt(), raw_basis_n=pl.col("t")))
    else:
        if m in FILLM:
            x = x.join(FILL.filter(pl.col("month") == m).select("r5", "est"), on="r5", how="left").with_columns(pl.col("est").fill_null(0.0))
        else:
            x = x.with_columns(est=pl.lit(0.0))
        x = x.with_columns(h0=(pl.col("t") + pl.col("a")).cast(pl.Float64)).with_columns(
            h_count=pl.col("h0") + pl.col("est"), h_sd_rand=(pl.col("h0") + A_PAIR * pl.col("est")).sqrt(),
            h_sd_sys=S_PAIR * pl.col("est"), raw_basis_n=pl.col("t") + pl.col("a"))
    emit(x.with_columns(regime=pl.lit(reg), raw_modis_n=pl.col("t") + pl.col("a"), raw_snpp_n=pl.lit(0), raw_noaa20_n=pl.lit(0), raw_noaa21_n=pl.lit(0),
                        provisional=pl.lit(False), modis_outage=pl.lit(m in OUTM)))
del mw, mod; gc.collect()
print(f"T/M written ({time.time()-t00:.0f}s)", flush=True)

# B, V, N
VBj = VB.select("b", "vtot", "vmod")
for y in range(2012, 2027):
    raw_y = pl.read_parquet(work / f"raw_{y}.parquet")
    pr = pl.read_parquet(work / "pred_cf.parquet").filter(pl.col("month").str.slice(0, 4) == str(y)) if y <= 2019 else pl.read_parquet(work / f"pred_final_{y}.parquet")
    for m in sorted(raw_y["month"].unique().to_list()):
        reg = regime(m); rm = raw_y.filter(pl.col("month") == m)
        g = month_grid(m, rm)
        if reg == "B":
            parts = []
            for k in range(5):
                zt, gz = Z_CF[k]
                parts.append(g.filter(pl.col("fold") == k).join(zt, on=["biome_id", "nbflag", "rbin"], how="left").with_columns(pl.col("z").fill_null(gz)))
            g = pl.concat(parts)
        else:
            zt, gz = Z_ALL
            g = g.join(zt, on=["biome_id", "nbflag", "rbin"], how="left").with_columns(pl.col("z").fill_null(gz))
        g = g.with_columns(z=pl.when(pl.col("ref_n") > 0).then(0.0).otherwise(pl.col("z"))).select("r5", "z")
        x = (rm.join(g, on="r5", how="full", coalesce=True).join(pr.filter(pl.col("month") == m).select("r5", "p_model"), on="r5", how="left")
               .join(lk, on="r5", how="left")
               .with_columns([pl.col(c).fill_null(0) for c in ("ref_n", "terra_n", "aqua_n", "raw_snpp_n", "raw_noaa20_n", "raw_noaa21_n", "z", "p_model")])
               .with_columns(pl.col("biome_id").fill_null(0), month=pl.lit(m), p=pl.col("p_model") + pl.col("z"))
               .with_columns(b=pl.col("p").clip(1e-4, None).log10().floordiv(0.25).cast(pl.Int16)).join(VBj, on="b", how="left").join(SYS, on="biome_id", how="left")
               .with_columns(vtot=pl.col("vtot").fill_null(pl.col("p")), vmod=pl.col("vmod").fill_null(0.01 * pl.col("p") ** 2 + 1e-4),
                             rel_sys=pl.col("rel_sys").fill_null(0.02), y=(pl.col("terra_n") + pl.col("aqua_n")).cast(pl.Float64)))
        cR = cfac(refsrc.get(m, "SNPP"), m) if m not in SNPP_GAP else 1.0
        if reg == "B" and m in FILLM and m not in OUTM:
            x = x.join(FILL.filter(pl.col("month") == m).select("r5", "est"), on="r5", how="left").with_columns(pl.col("est").fill_null(0.0))
        else:
            x = x.with_columns(est=pl.lit(0.0))
        x = x.with_columns(pc=pl.col("p") * cR, yf=pl.col("y") + pl.col("est"))
        if reg == "B":  # inverse-variance blend of MODIS observed (Poisson var ~ p) and cross-fitted Bridge (model-error var)
            x = (x.with_columns(vm=pl.col("pc").clip(0.05, None) + A_PAIR * pl.col("est"),
                                vb=(pl.col("vmod") * cR ** 2 + A_CC * (pl.col("pc") - pl.col("p"))).clip(1e-4, None))
                  .with_columns(wb=pl.lit(1.0) if m in OUTM else pl.lit(0.0) if m in SNPP_GAP else (1 / pl.col("vb")) / (1 / pl.col("vm") + 1 / pl.col("vb")))
                  .with_columns(h_count=(1 - pl.col("wb")) * pl.col("yf") + pl.col("wb") * pl.col("pc"),
                                h0=(1 - pl.col("wb")) * pl.col("y") + pl.col("wb") * pl.col("p"),
                                h_sd_rand=(pl.col("vtot") * cR ** 2 + A_CC * (pl.col("pc") - pl.col("p"))).sqrt() if m in OUTM
                                else pl.col("y").sqrt() if m in SNPP_GAP else (1 / (1 / pl.col("vm") + 1 / pl.col("vb"))).sqrt())
                  .with_columns(h_sd_sys=pl.col("wb") * (pl.col("pc") * pl.col("rel_sys") + S_CC * (pl.col("pc") - pl.col("p")))
                                + (1 - pl.col("wb")) * S_PAIR * pl.col("est")))
        else:
            chain = 0.006 if refsrc.get(m) == "NOAA20" else 0.0
            x = x.with_columns(h_count=pl.col("pc"), h0=pl.col("p"), h_sd_rand=(pl.col("vtot") * cR ** 2 + A_CC * (pl.col("pc") - pl.col("p"))).sqrt(),
                               h_sd_sys=((pl.col("pc") ** 2) * (pl.col("rel_sys") ** 2 + chain ** 2) + (S_CC * (pl.col("pc") - pl.col("p"))) ** 2).sqrt())
        basis = "raw_noaa20_n" if refsrc.get(m) == "NOAA20" else "raw_snpp_n"
        emit(x.with_columns(regime=pl.lit(reg), raw_modis_n=pl.col("terra_n") + pl.col("aqua_n"), raw_basis_n=pl.col(basis),
                            provisional=pl.lit(reg == "N"), modis_outage=pl.lit(reg in ("T", "M", "B") and m in OUTM)))
    print(f"{y} written ({time.time()-t00:.0f}s)", flush=True)
    del raw_y, pr; gc.collect()
writer.close()
q = pl.DataFrame(qa)
q.write_csv(prod / "harmonized_qa_monthly.csv")
sha = subprocess.run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
meta = {"product": "harmonized_cell_month", "version": "0.9.1-preH0", "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": "H1E1g_z2 tuned (Bridge v2)", "git_sha": sha, "config_hash": "n/a (pre-H0 exploration build)",
        "notes": "Built with harmonization/build. Regimes T/M/B/V/N; NOAA-20/0.985 replaces S-NPP in its loss months (see below); "
                 "modis_outage (optional QA column) marks T/M/B months where a MODIS "
                 "satellite lost data (>=3 days below 25% of its rolling median); in B outage months MODIS is not blended (model only); "
                 "in B months with incomplete S-NPP (>=3 days missing, or lost >=5% with complete MODIS: 2012-01, 2012-03) the blend uses MODIS only; "
                 "input-completeness correction (sensor-month lost fraction L>=0.02): paired-satellite fill of MODIS in M/B, scaling 1/(1-L) of Terra in T "
                 "and of the model reference input in B/V/N; NOAA-20 replaces S-NPP from 2020 where S-NPP lost >=5% and NOAA-20 at most half as much "
                 "(2022-07/08, 2024-05/06/07/11, 2025-07, 2026-03/04/06/07, and from 2026-08); fill_frac (optional) = share of h_count added by the correction; 2026-11 is month-to-date (to 2026-11-12). Static mask v1 applied."}
(prod / "harmonized_cell_month.parquet.meta.json").write_text(json.dumps(meta, indent=1))
ann = q.with_columns(yr=pl.col("month").str.slice(0, 4)).group_by("yr", "regime").agg(pl.col("h").sum(), pl.col("modis").sum(), pl.col("snpp").sum(), pl.col("rows").sum()).sort("yr")
print(ann.to_pandas().round(0).to_string())
print(f"DONE assemble ({time.time()-t00:.0f}s)")
