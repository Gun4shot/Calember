"""Hotspot partitions for the static site's hotspots.csv / bundle.zip: every cleaned detection, packed by year and H3 r2 region.

The browser downloads only the partitions an export touches (years x r2 regions of the area), keeps the rows whose r5
cell is in the area and whose date and sensor match, and writes the same CSV as the API (CONTRACTS §6.1). The cleaning
and the meh_weight rule are the API's (api/ember_api/hotspots.py): type 0, MODIS confidence >= 30, VIIRS n/h, static
mask v1; a detection of the month's basis sensor carries the cell-month factor, others carry 0.

  <out>/<year>/<r2>.bin.gz    gzip of: "CAL2" | u32 header length | header JSON | pad to 4 | columns (n values each)
  header = {"kind": "h", "year": Y, "first_day": "2000-11-01", "cells": [r5 hex], "n": rows, "cols": [[name, type], ...]}
  columns (rows sorted by block, day, time):
    ci u16 cell index · blk u8 source block (see BLOCKS) · sat u8 (0 TERRA 1 AQUA 2 SNPP 3 NOAA20 4 NOAA21)
    day u16 days since first_day · t u16 hhmm · lat, lon i32 (x 1e5, lossless) · frp, bm, bt i32 (x 100, lossless)
    sc, tr u16 (x 100) · conf u8 (MODIS 0-100; VIIRS 201 = n, 202 = h) · dn u8 (0 D, 1 N, 2 null)
    w i32 (round(meh_weight, 4) x 1e4) · lsh u16 (round(local solar hour, 2) x 100) · reg u8 (0 none, 1 T 2 M 3 B 4 V 5 N)
    prov u8 (provisional)
Usage:  python pipeline/build_hotspot_parts.py [out_dir=data/hotspots] [years...]
"""
from __future__ import annotations

import gzip
import json
import struct
import sys
import time
from pathlib import Path

import duckdb
import h3
import numpy as np
import polars as pl
import yaml

REPO = Path(__file__).resolve().parents[1]
FIRST_DAY = "2000-11-01"
SATS = {"TERRA": 0, "AQUA": 1, "SNPP": 2, "NOAA20": 3, "NOAA21": 4}
REG = {"T": 1, "M": 2, "B": 3, "V": 4, "N": 5}
# block id -> (path relative to data/interim, instrument, source label, VIIRS satellite); archive paths take {y}
BLOCKS = {
    0: ("firms_raw/product=modis/year={y}/*.parquet", "MODIS", "SP", ""),
    1: ("firms_raw/product=viirs-snpp/year={y}/*.parquet", "VIIRS", "SP", "SNPP"),
    2: ("firms_raw/product=viirs-jpss1/year={y}/*.parquet", "VIIRS", "SP", "NOAA20"),
    3: ("firms_api/VIIRS_NOAA21_SP.parquet", "VIIRS", "SP", "NOAA21"),
    4: ("firms_api/VIIRS_NOAA21_NRT.parquet", "VIIRS", "NRT", "NOAA21"),
    5: ("firms_api/MODIS_SP.parquet", "MODIS", "SP", ""),
    6: ("firms_api/MODIS_NRT.parquet", "MODIS", "NRT", ""),
    7: ("firms_api/VIIRS_SNPP_SP.parquet", "VIIRS", "SP", "SNPP"),
    8: ("firms_api/VIIRS_SNPP_NRT.parquet", "VIIRS", "NRT", "SNPP"),
    9: ("firms_api/VIIRS_NOAA20_SP.parquet", "VIIRS", "SP", "NOAA20"),
    10: ("firms_api/VIIRS_NOAA20_NRT.parquet", "VIIRS", "NRT", "NOAA20"),
}
N_BUCKETS = 4  # each year is processed in 4 passes (by r0 base cell) to bound memory


def write(path: Path, header: dict, cols: list[tuple[str, np.ndarray]]) -> int:
    head = json.dumps({**header, "cols": [[n, a.dtype.str.lstrip("<|=")] for n, a in cols]}, separators=(",", ":")).encode("utf-8")
    parts = [b"CAL2", struct.pack("<I", len(head)), head, b"\0" * ((-(8 + len(head))) % 4)]
    for _, a in cols:
        b = a.astype(a.dtype.newbyteorder("<"), copy=False).tobytes()
        parts.append(b + b"\0" * ((-len(b)) % 4))
    data = gzip.compress(b"".join(parts), compresslevel=6, mtime=0)
    path.write_bytes(data)
    return len(data)


def py_round_scaled(values: np.ndarray, nd: int) -> np.ndarray:
    """int(round(round(v, nd) * 10**nd)) with Python's exact round(), via the unique values."""
    u, inv = np.unique(values, return_inverse=True)
    s = 10 ** nd
    r = np.array([round(round(float(v), nd) * s) for v in u], dtype=np.int64)
    return r[inv]


def main() -> None:
    args = [a for a in sys.argv[1:]]
    out = Path(args[0]) if args else REPO / "data/hotspots"
    years = [int(a) for a in args[1:]] or list(range(2000, 2027))
    cfg = yaml.safe_load((REPO / "config/ember.yaml").read_text(encoding="utf-8"))
    interim = REPO / cfg["paths"]["interim"]
    products = REPO / cfg["paths"]["products"]
    cm = (REPO / cfg["paths"]["api_cell_month"]).as_posix()
    refsrc = json.loads((products / "work/refsrc.json").read_text(encoding="utf-8"))
    mask = (REPO / "data/interim/explore/static_mask_r7.parquet").as_posix()

    con = duckdb.connect()
    con.execute("SET memory_limit='3GB'; SET threads=3; LOAD h3")
    con.execute(f"CREATE TABLE mask AS SELECT r7 FROM '{mask}'")

    for y in years:
        t0 = time.time()
        con.execute(f"CREATE OR REPLACE TABLE fac AS SELECT h3_r5_u64 AS r5, month, regime, factor, provisional FROM read_parquet('{cm}') "
                    f"WHERE month BETWEEN '{y}-01' AND '{y}-12'")
        srcs = []
        for b, (rel, inst, src, vsat) in BLOCKS.items():
            p = interim / rel.format(y=y)
            if "{y}" in rel:
                if not p.parent.exists():
                    continue
            elif not p.exists():
                continue
            srcs.append((b, p.as_posix(), inst, vsat))
        if not srcs:
            continue
        (out / str(y)).mkdir(parents=True, exist_ok=True)
        n_rows = n_regions = total = 0
        for bucket in range(N_BUCKETS):
            frames = []
            for b, path, inst, vsat in srcs:
                sat = ("CASE satellite WHEN 'Terra' THEN 0 WHEN 'T' THEN 0 WHEN 'Aqua' THEN 1 WHEN 'A' THEN 1 ELSE 255 END" if inst == "MODIS"
                       else str(SATS[vsat]))
                conf_ok = "try_cast(confidence AS INT) >= 30" if inst == "MODIS" else "confidence IN ('n','h')"
                conf = "try_cast(confidence AS INT)" if inst == "MODIS" else "CASE confidence WHEN 'n' THEN 201 ELSE 202 END"
                bm, bt = ("brightness", "bright_t31") if inst == "MODIS" else ("bright_ti4", "bright_ti5")
                q = f"""
                  WITH d AS (
                    SELECT {sat} AS sat, acq_date, lpad(CAST(acq_time AS VARCHAR), 4, '0') AS t, latitude AS lat, longitude AS lon,
                           daynight, {conf} AS conf, frp, {bm} AS bm, {bt} AS bt, scan, track,
                           h3_latlng_to_cell(latitude, longitude, 5) AS r5, h3_latlng_to_cell(latitude, longitude, 7) AS r7
                    FROM read_parquet('{path}', union_by_name=true)
                    WHERE acq_date BETWEEN '{y}-01-01' AND '{y}-12-31' AND (type = 0 OR type IS NULL) AND {conf_ok})
                  SELECT {b} AS blk, d.sat, (CAST(d.acq_date AS DATE) - DATE '{FIRST_DAY}')::INTEGER AS day, CAST(d.t AS INTEGER) AS t,
                         d.lat, d.lon, d.daynight, d.conf, d.frp, d.bm, d.bt, d.scan, d.track, d.r5,
                         h3_h3_to_string(h3_cell_to_parent(d.r5, 2)) AS r2, substr(d.acq_date, 1, 7) AS month,
                         f.regime, f.factor, f.provisional
                  FROM d ANTI JOIN mask USING (r7)
                  LEFT JOIN fac f ON f.r5 = d.r5 AND f.month = substr(d.acq_date, 1, 7)
                  WHERE h3_get_base_cell_number(d.r5) % {N_BUCKETS} = {bucket}"""
                df = pl.from_arrow(con.sql(q).to_arrow_table())
                if df.height:
                    frames.append(df)
            if not frames:
                continue
            df = pl.concat(frames, how="vertical_relaxed")
            n_rows += df.height
            if (df["sat"] == 255).any():
                raise SystemExit(f"{y}: unknown MODIS satellite code")
            # meh_weight: the basis sensor of the month carries the factor
            month = df["month"].to_numpy(); reg = df["regime"].to_list()
            nb = df.select(pl.col("month").replace_strict(refsrc, default="SNPP").eq("NOAA20").alias("x"))["x"].to_numpy()
            r = df["regime"].fill_null("").to_numpy(); s_ = df["sat"].to_numpy()
            basis_ok = ((r == "T") & (s_ == 0)) | ((r == "M") & (s_ <= 1)) | (np.isin(r, ["B", "V", "N"]) & (s_ == np.where(nb, 3, 2)))
            fac = df["factor"].fill_null(0.0).cast(pl.Float64).to_numpy()
            w = py_round_scaled(np.where(basis_ok, fac, 0.0), 4).astype(np.int32)
            hh = df["t"].to_numpy() // 100; mm = df["t"].to_numpy() % 100
            lsh_raw = (hh + mm / 60 + df["lon"].to_numpy() / 15.0) % 24
            lsh = np.array([round(round(float(v), 2) * 100) for v in lsh_raw.tolist()], dtype=np.uint16)
            dn = df["daynight"].replace_strict({"D": 0, "N": 1}, default=2, return_dtype=pl.UInt8).to_numpy()
            prov = df["provisional"].fill_null(pl.Series([m >= "2026-08" for m in month])).cast(pl.UInt8).to_numpy()
            regc = np.array([REG.get(r, 0) if r else 0 for r in reg], dtype=np.uint8)
            packed = pl.DataFrame({
                "r2": df["r2"], "r5": df["r5"], "blk": df["blk"].cast(pl.UInt8), "sat": df["sat"].cast(pl.UInt8),
                "day": df["day"].cast(pl.UInt16), "t": df["t"].cast(pl.UInt16),
                "lat": (df["lat"] * 1e5).round().cast(pl.Int32), "lon": (df["lon"] * 1e5).round().cast(pl.Int32),
                "frp": (df["frp"].cast(pl.Float64) * 100).round().cast(pl.Int32),
                "bm": (df["bm"].cast(pl.Float64) * 100).round().cast(pl.Int32), "bt": (df["bt"].cast(pl.Float64) * 100).round().cast(pl.Int32),
                "sc": (df["scan"].cast(pl.Float64) * 100).round().cast(pl.UInt16), "tr": (df["track"].cast(pl.Float64) * 100).round().cast(pl.UInt16),
                "conf": df["conf"].cast(pl.UInt8), "dn": dn, "w": w, "lsh": lsh, "reg": regc, "prov": prov.astype(np.uint8),
            })
            del df, frames
            for (r2,), g in packed.partition_by("r2", as_dict=True, maintain_order=False).items():
                n_regions += 1
                g = g.sort("blk", "day", "t", maintain_order=True)
                cells, ci = np.unique(g["r5"].to_numpy(), return_inverse=True)
                cols = [("ci", ci.astype(np.uint16))] + [(c, g[c].to_numpy()) for c in
                        ("blk", "sat", "day", "t", "lat", "lon", "frp", "bm", "bt", "sc", "tr", "conf", "dn", "w", "lsh", "reg", "prov")]
                total += write(out / str(y) / f"{r2}.bin.gz", {"kind": "h", "year": y, "first_day": FIRST_DAY,
                                                               "cells": [h3.int_to_str(int(c)) for c in cells], "n": g.height}, cols)
            del packed
        print(f"{y}: {n_rows:,} rows, {n_regions} regions, {total / 1e6:.0f} MB, {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
