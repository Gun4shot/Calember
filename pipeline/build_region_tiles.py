"""Region tiles for drawn areas on the static site: the full harmonized record of every r5 cell, grouped by H3 r2 parent.

The static site (no Python server) reads these in the browser for lassos, circles, coordinates and twin regions and
computes the same answers as the API (calendar with 90 % range and raw sensor counts, terrain, places, day-by-day,
season, twins, hotspot estimate). Two gzip-compressed files per r2 region:

  <out>/g/<r2>.bin.gz   cell-months   (cell_month_by_cell.parquet)
  <out>/y/<r2>.bin.gz   cell-days     (cell_day_by_cell.parquet)

Layout (little-endian, before gzip):
  "CAL2" | u32 header length | header JSON (utf-8) | zero padding to a multiple of 4 | columns, each n values
  g header = {"kind": "g", "months": [first, last], "cells": [r5 hex], "adm1": [code|null], "iso3": [code|null], "biome": [id|null], "n": rows,
              "cols": [[name, type], ...]}
  g columns: ci u16 (index into cells), k u16 (month index), h f32 (h_count), sr f32 (h_sd_rand), ss f32 (h_sd_sys),
             f f32 (factor, NaN = null), ff f32 (fill_frac), rm/rs/r20/r21 u32 (raw MODIS / S-NPP / NOAA-20 / NOAA-21),
             fl u8 (bit 0 provisional, bit 1 modis_outage)
  y header = {"kind": "y", "first_day": "2000-11-01", "cells": [...], "n": rows, "cols": [...]}
  y columns: ci u16, day u16 (days since first_day), h f32

Both product files are sorted by cell, and the H3 children of one r2 cell are contiguous in that order, so each file
streams once with bounded memory.   Usage:  python pipeline/build_region_tiles.py [out_dir=web/snap]
"""
from __future__ import annotations

import gzip
import json
import struct
import sys
from datetime import date
from pathlib import Path

import duckdb
import h3
import numpy as np
import polars as pl
import yaml

REPO = Path(__file__).resolve().parents[1]
FIRST_DAY = date(2000, 11, 1)


def month_index(first: str):
    y0, m0 = int(first[:4]), int(first[5:7])
    return lambda s: (int(s[:4]) - y0) * 12 + int(s[5:7]) - m0


def write(path: Path, header: dict, cols: list[tuple[str, np.ndarray]]) -> int:
    head = json.dumps({**header, "cols": [[n, a.dtype.str.lstrip("<|=")] for n, a in cols]}, separators=(",", ":")).encode("utf-8")
    pad = (-(8 + len(head))) % 4
    parts = [b"CAL2", struct.pack("<I", len(head)), head, b"\0" * pad]
    for _, a in cols:
        b = a.astype(a.dtype.newbyteorder("<"), copy=False).tobytes()
        parts.append(b + b"\0" * ((-len(b)) % 4))
    data = gzip.compress(b"".join(parts), compresslevel=9, mtime=0)
    path.write_bytes(data)
    return len(data)


def stream_groups(con: duckdb.DuckDBPyConnection, sql: str, cell_col: str):
    """Yields (r2 hex, arrow-converted polars frame) for each r2 region, in file order."""
    reader = con.sql(sql).to_arrow_reader(batch_size=1_000_000)
    parent_of: dict[int, str] = {}
    cur: str | None = None
    buf: list[pl.DataFrame] = []
    done: set[str] = set()
    for batch in reader:
        df = pl.from_arrow(batch)
        cells = df[cell_col].to_numpy()
        uniq = np.unique(cells)
        for c in uniq:
            if int(c) not in parent_of:
                parent_of[int(c)] = h3.cell_to_parent(h3.int_to_str(int(c)), 2)
        r2 = np.array([parent_of[int(c)] for c in cells], dtype=object)
        # split the batch where the region changes
        cuts = np.flatnonzero(r2[1:] != r2[:-1]) + 1
        starts = np.concatenate([[0], cuts]); ends = np.concatenate([cuts, [len(r2)]])
        for s, e in zip(starts, ends):
            reg = r2[s]
            if reg != cur:
                if cur is not None:
                    yield cur, pl.concat(buf)
                    done.add(cur)
                if reg in done:
                    raise SystemExit(f"r2 region {reg} seen twice: input not sorted by cell")
                cur, buf = reg, []
            buf.append(df.slice(int(s), int(e - s)))
        if len(parent_of) > 2_000_000:
            parent_of.clear()
    if cur is not None:
        yield cur, pl.concat(buf)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "web/snap"
    only = sys.argv[2:] if len(sys.argv) > 2 else ["g", "y"]
    cfg = yaml.safe_load((REPO / "config/ember.yaml").read_text(encoding="utf-8"))
    products = REPO / cfg["paths"]["products"]
    cm = (REPO / cfg["paths"]["api_cell_month"]).as_posix()
    cd = (products / "api/cell_day_by_cell.parquet").as_posix()
    adm = pl.read_parquet(products / "api/cells_r5.parquet").select("r5", "adm1_code", "iso3")
    adm1 = dict(zip(adm["r5"].to_list(), adm["adm1_code"].to_list()))
    iso3 = dict(zip(adm["r5"].to_list(), adm["iso3"].to_list()))

    con = duckdb.connect()
    con.execute("SET memory_limit='1500MB'; SET threads=2; SET preserve_insertion_order=true")

    if "g" in only:
        (out / "g").mkdir(parents=True, exist_ok=True)
        first, last = con.sql(f"SELECT min(month), max(month) FROM read_parquet('{cm}')").fetchall()[0]
        mi = month_index(first)
        n_files = total = 0
        sql = (f"SELECT h3_r5_u64 AS c, month, h_count, h_sd_rand, h_sd_sys, factor, fill_frac, biome_id, raw_modis_n, raw_snpp_n, "
               f"raw_noaa20_n, raw_noaa21_n, provisional, modis_outage FROM read_parquet('{cm}')")
        for r2, g in stream_groups(con, sql, "c"):
            cells, ci = np.unique(g["c"].to_numpy(), return_inverse=True)
            biome = g.group_by("c").agg(pl.col("biome_id").first()).sort("c")["biome_id"].to_list()
            k = np.array([mi(m) for m in g["month"].to_list()], dtype=np.uint16)
            f32 = lambda col: g[col].cast(pl.Float32).fill_null(float("nan")).to_numpy().astype(np.float32)  # noqa: E731
            u32 = lambda col: g[col].fill_null(0).cast(pl.UInt32).to_numpy().astype(np.uint32)  # noqa: E731
            fl = (g["provisional"].fill_null(False).cast(pl.UInt8).to_numpy() | (g["modis_outage"].fill_null(False).cast(pl.UInt8).to_numpy() << 1)).astype(np.uint8)
            total += write(out / "g" / f"{r2}.bin.gz",
                           {"kind": "g", "months": [first, last], "cells": [h3.int_to_str(int(c)) for c in cells],
                            "adm1": [adm1.get(int(c)) for c in cells], "iso3": [iso3.get(int(c)) for c in cells], "biome": biome, "n": g.height},
                           [("ci", ci.astype(np.uint16)), ("k", k), ("h", f32("h_count")), ("sr", f32("h_sd_rand")), ("ss", f32("h_sd_sys")),
                            ("f", f32("factor")), ("ff", f32("fill_frac")), ("rm", u32("raw_modis_n")), ("rs", u32("raw_snpp_n")),
                            ("r20", u32("raw_noaa20_n")), ("r21", u32("raw_noaa21_n")), ("fl", fl)])
            n_files += 1
        print(f"g: {n_files} regions, {total / 1e6:.0f} MB", flush=True)

    if "y" in only:
        (out / "y").mkdir(parents=True, exist_ok=True)
        n_files = total = 0
        sql = f"SELECT r5 AS c, (date - DATE '{FIRST_DAY.isoformat()}')::INTEGER AS day, h FROM read_parquet('{cd}') WHERE h > 0"
        for r2, g in stream_groups(con, sql, "c"):
            cells, ci = np.unique(g["c"].to_numpy(), return_inverse=True)
            total += write(out / "y" / f"{r2}.bin.gz",
                           {"kind": "y", "first_day": FIRST_DAY.isoformat(), "cells": [h3.int_to_str(int(c)) for c in cells], "n": g.height},
                           [("ci", ci.astype(np.uint16)), ("day", g["day"].to_numpy().astype(np.uint16)), ("h", g["h"].cast(pl.Float32).to_numpy().astype(np.float32))])
            n_files += 1
        print(f"y: {n_files} regions, {total / 1e6:.0f} MB", flush=True)


if __name__ == "__main__":
    main()
