"""Small real-data extras for the story film (web/public/static/story/story_extras.json).

  punjab_day     every cleaned MODIS and VIIRS S-NPP detection over Punjab + Haryana on 2015-11-05
                 (the date of the true-colour photo in the pixel beat), with pixel sizes, and the
                 simplified Punjab + Haryana outline (Natural Earth admin-1)
  sensor_day     Aqua MODIS and S-NPP VIIRS detection counts on 2019-08-22 (the day of the globe imagery)
  aqua_outage    daily Terra and Aqua MODIS detection counts 2020-07-15 → 2020-09-30 (global, raw FIRMS)
                 around the Aqua data loss of 2020-08-16 → 2020-09-02

Cleaning matches the product (Guideline §4.11): MODIS confidence ≥ 30, VIIRS confidence n/h, type 0.

Run:  .venv/Scripts/python.exe pipeline/build_story_extras.py
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "interim" / "firms_raw"
DAILY = ROOT / "data" / "interim" / "explore" / "modis_daily_counts.parquet"
NE1 = ROOT / "data" / "raw" / "aux" / "ne" / "ne_10m_admin_1_states_provinces.shp"
OUT = ROOT / "web" / "public" / "static" / "story" / "story_extras.json"
DAY = "2015-11-05"
GLOBE_DAY = "2019-08-22"
AGG_DAY = ROOT / "data" / "products" / "api" / "agg_day.parquet"
STATES = ("Punjab", "Haryana")


def outline():
    import pyogrio
    import shapely

    df = pyogrio.read_dataframe(NE1, columns=["name", "adm0_a3"], where="adm0_a3 = 'IND'")
    g = shapely.union_all(df[df["name"].isin(STATES)].geometry.values).simplify(0.01)
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    rings = [[[round(x, 3), round(y, 3)] for x, y in p.exterior.coords] for p in polys if p.area > 0.01]
    return g, rings


def punjab_day(c: duckdb.DuckDBPyConnection) -> dict:
    import shapely

    g, rings = outline()
    x0, y0, x1, y1 = g.bounds
    box = f"latitude BETWEEN {y0} AND {y1} AND longitude BETWEEN {x0} AND {x1} AND acq_date = '{DAY}' AND type = 0"
    modis = c.execute(
        f"""SELECT latitude, longitude, scan, track FROM '{RAW}/product=modis/year=2015/*.parquet'
            WHERE {box} AND TRY_CAST(confidence AS INT) >= 30"""
    ).fetchall()
    viirs = c.execute(
        f"""SELECT latitude, longitude, scan, track FROM '{RAW}/product=viirs-snpp/year=2015/*.parquet'
            WHERE {box} AND confidence IN ('n', 'h', 'nominal', 'high')"""
    ).fetchall()

    def inside(rows):
        if not rows:
            return []
        pts = [r for r in rows if shapely.contains_xy(g, r[1], r[0])]
        return [[round(r[0], 4), round(r[1], 4), round(r[2], 2), round(r[3], 2)] for r in pts]

    m, v = inside(modis), inside(viirs)
    print(f"  punjab {DAY}: MODIS {len(m)} detections, VIIRS {len(v)} (cleaned, inside the outline)")
    return {
        "date": DAY,
        "region": "Punjab & Haryana, India",
        "bbox": [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
        "outline": rings,
        "fields": ["lat", "lon", "scan_km", "track_km"],
        "modis": m,
        "viirs": v,
        "cleaning": "MODIS confidence >= 30, VIIRS confidence n/h, type 0 (the product's confidence and type filters)",
        "source": "NASA FIRMS standard processing (MCD14ML C6.1, VNP14IMGML), data/interim/firms_raw",
    }


def aqua_outage(c: duckdb.DuckDBPyConnection) -> dict:
    rows = c.execute(
        f"""SELECT strftime(acq_date, '%Y-%m-%d'), satellite, n FROM '{DAILY}'
            WHERE acq_date BETWEEN '2020-07-15' AND '2020-09-30' ORDER BY 1, 2"""
    ).fetchall()
    days = sorted({r[0] for r in rows})
    by = {s: {d: 0 for d in days} for s in ("Terra", "Aqua")}
    for d, s, n in rows:
        if s in by:
            by[s][d] = int(n)
    med = {d: int(m) for d, m in c.execute(
        f"""SELECT strftime(acq_date, '%Y-%m-%d'), med FROM '{DAILY}'
            WHERE satellite = 'Aqua' AND acq_date BETWEEN '2020-07-15' AND '2020-09-30'"""
    ).fetchall()}
    ember = {d: float(h) for d, h in c.execute(
        f"""SELECT strftime(date, '%Y-%m-%d'), h FROM '{AGG_DAY}'
            WHERE unit = 'WORLD' AND date BETWEEN '2020-07-15' AND '2020-09-30'"""
    ).fetchall()}
    print(f"  aqua outage: {len(days)} days")
    return {
        "days": days,
        "terra": [by["Terra"][d] for d in days],
        "aqua": [by["Aqua"][d] for d in days],
        "aqua_normal": [med.get(d, 0) for d in days],
        "ember": [round(ember.get(d, 0.0), 1) for d in days],
        "ember_note": "Calember daily world total (MODIS-equivalent, from VIIRS in 2020; products/api/agg_day.parquet). Raw MODIS also counts low-confidence and static detections, so it sits about 10 % higher on normal days.",
        "outage": ["2020-08-16", "2020-09-02"],
        "unit": "MODIS fire detections per day, whole planet (raw FIRMS)",
        "source": "data/interim/explore/modis_daily_counts.parquet (raw FIRMS MCD14ML)",
    }


def sensor_day(c: duckdb.DuckDBPyConnection) -> dict:
    """Fire detections on the globe-imagery day (Aqua MODIS and S-NPP VIIRS only, the two sensors in the images)."""
    m = c.execute(
        f"""SELECT count(*) FROM '{RAW}/product=modis/year=2019/*.parquet'
            WHERE acq_date = '{GLOBE_DAY}' AND satellite IN ('Aqua', 'A') AND TRY_CAST(confidence AS INT) >= 30 AND type = 0"""
    ).fetchone()[0]
    v = c.execute(
        f"""SELECT count(*) FROM '{RAW}/product=viirs-snpp/year=2019/*.parquet'
            WHERE acq_date = '{GLOBE_DAY}' AND confidence IN ('n', 'h', 'nominal', 'high') AND type = 0"""
    ).fetchone()[0]
    print(f"  globe day {GLOBE_DAY}: Aqua MODIS {m}, S-NPP VIIRS {v}")
    return {"date": GLOBE_DAY, "modis_aqua": int(m), "viirs_snpp": int(v),
            "cleaning": "MODIS confidence >= 30, VIIRS n/h, type 0; whole planet, day and night",
            "images": "NASA Worldview snapshots of the same day (textures/*_2019-08-22.*)"}


DIVE_DAY = "2016-11-07"
DIVE_BOX = (26.6, 72.8, 33.6, 78.7)  # lat0, lon0, lat1, lon1 of the Worldview close-ups


def globe_dive(c: duckdb.DuckDBPyConnection) -> dict:
    """Daytime Aqua MODIS and S-NPP VIIRS detections in the Punjab close-up on the globe-dive day."""
    import shapely

    g, _ = outline()
    la0, lo0, la1, lo1 = DIVE_BOX
    box = f"latitude BETWEEN {la0} AND {la1} AND longitude BETWEEN {lo0} AND {lo1} AND acq_date = '{DIVE_DAY}' AND type = 0 AND daynight = 'D'"
    m = c.execute(f"""SELECT latitude, longitude, scan, track FROM '{RAW}/product=modis/year=2016/*.parquet'
                      WHERE {box} AND satellite IN ('Aqua', 'A') AND TRY_CAST(confidence AS INT) >= 30""").fetchall()
    v = c.execute(f"""SELECT latitude, longitude, scan, track FROM '{RAW}/product=viirs-snpp/year=2016/*.parquet'
                      WHERE {box} AND confidence IN ('n', 'h', 'nominal', 'high')""").fetchall()
    inside = lambda rows: sum(1 for r in rows if shapely.contains_xy(g, r[1], r[0]))
    pack = lambda rows: [[round(r[0], 3), round(r[1], 3), round(r[2], 2), round(r[3], 2)] for r in rows]
    out = {"date": DIVE_DAY, "box": list(DIVE_BOX), "fields": ["lat", "lon", "scan_km", "track_km"],
           "modis": pack(m), "viirs": pack(v), "modis_in_state": inside(m), "viirs_in_state": inside(v),
           "note": "daytime passes only (the afternoon images); Aqua MODIS conf >= 30, S-NPP VIIRS n/h, type 0; in_state = inside the Punjab + Haryana outline"}
    # dive target: the 0.5° box with the most VIIRS detections (searched on a 0.05° grid)
    best = (-1, 0.0, 0.0)
    for i in range(int((la1 - la0 - 0.5) / 0.05)):
        for j in range(int((lo1 - lo0 - 0.5) / 0.05)):
            a0, b0 = la0 + i * 0.05, lo0 + j * 0.05
            n = sum(1 for r in v if a0 <= r[0] < a0 + 0.5 and b0 <= r[1] < b0 + 0.5)
            if n > best[0]:
                best = (n, a0, b0)
    _, fa, fb = best
    out["focus"] = {"lat": round(fa + 0.25, 3), "lon": round(fb + 0.25, 3), "box_deg": 0.5,
                    "viirs": best[0], "modis": sum(1 for r in m if fa <= r[0] < fa + 0.5 and fb <= r[1] < fb + 0.5)}
    print(f"  globe dive {DIVE_DAY}: MODIS {len(m)} ({out['modis_in_state']} in state), VIIRS {len(v)} ({out['viirs_in_state']} in state); focus {out['focus']}")
    return out


def main() -> None:
    c = duckdb.connect()
    c.execute("SET memory_limit='500MB'; SET threads=2; SET preserve_insertion_order=false")
    out = {"built": time.strftime("%Y-%m-%dT%H:%M:%S"), "punjab_day": punjab_day(c), "aqua_outage": aqua_outage(c), "sensor_day": sensor_day(c), "globe_dive": globe_dive(c)}
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print("done ->", OUT, f"{OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
