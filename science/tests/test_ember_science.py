import datetime as dt
import math

import numpy as np
import polars as pl
import pytest

from ember_science import anomalies, area_monthly, climatology, season_metrics, year_totals


def _cm(rows):
    base = dict(raw_modis_n=0, raw_snpp_n=0, raw_noaa20_n=0, raw_noaa21_n=0, provisional=False, regime="M")
    return pl.DataFrame([{**base, **r} for r in rows])


def test_area_monthly_uncertainty_combines_sys_per_biome_and_rand_in_quadrature():
    cm = _cm([
        dict(h3_r5_u64=1, month="2005-01", biome_id=7, h_count=10.0, h_sd_rand=3.0, h_sd_sys=1.0),
        dict(h3_r5_u64=2, month="2005-01", biome_id=7, h_count=20.0, h_sd_rand=4.0, h_sd_sys=2.0),
        dict(h3_r5_u64=3, month="2005-01", biome_id=1, h_count=5.0, h_sd_rand=0.0, h_sd_sys=2.0),
    ])
    m = area_monthly(cm).row(0, named=True)
    # sys: biome 7 -> (1+2)^2 = 9, biome 1 -> 4 ; rand: 9 + 16 = 25  -> sqrt(38)
    assert m["h_count"] == pytest.approx(35.0)
    assert m["sd_area"] == pytest.approx(math.sqrt(38))
    assert m["lo90"] == pytest.approx(35 - 1.645 * math.sqrt(38))


def test_area_monthly_fills_missing_months_with_zero():
    cm = _cm([dict(h3_r5_u64=1, month="2005-02", biome_id=7, h_count=4.0, h_sd_rand=2.0, h_sd_sys=0.0)])
    m = area_monthly(cm, months=["2005-01", "2005-02", "2005-03"])
    assert m["h_count"].to_list() == [0.0, 4.0, 0.0]
    assert m["lo90"].min() >= 0


def _monthly(values_by_year):
    rows = []
    for y, vals in values_by_year.items():
        for k, v in enumerate(vals, start=1):
            rows.append(dict(month=f"{y}-{k:02d}", h_count=float(v), sd_area=1.0))
    return pl.DataFrame(rows)


def test_anomalies_leave_one_out_and_categories():
    years = {y: [10] * 12 for y in range(2003, 2013)}
    years[2013] = [50] + [10] * 11  # record January
    m = anomalies(_monthly(years), (2003, 2025))
    jan13 = m.filter(pl.col("month") == "2013-01").row(0, named=True)
    assert jan13["median_m"] == 10.0  # own year excluded
    assert jan13["ratio_to_median"] == 5.0
    assert jan13["pct_rank"] == 100.0
    assert jan13["category"] == "record"
    feb13 = m.filter(pl.col("month") == "2013-02").row(0, named=True)
    assert feb13["pct_rank"] == 50.0 and feb13["category"] == "normal"
    assert feb13["robust_z"] is None  # MAD = 0


def test_climatology_and_year_totals():
    m = _monthly({y: [y - 2000] * 12 for y in range(2003, 2008)})
    c = climatology(m, (2003, 2025))
    assert c.height == 12 and c["median"][0] == 5.0 and c["n_years"][0] == 5
    yt = year_totals(m, complete_through="2026-10")
    assert yt.filter(pl.col("year") == 2007)["rank"][0] == 1
    assert yt["complete"].all()


def test_season_metrics_finds_onset_peak_end():
    days = pl.date_range(dt.date(2003, 1, 1), dt.date(2012, 12, 31), "1d", eager=True)
    doy = np.array([d.timetuple().tm_yday for d in days])
    h = np.exp(-0.5 * ((doy - 90) / 12.0) ** 2) * 10  # peak around 31 March every year
    yrs, tr = season_metrics(pl.DataFrame({"date": days, "h_count": h}), {"smooth_days": 15, "onset_frac": 0.1, "end_frac": 0.9, "min_hotspots": 20})
    assert tr["fire_year_start_month"] in (8, 9, 10, 11, 12, 1)  # month after the climatological minimum
    ok = yrs.filter(~pl.col("insufficient"))
    assert ok.height >= 8
    peaks = [dt.date.fromisoformat(p).timetuple().tm_yday for p in ok["peak"].to_list()]
    assert all(abs(p - 90) <= 3 for p in peaks)
    assert abs(tr["onset"]["sen_days_per_decade"]) < 1
