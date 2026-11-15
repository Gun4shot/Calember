"""Data conversion.

Streams every country CSV inside each FIRMS yearly zip into one zstd Parquet file per zip:
  <out>/product=<modis|viirs-snpp|viirs-jpss1>/year=<YYYY>/part.parquet
Raw columns are kept as-is (no cleaning), plus `country` (from the file name) and `src_file`.
A manifest with row counts per (product, year, country) is written to <out>/_manifest.csv.
Usage: python -P convert_firms.py <zips_dir> <out_dir>
"""
from __future__ import annotations

import csv
import io
import re
import sys
import time
import zipfile
from pathlib import Path

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq

MODIS_COLS = ["latitude", "longitude", "brightness", "scan", "track", "acq_date", "acq_time",
              "satellite", "instrument", "confidence", "version", "bright_t31", "frp", "daynight", "type"]
VIIRS_COLS = ["latitude", "longitude", "bright_ti4", "scan", "track", "acq_date", "acq_time",
              "satellite", "instrument", "confidence", "version", "bright_ti5", "frp", "daynight", "type"]


def schema_for(product: str) -> pa.Schema:
    modis = product == "modis"
    f = [
        ("latitude", pa.float64()), ("longitude", pa.float64()),
        ("brightness" if modis else "bright_ti4", pa.float32()),
        ("scan", pa.float32()), ("track", pa.float32()),
        ("acq_date", pa.string()), ("acq_time", pa.string()),
        ("satellite", pa.string()), ("instrument", pa.string()),
        ("confidence", pa.string()), ("version", pa.string()),
        ("bright_t31" if modis else "bright_ti5", pa.float32()),
        ("frp", pa.float32()), ("daynight", pa.string()), ("type", pa.int8()),
        ("country", pa.string()), ("src_file", pa.string()),
    ]
    return pa.schema(f)


def main(zips_dir: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = out_dir / "_manifest.csv"
    done = set()
    if manifest.exists():
        with manifest.open() as fh:
            done = {r["zip"] for r in csv.DictReader(fh)}
    new_manifest = not manifest.exists()
    mfh = manifest.open("a", newline="")
    mw = csv.DictWriter(mfh, fieldnames=["zip", "product", "year", "country", "rows", "bytes_csv"])
    if new_manifest:
        mw.writeheader()

    for zp in sorted(zips_dir.glob("*_all_countries.zip")):
        if zp.name in done:
            print("skip", zp.name, flush=True)
            continue
        m = re.match(r"(modis|viirs-snpp|viirs-jpss1)_(\d{4})_all_countries\.zip", zp.name)
        if not m:
            raise ValueError(f"unexpected zip name {zp.name}")
        product, year = m.group(1), m.group(2)
        schema = schema_for(product)
        cols = MODIS_COLS if product == "modis" else VIIRS_COLS
        target = out_dir / f"product={product}" / f"year={year}" / "part.parquet"
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        t0 = time.time()
        total = 0
        rows_log = []
        with zipfile.ZipFile(zp) as z, pq.ParquetWriter(tmp, schema, compression="zstd") as w:
            for info in z.infolist():
                if not info.filename.endswith(".csv"):
                    continue
                country = re.sub(rf"^{re.escape(product)}_{year}_", "", Path(info.filename).stem)
                data = z.read(info)
                if not data.strip():
                    continue
                conv = pacsv.ConvertOptions(
                    column_types={c: schema.field(c).type for c in cols},
                    include_columns=cols,
                )
                tbl = pacsv.read_csv(io.BytesIO(data), convert_options=conv)
                header = tbl.column_names
                if header != cols:
                    raise ValueError(f"{zp.name}:{info.filename} header {header} != {cols}")
                n = tbl.num_rows
                tbl = tbl.append_column("country", pa.array([country] * n, pa.string()))
                tbl = tbl.append_column("src_file", pa.array([zp.name] * n, pa.string()))
                w.write_table(tbl.cast(schema), row_group_size=1_000_000)
                total += n
                rows_log.append({"zip": zp.name, "product": product, "year": year,
                                 "country": country, "rows": n, "bytes_csv": info.file_size})
        tmp.replace(target)
        for r in rows_log:
            mw.writerow(r)
        mfh.flush()
        print(f"{zp.name}: {total:,} rows, {len(rows_log)} countries, "
              f"{target.stat().st_size/1e6:.0f} MB parquet, {time.time()-t0:.0f}s", flush=True)
    mfh.close()


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
