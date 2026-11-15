"""rate-aware sequential FIRMS API queue.
Checks the MAP_KEY transaction status before each call and waits when near the 5000/10-min limit.
Chunk naming/alignment identical to fetch_api.py so existing chunks are reused. Never prints the key.
Usage: python -P fetch_queue.py <repo>
"""
import json
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

repo = Path(sys.argv[1])
KEY = next(l.split("=", 1)[1].strip() for l in (repo / ".env").read_text().splitlines() if l.startswith("FIRMS_MAP_KEY="))
BASE = "https://firms.modaps.eosdis.nasa.gov"
STEP = 5
# (source, aligned start, end) in priority order
JOBS = [
    ("VIIRS_SNPP_SP", "2026-01-01", "2026-07-31"),
    ("MODIS_SP", "2026-01-01", "2026-08-31"),
    ("VIIRS_NOAA20_SP", "2026-01-01", "2026-07-31"),
    ("VIIRS_SNPP_NRT", "2026-08-01", "2026-11-02"),
    ("VIIRS_NOAA20_NRT", "2026-08-01", "2026-11-12"),
    ("VIIRS_NOAA21_NRT", "2026-08-01", "2026-11-12"),
    ("MODIS_NRT", "2026-09-01", "2026-11-12"),
    ("VIIRS_NOAA21_SP", "2024-12-31", "2026-07-31"),
    ("VIIRS_NOAA21_SP", "2023-03-01", "2024-12-30"),
]


def http(url: str, timeout: int = 300) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def used() -> int:
    for _ in range(5):
        try:
            return int(json.loads(http(f"{BASE}/mapserver/mapkey_status/?MAP_KEY={KEY}", 60))["current_transactions"])
        except Exception:  # noqa: BLE001
            time.sleep(20)
    return 5000


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg.replace(KEY, "***"), flush=True)


for src, s0, s1 in JOBS:
    d, d1 = date.fromisoformat(s0), date.fromisoformat(s1)
    out = repo / "data/raw/firms/api" / src
    out.mkdir(parents=True, exist_ok=True)
    while d <= d1:
        n = min(STEP, (d1 - d).days + 1)
        f = out / f"{d.isoformat()}_{n}.csv"
        if f.exists() and f.stat().st_size > 0:
            d += timedelta(days=n); continue
        while (u := used()) > 4500:
            log(f"quota {u}/5000, waiting 60s"); time.sleep(60)
        before = u
        try:
            body = http(f"{BASE}/api/area/csv/{KEY}/{src}/world/{n}/{d.isoformat()}")
        except Exception as e:  # noqa: BLE001
            log(f"{src} {d}: {e}; waiting 120s"); time.sleep(120); continue
        if not body.startswith(b"latitude"):
            log(f"{src} {d}: unexpected body {body[:120]!r}; waiting 120s"); time.sleep(120); continue
        tmp = f.with_suffix(".part"); tmp.write_bytes(body); tmp.replace(f)
        log(f"{src} {d} +{n}d: {body.count(b'\n')-1} rows, cost~{used()-before} tx")
        d += timedelta(days=n)
log("ALL_DONE")
