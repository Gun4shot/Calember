"""Fine terrain files for the countries over the API's cell limit (Russia, Antarctica, China, Canada, USA, Australia,
Brazil): the same per-cell answer as /api/areas/{id}/cells (mean per year, peak month, last 12 months, province), so the
static site shows ~253 km² cells for them too. No month-by-month grid (too large); the site uses the coarse globe
record for the timeline month in these countries.

    PYTHONPATH="api;science" python pipeline/build_big_terrain.py [out_dir=web/snap]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "web/snap"
    from ember_api.main import cells_body
    from ember_api.store import get_store

    s = get_store()
    limit = int(s.cfg["api"]["max_area_cells_r5"])
    lk = s.lookup
    sizes = lk.drop_nulls("iso3").group_by("iso3").len()
    big = sorted(r[0] for r in sizes.filter(sizes["len"] > limit).iter_rows())
    for iso in big:
        cells = [int(c) for c in lk.filter(lk["iso3"] == iso)["r5"].to_list()]  # lookup order, as the API lists a country
        sid = f"ISO-{iso}"
        body = cells_body(sid, cells)
        f = out / "c" / f"{sid}.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(body, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        print(f"{sid}: {len(cells):,} cells, {f.stat().st_size / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
