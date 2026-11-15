"""Calember API (CONTRACTS §5). Run: uvicorn ember_api.main:app --app-dir api --port 8000"""
from __future__ import annotations

import csv
import io
import json
import random
import zipfile
from datetime import date, datetime, timedelta, timezone

import numpy as np
import polars as pl
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from .store import get_store  # sets the import path for ember_science  # isort: skip
from ember_science import (MONTH_NAMES, CATEGORY_RULE, anomalies, area_monthly, calendar_summary, climatology,  # noqa: E402
                           season_metrics, season_summary, to_meh_nrt, year_totals)

from .areas import AreaError, get_area, public, resolve
from .hotspots import estimate_rows, stream_hotspots

app = FastAPI(title="Calember API", version="0.9.1", description="Harmonized MODIS-equivalent fire hotspot record, 2000 to now.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def _warm_rankings() -> None:
    """Compute the country rankings in the background so the first visitor does not wait (~4 s)."""
    import threading
    threading.Thread(target=lambda: _country_series(), daemon=True).start()


def err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


@app.exception_handler(AreaError)
async def _area_error(_: Request, e: AreaError):
    return err(e.code, e.message, e.status)


@app.exception_handler(Exception)
async def _internal(_: Request, e: Exception):
    return err("internal", f"Something went wrong on our side ({type(e).__name__}).", 500)


def _months(start: str, end: str) -> list[str]:
    y, m = int(start[:4]), int(start[5:7]); out = []
    while f"{y:04d}-{m:02d}" <= end:
        out.append(f"{y:04d}-{m:02d}"); m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def _r(v, nd=3):
    return None if v is None else round(float(v), nd)


# ---------------- health ----------------
@app.get("/api/health")
def health():
    s = get_store()
    return {"status": "ok", "data_version": s.meta.get("created"), "latest_month": s.cfg["product"]["latest_complete_month"],
            "month_to_date": s.cfg["product"]["month_to_date"], "coverage_tiers": ["A", "B", "C"], "model": "H1",
            "model_name": s.cfg["product"]["model"], "product_version": s.cfg["product"]["version"]}


# ---------------- areas ----------------
class AreaRequest(BaseModel):
    geometry: dict | None = None
    circle: dict | None = None
    admin_id: str | None = None
    h3_cells: list[str] | None = None


@app.post("/api/areas", status_code=201)
def post_area(req: AreaRequest):
    return resolve(get_store(), req.model_dump())


@app.get("/api/areas/{area_id}")
def area(area_id: str):
    return public(get_area(area_id))


def _calendar_data(area_id: str, start: str, end: str, baseline: str):
    s = get_store(); a = get_area(area_id)
    try:
        b0, b1 = (int(x) for x in baseline.split("-"))
    except ValueError as e:
        raise AreaError("invalid_geometry", "baseline must look like 2003-2025.") from e
    first = "2000-11"; last = s.cfg["product"]["month_to_date"]
    start = max(start, first); end = min(end, last)
    months = _months(start, end)
    unit = a.get("_unit")

    def monthly_for(ms: list[str]) -> pl.DataFrame:
        if unit:  # country / biome / world: precomputed totals
            return s.unit_monthly(unit, ms)
        rows = s.area_rows(a["_cells_int"], ms[0], ms[-1])
        return area_monthly(rows if rows.height else _empty(), months=ms)

    rows = pl.DataFrame() if unit else s.area_rows(a["_cells_int"], start, end)
    monthly = monthly_for(months)
    full = monthly
    if (start > f"{b0}-01" or end < f"{b1}-12"):  # anomalies need the whole baseline even when the view is narrower
        base_m = monthly_for(_months(f"{b0}-01", f"{b1}-12"))
        full = pl.concat([base_m.select(monthly.columns), monthly]).unique("month", keep="last").sort("month")
    an = anomalies(full, (b0, b1), s.cfg["anomaly"]["pct_bounds"]).filter(pl.col("month").is_in(months))
    clim = climatology(full, (b0, b1))
    yt = year_totals(monthly, s.cfg["product"]["latest_complete_month"])
    return a, rows, an, clim, yt, (b0, b1)


def _empty() -> pl.DataFrame:
    return pl.DataFrame(schema={"h3_r5_u64": pl.UInt64, "month": pl.String, "regime": pl.String, "h_count": pl.Float32, "h_sd_rand": pl.Float32,
                                "h_sd_sys": pl.Float32, "biome_id": pl.Int8, "raw_modis_n": pl.UInt32, "raw_snpp_n": pl.UInt32,
                                "raw_noaa20_n": pl.UInt32, "raw_noaa21_n": pl.UInt32, "raw_basis_n": pl.UInt32, "factor": pl.Float32,
                                "provisional": pl.Boolean, "modis_outage": pl.Boolean, "fill_frac": pl.Float32})


@app.get("/api/areas/{area_id}/calendar")
def calendar(area_id: str, start: str = "2000-11", end: str = "2026-10", baseline: str = "2003-2025"):
    a, _, an, clim, yt, (b0, b1) = _calendar_data(area_id, start, end, baseline)
    months = []
    for r in an.iter_rows(named=True):
        months.append({"month": r["month"], "regime": r["regime"], "h_count": _r(r["h_count"]), "lo90": _r(r["lo90"]), "hi90": _r(r["hi90"]),
                       "raw": {"modis": int(r["raw_modis_n"]), "snpp": int(r["raw_snpp_n"]), "noaa20": int(r["raw_noaa20_n"]), "noaa21": int(r["raw_noaa21_n"])},
                       "median_m": _r(r["median_m"]), "ratio_to_median": _r(r["ratio_to_median"]), "pct_rank": _r(r["pct_rank"], 1),
                       "robust_z": _r(r["robust_z"]), "category": r["category"], "provisional": bool(r["provisional"]),
                       "modis_outage": bool(r.get("modis_outage") or False), "fill_frac": _r(r.get("fill_frac") or 0.0, 4)})
    years = [{"year": int(r["year"]), "total": _r(r["total"]), "lo90": _r(r["lo90"]), "hi90": _r(r["hi90"]), "rank": r["rank"],
              "n_years": int(r["n_years"]), "complete": bool(r["complete"])} for r in yt.iter_rows(named=True)]
    climo = [{k: (_r(v) if isinstance(v, float) else v) for k, v in r.items()} for r in clim.iter_rows(named=True)]
    return {"area_id": area_id, "unit": "MEH", "baseline": [b0, b1], "months": months, "years": years, "climatology": climo,
            "summary": calendar_summary(clim, yt, an)}


# ---------------- exports ----------------
CAL_COLS = ["year", "month", "month_num", "regime", "h_count", "lo90", "hi90", "raw_modis", "raw_snpp", "raw_noaa20", "raw_noaa21",
            "median_m", "ratio_to_median", "pct_rank", "robust_z", "category", "provisional"]


def _calendar_csv(area_id: str, start: str, end: str, baseline: str) -> str:
    _, _, an, _, _, _ = _calendar_data(area_id, start, end, baseline)
    buf = io.StringIO(); w = csv.writer(buf, lineterminator="\n"); w.writerow(CAL_COLS)
    f = lambda v, nd=3: "" if v is None else round(float(v), nd)
    for r in an.iter_rows(named=True):
        w.writerow([r["month"][:4], r["month"], int(r["month"][5:]), r["regime"], f(r["h_count"]), f(r["lo90"]), f(r["hi90"]), r["raw_modis_n"],
                    r["raw_snpp_n"], r["raw_noaa20_n"], r["raw_noaa21_n"], f(r["median_m"]), f(r["ratio_to_median"]), f(r["pct_rank"], 1),
                    f(r["robust_z"]), r["category"] or "", str(bool(r["provisional"])).lower()])
    return buf.getvalue()


def _attach(name: str) -> dict:
    return {"Content-Disposition": f'attachment; filename="{name}"'}


@app.get("/api/areas/{area_id}/export/calendar.csv")
def export_calendar(area_id: str, start: str = "2000-11", end: str = "2026-10", baseline: str = "2003-2025"):
    return Response(_calendar_csv(area_id, start, end, baseline), media_type="text/csv", headers=_attach(f"ember_calendar_{area_id}.csv"))


def _hotspot_args(area_id: str, start: str | None, end: str | None, sensors: str):
    s = get_store(); a = get_area(area_id)
    if not a["_cells_int"]:
        raise AreaError("area_too_large", "Hotspot downloads are available for provinces, drawn areas and smaller countries. "
                        "For this area, download the calendar instead.")
    last = date(2026, 11, 12)
    try:
        d1 = date.fromisoformat(end) if end else last
        d0 = date.fromisoformat(start) if start else d1 - timedelta(days=364)
    except ValueError as e:
        raise AreaError("invalid_geometry", "start and end must be dates like 2024-03-01.") from e
    if d0 > d1:
        raise AreaError("invalid_geometry", "start must be before end.")
    sens = {x.strip().upper() for x in sensors.split(",") if x.strip()} & {"MODIS", "VIIRS"} or {"MODIS", "VIIRS"}
    est = estimate_rows(s, a, d0, d1)
    if est > int(s.cfg["api"]["max_csv_rows"]):
        raise AreaError("area_too_large", f"About {est:,.0f} hotspots match; the limit is {s.cfg['api']['max_csv_rows']:,}. Please narrow the dates.")
    fac = s.area_rows(a["_cells_int"], d0.isoformat()[:7], d1.isoformat()[:7])
    fac = fac.select(pl.col("h3_r5_u64").alias("r5"), "month", "regime", "factor", "provisional") if fac.height else \
        pl.DataFrame(schema={"r5": pl.UInt64, "month": pl.String, "regime": pl.String, "factor": pl.Float32, "provisional": pl.Boolean})
    return s, a, d0, d1, sens, fac


@app.get("/api/areas/{area_id}/export/hotspots.csv")
def export_hotspots(area_id: str, start: str | None = None, end: str | None = None, sensors: str = "MODIS,VIIRS"):
    s, a, d0, d1, sens, fac = _hotspot_args(area_id, start, end, sensors)
    return StreamingResponse(stream_hotspots(s, a, d0, d1, sens, fac), media_type="text/csv",
                             headers=_attach(f"ember_hotspots_{area_id}_{d0}_{d1}.csv"))


README = """Calember: harmonized fire hotspot record (MODIS-equivalent)
=========================================================

Unit: MEH = "hotspots (MODIS-equivalent)": the number of active-fire detections that NASA FIRMS MODIS Collection 6.1
(Terra + Aqua, confidence >= 30, type 0, persistent industrial hotspots masked) would have reported at its pre-drift
overpass times, with complete data on every day.

Record regimes (column `regime`):
  T  2000-11 to 2002-06  Terra only, scaled to Terra + Aqua
  M  2002-07 to 2011-12  MODIS Terra + Aqua as observed (satellite data gaps filled)
  B  2012-01 to 2019-12  MODIS blended with the VIIRS-based Bridge model
  V  2020-01 to 2026-07  VIIRS-based Bridge model (S-NPP; NOAA-20 in S-NPP data-loss months)
  N  2026-08 onward      NOAA-20 near-real-time input; provisional (2026-11 is month-to-date)

Files:
  calendar.csv  monthly harmonized counts with 90 % intervals, raw sensor counts and anomalies vs the baseline median
  hotspots.csv  cleaned detections in the area for the requested dates; meh_weight = each detection's share of the
                harmonized count (basis-sensor detections carry the cell-month factor; other sensors carry 0)
  season.csv    per fire year: onset, peak and end dates (10 %, peak, 90 % of the year's hotspots), length, total
  metadata.json request, area, data version, model

Validation: held-out regions and years (KGE 0.991 at province/country/biome scale on 2018-2019; sealed 2020 test 0.968,
0.989 when the 2020 Aqua data outage is excluded). Full report: static/validation_report.json on the website.

Credits: NASA FIRMS (MODIS C6.1 MCD14ML, VIIRS 375 m VNP14IMGML / VJ114IMGML / VJ214IMGML), Natural Earth (boundaries),
RESOLVE Ecoregions 2017 (CC-BY 4.0). We acknowledge the use of data and imagery from LANCE FIRMS operated by NASA's
Earth Science Data and Information System (ESDIS).
Cite as: Calember harmonized fire record, NASA Space Apps 2026, team Calember.
"""


@app.get("/api/areas/{area_id}/export/bundle.zip")
def export_bundle(area_id: str, start: str | None = None, end: str | None = None, baseline: str = "2003-2025"):
    s, a, d0, d1, sens, fac = _hotspot_args(area_id, start, end, "MODIS,VIIRS")
    mem = io.BytesIO()
    with zipfile.ZipFile(mem, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("calendar.csv", _calendar_csv(area_id, "2000-11", "2026-10", baseline))
        z.writestr("hotspots.csv", "".join(stream_hotspots(s, a, d0, d1, sens, fac)))
        z.writestr("season.csv", _season_csv(area_id))
        z.writestr("README.txt", README)
        z.writestr("metadata.json", json.dumps({"request": {"area_id": area_id, "hotspots_start": str(d0), "hotspots_end": str(d1), "baseline": baseline},
                                                "area": public(a), "data_version": s.meta.get("created"), "product_version": s.cfg["product"]["version"],
                                                "model": s.cfg["product"]["model"], "config_hash": s.meta.get("config_hash"),
                                                "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}, indent=1))
    return Response(mem.getvalue(), media_type="application/zip", headers=_attach(f"ember_{area_id}.zip"))


# ---------------- season (F15) ----------------
_season_cache: dict[str, dict] = {}
LAST_DAY = date(2026, 11, 12)  # last day in the stored record (month-to-date)


def _season(area_id: str) -> dict:
    if area_id in _season_cache:
        return _season_cache[area_id]
    s = get_store(); a = get_area(area_id)
    d = s.area_daily(a["_cells_int"], a.get("_unit"))
    full = pl.DataFrame({"date": pl.date_range(date(2000, 11, 1), LAST_DAY, "1d", eager=True)}).join(d, on="date", how="left") \
        .with_columns(h_count=pl.col("h").fill_null(0.0)).select("date", "h_count")
    yrs, trends = season_metrics(full, s.cfg["season"])
    from ember_science.twins import is_bimodal, two_peaks
    clim = full.filter(pl.col("date").dt.year().is_between(*s.cfg["baseline_years"])).group_by(pl.col("date").dt.month().alias("m"))         .agg(pl.col("h_count").sum()).sort("m")["h_count"].to_numpy()
    two = None
    if clim.sum() > 0 and len(clim) == 12:
        shp = clim / clim.sum()
        if is_bimodal(shp):
            two = two_peaks(shp)
    rows = yrs.with_columns(pl.col("total").round(3)).to_dicts() if yrs.height else []
    tr = {k: trends.get(k) for k in ("onset", "peak", "end", "length", "total")}
    for v in tr.values():
        if v:
            for kk in ("sen_days_per_decade", "sen_pct_per_decade", "p"):
                if v.get(kk) is not None:
                    v[kk] = round(float(v[kk]), 3)
    out = {"area_id": area_id, "years": rows, "fire_year_start_month": trends.get("fire_year_start_month"), "trends": tr,
           "two_seasons": list(two) if two else None,
           "summary": season_summary(yrs, trends, two) if yrs.height else "No fire seasons to measure here."}
    _season_cache[area_id] = out
    return out


@app.get("/api/areas/{area_id}/season")
def season(area_id: str):
    return _season(area_id)


@app.get("/api/areas/{area_id}/cells")
def cells(area_id: str, first_year: int = 2001, last_year: int = 2025):
    """Additive (APP_V2_PLAN §13): harmonized values per r5 cell inside the area, for the 3D terrain view.
    Columns: cells (hex), lat, lon, mean_annual (MEH/yr over first..last year), peak_month (1-12, null when no fire),
    recent12 (last 12 complete months), years + by_year (per-year totals; only for areas up to 4,000 cells)."""
    import h3
    s = get_store(); a = get_area(area_id)
    cells_int = a.get("_cells_int") or []
    if not cells_int:
        raise AreaError("area_too_large", "This area is too large for a per-cell view; pick a province or draw a smaller area.")
    latest = s.cfg["product"]["latest_complete_month"]
    rows = s.area_rows(cells_int, f"{first_year}-01", latest)
    if rows.height == 0:
        rows = _empty()
    rows = rows.select("h3_r5_u64", "month", "h_count").with_columns(
        pl.col("month").str.slice(0, 4).cast(pl.Int32).alias("year"), pl.col("month").str.slice(5, 2).cast(pl.Int32).alias("mnum"))
    n_years = last_year - first_year + 1
    base = rows.filter(pl.col("year").is_between(first_year, last_year))
    tot = base.group_by("h3_r5_u64").agg(pl.col("h_count").sum().alias("t"))
    by_m = base.group_by("h3_r5_u64", "mnum").agg(pl.col("h_count").sum().alias("v")).sort("v", descending=True).unique("h3_r5_u64", keep="first")
    y, m = int(latest[:4]), int(latest[5:7])
    m0 = f"{y - 1:04d}-{m + 1:02d}" if m < 12 else f"{y:04d}-01"
    rec = rows.filter(pl.col("month").is_between(pl.lit(m0), pl.lit(latest))).group_by("h3_r5_u64").agg(pl.col("h_count").sum().alias("r"))
    tmap = dict(zip(tot["h3_r5_u64"].to_list(), tot["t"].to_list()))
    pmap = dict(zip(by_m["h3_r5_u64"].to_list(), by_m["mnum"].to_list()))
    rmap = dict(zip(rec["h3_r5_u64"].to_list(), rec["r"].to_list()))
    out_cells, lat, lon, mean_annual, peak, recent = [], [], [], [], [], []
    for ci in cells_int:
        hx = h3.int_to_str(int(ci)); la, lo = h3.cell_to_latlng(hx)
        out_cells.append(hx); lat.append(round(la, 4)); lon.append(round(lo, 4))
        t = float(tmap.get(ci, 0.0)); mean_annual.append(round(t / n_years, 3))
        peak.append(int(pmap[ci]) if t > 0 and ci in pmap else None); recent.append(round(float(rmap.get(ci, 0.0)), 3))
    body = {"area_id": area_id, "unit": "MEH", "first_year": first_year, "last_year": last_year, "latest_month": latest,
            "cells": out_cells, "lat": lat, "lon": lon, "mean_annual": mean_annual, "peak_month": peak, "recent12": recent}
    if len(cells_int) <= 4000:
        yrs = list(range(first_year, int(latest[:4]) + 1))
        piv = rows.group_by("h3_r5_u64", "year").agg(pl.col("h_count").sum().alias("v"))
        vmap = {(int(c_), int(y_)): float(v) for c_, y_, v in piv.iter_rows()}
        body["years"] = yrs
        body["by_year"] = [[round(vmap.get((ci, yy), 0.0), 2) for yy in yrs] for ci in cells_int]
    amap = _cell_places().select("r5", "adm1_code")
    amap = dict(zip(amap["r5"].to_list(), amap["adm1_code"].to_list()))
    body["adm1"] = [amap.get(int(ci)) for ci in cells_int]  # additive: province of each cell (links the terrain to /places)
    return body


@app.get("/api/areas/{area_id}/cells_month")
def cells_month(area_id: str, month: str, baseline: str = "2003-2025"):
    """Additive: one month per r5 cell, in the same cell order as /cells, for the Terrain station's "timeline month"
    mode. `values` = harmonized hotspots (MEH) of `month` in each cell; `typical` = that cell's mean for the same calendar
    month over the baseline years (the month's own year excluded), so the UI can show a cell against its own normal."""
    s = get_store(); a = get_area(area_id)
    cells_int = a.get("_cells_int") or []
    if not cells_int:
        raise AreaError("area_too_large", "This area is too large for a per-cell view; pick a province or draw a smaller area.")
    try:
        y, mm = int(month[:4]), int(month[5:7])
        b0, b1 = (int(x) for x in baseline.split("-"))
        assert 1 <= mm <= 12
    except (ValueError, AssertionError) as e:
        raise AreaError("invalid_geometry", "month must look like 2026-10 and baseline like 2003-2025.") from e
    rows = s.area_rows(cells_int, f"{min(b0, y):04d}-01", f"{max(b1, y):04d}-12")
    if rows.height == 0:
        rows = _empty()
    rows = rows.select("h3_r5_u64", "month", "h_count")
    cur = rows.filter(pl.col("month") == f"{y:04d}-{mm:02d}")
    vmap = dict(zip(cur["h3_r5_u64"].to_list(), cur["h_count"].to_list()))
    yrs = [yy for yy in range(b0, b1 + 1) if yy != y]
    base = rows.filter(pl.col("month").is_in([f"{yy:04d}-{mm:02d}" for yy in yrs]))
    tsum = base.group_by("h3_r5_u64").agg(pl.col("h_count").sum().alias("t"))
    tmap = dict(zip(tsum["h3_r5_u64"].to_list(), tsum["t"].to_list()))
    n = max(1, len(yrs))
    return {"area_id": area_id, "unit": "MEH", "month": f"{y:04d}-{mm:02d}", "baseline": [b0, b1],
            "values": [round(float(vmap.get(ci, 0.0)), 3) for ci in cells_int],
            "typical": [round(float(tmap.get(ci, 0.0)) / n, 3) for ci in cells_int]}


# ---------------- daily: the days of one month against the typical day (additive) ----------------
@app.get("/api/areas/{area_id}/daily")
def daily(area_id: str, month: str, baseline: str = "2003-2025"):
    """Every day of `month` (harmonized daily counts, D-020) with the typical value of the same day of the month in the
    baseline years (median, p25, p75; the month's own year excluded), plus the cumulative month against its typical
    cumulative curve. Daily values carry about 98.8 % of the monthly totals (the rest has no day)."""
    import calendar as _cal
    s = get_store(); a = get_area(area_id)
    try:
        y, mm = int(month[:4]), int(month[5:7])
        b0, b1 = (int(x) for x in baseline.split("-"))
    except ValueError as e:
        raise AreaError("invalid_geometry", "month must look like 2026-10 and baseline like 2003-2025.") from e
    n = _cal.monthrange(y, mm)[1]
    d = s.area_daily(a.get("_cells_int") or [], a.get("_unit"), f"{min(b0, y)}-01-01", f"{max(b1, y)}-12-31")
    data_end = LAST_DAY.isoformat()  # the record is complete through this day everywhere (days without fire are 0)
    d = d.with_columns(pl.col("date").dt.year().alias("y"), pl.col("date").dt.month().alias("m"), pl.col("date").dt.day().alias("d")).filter(pl.col("m") == mm)
    cur = {int(r["d"]): float(r["h"]) for r in d.filter(pl.col("y") == y).iter_rows(named=True)}
    years = [yy for yy in range(b0, b1 + 1) if yy != y]
    grid = np.zeros((len(years), n))
    for r in d.filter(pl.col("y").is_in(years)).iter_rows(named=True):
        if r["d"] <= n:
            grid[years.index(int(r["y"])), int(r["d"]) - 1] = float(r["h"])
    cum = np.cumsum(grid, axis=1)
    days = []
    run = 0.0
    for k in range(n):
        h = cur.get(k + 1)
        run += h or 0.0
        date = f"{y:04d}-{mm:02d}-{k + 1:02d}"
        days.append({"day": k + 1, "date": date, "h": None if date > data_end else _r(h or 0.0, 2),
                     "typical": _r(float(np.median(grid[:, k])), 2), "p25": _r(float(np.percentile(grid[:, k], 25)), 2), "p75": _r(float(np.percentile(grid[:, k], 75)), 2),
                     "cum": _r(run, 1), "cum_typical": _r(float(np.median(cum[:, k])), 1), "cum_p25": _r(float(np.percentile(cum[:, k], 25)), 1), "cum_p75": _r(float(np.percentile(cum[:, k], 75)), 1)})
    return {"area_id": area_id, "month": month, "baseline": [b0, b1], "unit": "MEH", "days": days, "data_through": data_end,
            "note": "Harmonized daily counts: each day's detections of the month's reference sensor × the cell-month harmonization factor."}


# ---------------- places: where in the area it burns (additive, APP_V2_PLAN) ----------------
_places_cache: dict[str, pl.DataFrame] = {}


def _cell_places() -> pl.DataFrame:
    """Per r5 cell: record total (2000-11 → latest), centre, province and country (pipeline/build_static.py)."""
    if "cells" not in _places_cache:
        s = get_store()
        _places_cache["cells"] = pl.read_parquet(s.products / "api/cells_r5.parquet").select(
            "r5", "tot", "lat", "lon", "biome_id", "adm1_code", "adm1_name", "iso3", "country_name")
    return _places_cache["cells"]


_COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]


@app.get("/api/areas/{area_id}/places")
def places(area_id: str, k: int = 6):
    """The provinces (or, for the world and biomes, the countries) holding most of the area's fire over the whole record,
    and the single hottest grid cell with where it sits in the area. Shares are of the record total (2000-11 → latest)."""
    a = get_area(area_id); lk = _cell_places()
    unit = a.get("_unit")
    if unit == "WORLD":
        sub, key, name, level = lk, "iso3", "country_name", "country"
    elif unit and unit.startswith("ISO-"):
        sub, key, name, level = lk.filter(pl.col("iso3") == unit[4:]), "adm1_code", "adm1_name", "province"
    elif unit and unit.startswith("BIOME-"):
        sub, key, name, level = lk.filter(pl.col("biome_id") == int(unit[6:])), "iso3", "country_name", "country"
    else:
        cells_int = a.get("_cells_int") or []
        sub = lk.filter(pl.col("r5").is_in(cells_int))
        key, name, level = "adm1_code", "adm1_name", "province"
    sub = sub.filter(pl.col("tot") > 0)
    total = float(sub["tot"].sum()) if sub.height else 0.0
    latest = get_store().cfg["product"]["latest_complete_month"]
    years = (int(latest[:4]) - 2000) + (int(latest[5:7]) + 2) / 12  # 2000-11 → latest
    out: dict = {"area_id": area_id, "level": level, "period": f"2000-11 – {latest}", "total": round(total, 1), "places": [], "hottest": None, "n_places": 0}
    if total <= 0:
        return out
    g = (sub.filter(pl.col(key).is_not_null()).group_by(key)
         .agg(pl.col(name).first().alias("name"), pl.col("country_name").first().alias("country"), pl.col("tot").sum().alias("tot"), pl.len().alias("cells"))
         .sort("tot", descending=True))
    out["n_places"] = g.height
    out["places"] = [{"code": r[key], "name": r["name"] or r["country"], "country": r["country"], "share": round(r["tot"] / total, 4),
                      "mean_annual": round(r["tot"] / years, 1), "cells": int(r["cells"])} for r in g.head(k).iter_rows(named=True)]
    h = sub.sort("tot", descending=True).row(0, named=True)
    cx, cy = a.get("centroid") or [h["lon"], h["lat"]]
    dx = (h["lon"] - cx) * np.cos(np.radians(cy)); dy = h["lat"] - cy
    far = (dx * dx + dy * dy) ** 0.5
    where = "near the centre" if far < 0.15 * max(1e-6, (a["bbox"][2] - a["bbox"][0] + a["bbox"][3] - a["bbox"][1]) / 2) else \
        f"in the {_COMPASS[int(((np.degrees(np.arctan2(dx, dy)) + 360 + 22.5) % 360) // 45)]}"
    mean_cell = total / max(1, sub.height)
    out["hottest"] = {"lat": round(h["lat"], 3), "lon": round(h["lon"], 3), "province": h["adm1_name"], "country": h["country_name"],
                      "share": round(h["tot"] / total, 4), "times_average": round(h["tot"] / mean_cell, 1), "mean_annual": round(h["tot"] / years, 1),
                      "where": where}
    return out


# ---------------- rankings: every country this month vs its normal, and all time (additive) ----------------
_rank_cache: dict[str, pl.DataFrame] = {}


def _country_series() -> pl.DataFrame:
    """Monthly anomalies (Guideline §4.7, same rules as /calendar) for every country, computed once."""
    if "all" in _rank_cache:
        return _rank_cache["all"]
    s = get_store()
    units = s.agg_units.filter(pl.col("kind") == "country")
    months = _months("2000-11", s.cfg["product"]["month_to_date"])
    b = tuple(s.cfg["baseline_years"]) if "baseline_years" in s.cfg else (2003, 2025)
    frames = []
    for r in units.iter_rows(named=True):
        m = s.unit_monthly(r["unit"], months)
        an = anomalies(m, (int(b[0]), int(b[1])), s.cfg["anomaly"]["pct_bounds"])
        frames.append(an.select("month", "h_count", "median_m", "ratio_to_median", "pct_rank", "category", "provisional")
                      .with_columns(pl.lit(r["unit"]).alias("unit"), pl.lit(r["name"]).alias("name"), pl.lit(float(r["area_km2"])).alias("area_km2")))
    _rank_cache["all"] = pl.concat(frames)
    return _rank_cache["all"]


@app.get("/api/rankings")
def rankings(month: str | None = None):
    """Every country for one month: hotspots, the same month's 2003–2025 median, percentile and category (as in /calendar),
    plus all-time figures (mean per year 2001–2025, busiest month on record)."""
    s = get_store()
    allc = _country_series()
    month = month or s.cfg["product"]["latest_complete_month"]
    cur = allc.filter(pl.col("month") == month)
    full = allc.filter(pl.col("month").str.slice(0, 4).cast(pl.Int32).is_between(2001, 2025))
    life = full.group_by("unit").agg((pl.col("h_count").sum() / 25).alias("mean_annual"))
    rec = allc.sort("h_count", descending=True).unique("unit", keep="first").select("unit", pl.col("month").alias("record_month"), pl.col("h_count").alias("record_value"))
    t = cur.join(life, on="unit", how="left").join(rec, on="unit", how="left").sort("h_count", descending=True)
    rows = []
    for r in t.iter_rows(named=True):
        if (r["mean_annual"] or 0) < 1 and r["h_count"] < 1:
            continue
        rows.append({"admin_id": r["unit"], "name": r["name"], "area_km2": round(r["area_km2"]), "h_count": _r(r["h_count"], 1),
                     "median_m": _r(r["median_m"], 1), "ratio_to_median": _r(r["ratio_to_median"]), "pct_rank": _r(r["pct_rank"], 1),
                     "category": r["category"], "provisional": bool(r["provisional"]), "mean_annual": _r(r["mean_annual"], 1),
                     "per_1000km2_yr": _r(1000 * (r["mean_annual"] or 0) / max(1.0, r["area_km2"]), 3),
                     "record_month": r["record_month"], "record_value": _r(r["record_value"], 1)})
    return {"month": month, "baseline": [2003, 2025], "latest_month": s.cfg["product"]["latest_complete_month"],
            "month_to_date": s.cfg["product"]["month_to_date"], "countries": rows}


SEASON_COLS = ["fire_year", "start_date", "onset", "peak", "end", "onset_doy", "peak_doy", "end_doy", "length_days", "total", "insufficient"]


def _season_csv(area_id: str) -> str:
    buf = io.StringIO(); w = csv.writer(buf, lineterminator="\n"); w.writerow(SEASON_COLS)
    for r in _season(area_id)["years"]:
        w.writerow(["" if r.get(c) is None else (str(r[c]).lower() if isinstance(r[c], bool) else r[c]) for c in SEASON_COLS])
    return buf.getvalue()


@app.get("/api/areas/{area_id}/export/season.csv")
def export_season(area_id: str):
    return Response(_season_csv(area_id), media_type="text/csv", headers=_attach(f"ember_season_{area_id}.csv"))


# ---------------- tactile STL (F22) ----------------
def _stl_calendar(values: dict[tuple[int, int], float], years: list[int], title: str) -> bytes:
    """Binary STL: a base plate plus one bar per month (columns = months, rows = years, newest year at the front).
    Bar height (mm) = 2 + 28 * log1p(v) / log1p(max). Cell 6 mm, gap 1 mm, base 3 mm. Printable without supports."""
    import struct
    cell, gap, base = 6.0, 1.0, 3.0
    vmax = max([v for v in values.values()] + [1.0])
    tris: list[tuple] = []

    def box(x0, y0, z0, x1, y1, z1):
        v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        for a, b, c in ((0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)):
            tris.append((v[a], v[b], v[c]))
    W = 12 * (cell + gap) + gap; D = len(years) * (cell + gap) + gap
    box(0, 0, 0, W, D, base)
    for ri, y in enumerate(sorted(years, reverse=True)):
        for k in range(12):
            v = values.get((y, k + 1), 0.0)
            hgt = 2.0 + 28.0 * float(np.log1p(v) / np.log1p(vmax)) if v > 0 else 0.6
            x0 = gap + k * (cell + gap); y0 = gap + ri * (cell + gap)
            box(x0, y0, base, x0 + cell, y0 + cell, base + hgt)
    head = (f"Calember fire calendar: {title}"[:79]).encode("ascii", "replace").ljust(80, b" ")
    out = bytearray(head); out += struct.pack("<I", len(tris))
    for a, b, c in tris:
        n = np.cross(np.subtract(b, a), np.subtract(c, a)); ln = float(np.linalg.norm(n)) or 1.0
        out += struct.pack("<12fH", *(n / ln), *a, *b, *c, 0)
    return bytes(out)


@app.get("/api/areas/{area_id}/export/calendar.stl")
def export_stl(area_id: str):
    a = get_area(area_id)
    _, _, an, _, _, _ = _calendar_data(area_id, "2001-01", "2025-12", "2003-2025")
    vals = {(int(m[:4]), int(m[5:])): float(h) for m, h in an.select("month", "h_count").iter_rows()}
    years = sorted({y for y, _ in vals})
    return Response(_stl_calendar(vals, years, a["name"]), media_type="model/stl", headers=_attach(f"ember_calendar_{area_id}.stl"))


# ---------------- fire twins (F20) ----------------
_twins: dict = {}


def _twins_index():
    if not _twins:
        s = get_store()
        f = s.products / "twins_index.parquet"
        if not f.exists():
            return None
        idx = pl.read_parquet(f)
        X = np.array(idx["features"].to_list(), dtype=np.float64)
        S = np.array(idx["shape12"].to_list(), dtype=np.float64)
        sc = json.loads((s.products / "twins_scaler.json").read_text(encoding="utf-8"))
        reg = {r["regime_id"]: r for r in json.loads((s.products / "regimes.json").read_text(encoding="utf-8"))}
        cent = {rid: X[(idx["regime_id"] == rid).to_numpy()].mean(axis=0) for rid in reg}
        _twins.update(idx=idx, X=X, S=S, sc=sc, reg=reg, cent=cent)
    return _twins


@app.get("/api/areas/{area_id}/twins")
def twins(area_id: str, mode: str = Query("calendar", pattern="^(calendar|season)$"), k: int = Query(5, ge=1, le=20), allow_near: bool = False):
    from ember_science.twins import Scaler, features, haversine_km, why
    T = _twins_index()
    if T is None:
        return err("not_found", "The Fire Twins index is not built yet.", 404)
    s = get_store(); a = get_area(area_id)
    b0, b1 = s.cfg["baseline_years"]
    _, _, an, _, _, _ = _calendar_data(area_id, f"{b0}-01", f"{b1}-12", f"{b0}-{b1}")
    g = {y: np.zeros(12) for y in range(b0, b1 + 1)}
    for mth, h in an.select("month", "h_count").iter_rows():
        g[int(mth[:4])][int(mth[5:]) - 1] = h
    q = features(g, float(a["area_km2"]))
    if q is None or q.mean_annual < 1:
        return err("not_found", "Too few fires in this area to find twins.", 404)
    sc = Scaler(T["sc"]); w = sc.d["weights"]
    qv = sc.vector(q)
    X, S, idx = T["X"], T["S"], T["idx"]
    shift = np.zeros(len(S), dtype=int)
    if mode == "season":  # rotate each candidate so its peak month lines up with the query's
        shift = (int(np.argmax(q.shape12)) - np.argmax(S, axis=1)) % 12
        rows = (np.arange(12)[None, :] - shift[:, None]) % 12
        S2 = np.take_along_axis(S, rows, axis=1)
        X = X.copy(); X[:, :12] = S2 * np.sqrt(w["shape"]) / sc.d["s_shape"]
    d = np.sqrt(((X - qv) ** 2).sum(axis=1))
    lat, lon = a["centroid"][1], a["centroid"][0]
    dist = haversine_km(lat, lon, idx["lat"].to_numpy(), idx["lon"].to_numpy())
    ok = np.ones(len(d), dtype=bool) if allow_near else dist >= float(s.cfg["twins"]["exclude_km"])
    order, seen = [], set()
    for i in np.argsort(d):  # best match per place name, so twins are distinct places
        if not ok[i]:
            continue
        nm = idx["name"][int(i)]
        if nm in seen:
            continue
        seen.add(nm); order.append(int(i))
        if len(order) == k:
            break
    # regime of the area = the regime holding most of its fire (index units inside the area, weighted by hotspots);
    # areas without index units fall back to the nearest regime centre
    import h3
    if a["_cells_int"]:
        r3s = {h3.cell_to_parent(h3.int_to_str(int(c)), 3) for c in a["_cells_int"]}
    else:
        lk = s.lookup; unit = a.get("_unit") or ""
        sel = lk if unit == "WORLD" else (lk.filter(lk["iso3"] == unit[4:]) if unit.startswith("ISO-") else lk.filter(lk["biome_id"] == int(unit[6:] or 0)))
        r3s = {h3.cell_to_parent(h3.int_to_str(int(c)), 3) for c in sel["r5"].to_list()}
    inside = idx.filter(pl.col("h3_r3").is_in(list(r3s))).group_by("regime_id").agg(w=pl.col("total_meh").sum()).sort("w", descending=True)
    if inside.height:
        qreg = int(inside["regime_id"][0]); qshare = float(inside["w"][0] / inside["w"].sum())
    else:
        qreg = min(T["cent"], key=lambda r: float(((T["cent"][r] - qv) ** 2).sum())); qshare = None
    from ember_science.twins import Features
    out = []
    for i in order:
        r = idx.row(int(i), named=True)
        tf = Features(np.array(r["shape12"]), float(np.argmax(r["shape12"]) + 1), r["R"], r["density"], r["cv"], r["trend"], r["bimodal"], r["night"], r["mean_annual"])
        sh = int(shift[i]); sh = sh - 12 if sh > 6 else sh
        out.append({"h3_r3": r["h3_r3"], "name": r["name"], "lat": r["lat"], "lon": r["lon"], "similarity": int(round(100 / (1 + float(d[i])))),
                    "distance_km": int(round(float(dist[i]))), "shape12": [round(float(v), 4) for v in r["shape12"]], "shift_months": sh,
                    "regime_id": int(r["regime_id"]), "regime_name": T["reg"][int(r["regime_id"])]["name"], "why": why(q, tf, sh, mode)})
    return {"area_id": area_id, "mode": mode,
            "query": {"shape12": [round(float(v), 4) for v in q.shape12], "peak_month": int(np.argmax(q.shape12)) + 1, "regime_id": int(qreg),
                      "regime_name": T["reg"][qreg]["name"], "regime_description": T["reg"][qreg]["description"],
                      "regime_share": None if qshare is None else round(qshare, 3),
                      "R": round(q.R, 3), "trend_pct_per_decade": round(q.trend, 1), "bimodal": q.bimodal},
            "twins": out}


# ---------------- right now (F14) ----------------
_now_cache: dict[str, tuple[float, dict]] = {}
CAT_WORDS = {"much_below": "much below normal", "below": "below normal", "normal": "normal", "above": "above normal",
             "much_above": "much above normal", "record": "a record for this date"}


@app.get("/api/areas/{area_id}/now")
def now(area_id: str):
    import calendar as pycal
    import time as _t

    import h3

    from .live import fetch_nrt

    hit = _now_cache.get(area_id)
    if hit and _t.time() - hit[0] < 15 * 60:
        return hit[1]
    s = get_store(); a = get_area(area_id); unit = a.get("_unit")
    today = datetime.now(timezone.utc).date()
    month = today.strftime("%Y-%m"); dim = pycal.monthrange(today.year, today.month)[1]; elapsed = today.day
    # stored daily record for this month, plus the whole baseline for the same days of the month
    daily = s.area_daily(a["_cells_int"], unit, "2003-01-01", today.isoformat())
    cur = daily.filter(pl.col("date") >= date(today.year, today.month, 1))
    last_stored = cur["date"].max() if cur.height else date(today.year, today.month, 1) - timedelta(days=1)
    stored_mtd = float(cur["h"].sum()) if cur.height else 0.0
    # live NRT detections (last 7 days), converted to MODIS-equivalent with the area's recent NOAA-20 factor
    w, so, e, n = a["bbox"]
    if unit == "WORLD":
        w, so, e, n = -180.0, -60.0, 180.0, 80.0
    det, status = fetch_nrt(s.repo, [w, so, e, n])
    recent = _calendar_data(area_id, "2026-05", "2026-10", "2003-2025")[2]
    n20 = float(recent["raw_noaa20_n"].sum()); hsum = float(recent["h_count"].sum())
    glob = s.unit_monthly("WORLD", ["2026-08", "2026-09", "2026-10"])
    gfac = float(glob["h_count"].sum()) / max(float(glob["raw_noaa20_n"].sum()), 1.0)
    fac = hsum / n20 if n20 >= 50 else gfac
    feats = []; live_after = 0.0
    if det.height:
        det = det.filter(pl.col("confidence").is_in(["n", "h", "nominal", "high"]))
        det = det.with_columns(r5=pl.struct("latitude", "longitude").map_elements(lambda r: h3.str_to_int(h3.latlng_to_cell(r["latitude"], r["longitude"], 5)), return_dtype=pl.UInt64))
        if a["_cells_int"]:
            det = det.filter(pl.col("r5").is_in(a["_cells_int"]))
        elif unit and unit != "WORLD":
            lk = s.lookup
            cells = lk.filter(lk["iso3"] == unit[4:])["r5"] if unit.startswith("ISO-") else lk.filter(lk["biome_id"] == int(unit[6:]))["r5"]
            det = det.filter(pl.col("r5").is_in(cells.implode()))
        det = to_meh_nrt(det, None, fac)
        live_after = float(det.filter(pl.col("acq_date") > str(last_stored))["meh_weight"].sum())
        for r in det.sort("acq_date", "acq_time", descending=True).head(5000).iter_rows(named=True):
            t = r["acq_time"]
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(r["longitude"], 4), round(r["latitude"], 4)]},
                          "properties": {"satellite": r["satellite_code"], "acq_datetime": f"{r['acq_date']}T{t[:2]}:{t[2:]}:00Z", "frp": r["frp"],
                                         "confidence": r["confidence"], "meh_weight": round(r["meh_weight"], 3)}})
    mtd = stored_mtd + live_after
    # baseline: the same first `elapsed` days of this calendar month in 2003-2025
    base = daily.filter((pl.col("date").dt.month() == today.month) & (pl.col("date").dt.day() <= elapsed) & (pl.col("date").dt.year().is_between(2003, 2025)))
    by_year = {y: 0.0 for y in range(2003, 2026)}
    for y, v in base.group_by(pl.col("date").dt.year()).agg(pl.col("h").sum()).iter_rows():
        by_year[int(y)] = float(v)
    S = np.array(list(by_year.values()))
    pct = float(100 * (np.sum(S < mtd) + 0.5 * np.sum(S == mtd)) / len(S))
    cat = CATEGORY_RULE(pct, mtd, float(S.max()), s.cfg["anomaly"]["pct_bounds"])
    cal = _calendar_data(area_id, "2003-01", "2026-10", "2003-2025")
    clim = cal[3]
    med_m = clim.filter(pl.col("month_num") == today.month)["median"][0] or 0.0
    expected = float(med_m) * elapsed / dim
    peak = int(clim.sort("median", descending=True, nulls_last=True)["month_num"][0])
    nxt = date(today.year + (1 if peak < today.month else 0), peak, 15)
    to_peak = 0 if peak == today.month else (nxt - today).days
    # interval: relative uncertainty of the latest months applied to the month-to-date value
    rel = float((recent["sd_area"] / recent["h_count"].clip(1e-9, None)).median()) if recent.height else 0.1
    sd = mtd * rel
    summary = (f"So far in {MONTH_NAMES[today.month - 1]} ({elapsed} of {dim} days), {a['name']} has about {mtd:,.0f} hotspots (MODIS-equivalent); "
               f"a typical year has {expected:,.0f} by this date, so this is {CAT_WORDS.get(cat, "not comparable")}. The typical peak is in {MONTH_NAMES[peak - 1]}"
               + ("." if to_peak == 0 else f", {to_peak} days away."))
    body = {"as_of": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "month": month, "days_elapsed": elapsed, "days_in_month": dim,
            "mtd_h_count": round(mtd, 3), "mtd_lo90": round(max(0.0, mtd - 1.645 * sd), 3), "mtd_hi90": round(mtd + 1.645 * sd, 3),
            "expected_mtd": round(expected, 3), "pct_rank_mtd": round(pct, 1), "category": cat, "typical_peak_month": peak,
            "days_to_typical_peak": to_peak, "last7d": {"type": "FeatureCollection", "features": feats}, "source_status": status,
            "stored_through": str(last_stored), "live_meh_after_stored": round(live_after, 3), "nrt_factor": round(fac, 4), "summary": summary}
    _now_cache[area_id] = (_t.time(), body)
    return body


@app.get("/api/firms")
def firms_passthrough(bbox: str):
    """Local twin of the Cloudflare Pages Function web/functions/api/firms.ts (static deployment): live NOAA-20/21 NRT
    detections for a bounding box, the last 7 days, as FIRMS CSV with a "#source=" line before each part."""
    import datetime as dt

    import httpx

    from .live import FIRMS, map_key
    try:
        w, so, e, n = (float(x) for x in bbox.split(","))
    except ValueError:
        return err("invalid_geometry", "bbox=west,south,east,north required", 400)
    key = map_key(get_store().repo)
    if not key:
        return err("upstream_unavailable", "FIRMS_MAP_KEY is not configured.", 503)
    w, so, e, n = (f"{v:.2f}" for v in (max(-180, w - 0.1), max(-90, so - 0.1), min(180, e + 0.1), min(90, n + 0.1)))
    today = dt.datetime.now(dt.timezone.utc).date()
    parts = []
    with httpx.Client(timeout=25) as c:
        for src in ("VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"):
            for start, span in ((today - dt.timedelta(days=6), 5), (today - dt.timedelta(days=1), 2)):
                try:
                    t = c.get(f"{FIRMS}/{key}/{src}/{w},{so},{e},{n}/{span}/{start.isoformat()}").text.lstrip()
                except httpx.HTTPError:
                    continue
                if t.startswith("latitude"):
                    parts.append(f"#source={src}\n{t}")
    if not parts:
        return err("upstream_unavailable", "FIRMS did not answer.", 502)
    return Response("\n".join(parts), media_type="text/csv")


# ---------------- global ----------------
def _product(name: str):
    d = get_store().product_json(name)
    return d if d is not None else err("not_found", f"{name} is not built yet.", 404)


@app.get("/api/validation")
def validation():
    return _product("validation_report.json")


@app.get("/api/drift")
def drift():
    return _product("drift.json")


@app.get("/api/regimes")
def regimes():
    return _product("regimes.json")


_answers: dict[str, list[int]] = {"raw": [], "harmonized": []}
_answers_loaded = False


def _answers_file():
    # kept next to the products (data/ is never committed), so the crowd's score survives API restarts
    import os
    from pathlib import Path

    env = os.environ.get("CALEMBER_TURING_ANSWERS")  # tests point this at a temporary file
    return Path(env) if env else get_store().products / "turing_answers.json"


def _load_answers() -> None:
    global _answers_loaded
    if _answers_loaded:
        return
    _answers_loaded = True
    try:
        saved = json.loads(_answers_file().read_text(encoding="utf-8"))
        for k in _answers:
            _answers[k] = [int(bool(v)) for v in saved.get(k, [])]
    except (OSError, ValueError):
        pass


def _save_answers() -> None:
    try:
        f = _answers_file()
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(_answers), encoding="utf-8")
        tmp.replace(f)
    except OSError:
        pass


@app.get("/api/turing/rounds")
def turing_rounds(set: str = Query("harmonized", pattern="^(raw|harmonized)$"), n: int = Query(10, ge=1, le=50), seed: int | None = None):
    pool = [r for r in get_store().turing["rounds"] if r["set"] == set]
    rng = random.Random(seed)
    pick = rng.sample(pool, min(n, len(pool)))
    return {"window_months": get_store().turing.get("window_months", 24), "rounds": [{k: v for k, v in r.items() if k != "modis_is"} for r in pick]}


class Answer(BaseModel):
    round_id: str
    choice: str


@app.post("/api/turing/answer")
def turing_answer(ans: Answer):
    r = next((x for x in get_store().turing["rounds"] if x["id"] == ans.round_id), None)
    if r is None:
        return err("not_found", "Unknown round.", 404)
    if ans.choice not in ("a", "b"):
        return err("invalid_geometry", "choice must be 'a' or 'b'.", 422)
    ok = ans.choice == r["modis_is"]
    _load_answers()
    _answers[r["set"]].append(int(ok))
    _save_answers()
    return {"correct": ok, "modis_is": r["modis_is"]}


@app.get("/api/turing/stats")
def turing_stats():
    _load_answers()
    return {k: {"n": len(v), "accuracy": round(sum(v) / len(v), 3) if v else None} for k, v in _answers.items()}
