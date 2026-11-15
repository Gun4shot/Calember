"""API tests on the real v0.9.1 product (local data). Run: PYTHONPATH=api;science pytest api/tests"""
import csv
import io
import zipfile

import polars as pl
import pytest
from fastapi.testclient import TestClient

from ember_api.main import app
from ember_api.store import get_store

c = TestClient(app)


def test_health():
    r = c.get("/api/health").json()
    assert r["status"] == "ok" and r["latest_month"] == "2026-10" and r["model"] == "H1"


@pytest.fixture(scope="module")
def punjab():
    r = c.post("/api/areas", json={"admin_id": "IND-3249"})
    assert r.status_code == 201, r.text
    return r.json()


def test_area_admin(punjab):
    assert punjab["name"].startswith("Punjab") and punjab["coverage"] == "full"
    assert punjab["area_id"].startswith("a_") and len(punjab["area_id"]) == 14
    assert c.get(f"/api/areas/{punjab['area_id']}").json()["n_cells_r5"] == punjab["n_cells_r5"]


def test_calendar_matches_product(punjab):
    cal = c.get(f"/api/areas/{punjab['area_id']}/calendar").json()
    months = cal["months"]
    assert months[0]["month"] == "2000-11" and months[-1]["month"] == "2026-10" and len(months) == 312
    # totals equal the product summed over the area's cells
    s = get_store()
    cells = [int(x, 16) for x in punjab["cells_r5"]]
    p = pl.scan_parquet(s.products / "harmonized_cell_month.parquet").filter(pl.col("h3_r5_u64").is_in(cells) & (pl.col("month") == "2015-11"))
    want = p.select(pl.col("h_count").cast(pl.Float64).sum()).collect().item()
    got = next(m for m in months if m["month"] == "2015-11")["h_count"]
    assert got == pytest.approx(want, rel=1e-4)
    m = next(m for m in months if m["month"] == "2015-11")
    assert m["lo90"] <= m["h_count"] <= m["hi90"] and m["category"] in ("much_below", "below", "normal", "above", "much_above", "record")
    assert len(cal["climatology"]) == 12 and cal["summary"]
    assert any(y["rank"] == 1 for y in cal["years"])


def test_circle_polygon_and_errors():
    r = c.post("/api/areas", json={"circle": {"lat": 27.7, "lon": 85.3, "radius_km": 50}})
    assert r.status_code == 201 and r.json()["n_cells_r5"] > 10
    poly = {"type": "Polygon", "coordinates": [[[84.0, 27.0], [86.0, 27.0], [86.0, 28.5], [84.0, 28.5], [84.0, 27.0]]]}
    r = c.post("/api/areas", json={"geometry": poly})
    assert r.status_code == 201 and r.json()["coverage"] in ("full", "partial")
    r = c.post("/api/areas", json={"circle": {"lat": -30.0, "lon": -140.0, "radius_km": 30}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "outside_coverage"
    r = c.post("/api/areas", json={"circle": {"lat": 0.0, "lon": 20.0, "radius_km": 1000}})
    assert r.status_code in (201, 422)  # a 1000 km circle is either accepted or rejected as too large, never a crash
    r = c.post("/api/areas", json={})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_geometry"
    assert c.get("/api/areas/a_doesnotexist").json()["error"]["code"] == "not_found"


def test_calendar_csv(punjab):
    r = c.get(f"/api/areas/{punjab['area_id']}/export/calendar.csv")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows[0][:5] == ["year", "month", "month_num", "regime", "h_count"] and len(rows) == 313


def test_hotspots_weights_sum_to_calendar(punjab):
    # one post-2012 month: basis-sensor weights should sum to the harmonized count of cells that have detections
    r = c.get(f"/api/areas/{punjab['area_id']}/export/hotspots.csv", params={"start": "2016-11-01", "end": "2016-11-30"})
    assert r.status_code == 200
    df = pl.read_csv(io.StringIO(r.text), schema_overrides={"confidence": pl.String})
    assert df.height > 1000 and set(df["instrument"].unique()) <= {"MODIS", "VIIRS"}
    cal = c.get(f"/api/areas/{punjab['area_id']}/calendar", params={"start": "2016-11", "end": "2016-11"}).json()["months"][0]
    assert df["meh_weight"].sum() == pytest.approx(cal["h_count"], rel=0.05)


def test_bundle_and_global(punjab, tmp_path, monkeypatch):
    monkeypatch.setenv("CALEMBER_TURING_ANSWERS", str(tmp_path / "answers.json"))  # never touch the demo's crowd score
    r = c.get(f"/api/areas/{punjab['area_id']}/export/bundle.zip", params={"start": "2026-10-01", "end": "2026-10-31"})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert {"calendar.csv", "hotspots.csv", "season.csv", "README.txt", "metadata.json"} <= set(z.namelist())
    v = c.get("/api/validation").json()
    assert v["skill"]["primary"]["H1"]["primary_kge"] > 0.99
    assert c.get("/api/drift").json()["summary"]
    rounds = c.get("/api/turing/rounds", params={"set": "harmonized", "n": 5, "seed": 1}).json()["rounds"]
    assert len(rounds) == 5 and "modis_is" not in rounds[0] and len(rounds[0]["a"]) == 24
    ans = c.post("/api/turing/answer", json={"round_id": rounds[0]["id"], "choice": "a"}).json()
    assert ans["modis_is"] in ("a", "b")
    assert c.get("/api/turing/stats").json()["harmonized"]["n"] >= 1


def test_big_units_world_country_biome():
    s = get_store()
    w = c.post("/api/areas", json={"admin_id": "WORLD"}).json()
    assert w["kind"] == "world" and w["n_cells_r5"] > 500000
    cal = c.get(f"/api/areas/{w['area_id']}/calendar").json()
    y2020 = sum(m["h_count"] for m in cal["months"] if m["month"].startswith("2020"))
    want = pl.scan_parquet(s.products / "harmonized_cell_month.parquet").filter(pl.col("month").str.starts_with("2020"))         .select(pl.col("h_count").cast(pl.Float64).sum()).collect().item()
    assert y2020 == pytest.approx(want, rel=1e-4)
    bra = c.post("/api/areas", json={"admin_id": "ISO-BRA"}).json()
    assert bra["kind"] == "country" and bra["name"] == "Brazil"
    assert c.get(f"/api/areas/{bra['area_id']}/calendar").json()["summary"]
    r = c.get(f"/api/areas/{bra['area_id']}/export/hotspots.csv")
    assert r.status_code == 422 and r.json()["error"]["code"] == "area_too_large"
    npl = c.post("/api/areas", json={"admin_id": "ISO-NPL"}).json()
    assert npl["cells_r5"]  # small country keeps its cells (hotspot export works)
    b = c.post("/api/areas", json={"admin_id": "BIOME-7"}).json()
    assert b["kind"] == "biome"


def test_season_twins_stl(punjab):
    aid = punjab["area_id"]
    se = c.get(f"/api/areas/{aid}/season").json()
    assert se["years"] and se["fire_year_start_month"] in range(1, 13) and se["summary"]
    ok = [y for y in se["years"] if not y["insufficient"]]
    assert all(0 <= y["onset_doy"] <= y["peak_doy"] <= 366 and y["onset_doy"] <= y["end_doy"] for y in ok)
    assert se["two_seasons"]  # Punjab: rice (Oct-Nov) and wheat (Apr-May) stubble
    rows = list(csv.reader(io.StringIO(c.get(f"/api/areas/{aid}/export/season.csv").text)))
    assert rows[0][0] == "fire_year" and len(rows) == len(se["years"]) + 1
    tw = c.get(f"/api/areas/{aid}/twins", params={"mode": "season", "k": 5}).json()
    assert len(tw["twins"]) == 5 and all(t["distance_km"] >= 1000 for t in tw["twins"])
    assert all(0 < t["similarity"] <= 100 for t in tw["twins"]) and tw["query"]["regime_name"]
    stl = c.get(f"/api/areas/{aid}/export/calendar.stl").content
    import struct
    ntri = struct.unpack("<I", stl[80:84])[0]
    assert len(stl) == 84 + 50 * ntri and ntri == 12 * (1 + 25 * 12)
    reg = c.get("/api/regimes").json()
    assert 10 <= len(reg) <= 14 and all(abs(sum(r["shape12"]) - 1) < 0.01 for r in reg)


def test_now_shape(punjab):
    n = c.get(f"/api/areas/{punjab['area_id']}/now").json()
    assert n["source_status"] in ("ok", "unavailable") and n["days_elapsed"] >= 1
    assert n["mtd_lo90"] <= n["mtd_h_count"] <= n["mtd_hi90"] and 0 <= n["pct_rank_mtd"] <= 100
    assert n["last7d"]["type"] == "FeatureCollection" and n["summary"]


def test_cells_per_area(punjab):
    """Additive /cells: per-cell means sum to the area's mean annual calendar total (2001-2025)."""
    r = c.get(f"/api/areas/{punjab['area_id']}/cells").json()
    n = len(r["cells"])
    assert n == punjab["n_cells_r5"] and len(r["lat"]) == n and len(r["mean_annual"]) == n and len(r["by_year"]) == n
    cal = c.get(f"/api/areas/{punjab['area_id']}/calendar").json()
    yrs = [y["total"] for y in cal["years"] if 2001 <= y["year"] <= 2025]
    assert abs(sum(r["mean_annual"]) - sum(yrs) / len(yrs)) / (sum(yrs) / len(yrs)) < 0.01
    assert all(p is None or 1 <= p <= 12 for p in r["peak_month"])
    world = c.post("/api/areas", json={"admin_id": "WORLD"}).json()
    assert c.get(f"/api/areas/{world['area_id']}/cells").status_code == 422


def test_places_and_rankings(punjab):
    """Additive /places and /rankings: shares sum to ≤ 1, Punjab is its own top province, rankings follow /calendar rules."""
    p = c.get(f"/api/areas/{punjab['area_id']}/places").json()
    assert p["level"] == "province" and p["places"][0]["name"].startswith("Punjab")
    assert 0.99 <= sum(x["share"] for x in p["places"]) <= 1.0001 and p["hottest"]["share"] > 0
    chn = c.post("/api/areas", json={"admin_id": "ISO-CHN"}).json()
    pc = c.get(f"/api/areas/{chn['area_id']}/places").json()
    assert pc["n_places"] > 10 and pc["places"][0]["share"] > pc["places"][1]["share"]
    r = c.get("/api/rankings?month=2024-08").json()
    assert len(r["countries"]) > 150
    bra = next(x for x in r["countries"] if x["admin_id"] == "ISO-BRA")
    cal = c.get(f"/api/areas/{c.post('/api/areas', json={'admin_id': 'ISO-BRA'}).json()['area_id']}/calendar").json()
    m = next(x for x in cal["months"] if x["month"] == "2024-08")
    assert abs(bra["h_count"] - m["h_count"]) < 1 and bra["category"] == m["category"]


def test_daily(punjab):
    """Additive /daily: the days of a month sum to (≈98–100 % of) the calendar month; typical bands are ordered."""
    r = c.get(f"/api/areas/{punjab['area_id']}/daily?month=2024-10").json()
    assert len(r["days"]) == 31
    cal = c.get(f"/api/areas/{punjab['area_id']}/calendar").json()
    m = next(x for x in cal["months"] if x["month"] == "2024-10")["h_count"]
    s = sum(d["h"] for d in r["days"])
    assert 0.95 * m <= s <= 1.001 * m
    assert all(d["p25"] <= d["typical"] <= d["p75"] for d in r["days"])


def test_cells_month_matches_calendar(punjab):
    """The per-cell month sums to the area's calendar value for that month, in /cells order."""
    cm = c.get(f"/api/areas/{punjab['area_id']}/cells_month", params={"month": "2021-11"}).json()
    cells = c.get(f"/api/areas/{punjab['area_id']}/cells").json()
    assert len(cm["values"]) == len(cells["cells"]) == len(cm["typical"])
    cal = c.get(f"/api/areas/{punjab['area_id']}/calendar").json()
    h = next(m["h_count"] for m in cal["months"] if m["month"] == "2021-11")
    assert abs(sum(cm["values"]) - h) <= max(1.0, 0.01 * h)
