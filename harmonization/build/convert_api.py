"""data conversion: FIRMS API chunk CSVs -> one Parquet per source.
Checks: header, strict CSV parse (pyarrow raises on ragged rows), date coverage, exact duplicate rows.
Usage: python -P convert_api.py <repo>
"""
import sys
from datetime import date, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as pacsv
import pyarrow.parquet as pq

repo = Path(sys.argv[1])
src_root = repo / "data/raw/firms/api"
out_root = repo / "data/interim/firms_api"
out_root.mkdir(parents=True, exist_ok=True)
for d in sorted(p for p in src_root.iterdir() if p.is_dir()):
    src = d.name
    modis = src.startswith("MODIS")
    b1, b2 = ("brightness", "bright_t31") if modis else ("bright_ti4", "bright_ti5")
    types = {"latitude": pa.float64(), "longitude": pa.float64(), b1: pa.float32(), "scan": pa.float32(), "track": pa.float32(),
             "acq_date": pa.string(), "acq_time": pa.string(), "satellite": pa.string(), "instrument": pa.string(),
             "confidence": pa.string(), "version": pa.string(), b2: pa.float32(), "frp": pa.float32(), "daynight": pa.string()}
    tabs, covered = [], set()
    for f in sorted(d.glob("*.csv")):
        t = pacsv.read_csv(f, convert_options=pacsv.ConvertOptions(column_types=types))
        if "type" not in t.column_names:
            t = t.append_column("type", pa.nulls(t.num_rows, pa.int8()))
        else:
            t = t.set_column(t.column_names.index("type"), "type", pc.cast(t["type"], pa.int8()))
        t = t.select(list(types) + ["type"])
        s, n = f.stem.split("_"); s = date.fromisoformat(s)
        covered |= {s + timedelta(days=i) for i in range(int(n))}
        tabs.append(t)
    t = pa.concat_tables(tabs)
    n0 = t.num_rows
    t = pa.Table.from_pandas(t.to_pandas().drop_duplicates(), preserve_index=False)
    dmin, dmax = pc.min(t["acq_date"]).as_py(), pc.max(t["acq_date"]).as_py()
    span = (max(covered) - min(covered)).days + 1
    pq.write_table(t, out_root / f"{src}.parquet", compression="zstd")
    sats = pc.unique(t["satellite"]).to_pylist()
    print(f"{src}: {n0:,} rows ({n0 - t.num_rows:,} exact dups removed), requested days {len(covered)}/{span} contiguous, "
          f"data {dmin}..{dmax}, sats {sats}", flush=True)
