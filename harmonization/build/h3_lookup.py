"""r5 cell centre -> RESOLVE biome, ecoregion, NE admin-0/admin-1.
Usage: python -P h3_lookup.py <repo>
"""
import sys
import time
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import pandas as pd

repo = Path(sys.argv[1])
aux = repo / "data/raw/aux"
out = repo / "data/interim/aux"
out.mkdir(parents=True, exist_ok=True)
t0 = time.time()
cells = [c for r0 in h3.get_res0_cells() for c in h3.cell_to_children(r0, 5)]
ll = np.array([h3.cell_to_latlng(c) for c in cells])
pts = gpd.GeoDataFrame({"h3_r5": cells}, geometry=gpd.points_from_xy(ll[:, 1], ll[:, 0]), crs="EPSG:4326")
print(f"{len(cells):,} r5 cells in {time.time()-t0:.0f}s", flush=True)

eco = gpd.read_file(aux / "ecoregions/Ecoregions2017.shp")[["BIOME_NUM", "BIOME_NAME", "ECO_ID", "ECO_NAME", "geometry"]]
eco["biome_id"] = np.where(eco.BIOME_NAME.eq("N/A"), 0, eco.BIOME_NUM.fillna(0)).astype("int8")
a0 = gpd.read_file(aux / "ne/ne_10m_admin_0_countries.shp")[["ADM0_A3", "NAME", "geometry"]]
a1 = gpd.read_file(aux / "ne/ne_10m_admin_1_states_provinces.shp")[["adm1_code", "name", "adm0_a3", "geometry"]]

j = gpd.sjoin(pts, eco, how="left", predicate="within").drop_duplicates("h3_r5")
print(f"biome join {time.time()-t0:.0f}s", flush=True)
j = gpd.sjoin(j.drop(columns="index_right"), a0, how="left", predicate="within").drop_duplicates("h3_r5")
j = gpd.sjoin(j.drop(columns="index_right"), a1, how="left", predicate="within").drop_duplicates("h3_r5")
print(f"admin joins {time.time()-t0:.0f}s", flush=True)
df = pd.DataFrame({
    "h3_r5": j.h3_r5, "lat": ll[:, 0], "lon": ll[:, 1],
    "biome_id": j.biome_id.fillna(0).astype("int8"), "biome_name": j.BIOME_NAME, "eco_id": j.ECO_ID, "eco_name": j.ECO_NAME,
    "iso3": j.ADM0_A3, "country_name": j.NAME, "adm1_code": j.adm1_code, "adm1_name": j["name"],
})
df["h3_r5_u64"] = df.h3_r5.map(h3.str_to_int).astype("uint64")
df = df[df.biome_id.gt(0) | df.iso3.notna()]  # land-ish cells only
df.to_parquet(out / "h3r5_lookup.parquet", index=False)
print(f"kept {len(df):,} land cells; biome coverage {df.biome_id.gt(0).mean():.3f}; written in {time.time()-t0:.0f}s")
print(df.groupby(["biome_id", "biome_name"]).size().to_string())
