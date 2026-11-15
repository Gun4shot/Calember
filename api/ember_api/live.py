"""Live FIRMS near-real-time detections (area API, MAP_KEY from the environment or .env). Cached per bbox for 15 minutes."""
from __future__ import annotations

import io
import os
import time
from pathlib import Path

import httpx
import polars as pl

FIRMS = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
_cache: dict[str, tuple[float, pl.DataFrame]] = {}


def map_key(repo: Path) -> str | None:
    k = os.environ.get("FIRMS_MAP_KEY")
    if k:
        return k.strip()
    env = repo / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("FIRMS_MAP_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def fetch_nrt(repo: Path, bbox: list[float], days: int = 7, sources=("VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"), ttl_min: int = 15) -> tuple[pl.DataFrame, str]:
    """Returns (detections, status). status: ok | unavailable. Columns: latitude, longitude, acq_date, acq_time, confidence, frp, satellite_code, source."""
    key = map_key(repo)
    if not key:
        return pl.DataFrame(), "unavailable"
    w, s, e, n = (round(v, 2) for v in bbox)
    w, s = max(w - 0.1, -180), max(s - 0.1, -90); e, n = min(e + 0.1, 180), min(n + 0.1, 90)
    ck = f"{w},{s},{e},{n}|{days}|{','.join(sources)}"
    hit = _cache.get(ck)
    if hit and time.time() - hit[0] < ttl_min * 60:
        return hit[1], "ok"
    frames = []; ok_calls = 0
    # the FIRMS area API serves at most 5 days per request: split the window into chunks with explicit start dates
    import datetime as dt
    today = dt.datetime.now(dt.timezone.utc).date()
    chunks = []
    start = today - dt.timedelta(days=days - 1)
    while start <= today:
        span = min(5, (today - start).days + 1)
        chunks.append((start, span)); start += dt.timedelta(days=span)
    try:
        with httpx.Client(timeout=25) as c:
            for src in sources:
                for st, span in chunks:
                    r = c.get(f"{FIRMS}/{key}/{src}/{w},{s},{e},{n}/{span}/{st.isoformat()}")
                    txt = r.text.lstrip()
                    if r.status_code != 200 or txt.startswith(("Invalid", "<", "Error")):
                        continue
                    ok_calls += 1
                    if not txt.startswith("latitude"):
                        continue
                    df = pl.read_csv(io.StringIO(r.text), infer_schema_length=0)
                    if df.height:
                        frames.append(df.with_columns(source=pl.lit(src)))
    except httpx.HTTPError:
        return pl.DataFrame(), "unavailable"
    if ok_calls == 0:
        return pl.DataFrame(), "unavailable"
    if not frames:
        out = pl.DataFrame(schema={"latitude": pl.Float64, "longitude": pl.Float64, "acq_date": pl.String, "acq_time": pl.String,
                                   "confidence": pl.String, "frp": pl.Float64, "satellite_code": pl.String, "source": pl.String})
    else:
        df = pl.concat(frames, how="diagonal_relaxed")
        out = df.select(pl.col("latitude").cast(pl.Float64), pl.col("longitude").cast(pl.Float64), "acq_date",
                        pl.col("acq_time").str.zfill(4), "confidence", pl.col("frp").cast(pl.Float64, strict=False),
                        pl.when(pl.col("source").str.contains("NOAA21")).then(pl.lit("NOAA21")).otherwise(pl.lit("NOAA20")).alias("satellite_code"), "source")
    _cache[ck] = (time.time(), out)
    return out, "ok"
