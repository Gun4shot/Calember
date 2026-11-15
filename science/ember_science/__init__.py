"""ember_science: pure functions used by the API at runtime (CONTRACTS §3.3).

These are area-level statistics on top of the harmonized product (Guideline §4.7, §4.8, §4.10).
The harmonization model itself is built by harmonization/build (see the README).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import polars as pl
from scipy import stats

__all__ = ["MONTH_NAMES", "CATEGORY_RULE", "area_monthly", "climatology", "anomalies", "year_totals", "season_metrics", "season_summary", "calendar_summary", "to_meh_nrt", "Z90"]

Z90 = 1.645
RAW_COLS = ["raw_modis_n", "raw_snpp_n", "raw_noaa20_n", "raw_noaa21_n"]
CATS = ("much_below", "below", "normal", "above", "much_above", "record")


def area_monthly(cell_month: pl.DataFrame, months: list[str] | None = None) -> pl.DataFrame:
    """Aggregate harmonized cell-months of one area to monthly totals with a 90 % interval.

    sd_area = sqrt( sum_biomes (sum_cells_in_biome h_sd_sys)^2 + sum_cells h_sd_rand^2 )   (Guideline §4.10)
    `months` (optional) lists every month to return; months without rows are zero (consumers treat missing as 0).
    Output: month, regime, h_count, sd_area, lo90, hi90, raw_modis_n, raw_snpp_n, raw_noaa20_n, raw_noaa21_n, provisional,
            plus the optional QA fields modis_outage and fill_frac (area share of h_count that was gap-filled).
    """
    cm = cell_month
    has_out = "modis_outage" in cm.columns
    has_fill = "fill_frac" in cm.columns
    by_biome = cm.group_by("month", "biome_id").agg(sys_b=pl.col("h_sd_sys").cast(pl.Float64).sum())
    sys = by_biome.group_by("month").agg(sys2=(pl.col("sys_b") ** 2).sum())
    agg = [
        pl.col("h_count").cast(pl.Float64).sum().alias("h_count"),
        (pl.col("h_sd_rand").cast(pl.Float64) ** 2).sum().alias("rand2"),
        *[pl.col(c).cast(pl.Int64).sum().alias(c) for c in RAW_COLS],
        pl.col("provisional").any().alias("provisional"),
        # one regime per month in the product; take the most common to be safe
        pl.col("regime").mode().first().alias("regime"),
    ]
    if has_out:
        agg.append(pl.col("modis_outage").any().alias("modis_outage"))
    if has_fill:
        agg.append((pl.col("h_count").cast(pl.Float64) * pl.col("fill_frac").cast(pl.Float64)).sum().alias("_filled"))
    m = cm.group_by("month").agg(agg).join(sys, on="month", how="left")
    m = m.with_columns(sd_area=(pl.col("sys2").fill_null(0) + pl.col("rand2")).sqrt())
    if has_fill:
        m = m.with_columns(fill_frac=pl.when(pl.col("h_count") > 0).then(pl.col("_filled") / pl.col("h_count")).otherwise(0.0))
    if months is not None:
        frame = pl.DataFrame({"month": months}, schema={"month": pl.String})
        m = frame.join(m, on="month", how="left").with_columns(
            pl.col("regime").fill_null(pl.col("month").map_elements(regime_of, return_dtype=pl.String)),
            *[pl.col(c).fill_null(0) for c in ["h_count", "sd_area", *RAW_COLS]],
            pl.col("provisional").fill_null(pl.col("month") >= "2026-08"),
            *([pl.col("modis_outage").fill_null(False)] if has_out else []),
            *([pl.col("fill_frac").fill_null(0.0)] if has_fill else []),
        )
    m = m.with_columns(lo90=(pl.col("h_count") - Z90 * pl.col("sd_area")).clip(0, None), hi90=pl.col("h_count") + Z90 * pl.col("sd_area"))
    cols = ["month", "regime", "h_count", "sd_area", "lo90", "hi90", *RAW_COLS, "provisional"]
    cols += (["modis_outage"] if has_out else []) + (["fill_frac"] if has_fill else [])
    return m.select(cols).sort("month")


def regime_of(month: str) -> str:
    if month <= "2002-06":
        return "T"
    if month <= "2011-12":
        return "M"
    if month <= "2019-12":
        return "B"
    if month <= "2026-07":
        return "V"
    return "N"


def _with_ym(monthly: pl.DataFrame) -> pl.DataFrame:
    return monthly.with_columns(year=pl.col("month").str.slice(0, 4).cast(pl.Int32), month_num=pl.col("month").str.slice(5, 2).cast(pl.Int32))


def climatology(monthly: pl.DataFrame, baseline: tuple[int, int]) -> pl.DataFrame:
    """Per calendar month over the baseline years: median, p10, p25, p75, p90, mean, n_years."""
    m = _with_ym(monthly).filter(pl.col("year").is_between(baseline[0], baseline[1]))
    rows = []
    for k in range(1, 13):
        v = m.filter(pl.col("month_num") == k)["h_count"].to_numpy().astype(float)
        if len(v) == 0:
            rows.append(dict(month_num=k, median=None, p10=None, p25=None, p75=None, p90=None, mean=None, n_years=0))
            continue
        q = np.percentile(v, [10, 25, 50, 75, 90])
        rows.append(dict(month_num=k, median=float(q[2]), p10=float(q[0]), p25=float(q[1]), p75=float(q[3]), p90=float(q[4]),
                         mean=float(v.mean()), n_years=int(len(v))))
    return pl.DataFrame(rows, schema={"month_num": pl.Int32, "median": pl.Float64, "p10": pl.Float64, "p25": pl.Float64,
                                      "p75": pl.Float64, "p90": pl.Float64, "mean": pl.Float64, "n_years": pl.Int32})


def _category(pct: float | None, x: float, smax: float | None, bounds: dict[str, float]) -> str | None:
    if pct is None:
        return None
    if smax is not None and x > smax and x > 0:
        return "record"
    if pct < bounds["much_below"]:
        return "much_below"
    if pct < bounds["below"]:
        return "below"
    if pct > bounds["much_above"]:
        return "much_above"
    if pct > bounds["above"]:
        return "above"
    return "normal"


def anomalies(monthly: pl.DataFrame, baseline: tuple[int, int], bounds: dict[str, float] | None = None) -> pl.DataFrame:
    """Adds median_m, ratio_to_median, pct_rank, robust_z, category (Guideline §4.7). The baseline excludes the row's own year."""
    bounds = bounds or {"much_below": 10, "below": 25, "above": 75, "much_above": 90}
    m = _with_ym(monthly)
    base = m.filter(pl.col("year").is_between(baseline[0], baseline[1])).select("year", "month_num", "h_count")
    pools: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    for k in range(1, 13):
        b = base.filter(pl.col("month_num") == k)
        pools[k] = (b["year"].to_numpy(), b["h_count"].to_numpy().astype(float))
    out = {"median_m": [], "ratio_to_median": [], "pct_rank": [], "robust_z": [], "category": []}
    for y, k, x in zip(m["year"].to_list(), m["month_num"].to_list(), m["h_count"].to_list()):
        yrs, vals = pools[k]
        s = vals[yrs != y]
        if len(s) == 0:
            for key in out:
                out[key].append(None)
            continue
        med = float(np.median(s))
        pct = 100.0 * (np.sum(s < x) + 0.5 * np.sum(s == x)) / len(s)
        ls = np.log1p(s); mad = float(np.median(np.abs(ls - np.median(ls))))
        rz = (math.log1p(x) - float(np.median(ls))) / (1.4826 * mad) if mad > 0 else None
        out["median_m"].append(med)
        out["ratio_to_median"].append(x / med if med > 0 else None)
        out["pct_rank"].append(float(pct))
        out["robust_z"].append(rz)
        out["category"].append(_category(float(pct), x, float(s.max()), bounds))
    return monthly.with_columns(
        pl.Series("median_m", out["median_m"], dtype=pl.Float64), pl.Series("ratio_to_median", out["ratio_to_median"], dtype=pl.Float64),
        pl.Series("pct_rank", out["pct_rank"], dtype=pl.Float64), pl.Series("robust_z", out["robust_z"], dtype=pl.Float64),
        pl.Series("category", out["category"], dtype=pl.String))


def year_totals(monthly: pl.DataFrame, complete_through: str) -> pl.DataFrame:
    """Calendar-year totals with a 90 % interval (sd combined in quadrature across months, a conservative-enough approximation
    for the random part; systematic parts are summed linearly per month already inside sd_area), rank among complete years."""
    m = _with_ym(monthly)
    y = (m.group_by("year").agg(total=pl.col("h_count").sum(), var=(pl.col("sd_area") ** 2).sum(), n_months=pl.len(),
                               last=pl.col("month").max(), first=pl.col("month").min())
          .with_columns(sd=pl.col("var").sqrt()).sort("year"))
    y = y.with_columns(complete=(pl.col("n_months") == 12) & (pl.col("last") <= complete_through))
    comp = y.filter(pl.col("complete"))
    order = comp.sort("total", descending=True)["year"].to_list()
    rank = {yr: i + 1 for i, yr in enumerate(order)}
    return y.select(
        "year", "total", (pl.col("total") - Z90 * pl.col("sd")).clip(0, None).alias("lo90"), (pl.col("total") + Z90 * pl.col("sd")).alias("hi90"),
        pl.col("year").map_elements(lambda v: rank.get(v), return_dtype=pl.Int32).alias("rank"),
        pl.lit(len(order), dtype=pl.Int32).alias("n_years"), "complete")


MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def calendar_summary(clim: pl.DataFrame, years: pl.DataFrame, monthly: pl.DataFrame) -> str:
    """Plain-language 1-2 sentence summary generated from the numbers (no invented values)."""
    parts = []
    c = clim.drop_nulls("median")
    if c.height and float(c["median"].max()) > 0:
        peak = int(c.sort("median", descending=True)["month_num"][0])
        parts.append(f"{MONTH_NAMES[peak - 1]} is the peak burning month.")
    else:
        parts.append("Very few hotspots are recorded in this area.")
    comp = years.filter(pl.col("complete"))
    if comp.height and float(comp["total"].max()) > 0:
        top = comp.sort("total", descending=True).row(0, named=True)
        low = comp.sort("total").row(0, named=True)
        parts.append(f"{top['year']} was the most active year on record ({top['total']:,.0f} hotspots, MODIS-equivalent); "
                     f"{low['year']} was the quietest ({low['total']:,.0f}).")
    return " ".join(parts)


def _p(p: float) -> str:
    return "p < 0.01" if p < 0.01 else f"p = {p:.2f}"


def season_summary(yrs: pl.DataFrame, trends: dict, two_seasons: tuple[str, str] | None = None) -> str:
    """Plain-language season summary; only trends with p < 0.05 are called a trend."""
    import datetime as dt
    ok = yrs.filter(~pl.col("insufficient")) if yrs.height else yrs
    if ok.height < 5:
        return "Too few fires in most years to measure the fire season reliably."
    start_m = int(trends["fire_year_start_month"])

    def typical(col: str) -> str:
        d = float(np.median(ok[col].to_numpy()))
        base = dt.date(2001, start_m, 1) + dt.timedelta(days=round(d))
        return f"{MONTH_NAMES[base.month - 1][:3]} {base.day}"

    if two_seasons:
        parts = [f"This area has two fire seasons, around {two_seasons[0]} and around {two_seasons[1]}. Counting both, the fire year typically "
                 f"starts around {typical('onset_doy')}, peaks around {typical('peak_doy')} and ends around {typical('end_doy')}."]
    else:
        parts = [f"In a typical year the fire season starts around {typical('onset_doy')}, peaks around {typical('peak_doy')} and ends around {typical('end_doy')}."]
    words = {"onset": "starts", "peak": "peaks", "end": "ends"}
    sig = []
    for k in ("onset", "peak", "end"):
        t = trends.get(k) or {}
        if t.get("p") is not None and t["p"] < 0.05 and t.get("sen_days_per_decade"):
            v = t["sen_days_per_decade"]
            sig.append(f"it {words[k]} {abs(v):.0f} days {'earlier' if v < 0 else 'later'} per decade ({_p(t['p'])})")
    t = trends.get("length") or {}
    if t.get("p") is not None and t["p"] < 0.05 and t.get("sen_days_per_decade"):
        v = t["sen_days_per_decade"]
        sig.append(f"the season got {abs(v):.0f} days {'longer' if v > 0 else 'shorter'} per decade ({_p(t['p'])})")
    t = trends.get("total") or {}
    if t.get("p") is not None and t["p"] < 0.05 and t.get("sen_pct_per_decade") is not None:
        v = t["sen_pct_per_decade"]
        sig.append(f"yearly fire counts {'rose' if v > 0 else 'fell'} {abs(v):.0f} % per decade ({_p(t['p'])})")
    parts.append(("Since 2001, " + "; ".join(sig) + ".") if sig else "There is no clear trend in when the season starts, peaks or ends (p ≥ 0.05).")
    return " ".join(parts)


# ---------------- season metrics (Guideline §4.8) ----------------

def _sen_mk(x: np.ndarray, y: np.ndarray) -> tuple[float | None, float | None]:
    ok = np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(y) < 5:
        return None, None
    if np.all(y == y[0]):
        return 0.0, 1.0  # no change at all
    slope = stats.theilslopes(y, x)[0]
    p = stats.kendalltau(x, y).pvalue  # Mann-Kendall test == Kendall's tau between time and value
    return float(slope), float(p)


def season_metrics(daily: pl.DataFrame, cfg: dict[str, Any] | None = None) -> tuple[pl.DataFrame, dict]:
    """daily: columns date (Date), h_count (float), every day of the record (missing days = 0).
    Returns (per fire-year rows, trends dict) with the fields of CONTRACTS §5.6."""
    cfg = cfg or {}
    smooth = int(cfg.get("smooth_days", 15)); f_on = float(cfg.get("onset_frac", 0.10)); f_end = float(cfg.get("end_frac", 0.90))
    min_h = float(cfg.get("min_hotspots", 20))
    d = daily.sort("date").with_columns(pl.col("h_count").cast(pl.Float64))
    if d.height == 0:
        return pl.DataFrame(), {}
    full = pl.DataFrame({"date": pl.date_range(d["date"].min(), d["date"].max(), "1d", eager=True)}).join(d, on="date", how="left").fill_null(0.0)
    clim = full.group_by(pl.col("date").dt.month().alias("m")).agg(v=pl.col("h_count").mean()).sort("m")
    min_month = int(clim.sort("v")["m"][0])
    start_month = min_month % 12 + 1
    vals = full["h_count"].to_numpy()
    sm = np.convolve(vals, np.ones(smooth) / smooth, mode="same")
    full = full.with_columns(sm=pl.Series(sm))
    first, last = full["date"].min(), full["date"].max()
    import datetime as dt
    y0 = first.year if first.month <= start_month else first.year + 1
    rows = []
    y = y0 if dt.date(y0, start_month, 1) >= first else y0 + 1
    while True:
        s = dt.date(y, start_month, 1); e = dt.date(y + 1, start_month, 1) - dt.timedelta(days=1)
        if e > last:
            break
        seg = full.filter(pl.col("date").is_between(s, e))
        v = seg["h_count"].to_numpy(); tot = float(v.sum())
        fire_year = e.year
        row = dict(fire_year=fire_year, start_date=s.isoformat(), total=tot, insufficient=tot < min_h)
        if tot >= min_h:
            cs = np.cumsum(v) / tot
            on = int(np.argmax(cs >= f_on)); en = int(np.argmax(cs >= f_end)); pk = int(np.argmax(seg["sm"].to_numpy()))
            row.update(onset=(s + dt.timedelta(days=on)).isoformat(), peak=(s + dt.timedelta(days=pk)).isoformat(),
                       end=(s + dt.timedelta(days=en)).isoformat(), onset_doy=on, peak_doy=pk, end_doy=en, length_days=en - on)
        else:
            row.update(onset=None, peak=None, end=None, onset_doy=None, peak_doy=None, end_doy=None, length_days=None)
        rows.append(row)
        y += 1
    yrs = pl.DataFrame(rows, schema={"fire_year": pl.Int32, "start_date": pl.String, "onset": pl.String, "peak": pl.String, "end": pl.String,
                                     "onset_doy": pl.Int32, "peak_doy": pl.Int32, "end_doy": pl.Int32, "length_days": pl.Int32,
                                     "total": pl.Float64, "insufficient": pl.Boolean}) if rows else pl.DataFrame()
    trends: dict[str, Any] = {"fire_year_start_month": start_month}
    if yrs.height:
        ok = yrs.filter(~pl.col("insufficient"))
        x = ok["fire_year"].to_numpy().astype(float)
        for k in ("onset", "peak", "end", "length"):
            col = f"{k}_doy" if k != "length" else "length_days"
            sl, p = _sen_mk(x, ok[col].to_numpy().astype(float))
            trends[k] = {"sen_days_per_decade": None if sl is None else sl * 10, "p": p, "n": int(ok.height)}
        xt = yrs["fire_year"].to_numpy().astype(float); tt = yrs["total"].to_numpy().astype(float)
        sl, p = _sen_mk(xt, tt); mean = float(tt.mean()) if len(tt) else 0.0
        trends["total"] = {"sen_pct_per_decade": None if sl is None or mean == 0 else 100 * sl * 10 / mean, "p": p, "n": int(len(tt))}
    return yrs, trends


def to_meh_nrt(nrt_detections: pl.DataFrame, cell_factor: dict[int, float] | None = None, default_factor: float | None = None) -> pl.DataFrame:
    """Adds meh_weight to near-real-time detections (CONTRACTS §3.3).
    nrt_detections needs an `r5` column (UInt64). The weight is the cell's recent harmonized/NOAA-20 factor (h_count / raw_noaa20
    over the latest complete months), falling back to the area's factor, then to `default_factor`."""
    cell_factor = cell_factor or {}
    d = default_factor if default_factor is not None else 0.0
    return nrt_detections.with_columns(
        meh_weight=pl.col("r5").map_elements(lambda r: float(cell_factor.get(int(r), d)), return_dtype=pl.Float64))


CATEGORY_RULE = _category  # (pct_rank, value, max of baseline, bounds) -> category code (Guideline §4.7)
