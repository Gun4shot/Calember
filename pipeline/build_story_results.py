"""Build the results files for the story film's new acts (data & method, scorecard, Turing test).

Outputs (web/public/static/story/):
  results.json        every number the site shows, each with its source and test
  scatter_b3.bin      Float32 x4 per province-month of the sealed 2020 test:
                      observed MODIS, one-global-ratio (H0), SOTA-style (H0b), Calember
  turing_rounds.json  3 rounds for the human Turing game (real MODIS vs Calember-with-noise / raw VIIRS)

Only results are exported; the method is documented in the README.
Re-run when the product or the benchmarks change:  .venv/Scripts/python.exe pipeline/build_story_results.py
"""

from __future__ import annotations

import json
import random
import time
from pathlib import Path

import duckdb
import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
EX = ROOT / "data" / "interim" / "explore"
PROD = ROOT / "data" / "products"
OUT = ROOT / "web" / "public" / "static" / "story"
LOOKUP = ROOT / "data" / "interim" / "aux" / "h3r5_lookup.parquet"
FINAL = "H1E1g_z2"


def con() -> duckdb.DuckDBPyConnection:
    c = duckdb.connect()
    c.execute("SET memory_limit='400MB'; SET threads=2; SET preserve_insertion_order=false")
    return c


def scales(rep: dict) -> dict:
    out = {"primary": round(rep["primary"], 4)}
    for s in ("adm1", "country", "biome", "r5"):
        out[s] = {"kge": round(rep[s]["kge"], 4), "r2": round(rep[s]["r2"], 4), "bias_pct": round(rep[s]["bias_pct"], 2)}
    return out


def data_facts() -> dict:
    sp = {"MODIS": 0, "SNPP": 0, "NOAA20": 0, "NOAA21": 0}
    man = (ROOT / "data" / "interim" / "firms_raw" / "_manifest.csv").read_text().splitlines()[1:]
    key = {"modis": "MODIS", "viirs-snpp": "SNPP", "viirs-jpss1": "NOAA20"}
    for line in man:
        parts = line.split(",")
        sp[key[parts[1]]] += int(parts[4])
    api = {"MODIS": 0, "SNPP": 0, "NOAA20": 0, "NOAA21": 0}
    for f in (ROOT / "data" / "interim" / "firms_api").glob("*.parquet"):
        name = f.stem
        k = "MODIS" if name.startswith("MODIS") else "SNPP" if "SNPP" in name else "NOAA20" if "NOAA20" in name else "NOAA21"
        api[k] += pq.ParquetFile(f).metadata.num_rows
    by = {k: sp[k] + api[k] for k in sp}
    qa = json.loads((PROD / "qa_report.json").read_text())
    meta = json.loads((PROD / "harmonized_cell_month.parquet.meta.json").read_text())
    return {
        "raw_rows_total": sum(by.values()),
        "raw_rows_by_sensor": by,
        "satellites": ["Terra", "Aqua", "Suomi NPP", "NOAA-20", "NOAA-21"],
        "years": "2000-11 → 2026-11",
        # static-hotspot mask cells and land cells: science/JOURNAL.md (12 Nov), DATA.md
        "mask_cells": 54013,
        "r5_land_cells": 571982,
        "r5_cell_km2": 253,
        "product_rows": qa["rows"],
        "product_months": qa["months"],
        "product_first": qa["first"],
        "product_last": qa["last"],
        "product_version": meta["version"],
        "regimes": [
            {"code": "T", "label": "Terra only, scaled", "from": "2000-11", "to": "2002-06"},
            {"code": "M", "label": "MODIS observed", "from": "2002-07", "to": "2011-12"},
            {"code": "B", "label": "MODIS + Calember blend", "from": "2012-01", "to": "2019-12"},
            {"code": "V", "label": "Calember from VIIRS", "from": "2020-01", "to": "2026-07"},
            {"code": "N", "label": "Calember, provisional", "from": "2026-08", "to": "2026-11"},
        ],
        "train_years": "2012–2019",
        "folds": 5,
        "sources": "firms_raw/_manifest.csv, firms_api/*.parquet, products/qa_report.json + meta",
    }


def scores() -> dict:
    b2 = json.loads((EX / "bench_report_B2_T.json").read_text())["report"][FINAL]
    b2base = json.loads((EX / "bench_report_B2.json").read_text())["report"]
    b3 = json.loads((EX / "bench_report_B3.json").read_text())["report"]
    gap = json.loads((EX / "b3_sensitivity_aqua_gap.json").read_text())
    seam = json.loads((EX / "seam2_CF2_g_z2_summary.json").read_text())
    conf = json.loads((EX / "conformal_B2_T_H1E1g_z2.json").read_text())
    x3 = json.loads((EX / "b3_extras.json").read_text())[FINAL]
    sc = json.loads((EX / f"scorecard_B2_T_{FINAL}.json").read_text())
    sc_sota = json.loads((EX / "scorecard_B2_E9_H0b.json").read_text())
    pp = lambda k: round(seam[k]["median_abs_artifact_pp"], 1)
    return {
        "b2": {
            "test": "held-out regions and years (2018–2019); trained 2012–2017 on other regions",
            "models": {"global_ratio": scales(b2base["H0"]), "sota_style": scales(b2base["H0b"]), "ember": scales(b2)},
            "source": "bench_report_B2*.json",
        },
        "b3": {
            "test": "sealed 2020 holdout, pre-registered, run once; trained 2012–2019",
            "models": {"global_ratio": scales(b3["H0"]), "sota_style": scales(b3["H0b"]), "ember": scales(b3[FINAL])},
            "excl_aqua_outage": {
                "note": "post hoc: Aqua MODIS lost 80–95 % of detections 2020-08-16 → 09-02; months 2020-08/09 excluded",
                "global_ratio": gap["excl_2020-08_09|H0"]["primary"],
                "sota_style": gap["excl_2020-08_09|H0b"]["primary"],
                "ember": gap[f"excl_2020-08_09|{FINAL}"]["primary"],
            },
            "source": "bench_report_B3.json, b3_sensitivity_aqua_gap.json",
        },
        "seam": {
            "test": "median |step| at the sensor switch after removing seasons and MODIS's own change, 15 regions/biomes",
            "raw_pp": pp("2012-01|raw_sum"),
            "global_ratio_pp": pp("2012-01|H0"),
            "ember_pp": pp("2012-01|harm"),
            "placebo_2015_pp": pp("2015-01|harm"),
            "placebo_2017_pp": pp("2017-01|harm"),
            "handover_2020_pp": pp("2020-01|harm"),
            "source": "seam2_CF2_g_z2_summary.json",
        },
        "turing": {
            "test": "classifier two-sample test on 24-month province records (regions with ≥ 50 MODIS hotspots/month); 0.5 = a coin flip",
            "n_regions": sc["n_regions"],
            "ember": 0.551,
            "ember_seeds": [0.538, 0.555, 0.559],
            "sota_style": 0.589,
            "raw_viirs": round(sc["turing"]["raw"]["accuracy"], 3),
            "ci_half_width": 0.027,
            "ember_b3": round(x3["c2st_zinb"]["mean"], 3),
            "ember_b3_seeds": [round(r["c2st"], 3) for r in x3["c2st_zinb"]["runs"]],
            "ember_b3_regions": x3["c2st_zinb"]["regions"],
            "smooth_values_ember": round(sc["turing"]["harmonized"]["accuracy"], 3),
            "smooth_values_sota": round(sc_sota["turing"]["harmonized"]["accuracy"], 3),
            "how": "Calember is tested as a realistic sample from its calibrated predictive distribution (MODIS-like counting noise); "
            "the smooth calendar values alone are distinguishable for every method",
            "source": "B2: science/JOURNAL.md 'Turing-test deep-dive' (3 seeds); B3: b3_extras.json; raw + smooth: scorecard_B2_*.json",
        },
        "coverage90": {
            "b2_adm1": round(conf["adm1"]["coverage"], 3),
            "b3_adm1": round(x3["conformal_adm1"]["coverage"], 3),
            "source": "conformal_B2_T_H1E1g_z2.json, b3_extras.json",
        },
        "calendar_kappa": {"ember": round(sc["calendar_agreement"]["kappa"], 3), "sota_style": round(sc_sota["calendar_agreement"]["kappa"], 3)},
    }


def scatter(c: duckdb.DuckDBPyConnection) -> int:
    rows = c.execute(
        f"""SELECT adm1_code, month, sum(y), sum(H0), sum(H0b), sum({FINAL})
            FROM '{EX / "bench_oof_B3.parquet"}' WHERE adm1_code IS NOT NULL GROUP BY 1, 2"""
    ).fetchall()
    arr = np.array([r[2:] for r in rows], dtype=np.float32)
    OUT.joinpath("scatter_b3.bin").write_bytes(arr.tobytes())
    return len(arr)


def turing_rounds(c: duckdb.DuckDBPyConnection) -> list:
    s = c.execute(
        f"""SELECT adm1_code, list(obs ORDER BY month), list(draw ORDER BY month), list(raw ORDER BY month), avg(obs), min(month)
            FROM '{EX / f"c2st_series_B2_T_{FINAL}.parquet"}' GROUP BY 1 HAVING avg(obs) >= 80 AND count(*) = 24"""
    ).fetchall()
    names = dict(c.execute(f"SELECT DISTINCT adm1_code, adm1_name || ', ' || country_name FROM '{LOOKUP}'").fetchall())
    rnd = random.Random(2026)
    rnd.shuffle(s)
    picks = []
    for kind in ("raw", "ember", "ember"):
        r = s.pop()
        real = [round(float(v), 1) for v in r[1]]
        other = [round(float(v), 1) for v in (r[3] if kind == "raw" else r[2])]
        real_is = rnd.choice(["a", "b"])
        picks.append(
            {
                "kind": kind,
                "region": names.get(r[0], r[0]),
                "start": r[5],
                "a": real if real_is == "a" else other,
                "b": other if real_is == "a" else real,
                "real_is": real_is,
                "other_label": "raw VIIRS (sensors as recorded)" if kind == "raw" else "Calember (with realistic counting noise, as in the test)",
            }
        )
    return picks


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    c = con()
    res = {"built": time.strftime("%Y-%m-%dT%H:%M:%S"), "data": data_facts(), **scores()}
    res["scatter_b3"] = {"n": scatter(c), "fields": ["observed", "global_ratio", "sota_style", "ember"], "unit": "MODIS-equivalent hotspots per province-month, 2020"}
    OUT.joinpath("results.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")
    OUT.joinpath("turing_rounds.json").write_text(json.dumps({"window_months": 24, "rounds": turing_rounds(c)}, ensure_ascii=False), encoding="utf-8")
    print("ok:", res["scatter_b3"]["n"], "scatter points; product", res["data"]["product_version"], "; raw rows", res["data"]["raw_rows_total"])


if __name__ == "__main__":
    main()
