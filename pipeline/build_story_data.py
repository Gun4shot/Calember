"""Build the small static files the story film needs (web/public/static/story/).

Inputs are R1 exploration products (data/interim/explore). Every number in the
outputs comes from those files; nothing is typed in by hand.

Outputs:
  story_ridge.json     monthly series for the hero region (Punjab + Haryana) and
                       four context regions: MODIS observed, VIIRS raw, raw sum,
                       harmonized (MODIS <= 2011-12, Bridge H1E1c cross-fit >= 2012-01)
  globe_cells.json     r3 cells with fire: lat, lon
  globe_months.json    month labels
  globe_harm.u8        n_months x n_cells, log1p-scaled (shared h_max)
  globe_raw.u8         same grid, raw sensors summed (MODIS + S-NPP + NOAA-20)
  globe_meta.json      h_max, encoding, model, built
  land_points.bin      Float32 lat/lon pairs of land dots (Natural Earth admin-0)
  story_facts.json     scalar facts used by captions (seam, H2 curve, drift)

Memory: the host runs heavy jobs; every DuckDB query is capped (300 MB, 2 threads)
and processed one year at a time.

Run:  .venv/Scripts/python.exe pipeline/build_story_data.py   (add --ridge-only to skip facts and globe)
"""

from __future__ import annotations

import csv
import json
import math
import struct
import time
from pathlib import Path

import duckdb
import h3
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
EXPLORE = ROOT / "data" / "interim" / "explore"
CM = EXPLORE / "cm_long_m1"  # cleaned + static-masked cell-month counts
CROSSFIT = EXPLORE / "crossfit_CF.parquet"  # H1E1c cross-fitted predictions 2012-2025
LOOKUP = ROOT / "data" / "interim" / "aux" / "h3r5_lookup.parquet"
NE0 = ROOT / "data" / "raw" / "aux" / "ne" / "ne_10m_admin_0_countries.shp"
OUT = ROOT / "web" / "public" / "static" / "story"

FIRST_MONTH = "2000-11"
LAST_MONTH = "2026-10"  # last complete month (2026-11 is month-to-date)
MODEL = "Bridge v2 (product + cross-fitted model for 2012-2019)"
PRODUCT = ROOT / "data" / "products" / "harmonized_cell_month.parquet"
PRED_CF = ROOT / "data" / "products" / "work" / "pred_cf.parquet"  # cross-fitted model only, 2012-2019

# Hero + context regions, defined on admin-1 codes / iso3 from the r5 lookup.
REGIONS = [
    {"id": "punjab", "name": "Punjab & Haryana, India", "where": "adm1_name IN ('Punjab','Haryana') AND iso3 = 'IND'"},
    {"id": "npl", "name": "Nepal", "where": "iso3 = 'NPL'"},
    {"id": "bra", "name": "Brazil", "where": "iso3 = 'BRA'"},
    {"id": "aus", "name": "Australia", "where": "iso3 = 'AUS'"},
    {"id": "can", "name": "Canada", "where": "iso3 = 'CAN'"},
]


def con() -> duckdb.DuckDBPyConnection:
    c = duckdb.connect()
    c.execute("SET memory_limit='300MB'; SET threads=2; SET preserve_insertion_order=false")
    return c


def months() -> list[str]:
    out, y, m = [], 2000, 11
    while f"{y:04d}-{m:02d}" <= LAST_MONTH:
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


MONTHS = months()
MIDX = {m: i for i, m in enumerate(MONTHS)}


def build_ridges(c: duckdb.DuckDBPyConnection) -> dict:
    regions_out = []
    for reg in REGIONS:
        cells = c.execute(f"SELECT h3_r5_u64 FROM '{LOOKUP}' WHERE {reg['where']}").fetchnumpy()["h3_r5_u64"]
        c.register("cells", {"r5": cells})
        n = len(MONTHS)
        modis = np.zeros(n)
        snpp = np.zeros(n)
        n20 = np.zeros(n)
        harm_pred = np.zeros(n)
        for year in range(2000, 2026):
            for prod, arr in (("modis", modis), ("viirs-snpp", snpp), ("viirs-jpss1", n20)):
                f = CM / f"{prod}_{year}.parquet"
                if not f.exists():
                    continue
                rows = c.execute(
                    f"SELECT month, sum(n) FROM '{f}' t JOIN cells USING (r5) GROUP BY month"
                ).fetchall()
                for mo, v in rows:
                    if mo in MIDX:
                        arr[MIDX[mo]] += float(v)
        rows = c.execute(
            f"SELECT month, sum(H1E1c) FROM '{CROSSFIT}' t JOIN cells USING (r5) GROUP BY month"
        ).fetchall()
        for mo, v in rows:
            if mo in MIDX:
                harm_pred[MIDX[mo]] = float(v)
        c.unregister("cells")
        i2012 = MIDX["2012-01"]
        harmonized = modis.copy()
        harmonized[i2012:] = harm_pred[i2012:]
        raw_sum = modis + snpp + n20
        regions_out.append(
            {
                "id": reg["id"],
                "name": reg["name"],
                "n_cells_r5": int(len(cells)),
                "modis": [round(x, 1) for x in modis],
                "viirs_snpp": [round(x, 1) for x in snpp],
                "viirs_noaa20": [round(x, 1) for x in n20],
                "raw_sum": [round(x, 1) for x in raw_sum],
                "harmonized": [round(x, 1) for x in harmonized],
            }
        )
        print(f"  ridge {reg['id']}: cells={len(cells)} modis_total={modis.sum():.0f} raw_total={raw_sum.sum():.0f}")
    return {
        "months": MONTHS,
        "switch_month": "2012-01",
        "model": MODEL,
        "unit": "hotspots (MODIS-equivalent)",
        "notes": "modis = Terra+Aqua observed (cleaned, static-masked). raw_sum = MODIS + S-NPP + NOAA-20 detections. "
        "harmonized = MODIS observed up to 2011-12, Bridge prediction from S-NPP from 2012-01 (MODIS after 2012 is the independent check).",
        "regions": regions_out,
    }


def build_ridges_product(c: duckdb.DuckDBPyConnection) -> dict:
    """Ridge series from the harmonized product.

    Calember 2012-2019 uses the *cross-fitted model alone* (each region predicted by a model that never saw its
    MODIS), because the product blends observed MODIS into those years and the white MODIS check line must be
    an independent test. 2000-2011 and 2020+ come from the product (MODIS itself / model only)."""
    out = []
    for reg in REGIONS:
        c.execute(f"CREATE OR REPLACE TEMP TABLE cells AS SELECT h3_r5_u64 AS c FROM '{LOOKUP}' WHERE {reg['where']}")
        n = len(MONTHS)
        h = np.zeros(n); m = np.zeros(n); s = np.zeros(n); n20 = np.zeros(n); n21 = np.zeros(n); cf = np.full(n, np.nan)
        regime = [""] * n
        for mo, hh, mm, ss, a, b, rg in c.execute(
            f"""SELECT month, sum(h_count), sum(raw_modis_n), sum(raw_snpp_n), sum(raw_noaa20_n), sum(raw_noaa21_n), any_value(regime)
                FROM '{PRODUCT}' p JOIN cells ON p.h3_r5_u64 = cells.c GROUP BY month"""
        ).fetchall():
            if mo in MIDX:
                i = MIDX[mo]
                h[i], m[i], s[i], n20[i], n21[i], regime[i] = hh, mm, ss, a, b, rg
        for mo, pm in c.execute(f"SELECT month, sum(p_model) FROM '{PRED_CF}' x JOIN cells ON x.r5 = cells.c GROUP BY month").fetchall():
            if mo in MIDX:
                cf[MIDX[mo]] = pm
        ember = h.copy()
        for mo in MONTHS:
            i = MIDX[mo]
            # 2012-01 and 2012-03 have incomplete S-NPP input; the product uses MODIS there (D-017)
            if "2012-01" <= mo <= "2019-12" and mo not in ("2012-01", "2012-03") and not np.isnan(cf[i]):
                ember[i] = cf[i]
        raw = m + s + n20 + n21
        out.append({
            "id": reg["id"], "name": reg["name"],
            "modis": [round(x, 1) for x in m],
            "viirs_snpp": [round(x, 1) for x in s],
            "viirs_noaa20": [round(x, 1) for x in n20 + n21],
            "raw_sum": [round(x, 1) for x in raw],
            "harmonized": [round(x, 1) for x in ember],
            "product": [round(x, 1) for x in h],
            "regime": regime,
        })
        print(f"  ridge {reg['id']}: modis={m.sum():.0f} raw={raw.sum():.0f} ember={ember.sum():.0f} product={h.sum():.0f}")
    # first month each sensor has data in the product (labels the raw-sum HUD on the globe)
    first = c.execute(
        f"""SELECT min(month) FILTER (WHERE raw_modis_n > 0), min(month) FILTER (WHERE raw_snpp_n > 0),
                   min(month) FILTER (WHERE raw_noaa20_n > 0), min(month) FILTER (WHERE raw_noaa21_n > 0) FROM '{PRODUCT}'"""
    ).fetchone()
    meta = json.loads((PRODUCT.parent / (PRODUCT.name + ".meta.json")).read_text())
    return {
        "months": MONTHS, "switch_month": "2012-01", "model": MODEL, "product_version": meta["version"],
        "unit": "hotspots (MODIS-equivalent)",
        "sensor_first": dict(zip(("MODIS", "SNPP", "NOAA20", "NOAA21"), first)),
        "notes": "modis = Terra+Aqua observed; raw_sum = MODIS + S-NPP + NOAA-20 + NOAA-21; harmonized = product (MODIS to 2011, "
                 "Calember from VIIRS from 2020) with 2012-2019 from the cross-fitted model alone (independent of the region's MODIS); "
                 "product = the harmonized product itself (h_count) in every month, used for record totals.",
        "regions": out,
    }


def build_globe_product(c: duckdb.DuckDBPyConnection) -> None:
    cells = c.execute(f"SELECT DISTINCT h3_r5_u64 FROM '{PRODUCT}'").fetchnumpy()["h3_r5_u64"]
    r3 = np.array([h3.str_to_int(h3.cell_to_parent(h3.int_to_str(int(x)), 3)) for x in cells], dtype=np.uint64)
    c.register("p3", {"r5": cells, "r3": r3})
    n = len(MONTHS)
    harm: dict[int, np.ndarray] = {}
    raw: dict[int, np.ndarray] = {}
    for year in range(2000, int(LAST_MONTH[:4]) + 1):
        t0 = time.time()
        for cell, mo, hh, rr in c.execute(
            f"""SELECT p3.r3, month, sum(h_count)::FLOAT, sum(raw_modis_n + raw_snpp_n + raw_noaa20_n + raw_noaa21_n)::FLOAT
                FROM '{PRODUCT}' p JOIN p3 ON p.h3_r5_u64 = p3.r5 WHERE month LIKE '{year}-%' GROUP BY ALL"""
        ).fetchall():
            if mo not in MIDX:
                continue
            for store, v in ((harm, hh), (raw, rr)):
                a = store.get(cell)
                if a is None:
                    a = store[cell] = np.zeros(n, dtype=np.float32)
                a[MIDX[mo]] += v
        print(f"  globe {year}: {time.time() - t0:.1f}s")
    c.unregister("p3")
    keep = sorted(k for k in harm if harm[k].sum() >= 50)
    H = np.stack([harm[k] for k in keep], axis=1)
    R = np.stack([raw.get(k, np.zeros(n, dtype=np.float32)) for k in keep], axis=1)
    h_max = float(np.percentile(R[R > 0], 99.9))
    enc = lambda a: np.clip(np.round(255 * np.log1p(a) / math.log1p(h_max)), 0, 255).astype(np.uint8)
    OUT.joinpath("globe_harm.u8").write_bytes(enc(H).tobytes())
    OUT.joinpath("globe_raw.u8").write_bytes(enc(R).tobytes())
    lat, lon = zip(*(h3.cell_to_latlng(h3.int_to_str(int(k))) for k in keep))
    OUT.joinpath("globe_cells.json").write_text(json.dumps({"lat": [round(x, 3) for x in lat], "lon": [round(x, 3) for x in lon]}))
    OUT.joinpath("globe_months.json").write_text(json.dumps({"months": MONTHS}))
    meta = json.loads((PRODUCT.parent / (PRODUCT.name + ".meta.json")).read_text())
    OUT.joinpath("globe_meta.json").write_text(json.dumps({
        "h_max": h_max, "encoding": "round(255*log1p(x)/log1p(h_max)), clipped; shared by harm and raw",
        "n_cells": len(keep), "n_months": n, "model": MODEL, "product_version": meta["version"],
        "built": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "monthly_total_harm": [round(float(x), 1) for x in H.sum(axis=1)],
        "monthly_total_raw": [round(float(x), 1) for x in R.sum(axis=1)],
    }))
    print(f"  globe: {len(keep)} r3 cells, h_max={h_max:.0f}")


def build_globe(c: duckdb.DuckDBPyConnection) -> None:
    # r5 -> r3 parent map for every r5 that appears in the lookup (land cells).
    r5 = c.execute(f"SELECT h3_r5_u64 FROM '{LOOKUP}'").fetchnumpy()["h3_r5_u64"]
    r3 = np.array([h3.str_to_int(h3.cell_to_parent(h3.int_to_str(int(x)), 3)) for x in r5], dtype=np.uint64)
    c.register("p", {"r5": r5, "r3": r3})
    n = len(MONTHS)
    harm: dict[int, np.ndarray] = {}
    raw: dict[int, np.ndarray] = {}

    def add(store: dict[int, np.ndarray], rows) -> None:
        for cell, mo, v in rows:
            if mo not in MIDX:
                continue
            a = store.get(cell)
            if a is None:
                a = store[cell] = np.zeros(n, dtype=np.float32)
            a[MIDX[mo]] += v

    for year in range(2000, 2026):
        t0 = time.time()
        for prod in ("modis", "viirs-snpp", "viirs-jpss1"):
            f = CM / f"{prod}_{year}.parquet"
            if not f.exists():
                continue
            rows = c.execute(
                f"SELECT p.r3, month, sum(n)::FLOAT FROM '{f}' t JOIN p USING (r5) GROUP BY ALL"
            ).fetchall()
            add(raw, rows)
            if prod == "modis" and year < 2012:
                add(harm, rows)
        if year >= 2012:
            rows = c.execute(
                f"SELECT p.r3, month, sum(H1E1c)::FLOAT FROM '{CROSSFIT}' t JOIN p USING (r5) "
                f"WHERE month LIKE '{year}-%' GROUP BY ALL"
            ).fetchall()
            add(harm, rows)
        print(f"  globe {year}: {time.time() - t0:.1f}s cells={len(raw)}")
    c.unregister("p")

    # keep cells with meaningful activity (>= 50 harmonized hotspots over the record)
    keep = sorted(k for k in raw if harm.get(k) is not None and harm[k].sum() >= 50)
    H = np.stack([harm[k] for k in keep], axis=1)  # months x cells
    R = np.stack([raw[k] for k in keep], axis=1)
    h_max = float(np.percentile(R[R > 0], 99.9))  # shared scale so raw vs harm brightness is honest
    enc = lambda a: np.clip(np.round(255 * np.log1p(a) / math.log1p(h_max)), 0, 255).astype(np.uint8)
    OUT.joinpath("globe_harm.u8").write_bytes(enc(H).tobytes())
    OUT.joinpath("globe_raw.u8").write_bytes(enc(R).tobytes())
    lat, lon = zip(*(h3.cell_to_latlng(h3.int_to_str(int(k))) for k in keep))
    OUT.joinpath("globe_cells.json").write_text(
        json.dumps({"lat": [round(x, 3) for x in lat], "lon": [round(x, 3) for x in lon]})
    )
    OUT.joinpath("globe_months.json").write_text(json.dumps({"months": MONTHS}))
    OUT.joinpath("globe_meta.json").write_text(
        json.dumps(
            {
                "h_max": h_max,
                "encoding": "round(255*log1p(x)/log1p(h_max)), clipped; shared by harm and raw",
                "n_cells": len(keep),
                "n_months": n,
                "model": MODEL,
                "built": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "monthly_total_harm": [round(float(x), 1) for x in H.sum(axis=1)],
                "monthly_total_raw": [round(float(x), 1) for x in R.sum(axis=1)],
            }
        )
    )
    print(f"  globe: {len(keep)} r3 cells, h_max={h_max:.0f}")


def build_land_points() -> None:
    """Fibonacci-sphere dots that fall on land (Natural Earth admin-0), as Float32 lat/lon."""
    import pyogrio
    import shapely

    geoms = pyogrio.read_dataframe(NE0, columns=[]).geometry.values
    N = 60000
    i = np.arange(N) + 0.5
    lat = np.degrees(np.arcsin(1 - 2 * i / N))
    lon = (np.degrees(np.pi * (1 + 5**0.5) * i) % 360) - 180
    on = np.zeros(N, dtype=bool)
    for g in geoms:
        x0, y0, x1, y1 = g.bounds
        m = (~on) & (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1)
        if m.any():
            idx = np.where(m)[0]
            on[idx[shapely.contains_xy(g, lon[idx], lat[idx])]] = True
    land = np.column_stack([lat[on], lon[on]]).astype(np.float32)
    OUT.joinpath("land_points.bin").write_bytes(land.tobytes())
    print(f"  land points: {len(land)}")


def build_facts() -> dict:
    seam = json.loads((EXPLORE / "seam2_CF2_g_z2_summary.json").read_text())
    h2 = json.loads((EXPLORE / "h2_feas_2019.json").read_text())
    drift = {}
    with open(EXPLORE / "drift.csv") as fh:
        for row in csv.DictReader(fh):
            drift.setdefault(row["sat"], {})[row["month"]] = float(row["median_lst"])

    def yearly(sat: str, year: int) -> float:
        vals = [v for m, v in drift.get(sat, {}).items() if m.startswith(f"{year}-")]
        return float(np.median(vals)) if vals else float("nan")

    def hhmm(h: float) -> str:
        return f"{int(h):02d}:{int(round((h % 1) * 60)):02d}"

    return {
        "seam_2012": {
            "raw_sum_pp": round(seam["2012-01|raw_sum"]["median_abs_artifact_pp"], 1),
            "harmonized_pp": round(seam["2012-01|harm"]["median_abs_artifact_pp"], 1),
            "n_units": seam["2012-01|harm"]["n"],
            "definition": "median |step at 2012-01| of the deseasonalized monthly series, minus MODIS's own step, over 15 regions/biomes",
        },
        "h2": {
            "year": h2["year"],
            "n_units": h2["n_units"],
            "auc_oof": round(h2["auc_oof"], 3),
            "detect_rate_by_npix": {k: round(v, 3) for k, v in h2["detect_rate_by_npix"].items()},
            "detect_rate_day_night": {k: round(v, 3) for k, v in h2["detect_rate_day_night"].items()},
        },
        "drift": {
            "aqua_2003": hhmm(yearly("AQUA", 2003)),
            "aqua_2025": hhmm(yearly("AQUA", 2025)),
            "terra_2003": hhmm(yearly("TERRA", 2003)),
            "terra_2025": hhmm(yearly("TERRA", 2025)),
        },
        "pixel_area_km2": {"modis_nadir": 1.0, "viirs_nadir": round(0.375**2, 4)},
        "sources": "data/interim/explore: seam2_CF2_g_z2_summary.json, h2_feas_2019.json, drift.csv",
    }


def main() -> None:
    import sys

    OUT.mkdir(parents=True, exist_ok=True)
    c = con()
    use_product = PRODUCT.exists() and PRED_CF.exists()
    print("ridges...", "(product)" if use_product else "(exploration)")
    ridge = build_ridges_product(c) if use_product else build_ridges(c)
    OUT.joinpath("story_ridge.json").write_text(json.dumps(ridge))
    if "--ridge-only" in sys.argv:
        print("done (ridge only) ->", OUT)
        return
    print("facts...")
    OUT.joinpath("story_facts.json").write_text(json.dumps(build_facts(), indent=1))
    if not OUT.joinpath("land_points.bin").exists():
        print("land...")
        build_land_points()
    print("globe...")
    build_globe_product(c) if use_product else build_globe(c)
    print("done ->", OUT)


if __name__ == "__main__":
    main()
