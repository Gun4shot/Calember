"""Static snapshot of the API for every named place, so the site runs without a Python server (Cloudflare Pages).

For each entry of web/public/static/search_index.json (the world, biomes, countries, provinces) it writes:
  <out>/p/<id>.json   area, calendar, season, twins (season and calendar modes), places, and the inputs of the live
                      "right now" answer (NOAA-20 -> MODIS-equivalent factor, recent relative uncertainty)
  <out>/c/<id>.json   terrain cells (only for areas with a cell list) plus every month of every cell (sparse)
  <out>/d/<id>.json   the harmonized daily series, first day -> last stored day
and <out>/r/<YYYY-MM>.json + r/latest.json for the country rankings, plus <out>/meta.json.

The responses are the API's own (FastAPI TestClient, in process); `area_id` is replaced by the admin id so the static
site can address a place by its id. Usage:
    PYTHONPATH="api;science" python pipeline/build_snapshot.py [out_dir=web/snap] [--only ID ...] [--skip-existing]
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parents[1]


def dump(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    s = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(s, encoding="utf-8")
    return len(s)


def fname(sid: str) -> str:
    """File name of a place id: "?" (in a few Natural Earth codes) is not allowed in Windows file names; the site maps it the same way."""
    return sid.replace("?", "~")


def relabel(obj, aid: str, sid: str):
    """The API's random area id -> the place's admin id, everywhere it appears."""
    if isinstance(obj, dict):
        return {k: (sid if (k == "area_id" and v == aid) else relabel(v, aid, sid)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [relabel(v, aid, sid) for v in obj]
    return obj


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = Path(args[0]) if args else REPO / "web/snap"
    only = sys.argv[sys.argv.index("--only") + 1:] if "--only" in sys.argv else None
    skip = "--skip-existing" in sys.argv

    from fastapi.testclient import TestClient

    import ember_api.main as M
    from ember_api.areas import get_area
    from ember_api.store import get_store

    c = TestClient(M.app)
    s = get_store()
    months = json.loads((REPO / "web/public/static/globe_months.json").read_text(encoding="utf-8"))["months"]
    m_index = {m: i for i, m in enumerate(months)}
    entries = json.loads((REPO / "web/public/static/search_index.json").read_text(encoding="utf-8"))
    ids = [e["admin_id"] for e in entries if e.get("admin_id")]
    if only:
        ids = [i for i in ids if i in only]

    t0 = time.time(); total = 0; failed: list[str] = []
    for k, sid in enumerate(ids):
        if skip and (out / "p" / f"{fname(sid)}.json").exists():
            continue
        try:
            r = c.post("/api/areas", json={"admin_id": sid})
            if r.status_code >= 400:
                failed.append(f"{sid}: {r.json().get('error', {}).get('message', r.status_code)}")
                continue
            area = r.json(); aid = area["area_id"]
            get = lambda path, **q: c.get(path, params=q)  # noqa: E731
            parts = {"area": area}
            for name, path, q in [("calendar", f"/api/areas/{aid}/calendar", {}), ("season", f"/api/areas/{aid}/season", {}),
                                  ("twins_season", f"/api/areas/{aid}/twins", {"mode": "season", "k": 5}),
                                  ("twins_calendar", f"/api/areas/{aid}/twins", {"mode": "calendar", "k": 5}),
                                  ("places", f"/api/areas/{aid}/places", {})]:
                rr = get(path, **q)
                parts[name] = rr.json() if rr.status_code == 200 else None
            # inputs of the live answer (the same rules as /now)
            a = get_area(aid)
            recent = M._calendar_data(aid, "2026-05", "2026-10", "2003-2025")[2]
            n20 = float(recent["raw_noaa20_n"].sum()); hsum = float(recent["h_count"].sum())
            glob = s.unit_monthly("WORLD", ["2026-08", "2026-09", "2026-10"])
            gfac = float(glob["h_count"].sum()) / max(float(glob["raw_noaa20_n"].sum()), 1.0)
            rel = float((recent["sd_area"] / recent["h_count"].clip(1e-9, None)).median()) if recent.height else 0.1
            parts["now_inputs"] = {"nrt_factor": round(hsum / n20 if n20 >= 50 else gfac, 4), "rel_sd": round(rel if rel == rel else 0.1, 4),
                                   "bbox": a["bbox"], "unit": a.get("_unit"), "pct_bounds": s.cfg["anomaly"]["pct_bounds"]}
            total += dump(out / "p" / f"{fname(sid)}.json", relabel(parts, aid, sid))

            # daily series (all days, zero-filled)
            d = s.area_daily(a.get("_cells_int") or [], a.get("_unit"), "2000-11-01", "2026-12-31")
            if d.height:
                first, last = d["date"].min(), d["date"].max()
                vals = dict(zip(d["date"].to_list(), d["h"].to_list()))
                n = (last - first).days + 1
                series = [round(float(vals.get(first + timedelta(days=i), 0.0)), 2) for i in range(n)]
                total += dump(out / "d" / f"{fname(sid)}.json", {"first": str(first), "last": str(last), "h": series})

            # terrain cells + every month of every cell (sparse triplets)
            cells_int = a.get("_cells_int") or []
            if cells_int:
                rc = get(f"/api/areas/{aid}/cells")
                if rc.status_code == 200:
                    cells = rc.json()
                    # every month of every cell, for the Terrain "timeline month" mode: a dense grid of tenths of a
                    # hotspot (cell-major, months[0] -> months[-1]), only for areas up to 4,000 cells (file-size limit)
                    if len(cells_int) <= 4000:
                        rows = s.area_rows(cells_int, months[0], months[-1])
                        ci_of = {ci: i for i, ci in enumerate(cells_int)}
                        nm = len(months)
                        grid = [0] * (len(cells_int) * nm)
                        if rows.height:
                            for cell, mon, h in rows.select("h3_r5_u64", "month", "h_count").filter(pl.col("h_count") > 0).iter_rows():
                                if mon in m_index:
                                    grid[ci_of[int(cell)] * nm + m_index[mon]] = int(round(float(h) * 10))
                        cells["month_grid"] = {"months": [months[0], months[-1]], "scale": 0.1, "v": grid}
                    total += dump(out / "c" / f"{fname(sid)}.json", relabel(cells, aid, sid))
        except Exception as e:  # keep going; report at the end
            failed.append(f"{sid}: {type(e).__name__}: {e}")
        if k % 50 == 0:
            print(f"{k + 1}/{len(ids)} {sid}  {total / 1e6:.0f} MB  {time.time() - t0:.0f}s", flush=True)

    if not only:
        # rankings: every month with an answer, and the default month
        for m in months:
            rr = c.get("/api/rankings", params={"month": m})
            if rr.status_code == 200:
                total += dump(out / "r" / f"{m}.json", rr.json())
        rr = c.get("/api/rankings")
        if rr.status_code == 200:
            dump(out / "r" / "latest.json", rr.json())
    health = c.get("/api/health").json()
    dump(out / "meta.json", {"built": date.today().isoformat(), "health": health, "places": len(ids) - len(failed), "failed": failed})
    print(f"done: {len(ids) - len(failed)} places, {total / 1e6:.0f} MB, {time.time() - t0:.0f}s; failed {len(failed)}")
    for f in failed[:20]:
        print("  ", f)


if __name__ == "__main__":
    main()
