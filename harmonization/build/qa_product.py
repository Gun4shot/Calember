"""QA of data/products/harmonized_cell_month.parquet (contract CONTRACTS 3.1 + optional modis_outage).
Checks: schema, month coverage, uniqueness, nulls/NaN/negatives, factor consistency, regime boundaries continuity,
harmonized vs MODIS annual totals (2012-2026, excluding MODIS outage months), uncertainty sanity. Writes qa_report.json.
Usage: python -P qa_product.py <repo> [products_dir]
"""
import json
import sys
from pathlib import Path

import polars as pl
import pyarrow.parquet as pq

repo = Path(sys.argv[1]); prod = repo / (sys.argv[2] if len(sys.argv) > 2 else "data/products")
f = prod / "harmonized_cell_month.parquet"; rep = {"file": str(f), "size_mb": round(f.stat().st_size / 1e6, 1)}
EXPECT = {"h3_r5_u64": pl.UInt64, "month": pl.String, "regime": pl.String, "h_count": pl.Float32, "h_sd_rand": pl.Float32,
          "h_sd_sys": pl.Float32, "biome_id": pl.Int8, "raw_modis_n": pl.UInt32, "raw_snpp_n": pl.UInt32, "raw_noaa20_n": pl.UInt32,
          "raw_noaa21_n": pl.UInt32, "raw_basis_n": pl.UInt32, "factor": pl.Float32, "provisional": pl.Boolean}
sch = pl.read_parquet_schema(f)
rep["schema_ok"] = all(sch.get(k) == v for k, v in EXPECT.items()); rep["extra_columns"] = [c for c in sch if c not in EXPECT]
rep["row_groups"] = pq.ParquetFile(f).num_row_groups
lf = pl.scan_parquet(f)
m = (lf.group_by("month", "regime").agg(rows=pl.len(), h=pl.col("h_count").sum(), modis=pl.col("raw_modis_n").sum().cast(pl.Float64),
                                        snpp=pl.col("raw_snpp_n").sum().cast(pl.Float64), n20=pl.col("raw_noaa20_n").sum().cast(pl.Float64),
                                        sdr=(pl.col("h_sd_rand").cast(pl.Float64) ** 2).sum().sqrt(), sds=pl.col("h_sd_sys").sum(),
                                        outage=pl.col("modis_outage").any() if "modis_outage" in sch else pl.lit(False),
                                        prov=pl.col("provisional").all())
       .sort("month").collect())
rep["rows"] = int(m["rows"].sum()); rep["months"] = m.height; rep["first"], rep["last"] = m["month"][0], m["month"][-1]
rep["months_with_two_regimes"] = int(m.group_by("month").len().filter(pl.col("len") > 1).height)
# expected months 2000-11 .. 2026-11
exp = [f"{y}-{mm:02d}" for y in range(2000, 2027) for mm in range(1, 13) if "2000-11" <= f"{y}-{mm:02d}" <= "2026-11"]
rep["missing_months"] = sorted(set(exp) - set(m["month"].to_list()))
dup = lf.group_by("h3_r5_u64", "month").len().filter(pl.col("len") > 1).select(pl.len()).collect().item()
bad = lf.select(nulls=pl.sum_horizontal([pl.col(c).is_null().sum() for c in EXPECT if c != "factor"]),
                nan=pl.col("h_count").is_nan().sum() + pl.col("h_sd_rand").is_nan().sum() + pl.col("h_sd_sys").is_nan().sum(),
                neg=(pl.col("h_count") < 0).sum() + (pl.col("h_sd_rand") < 0).sum() + (pl.col("h_sd_sys") < 0).sum(),
                inf=pl.col("h_count").is_infinite().sum(),
                factor_bad=((pl.col("raw_basis_n") > 0) & ((pl.col("factor") - pl.col("h_count") / pl.col("raw_basis_n")).abs() > 1e-3 * (1 + pl.col("factor").abs()))).sum(),
                factor_null_ok=((pl.col("raw_basis_n") == 0) & pl.col("factor").is_not_null()).sum(),
                prov_bad=((pl.col("regime") == "N") != pl.col("provisional")).sum(),
                fill_bad=((pl.col("fill_frac") < 0) | (pl.col("fill_frac") > 1) | pl.col("fill_frac").is_nan() | pl.col("fill_frac").is_null()).sum() if "fill_frac" in sch else pl.lit(0),
                max_h=pl.col("h_count").max()).collect().to_dicts()[0]
rep.update(duplicates=int(dup), **{k: (float(v) if isinstance(v, float) else int(v)) for k, v in bad.items()})
# annual totals by regime
a = (m.with_columns(yr=pl.col("month").str.slice(0, 4)).group_by("yr", "regime")
      .agg(pl.col("h").sum(), pl.col("modis").sum(), pl.col("snpp").sum(), pl.col("n20").sum(), pl.len().alias("n_months")).sort("yr", "regime"))
rep["annual"] = a.with_columns(pl.col(pl.Float64).round(0), pl.col("h").cast(pl.Float64).round(0)).to_dicts()
# harmonized vs MODIS where MODIS is intact, 2012+ (B blends MODIS; V/N independent of MODIS)
c = (m.filter((pl.col("month") >= "2012-01") & ~pl.col("outage") & (pl.col("month") <= "2026-10"))
      .with_columns(yr=pl.col("month").str.slice(0, 4)).group_by("yr", "regime").agg(h=pl.col("h").sum(), modis=pl.col("modis").sum())
      .with_columns(ratio=pl.col("h") / pl.col("modis")).sort("yr"))
rep["h_over_modis_intact"] = c.with_columns(pl.col("ratio").round(4)).select("yr", "regime", "ratio").to_dicts()
# month-level continuity at boundaries: mean of 12 months each side
def side(lo, hi):
    return float(m.filter((pl.col("month") >= lo) & (pl.col("month") <= hi))["h"].sum())
rep["boundaries"] = {
    "2002-07 T->M (12m each side, h)": [side("2001-07", "2002-06"), side("2002-07", "2003-06")],
    "2012-01 M->B": [side("2011-01", "2011-12"), side("2012-01", "2012-12")],
    "2020-01 B->V": [side("2019-01", "2019-12"), side("2020-01", "2020-12")]}
rep["global_rel_sd_rand_median"] = float((m["sdr"] / m["h"]).median()); rep["global_rel_sd_sys_median"] = float((m["sds"] / m["h"]).median())
m.write_csv(prod / "qa_monthly_full.csv")
(prod / "qa_report.json").write_text(json.dumps(rep, indent=1, default=str))
ok = rep["schema_ok"] and not rep["missing_months"] and rep["duplicates"] == 0 and rep["nulls"] == 0 and rep["nan"] == 0 and rep["neg"] == 0 \
    and rep["inf"] == 0 and rep["factor_bad"] == 0 and rep["factor_null_ok"] == 0 and rep["prov_bad"] == 0 and rep["fill_bad"] == 0 and rep["months_with_two_regimes"] == 0
rep["PASS"] = ok
(prod / "qa_report.json").write_text(json.dumps(rep, indent=1, default=str))
print(json.dumps({k: v for k, v in rep.items() if k not in ("annual", "h_over_modis_intact")}, indent=1, default=str))
pl.Config.set_tbl_rows(40); pl.Config.set_tbl_formatting("ASCII_MARKDOWN")
print(a.with_columns(pl.col(pl.Float64).round(0)))
print(c.with_columns(pl.col("ratio").round(4)))
print("QA", "PASS" if ok else "FAIL")
