"""Small static files the browser engine needs to answer drawn areas like the API (web/src/app/engine/).

  <out>/engine/meta.json    config values (baseline, bounds, season rules, limits), product metadata, global NRT factor
  <out>/engine/names.json   province code -> [province name, country name]; ISO3 -> country name
  <out>/engine/twins.json   the Fire Twins index (features, shapes, places), its scaler and the regimes
  <out>/engine/land.u64.gz  every land r5 cell (sorted u64 H3 ids), for the coverage test of drawn areas

Usage:  PYTHONPATH="api;science" python pipeline/build_engine_static.py [out_dir=web/snap]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import polars as pl
import yaml

REPO = Path(__file__).resolve().parents[1]


def dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False), encoding="utf-8")


def main() -> None:
    out = (Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "web/snap") / "engine"
    cfg = yaml.safe_load((REPO / "config/ember.yaml").read_text(encoding="utf-8"))
    products = REPO / cfg["paths"]["products"]
    meta = json.loads((products / "harmonized_cell_month.parquet.meta.json").read_text(encoding="utf-8"))
    refsrc = json.loads((products / "work/refsrc.json").read_text(encoding="utf-8"))

    # the API's global NOAA-20 -> MODIS-equivalent factor (main.py /now): WORLD totals of 2026-08..10
    agg = pl.read_parquet(products / "api/agg_month.parquet").filter((pl.col("unit") == "WORLD") & pl.col("month").is_in(["2026-08", "2026-09", "2026-10"]))
    gfac = float(agg["h_count"].sum()) / max(float(agg["raw_noaa20_n"].sum()), 1.0)

    dump(out / "meta.json", {
        "baseline_years": cfg["baseline_years"], "pct_bounds": cfg["anomaly"]["pct_bounds"], "season": cfg["season"],
        "twins": cfg["twins"], "api": cfg["api"], "product": cfg["product"], "last_day": "2026-11-12",
        "data_version": meta.get("created"), "config_hash": meta.get("config_hash"), "refsrc": refsrc, "global_nrt_factor": gfac,
    })

    lk = pl.read_parquet(products / "api/cells_r5.parquet").select("adm1_code", "adm1_name", "iso3", "country_name")
    a = lk.drop_nulls("adm1_code").unique("adm1_code", keep="first")
    c = lk.drop_nulls("iso3").unique("iso3", keep="first")
    dump(out / "names.json", {"adm1": {r[0]: [r[1], r[3]] for r in a.iter_rows()}, "iso3": {r[2]: r[3] for r in c.iter_rows()}})

    idx = pl.read_parquet(products / "twins_index.parquet")
    sc = json.loads((products / "twins_scaler.json").read_text(encoding="utf-8"))
    regimes = json.loads((products / "regimes.json").read_text(encoding="utf-8"))
    X = np.array(idx["features"].to_list(), dtype=np.float64)
    S = np.array(idx["shape12"].to_list(), dtype=np.float64)
    reg = {int(r["regime_id"]): {"name": r["name"], "description": r["description"]} for r in regimes}
    cent = {str(rid): X[(idx["regime_id"] == rid).to_numpy()].mean(axis=0).tolist() for rid in reg}
    f = lambda col: [float(v) for v in idx[col].to_list()]  # noqa: E731
    dump(out / "twins.json", {
        "scaler": sc, "regimes": {str(k): v for k, v in reg.items()}, "cent": cent,
        "h3_r3": idx["h3_r3"].to_list(), "name": idx["name"].to_list(), "lat": f("lat"), "lon": f("lon"), "total_meh": f("total_meh"),
        "regime_id": [int(v) for v in idx["regime_id"].to_list()], "R": f("R"), "density": f("density"), "cv": f("cv"), "trend": f("trend"),
        "bimodal": [bool(v) for v in idx["bimodal"].to_list()], "night": [None if v is None else float(v) for v in idx["night"].to_list()],
        "mean_annual": f("mean_annual"), "X": X.tolist(), "S": S.tolist(),
    })
    # land cells (areas.py coverage test): sorted u64 H3 ids, gzip
    import gzip
    land = np.sort(pl.read_parquet(REPO / cfg["paths"]["h3_lookup"])["h3_r5_u64"].cast(pl.UInt64).to_numpy()).astype("<u8")
    (out / "land.u64.gz").write_bytes(gzip.compress(land.tobytes(), compresslevel=9, mtime=0))
    print("engine files written to", out, f"({len(land):,} land cells)")


if __name__ == "__main__":
    main()
