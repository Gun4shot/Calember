"""Data access for the API: config, cell lookup, product queries (DuckDB over the cell-sorted product copy), science JSONs."""
from __future__ import annotations

import json
import sys
import threading
from functools import cached_property
from pathlib import Path

import duckdb
import polars as pl
import yaml

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "science"))


class Store:
    def __init__(self, repo: Path = REPO):
        self.repo = repo
        self.cfg = yaml.safe_load((repo / "config/ember.yaml").read_text(encoding="utf-8"))
        p = self.cfg["paths"]
        self.products = repo / p["products"]
        self.cell_month = repo / p["api_cell_month"]
        self.lock = threading.Lock()
        self.con = duckdb.connect()
        self.con.execute("SET threads=4")
        try:
            self.con.execute("LOAD h3")
        except Exception:  # h3 extension needed only for the hotspot export
            self.con.execute("INSTALL h3 FROM community; LOAD h3")
        mask = repo / "data/interim/explore/static_mask_r7.parquet"
        if mask.exists():
            self.con.execute(f"CREATE TABLE mask AS SELECT r7 FROM '{mask.as_posix()}'")
        else:
            self.con.execute("CREATE TABLE mask (r7 UBIGINT)")

    # ---- reference tables
    @cached_property
    def lookup(self) -> pl.DataFrame:
        """All land r5 cells: r5, lat, lon, biome_id, adm1_code, adm1_name, iso3, country_name."""
        return pl.read_parquet(self.repo / self.cfg["paths"]["h3_lookup"]).select(
            pl.col("h3_r5_u64").alias("r5"), "lat", "lon", "biome_id", "adm1_code", "adm1_name", "iso3", "country_name")

    @cached_property
    def land(self) -> set[int]:
        return set(self.lookup["r5"].to_list())

    @cached_property
    def admin_names(self) -> dict[str, str]:
        t = self.lookup.select("adm1_code", "adm1_name", "country_name").drop_nulls("adm1_code").unique("adm1_code")
        out = {r[0]: f"{r[1]}, {r[2]}" if r[1] else r[2] for r in t.iter_rows()}
        c = self.lookup.select("iso3", "country_name").drop_nulls().unique("iso3")
        out.update({f"ISO-{r[0]}": r[1] for r in c.iter_rows()})
        return out

    @cached_property
    def meta(self) -> dict:
        f = self.products / "harmonized_cell_month.parquet.meta.json"
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}

    @cached_property
    def refsrc(self) -> dict[str, str]:
        f = self.products / "work/refsrc.json"
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}

    def product_json(self, name: str) -> dict | list | None:
        f = self.products / name
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None

    @cached_property
    def turing(self) -> dict:
        return self.product_json("turing_rounds.json") or {"rounds": []}

    # ---- queries
    def area_rows(self, cells: list[int], start: str = "0000-00", end: str = "9999-99") -> pl.DataFrame:
        """Product rows for the given r5 cells (cell-sorted file + range filter -> row-group pruning)."""
        if not cells:
            return pl.DataFrame()
        with self.lock:
            self.con.register("area_cells", pl.DataFrame({"h3_r5_u64": cells}, schema={"h3_r5_u64": pl.UInt64}).to_arrow())
            q = (f"SELECT p.* FROM read_parquet('{self.cell_month.as_posix()}') p SEMI JOIN area_cells USING (h3_r5_u64) "
                 f"WHERE p.h3_r5_u64 BETWEEN {min(cells)} AND {max(cells)} AND p.month BETWEEN '{start}' AND '{end}'")
            out = pl.from_arrow(self.con.sql(q).to_arrow_table())
            self.con.unregister("area_cells")
        return out


    # ---- daily harmonized counts (pipeline/build_daily.py)
    def area_daily(self, cells: list[int], unit: str | None, start: str = "2000-11-01", end: str = "2026-12-31") -> pl.DataFrame:
        """date, h for an area: precomputed unit totals, or a cell query on the cell-sorted daily table."""
        if unit:
            f = self.products / "api/agg_day.parquet"
            if not f.exists():
                return pl.DataFrame(schema={"date": pl.Date, "h": pl.Float64})
            with self.lock:
                out = pl.from_arrow(self.con.sql(f"SELECT date, h FROM '{f.as_posix()}' WHERE unit = '{unit}' AND date BETWEEN '{start}' AND '{end}' ORDER BY date").to_arrow_table())
            return out.with_columns(pl.col("h").cast(pl.Float64))
        f = self.products / "api/cell_day_by_cell.parquet"
        if not cells or not f.exists():
            return pl.DataFrame(schema={"date": pl.Date, "h": pl.Float64})
        with self.lock:
            self.con.register("day_cells", pl.DataFrame({"r5": cells}, schema={"r5": pl.UInt64}).to_arrow())
            q = (f"SELECT d.date, sum(d.h) AS h FROM read_parquet('{f.as_posix()}') d SEMI JOIN day_cells USING (r5) "
                 f"WHERE d.r5 BETWEEN {min(cells)} AND {max(cells)} AND d.date BETWEEN '{start}' AND '{end}' GROUP BY 1 ORDER BY 1")
            out = pl.from_arrow(self.con.sql(q).to_arrow_table())
            self.con.unregister("day_cells")
        return out.with_columns(pl.col("h").cast(pl.Float64))

    # ---- large units (countries, biomes, world): precomputed monthly totals (pipeline/build_aggregates.py)
    @cached_property
    def agg_units(self) -> pl.DataFrame:
        f = self.products / "api/agg_units.parquet"
        return pl.read_parquet(f) if f.exists() else pl.DataFrame(schema={"unit": pl.String, "kind": pl.String, "name": pl.String})

    @cached_property
    def agg_month(self) -> pl.DataFrame:
        f = self.products / "api/agg_month.parquet"
        return pl.read_parquet(f) if f.exists() else pl.DataFrame()

    def unit_monthly(self, unit: str, months: list[str]) -> pl.DataFrame:
        """Same shape as ember_science.area_monthly output, from the precomputed totals."""
        from ember_science import Z90, regime_of
        a = self.agg_month.filter(pl.col("unit") == unit)
        frame = pl.DataFrame({"month": months}, schema={"month": pl.String})
        m = frame.join(a, on="month", how="left").with_columns(
            pl.col("h_count").fill_null(0.0), pl.col("sys2").fill_null(0.0), pl.col("rand2").fill_null(0.0),
            *[pl.col(c).fill_null(0).cast(pl.Int64) for c in ("raw_modis_n", "raw_snpp_n", "raw_noaa20_n", "raw_noaa21_n")],
            pl.col("provisional").fill_null(pl.col("month") >= "2026-08"), pl.col("modis_outage").fill_null(False), pl.col("filled").fill_null(0.0))
        m = m.with_columns(sd_area=(pl.col("sys2") + pl.col("rand2")).sqrt(),
                           regime=pl.col("month").map_elements(regime_of, return_dtype=pl.String),
                           fill_frac=pl.when(pl.col("h_count") > 0).then(pl.col("filled") / pl.col("h_count")).otherwise(0.0))
        m = m.with_columns(lo90=(pl.col("h_count") - Z90 * pl.col("sd_area")).clip(0, None), hi90=pl.col("h_count") + Z90 * pl.col("sd_area"))
        return m.select("month", "regime", "h_count", "sd_area", "lo90", "hi90", "raw_modis_n", "raw_snpp_n", "raw_noaa20_n", "raw_noaa21_n",
                        "provisional", "modis_outage", "fill_frac").sort("month")


_store: Store | None = None


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store()
    return _store
