"""Area resolution (CONTRACTS §5.2): geometry | circle | admin_id | h3_cells -> r5 cells (centres inside)."""
from __future__ import annotations

import hashlib
import math
from collections import OrderedDict
from typing import Any

import h3

from .store import Store


class AreaError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


_cache: "OrderedDict[str, dict]" = OrderedDict()
CACHE_MAX = 5000


def _haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _cells_from_geometry(geom: dict) -> list[str]:
    t = geom.get("type")
    if t not in ("Polygon", "MultiPolygon"):
        raise AreaError("invalid_geometry", "The area must be a polygon. Draw at least three points.")
    try:
        cells = list(h3.geo_to_cells(geom, 5))
    except Exception as e:  # noqa: BLE001
        raise AreaError("invalid_geometry", f"The drawn shape could not be read ({e}).") from e
    if not cells:  # no cell centre inside: use the cell containing the centroid
        ring = geom["coordinates"][0] if t == "Polygon" else geom["coordinates"][0][0]
        lon = sum(p[0] for p in ring) / len(ring); lat = sum(p[1] for p in ring) / len(ring)
        cells = [h3.latlng_to_cell(lat, lon, 5)]
    return cells


def _cells_from_circle(c: dict) -> list[str]:
    try:
        lat, lon, rad = float(c["lat"]), float(c["lon"]), float(c["radius_km"])
    except (KeyError, TypeError, ValueError) as e:
        raise AreaError("invalid_geometry", "A circle needs lat, lon and radius_km.") from e
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or not (0 < rad <= 1000):
        raise AreaError("invalid_geometry", "Latitude, longitude or radius is out of range (radius 1-1000 km).")
    centre = h3.latlng_to_cell(lat, lon, 5)
    k = int(math.ceil(rad / 14.0)) + 1  # r5 centre spacing is about 17 km
    cells = [x for x in h3.grid_disk(centre, k) if _haversine_km(lat, lon, *h3.cell_to_latlng(x)) <= rad]
    return cells or [centre]


def resolve(store: Store, req: dict[str, Any]) -> dict:
    keys = [k for k in ("geometry", "circle", "admin_id", "h3_cells") if req.get(k) is not None]
    if len(keys) != 1:
        raise AreaError("invalid_geometry", "Send exactly one of geometry, circle, admin_id or h3_cells.")
    key = keys[0]; name = "Custom area"
    if key == "geometry":
        cells_hex = _cells_from_geometry(req["geometry"])
    elif key == "circle":
        cells_hex = _cells_from_circle(req["circle"]); name = f"Custom area ({float(req['circle']['radius_km']):g} km circle)"
    elif key == "admin_id":
        aid = str(req["admin_id"]); lk = store.lookup
        if aid == "WORLD" or aid.startswith("ISO-") or aid.startswith("BIOME-"):
            return _unit_area(store, aid)
        sel = lk.filter(lk["adm1_code"] == aid)
        if sel.height == 0:
            raise AreaError("not_found", f"No region with id {aid}.", 404)
        cells_hex = [h3.int_to_str(int(c)) for c in sel["r5"].to_list()]
        name = store.admin_names.get(aid, aid)
    else:
        raw = req["h3_cells"]
        if not isinstance(raw, list) or not raw:
            raise AreaError("invalid_geometry", "h3_cells must be a non-empty list of H3 cell ids.")
        try:
            cells_hex = sorted({c if h3.get_resolution(c) == 5 else h3.cell_to_parent(c, 5) for c in raw if h3.get_resolution(c) >= 5})
        except Exception as e:  # noqa: BLE001
            raise AreaError("invalid_geometry", "h3_cells contains an invalid H3 id.") from e
        if not cells_hex:
            raise AreaError("invalid_geometry", "h3_cells must be resolution 5 or finer.")
    return _finish(store, sorted(set(cells_hex)), name)


def _finish(store: Store, cells_hex: list[str], name: str) -> dict:
    max_cells = int(store.cfg["api"]["max_area_cells_r5"])
    if len(cells_hex) > max_cells:
        raise AreaError("area_too_large", f"This area has {len(cells_hex):,} grid cells; the limit is {max_cells:,}. Pick a smaller area.")
    cells_int = [h3.str_to_int(c) for c in cells_hex]
    land = store.land
    n_land = sum(1 for c in cells_int if c in land)
    coverage = "none" if n_land == 0 else ("full" if n_land == len(cells_int) else "partial")
    if coverage == "none":
        raise AreaError("outside_coverage", "This area has no land in the fire record (open ocean is not covered).")
    lls = [h3.cell_to_latlng(c) for c in cells_hex]
    lats = [p[0] for p in lls]; lons = [p[1] for p in lls]
    area_km2 = sum(h3.cell_area(c, "km^2") for c in cells_hex)
    area_id = "a_" + hashlib.sha1(",".join(cells_hex).encode()).hexdigest()[:12]
    body = {"area_id": area_id, "name": name, "area_km2": round(area_km2, 1), "n_cells_r5": len(cells_hex),
            "bbox": [round(min(lons), 4), round(min(lats), 4), round(max(lons), 4), round(max(lats), 4)],
            "centroid": [round(sum(lons) / len(lons), 4), round(sum(lats) / len(lats), 4)],
            "coverage": coverage, "small_area_warning": area_km2 < float(store.cfg["api"].get("small_area_km2", 2000)),
            "cells_r5": cells_hex}
    _cache[area_id] = {**body, "_cells_int": cells_int}
    _cache.move_to_end(area_id)
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)
    return body


def _unit_area(store: Store, unit: str) -> dict:
    """Whole country, biome or the world: served from precomputed totals (no cell limit).
    Additive fields: kind ('country'|'biome'|'world'), unit. cells_r5 is listed only when it is small enough for cell queries."""
    u = store.agg_units.filter(store.agg_units["unit"] == unit)
    if u.height == 0:
        raise AreaError("not_found", f"No region with id {unit}.", 404)
    row = u.row(0, named=True); lk = store.lookup
    if row["kind"] == "country":
        sel = lk.filter(lk["iso3"] == unit[4:])
    elif row["kind"] == "biome":
        sel = lk.filter(lk["biome_id"] == int(unit[6:]))
    else:
        sel = lk
    max_cells = int(store.cfg["api"]["max_area_cells_r5"])
    cells_int = sel["r5"].to_list() if sel.height <= max_cells else []
    lats, lons = sel["lat"], sel["lon"]
    area_id = "a_" + hashlib.sha1(unit.encode()).hexdigest()[:12]
    body = {"area_id": area_id, "name": row["name"], "area_km2": round(float(row["area_km2"]), 1), "n_cells_r5": int(row["n_cells_r5"]),
            "bbox": [round(float(lons.min()), 4), round(float(lats.min()), 4), round(float(lons.max()), 4), round(float(lats.max()), 4)],
            "centroid": [round(float(lons.mean()), 4), round(float(lats.mean()), 4)], "coverage": "full", "small_area_warning": False,
            "cells_r5": [h3.int_to_str(int(c)) for c in cells_int], "kind": row["kind"], "unit": unit}
    _cache[area_id] = {**body, "_cells_int": cells_int, "_unit": unit}
    _cache.move_to_end(area_id)
    return body


def get_area(area_id: str) -> dict:
    a = _cache.get(area_id)
    if a is None:
        raise AreaError("not_found", "This area is no longer cached; please select it again.", 404)
    _cache.move_to_end(area_id)
    return a


def public(a: dict) -> dict:
    return {k: v for k, v in a.items() if not k.startswith("_")}
