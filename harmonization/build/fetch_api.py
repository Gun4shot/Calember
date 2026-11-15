"""FIRMS area API for data missing from the yearly zips.
Reads FIRMS_MAP_KEY from <repo>/.env (never prints it). Writes one CSV per (source, start date) chunk to
<repo>/data/raw/firms/api/<SOURCE>/<YYYY-MM-DD>_<days>.csv. Resumable (skips existing non-empty files).
Usage:
  python -P fetch_api.py <repo> availability
  python -P fetch_api.py <repo> fetch <SOURCE> <start YYYY-MM-DD> <end YYYY-MM-DD> [days_per_call=5]
"""
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

BASE = "https://firms.modaps.eosdis.nasa.gov/api"


def read_key(repo: Path) -> str:
    for line in (repo / ".env").read_text().splitlines():
        if line.strip().startswith("FIRMS_MAP_KEY="):
            k = line.split("=", 1)[1].strip().strip('"').strip("'")
            if k:
                return k
    raise SystemExit("FIRMS_MAP_KEY missing in .env")


def get(url: str, key: str) -> bytes:
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            msg = str(e).replace(key, "***")
            print(f"  retry {attempt+1}: {msg}", flush=True)
            time.sleep(15 * (attempt + 1))
    raise SystemExit("giving up")


def main() -> None:
    repo, cmd = Path(sys.argv[1]), sys.argv[2]
    key = read_key(repo)
    if cmd == "availability":
        print(get(f"{BASE}/data_availability/csv/{key}/all", key).decode())
        return
    src, d0, d1 = sys.argv[3], date.fromisoformat(sys.argv[4]), date.fromisoformat(sys.argv[5])
    step = int(sys.argv[6]) if len(sys.argv) > 6 else 5
    out = repo / "data/raw/firms/api" / src
    out.mkdir(parents=True, exist_ok=True)
    d = d0
    while d <= d1:
        n = min(step, (d1 - d).days + 1)
        f = out / f"{d.isoformat()}_{n}.csv"
        if not (f.exists() and f.stat().st_size > 0):
            body = get(f"{BASE}/area/csv/{key}/{src}/world/{n}/{d.isoformat()}", key)
            if body[:9] != b"latitude," and b"latitude" not in body[:200]:
                raise SystemExit(f"unexpected response for {src} {d}: {body[:200]!r}")
            f.write_bytes(body)
            print(f"{src} {d} +{n}d: {body.count(b'\n')-1} rows", flush=True)
            time.sleep(2)
        d += timedelta(days=n)


if __name__ == "__main__":
    main()
