"""Fire Twins and the fire-regime atlas (Guideline §4.9). Pure functions; the index is built by pipeline/build_twins.py.

Features of a unit (baseline years, monthly harmonized counts):
  shape12   12-month climatology normalized to sum 1
  peak      circular mean month (1-12, float) and R = seasonal concentration (0 = year-round, 1 = one month)
  density   log10(mean annual MEH per km^2)
  cv        interannual coefficient of variation of annual totals
  trend     Sen's slope of annual totals, % of the mean per decade
  bimodal   two separated seasonal peaks
  night     share of VIIRS detections at night (reported, not used in the distance)
Distance: d^2 = w_shape (|dshape| / s_shape)^2 + w_density dz_density^2 + w_conc dz_R^2 + w_var dz_cv^2 + w_trend dz_trend^2
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy import stats

MONTHS3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
ANG = 2 * np.pi * (np.arange(12) + 0.5) / 12


@dataclass
class Features:
    shape12: np.ndarray
    peak_month: float
    R: float
    density: float
    cv: float
    trend: float
    bimodal: bool
    night: float | None
    mean_annual: float


def features(monthly_by_year: dict[int, np.ndarray], area_km2: float, night: float | None = None) -> Features | None:
    """monthly_by_year: {year: array of 12 monthly MEH}; baseline years only."""
    if not monthly_by_year:
        return None
    m = np.array(list(monthly_by_year.values()), dtype=float)
    clim = m.mean(axis=0)
    tot = clim.sum()
    if tot <= 0:
        return None
    shape = clim / tot
    vx, vy = (shape * np.cos(ANG)).sum(), (shape * np.sin(ANG)).sum()
    R = float(math.hypot(vx, vy))
    pk = (math.atan2(vy, vx) % (2 * np.pi)) / (2 * np.pi) * 12 + 0.5
    annual = m.sum(axis=1)
    cv = float(annual.std() / annual.mean()) if annual.mean() > 0 else 0.0
    yrs = np.array(list(monthly_by_year.keys()), dtype=float)
    slope = stats.theilslopes(annual, yrs)[0] if len(yrs) >= 5 and annual.std() > 0 else 0.0
    trend = float(100 * slope * 10 / annual.mean()) if annual.mean() > 0 else 0.0
    return Features(shape, float(pk), R, float(np.log10(max(annual.mean(), 1e-6) / max(area_km2, 1e-6))), cv, trend, is_bimodal(shape), night,
                    float(annual.mean()))


def is_bimodal(shape: np.ndarray) -> bool:
    """Two fire seasons: a second peak >= 3 months from the main one, at least 20 % of its height, a trough between them below
    half the second peak, and >= 10 % of the year's fire within one month of the second peak."""
    k1 = int(np.argmax(shape))
    cd = lambda a, b: min(abs(a - b), 12 - abs(a - b))
    far = [i for i in range(12) if cd(i, k1) >= 3]
    k2 = max(far, key=lambda i: shape[i])
    if shape[k2] < 0.2 * shape[k1]:
        return False
    fwd = [(k1 + t) % 12 for t in range(1, (k2 - k1) % 12)]
    bwd = [(k2 + t) % 12 for t in range(1, (k1 - k2) % 12)]
    arc = fwd if len(fwd) <= len(bwd) else bwd
    trough = min(shape[i] for i in arc) if arc else shape[k2]
    mass2 = sum(shape[(k2 + t) % 12] for t in (-1, 0, 1) if cd((k2 + t) % 12, k1) >= 2)
    return bool(trough < 0.5 * shape[k2] and mass2 >= 0.10)


def months_text(shape: np.ndarray, frac: float = 0.6) -> str:
    """Contiguous range of months around the peak where the shape is >= frac x max, e.g. 'Jul-Sep'."""
    k = int(np.argmax(shape)); thr = frac * shape[k]
    a = k
    while shape[(a - 1) % 12] >= thr and (a - 1) % 12 != k:
        a = (a - 1) % 12
    b = k
    while shape[(b + 1) % 12] >= thr and (b + 1) % 12 != a:
        b = (b + 1) % 12
    return MONTHS3[a] if a == b else f"{MONTHS3[a]}-{MONTHS3[b]}"


def two_peaks(shape: np.ndarray) -> tuple[str, str]:
    """Month ranges of the main and the second season (each within +-2 months of its own peak, >= 60 % of that peak)."""
    k1 = int(np.argmax(shape))
    cd = lambda a, b: min(abs(a - b), 12 - abs(a - b))
    k2 = max((i for i in range(12) if cd(i, k1) >= 3), key=lambda i: shape[i])

    def rng(k, other):
        a = b = k
        for _ in range(2):
            n = (a - 1) % 12
            if shape[n] >= 0.6 * shape[k] and cd(n, other) >= 2:
                a = n
            n = (b + 1) % 12
            if shape[n] >= 0.6 * shape[k] and cd(n, other) >= 2:
                b = n
        return MONTHS3[a] if a == b else f"{MONTHS3[a]}-{MONTHS3[b]}"
    return rng(k1, k2), rng(k2, k1)


class Scaler:
    def __init__(self, d: dict):
        self.d = d

    @classmethod
    def fit(cls, F: list[Features], weights: dict[str, float]) -> "Scaler":
        S = np.array([f.shape12 for f in F])
        rng = np.random.default_rng(2026)
        idx = rng.choice(len(F), size=(min(20000, len(F) * 4), 2))
        s_shape = float(np.sqrt(np.mean(np.sum((S[idx[:, 0]] - S[idx[:, 1]]) ** 2, axis=1))))
        st = lambda v: (float(np.mean(v)), float(np.std(v)) or 1.0)
        d = {"weights": weights, "s_shape": s_shape,
             "density": st([f.density for f in F]), "R": st([f.R for f in F]), "cv": st([f.cv for f in F]),
             "trend": st([np.clip(f.trend, -100, 100) for f in F]),
             "order": ["shape12 (12, scaled by sqrt(w_shape)/s_shape)", "density", "R", "cv", "trend"]}
        return cls(d)

    def vector(self, f: Features, shape: np.ndarray | None = None) -> np.ndarray:
        w = self.d["weights"]
        z = lambda k, v: (v - self.d[k][0]) / self.d[k][1]
        sh = (shape if shape is not None else f.shape12) * math.sqrt(w["shape"]) / self.d["s_shape"]
        return np.r_[sh, math.sqrt(w["density"]) * z("density", f.density), math.sqrt(w["concentration"]) * z("R", f.R),
                     math.sqrt(w["variability"]) * z("cv", f.cv), math.sqrt(w["trend"]) * z("trend", float(np.clip(f.trend, -100, 100)))]


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * np.arcsin(np.sqrt(a))


def why(q: Features, t: Features, shift: int, mode: str) -> str:
    parts = []
    dp = int(round((t.peak_month - q.peak_month + shift + 6) % 12 - 6))
    if mode == "season" and shift:
        parts.append(f"same season shape, shifted {abs(shift)} month{'s' if abs(shift) > 1 else ''} (peak in {MONTHS3[int(t.peak_month - 0.5) % 12]})")
    elif dp == 0:
        parts.append(f"same peak month ({MONTHS3[int(q.peak_month - 0.5) % 12]})")
    else:
        parts.append(f"peak {abs(dp)} month{'s' if abs(dp) > 1 else ''} {'later' if dp > 0 else 'earlier'}")
    if q.bimodal and t.bimodal:
        parts.append("both have two fire seasons")
    dd = t.density - q.density
    parts.append("similar density" if abs(dd) < 0.15 else (f"{10 ** abs(dd):.1f}x {'denser' if dd > 0 else 'sparser'}"))
    tr = lambda v: "rising" if v > 15 else ("falling" if v < -15 else "stable")
    parts.append(f"both {tr(q.trend)}" if tr(q.trend) == tr(t.trend) else f"{tr(t.trend)} (yours {tr(q.trend)})")
    s = "; ".join(parts)
    return s[0].upper() + s[1:] + "."


def regime_name(members: list[Features]) -> tuple[str, str]:
    """Plain name + one-sentence description generated from the member units' numbers (medians)."""
    shape = np.median(np.array([f.shape12 for f in members]), axis=0); shape = shape / shape.sum()
    R = float(np.median([f.R for f in members])); dens = float(np.median([f.density for f in members]))
    tr = float(np.median([f.trend for f in members])); cv = float(np.median([f.cv for f in members]))
    bim = np.mean([f.bimodal for f in members]) > 0.5
    rng = months_text(shape)
    sharp = "Sharp" if R > 0.6 else ("Broad" if R > 0.3 else "Year-round")
    dword = "very dense" if dens > -0.5 else ("dense" if dens > -1.2 else ("moderate" if dens > -2.0 else "sparse"))
    tword = "rising" if tr > 15 else ("falling" if tr < -15 else "stable")
    if bim:
        p1, p2 = two_peaks(shape)
        name = f"Two seasons ({p1} and {p2}), {dword}, {tword}"
    elif sharp == "Year-round":
        name = f"Year-round burning, {dword}, {tword}"
    else:
        name = f"{sharp} {rng} season, {dword}, {tword}"
    share = float(sum(shape[i] for i in range(12) if shape[i] >= 0.6 * shape.max()))
    per1k = 10 ** dens * 1000
    desc = (f"About {share:.0%} of the year's hotspots fall in {rng}; typically {per1k:,.1f} hotspots per 1,000 km² a year; "
            f"totals vary {cv:.0%} from year to year and the trend is {tword} ({tr:+.0f} % per decade).")
    return name, desc
