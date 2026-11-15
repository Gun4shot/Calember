"""Detection-level export (CONTRACTS §6.1) with H1-derived MEH weights (CONTRACTS §3.2, D-018).

meh_weight: a detection of the month's *basis* sensor (Terra in T, MODIS in M, S-NPP or NOAA-20 in B/V/N) carries the cell-month
factor h_count / raw_basis_n, so the weights of a cell-month sum to its harmonized count. Detections of other sensors carry 0
(they are shown for completeness). Cell-months whose harmonized mass comes only from the no-detection (zero) model have no
detections to carry it. Cleaning matches the product: type 0, MODIS confidence >= 30, VIIRS n/h, static mask v1.
"""
from __future__ import annotations

import csv
import hashlib
import io
from datetime import date
from typing import Iterator

import numpy as np
import polars as pl

from .store import Store

COLS = ["det_id", "acq_datetime_utc", "date", "local_solar_hour", "lat", "lon", "instrument", "satellite", "source", "daynight",
        "confidence", "frp_mw", "bt_mir_k", "bt_tir_k", "scan_km", "track_km", "h3_r5", "regime", "meh_weight", "provisional"]
SAT = ("CASE satellite WHEN 'Terra' THEN 'TERRA' WHEN 'T' THEN 'TERRA' WHEN 'Aqua' THEN 'AQUA' WHEN 'A' THEN 'AQUA' "
       "WHEN 'N' THEN 'SNPP' WHEN 'N20' THEN 'NOAA20' WHEN '1' THEN 'NOAA20' WHEN 'N21' THEN 'NOAA21' ELSE satellite END")


def _sources(store: Store, start: date, end: date, sensors: set[str]) -> list[tuple[str, str, str, str]]:
    """(path glob, instrument, source label, VIIRS default satellite) for every file touching the date range."""
    raw = store.repo / store.cfg["paths"]["interim"] / "firms_raw"
    api = store.repo / store.cfg["paths"]["interim"] / "firms_api"
    out = []
    years = range(start.year, end.year + 1)
    for y in years:  # yearly archive files: MODIS, S-NPP, NOAA-20
        if y <= 2025:
            if "MODIS" in sensors:
                out.append(((raw / f"product=modis/year={y}").as_posix() + "/*.parquet", "MODIS", "SP", ""))
            if "VIIRS" in sensors:
                for prod, sat in (("viirs-snpp", "SNPP"), ("viirs-jpss1", "NOAA20")):
                    if (raw / f"product={prod}/year={y}").exists():
                        out.append(((raw / f"product={prod}/year={y}").as_posix() + "/*.parquet", "VIIRS", "SP", sat))
    if end.year >= 2023 and "VIIRS" in sensors:  # NOAA-21 (one file for all years; listed once)
        for k in ("SP", "NRT"):
            f = api / f"VIIRS_NOAA21_{k}.parquet"
            if f.exists():
                out.append((f.as_posix(), "VIIRS", k, "NOAA21"))
    if end.year >= 2026:
        for stem, inst, sat in (("MODIS", "MODIS", ""), ("VIIRS_SNPP", "VIIRS", "SNPP"), ("VIIRS_NOAA20", "VIIRS", "NOAA20")):
            if inst in sensors:
                for k in ("SP", "NRT"):
                    f = api / f"{stem}_{k}.parquet"
                    if f.exists():
                        out.append((f.as_posix(), inst, k, sat))
    return out


def stream_hotspots(store: Store, area: dict, start: date, end: date, sensors: set[str], factors: pl.DataFrame) -> Iterator[str]:
    """Yields CSV text chunks. `factors`: r5, month, regime, factor, provisional (from the product rows of the area)."""
    cells = area["_cells_int"]
    w, s, e, n = area["bbox"]
    pad = 0.6  # bbox prefilter only (cell centres); the r5 membership test below is exact
    buf = io.StringIO(); wr = csv.writer(buf, lineterminator="\n")
    wr.writerow(COLS); yield buf.getvalue(); buf.seek(0); buf.truncate()
    fac = {(r, m): (reg, f, p) for r, m, reg, f, p in factors.select("r5", "month", "regime", "factor", "provisional").iter_rows()}
    seen_sp: dict[str, str] = {}
    for path, inst, src, vsat in _sources(store, start, end, sensors):
        sat_expr = SAT if inst == "MODIS" else f"'{vsat}'"  # VIIRS files hold one satellite each
        conf = "try_cast(confidence AS INT) >= 30" if inst == "MODIS" else "confidence IN ('n','h')"
        bt = ("brightness", "bright_t31") if inst == "MODIS" else ("bright_ti4", "bright_ti5")
        q = f"""
          WITH d AS (
            SELECT {sat_expr} AS satellite, acq_date, lpad(CAST(acq_time AS VARCHAR), 4, '0') AS t, latitude AS lat, longitude AS lon,
                   daynight, CAST(confidence AS VARCHAR) AS confidence, frp, {bt[0]} AS bt_mir, {bt[1]} AS bt_tir, scan, track,
                   h3_latlng_to_cell(latitude, longitude, 5) AS r5, h3_latlng_to_cell(latitude, longitude, 7) AS r7
            FROM read_parquet('{path}', union_by_name=true)
            WHERE acq_date BETWEEN '{start.isoformat()}' AND '{end.isoformat()}' AND (type = 0 OR type IS NULL) AND {conf}
              AND latitude BETWEEN {s - pad} AND {n + pad} AND longitude BETWEEN {w - pad} AND {e + pad})
          SELECT d.* FROM d SEMI JOIN area_cells USING (r5) ANTI JOIN mask USING (r7) ORDER BY acq_date, t"""
        with store.lock:
            store.con.register("area_cells", pl.DataFrame({"r5": cells}, schema={"r5": pl.UInt64}).to_arrow())
            rows = pl.from_arrow(store.con.sql(q).to_arrow_table())
            store.con.unregister("area_cells")
        if rows.height == 0:
            continue
        # 2026: SP and NRT overlap -> keep NRT only after the last SP day of that sensor
        key = f"{inst}-{vsat}"
        if src == "SP" and path.endswith(".parquet") and "firms_api" in path:
            seen_sp[key] = str(rows["acq_date"].max())
        if src == "NRT" and key in seen_sp:
            rows = rows.filter(pl.col("acq_date") > seen_sp[key])
        for r in rows.iter_rows(named=True):
            month = r["acq_date"][:7]
            reg, f, prov = fac.get((r["r5"], month), (None, None, month >= "2026-08"))
            basis = _basis(store, reg, month)
            sat = r["satellite"]
            wgt = (f or 0.0) if (sat in basis) else 0.0
            hh, mm = int(r["t"][:2]), int(r["t"][2:])
            lsh = (hh + mm / 60 + r["lon"] / 15.0) % 24
            det_id = int.from_bytes(hashlib.blake2b(f"{sat}|{r['acq_date']}|{r['t']}|{r['lat']:.5f}|{r['lon']:.5f}".encode(), digest_size=8).digest(), "big")
            wr.writerow([det_id, f"{r['acq_date']}T{hh:02d}:{mm:02d}:00Z", r["acq_date"], round(lsh, 2), round(r["lat"], 5), round(r["lon"], 5),
                         inst, sat, src, r["daynight"], r["confidence"], _f32(r["frp"]), _f32(r["bt_mir"]), _f32(r["bt_tir"]), _f32(r["scan"]), _f32(r["track"]),
                         format(int(r["r5"]), "x"), reg or "", round(wgt, 4), str(bool(prov)).lower()])
        yield buf.getvalue(); buf.seek(0); buf.truncate()


def _f32(v) -> str:
    """A float32 field as its shortest decimal (12.3, not 12.300000190734863)."""
    return "" if v is None else str(np.float32(v))


def _basis(store: Store, regime: str | None, month: str) -> set[str]:
    if regime == "T":
        return {"TERRA"}
    if regime == "M":
        return {"TERRA", "AQUA"}
    if regime in ("B", "V", "N"):
        return {"NOAA20"} if store.refsrc.get(month) == "NOAA20" else {"SNPP"}
    return set()


def estimate_rows(store: Store, area: dict, start: date, end: date) -> float:
    """Rough upper bound of rows: (raw MODIS + all VIIRS) in the area over the date range, from the product."""
    rows = store.area_rows(area["_cells_int"], start.isoformat()[:7], end.isoformat()[:7])
    if rows.height == 0:
        return 0.0
    return float(rows.select((pl.col("raw_modis_n") + pl.col("raw_snpp_n") + pl.col("raw_noaa20_n") + pl.col("raw_noaa21_n")).sum()).item())
