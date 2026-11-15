**🌍 Live: [calember.earth](https://calember.earth)**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/calember-logo-dark.svg">
    <img src="web/public/calember-logo.svg" alt="Calember logo: a flame inside a satellite crosshair" width="160">
  </picture>
</p>

# Calember

**The fire memory that outlives its satellites.**
NASA Space Apps Challenge 2026 · challenge *Harmonization of MODIS and VIIRS Hot Spots* · team Calember

Since 2000, MODIS on NASA's Terra and Aqua has counted every active fire on Earth. Both satellites are drifting and end science operations in 2027. The VIIRS sensors that follow (Suomi NPP, NOAA-20, NOAA-21) see far more fires with smaller pixels, so their counts cannot be added to MODIS's: stitched together naively, the record jumps about 400 % in 2012.

Calember translates every VIIRS detection month into **hotspots (MODIS-equivalent)**, what MODIS Terra + Aqua would have counted at their original overpass times. The result is one continuous, validated fire record from **November 2000 to today**, for any place on Earth, with an interactive 3D site to explore it.

| | |
|---|---|
| Record | 68.6 M cell-months · 313 months (2000-11 → 2026-11) · 571,982 land cells of ≈ 253 km² |
| Input | 657.8 M NASA FIRMS detections from 5 satellites |
| Skill on unseen regions and years (KGE, 1 = perfect) | **0.9913** (state-of-the-art-style look-up table: 0.9633) |
| Sealed 2020 test, run once | **0.9684** (0.9894 without the Aqua data loss of Aug 2020) |
| 2012 sensor jump | 400 % raw → **4.0 %** harmonized |
| Sensor Turing test (can a classifier tell real MODIS from ours? 50 % = coin flip) | **55 %** (raw VIIRS: 77 %) |

**Live site: [calember.earth](https://calember.earth)** · the story at `/`, the Observatory at `/app`, the classic view at `/classic` (mirror: https://calember.pages.dev).

---

## The website

| Page | What it is |
|---|---|
| `index.html`, **the story** | A scroll-driven 3D film: why the record breaks in 2012, the method in one picture, the scorecard, the outage, the Sensor Turing test, and a lens to see the raw data under the harmonized record. |
| `app.html`, **Calember Observatory** | The main tool. A 3D night Earth with 26 years of fire and the five fire satellites in orbit. Search, click, lasso or circle any place, type coordinates, or switch to a precise 2D map. The place lifts onto a stage with seven stations (below). Also: country Rankings, the Proof Lab, a playable Sensor Turing test. |
| `classic.html`, **classic view** | A no-3D, screen-reader-first view of the same data. Browsers without WebGL are sent here automatically. |

**The seven stations of a place**
1. **Verdict.** Is this month normal? Live month-to-date (NASA FIRMS near-real-time) against the same days in 2003–2025, then the month on the stage against every year, a day-by-day view, and the 90 % range.
2. **Terrain.** Where in the area it burns: one hexagon per cell, long-term or month by month along the timeline, coloured by amount, peak month or against each cell's own normal. Top provinces and the hottest cell.
3. **Calendar.** Every month since 2000 as a 3D landscape or flat heatmap; harmonized ⇄ raw sensors (watch the 2012 cliff appear), count ⇄ vs normal, a table.
4. **Season.** Fire-season onset, peak and end per year (10 / 50 / 90 % of the year's fire) with Sen's-slope trends and Mann–Kendall significance; two-season places are detected.
5. **Helix.** 26 years in one spiral, with sonification ("listen to 26 years").
6. **Twins.** The places on Earth that burn the same way, by season shape, density, concentration, variability and trend (≥ 1,000 km apart); fly there, open or compare.
7. **Take it.** `calendar.csv`, `season.csv`, `hotspots.csv` (every detection with its MODIS-equivalent weight), a ZIP bundle with metadata, and a 3D-printable calendar (`.stl`).

Plus: watch places (flagged when they run above normal), compare two places side by side, keyboard shortcuts (`?`), synthesized sound, deep links for every view.

---

## The harmonization method

### Target
For every H3 resolution-5 cell (≈ 253 km²) and calendar month: the number of cleaned detections that **MODIS Collection 6.1 Terra + Aqua** would have reported (confidence ≥ 30, type 0 "presumed vegetation fire", static sources masked) at their **pre-drift overpass times**, with complete data on every day. The aim: a record in which the sensor of origin cannot be detected.

### Data
- NASA FIRMS yearly country archives (standard processing): MODIS C6.1 2000–2025, VIIRS S-NPP 2012–2025, NOAA-20 2018–2025.
- NASA FIRMS area API for 2026 and for NOAA-21 (from 2023-03), standard and near-real-time.
- RESOLVE Ecoregions 2017 (biomes) and Natural Earth admin-0/admin-1 boundaries.
- 657.8 M detections in total. Downloads were verified by size, CRC, header checks and day coverage (no duplicates).

### 1. Clean
- Satellite codes are normalized (`Terra/Aqua/N/N20/N21`); unknown codes stop the build. Times are padded to UTC `HHMM`.
- MODIS: confidence ≥ 30, type 0. VIIRS: confidence nominal or high, type 0.
- **Static-source mask** (H3 resolution 7, ≈ 5 km²; 54,013 cells). A cell is masked when either:
  - S-NPP detects it in ≥ 50 % of the 144 months of 2013–2024 **and** in ≥ 8 distinct years; or
  - it has ≥ 3 detections of type 1 or 2 (volcano, other static source) from any product.
  The mask is needed because VIIRS collection 2 mislabels some gas flares as type 0. It removes 60–76 % of detections in flaring regions (Persian Gulf, Khanty-Mansiysk, Algeria) and < 2 % in agricultural or savanna regions (Punjab, Amazon, northern Australia).

### 2. Grid and describe
Each detection goes to its H3 r5 cell. Per satellite, cell and month we compute: detection count (day / night), fire radiative power (sum, median, 90th percentile, max), mean scan size, share of low-FRP (< 5 MW) detections, distinct fire days, and **fire-cell-passes** (distinct satellite × r7 cell × date × 10-minute slot), which separates "more fires" from "the same fire seen as several pixels".

### 3. Learn the translation on the overlap years
In 2012–2019 Aqua MODIS and Suomi NPP VIIRS cross the equator minutes apart in the early afternoon, so both answers are known for the same fires. A model learns MODIS counts from what VIIRS saw.

- **Rows:** cell-months with S-NPP detections > 0 (selection on the input only; selecting on "any sensor > 0" leaks the target).
- **Inputs, all from VIIRS or from the training period:**
  - the cell-month's S-NPP statistics above, plus multiplicity = detections / fire-cell-passes;
  - the neighbourhood: S-NPP detections and fire-cell-passes in the 6 surrounding cells;
  - temporal context: the cell's S-NPP count in the previous and next month;
  - the cell's own history, leave-one-year-out over the training years: `hist_ratio = (Y_h + 20·G) / (S_h + 20)` (MODIS and S-NPP totals of the cell without the row's year, shrunk to the global ratio G), plus log mean S-NPP and log mean MODIS per year;
  - the region this month (H3 r3 parent, ≈ 12,000 km²): log S-NPP total, detections per fire-cell-pass, FRP per detection;
  - static: latitude, month as sin/cos, biome (categorical).
- **Model:** two gradient-boosted tree models (LightGBM), one for the **Aqua** count and one for the **Terra** count, summed. Tweedie objective (variance power 1.2), learning rate 0.05, 63 leaves, ≥ 50 rows per leaf, 80 % feature and row sampling, L2 = 1.0, 1,400 (Aqua) / 1,500 (Terra) rounds, seed 2026. Monotone constraints: the prediction can only rise with the S-NPP count, day count, night count, fire-cell-passes, FRP sum and fire days. Hyperparameters were tuned on an inner split only (training folds ≤ 2016, validation 2017), never on the test sets.
- **Zero model** for fire-prone cells where S-NPP saw nothing that month: a rate per biome × (any S-NPP fire in the 6 neighbours) × (regional activity bin), shrunk towards pooled rates (k = 200).

### 4. Uncertainty
- **90 % ranges:** cross-fitted split-conformal prediction on `|log((y+1)/(p+1))|`, calibrated separately per predicted-level bin (edges 0.3, 1, 3, 10, 30, 100, 300, 1,000, 10,000). Interval = `[(p+1)·e^(−q) − 1, (p+1)·e^(q) − 1]`.
- **Predictive distribution** (used for the Turing test and simulations): a zero-inflated negative binomial with the model's mean, overdispersion per prediction-level bin, cross-fitted over region groups.
- Area totals combine a random part (√Σ sd²) and a systematic part correlated within a biome.

### 5. Assemble one record (regimes)
| Regime | Months | How the value is made |
|---|---|---|
| **T** | 2000-11 → 2002-06 | Terra only, scaled to Terra + Aqua with a factor per biome × month × day/night learned from 2003–2011 |
| **M** | 2002-07 → 2011-12 | MODIS Terra + Aqua as measured |
| **B** | 2012-01 → 2019-12 | inverse-variance blend of MODIS and the cross-fitted model (every region predicted by a model that never saw it) |
| **V** | 2020-01 → 2026-07 | the model on VIIRS (MODIS has drifted: Aqua's overpass moved from 13:33 to 14:47 local time, Terra's from 10:34 to 09:22) |
| **N** | 2026-08 → now | as V on NOAA-20 (S-NPP fire production ended 2026-11-02); provisional |

**Data losses are repaired, not ignored.** A sensor-day is "lost" when its global count falls below half its centred 61-day median. Lost MODIS days are filled from the paired satellite (the other satellite's detections × a biome ratio from days both were complete); model inputs are scaled by 1/(1 − lost share); in months where S-NPP lost ≥ 5 % and NOAA-20 at most half that, NOAA-20 (÷ 0.985) replaces it. On 36 simulated outages this fill brings the bias from −14.6 % (no fill) to +0.1 % (KGE 0.996). Filled months are flagged in the data (`fill_frac`, `modis_outage`).

The finished record matches MODIS where MODIS is still trustworthy: blended months vs MODIS median ratio 0.9993; annual 2020 and 2021 (pre-drift) **1.000**. From 2022 the real MODIS reads higher because of orbital drift, which the record removes by design.

### 6. Validation (everything is scored on data the model never trained on)
- **Spatial folds:** five folds of whole H3 r2 regions (no r3 region spans two folds).
- **B2, development test:** train on the other folds, 2012–2017; test on the held-out fold in 2018–2019.
- **B3, confirmation test:** written down in advance and run **once**: train on 2012–2019, predict 2020.
- **Metrics:** Kling–Gupta efficiency (KGE) of monthly totals at province, country and biome level; the primary score is their mean. Run-to-run noise is ±0.0005.

| Method | B2 primary KGE | Province R² | Sealed 2020 KGE | 2020 without the Aqua outage |
|---|---|---|---|---|
| One global VIIRS/MODIS ratio | 0.9445 | 0.958 | 0.9435 | 0.9299 |
| Biome × month × day/night look-up table (GFED5-NRT style) | 0.9633 | 0.978 | 0.9538 | 0.9750 |
| **Calember** | **0.9913** | **0.994** | **0.9684** | **0.9894** |

| Test | Result |
|---|---|
| 2012 seam: size of the jump after removing seasons and MODIS's own change (median of 15 regions) | raw 399.5 % · one ratio 8.9 % · **Calember 4.0 %**; placebo dates without any sensor change 1.7–2.6 % |
| Sensor Turing test: a classifier on 24-month province records, 678 held-out provinces | raw VIIRS 77.4 % · look-up table 58.9 % · **Calember 55.1 %** (sealed 2020: 55.2 %) |
| 90 % ranges that contain the truth (provinces) | **90.0 %** (sealed 2020: 89.7 %) |
| "Is this month normal?" category agreement with real MODIS (Cohen's κ) | **0.473** (look-up table 0.347) |

**Why 2020 scores lower:** Aqua MODIS lost 80–95 % of its detections from 16 Aug to 2 Sep 2020, so the reference itself has a hole; Calember, built from VIIRS, keeps counting.

### Limitations
- Calember reproduces what MODIS would have counted; it is not burned area or fire size.
- Quiet off-season months in small regions are the hardest case (their seasonal swing is slightly compressed).
- The FIRMS country files omit open-ocean detections; gas flares are masked on purpose.
- 2001-06 (Terra only, half the month lost) remains about 25 % low and is flagged.
- The newest months (regime N) are provisional and use near-real-time data.

---

## Repository layout

| Folder | What |
|---|---|
| `web/` | The site: story film (`src/film`), Observatory (`src/observatory`), classic view (`src/app`), static data layers (`public/static`). React 18, TypeScript, three.js / React Three Fiber, MapLibre, D3, Vite. |
| `api/` | FastAPI service: areas, calendar and anomalies, now (live FIRMS), season, twins, terrain cells, daily, rankings, exports, validation, Turing test. Tests in `api/tests`. |
| `science/ember_science/` | Shared science: anomalies against the 2003–2025 baseline, season metrics and trends, twins and regimes, area aggregation. Tests in `science/tests`. |
| `harmonization/build/` | The harmonized record, step by step (download → convert → mask → aggregate → features → train and predict → assemble → QA). |
| `harmonization/validation/` | Benchmarks (B2/B3), tuning, cross-fitting, seam test, Turing test, conformal ranges, outage simulation. |
| `pipeline/` | Builds the API tables and the site's static layers from the record. |
| `config/ember.yaml` | Paths and parameters. |

## Run it

Requirements: Python 3.12, Node 20+ and pnpm. The data products are several GB and are not in this repository (see "Rebuild the record"); with them in `data/products/`:

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt     # macOS/Linux: .venv/bin/pip
```

```bash
.venv/Scripts/python -m uvicorn ember_api.main:app --app-dir api --port 8000
```

```bash
pnpm --dir web install && pnpm --dir web dev
```

Open http://localhost:5173/ (story), `/app.html` (Observatory) or `/classic.html`. The dev server proxies `/api` to port 8000. Live near-real-time data needs a free FIRMS key in `.env` (copy `.env.example`).

Tests:

```bash
PYTHONPATH="api;science" python -m pytest -q api/tests science/tests
```

Production build (a static site; set `VITE_API_BASE` when the API runs on another host):

```bash
pnpm --dir web build
```

## How the live site is hosted

The public site runs with **no server to keep alive**. It is a static site on Cloudflare Pages: nothing can sleep or run out of memory, and it costs nothing.

- **Named places** (the world, 15 biomes, countries, about 3,900 provinces) answer from files precomputed with the API's own code (`pipeline/build_snapshot.py` → `web/snap/p|c|d|r`).
- **Drawn areas** (lasso, circle, coordinates, a twin's region) are computed in the visitor's browser by `web/src/app/engine/`, a line-by-line port of the API, from per-region tiles of the full record (`pipeline/build_region_tiles.py`, `build_engine_static.py`). A parity test against the Python API matched every field apart from float32 summation noise (±0.01 on a few terrain cells).
- **`hotspots.csv` and `bundle.zip`** are built in the browser from every cleaned detection, published as the public dataset [Sidant/calember-hotspots](https://huggingface.co/datasets/Sidant/calember-hotspots) (`pipeline/build_hotspot_parts.py`). The rows, `det_id` and `meh_weight` are identical to the API's.
- **Two small Pages Functions** (`web/functions/`): `/api/firms` relays live NASA FIRMS near-real-time detections (the FIRMS key stays a server-side secret), and `/api/turing/*` keeps the Sensor Turing test's crowd score in Cloudflare D1.

To redeploy after rebuilding the data (needs `wrangler login`):

```bash
bash web/scripts/deploy.sh
```

## Rebuild the record

From the repository root, in order (each script's docstring gives its usage; run heavy steps one at a time on a 16 GB laptop):

1. `harmonization/build/dl_firms.sh`, `fetch_queue.py` / `fetch_api.py` (FIRMS archives and API), `convert_firms.py`, `convert_api.py`
2. `h3_lookup.py`, `agg2.py`, `static_mask.py`, `agg3.py`, `agg_api.py`
3. `fill_prep.py` → `build_features.py` → `train_predict.py` → `assemble.py` → `qa_product.py`
4. Site layers: `pipeline/build_static.py`, `science_exports.py`, `build_aggregates.py`, `build_daily.py`, `build_twins.py`, then the story files (`build_story_*.py`)
5. Static deployment data: `pipeline/build_snapshot.py`, `build_big_terrain.py`, `build_region_tiles.py`, `build_engine_static.py`, `build_hotspot_parts.py` (then upload `data/hotspots` to the dataset)

Validation: `harmonization/validation/bench9.py` (B2/B3 benchmarks), `crossfit2.py` + `seam2.py`, `c2st_nb.py`, `conformal.py`, `scorecard_oof.py`, `sim_fill.py`.

## Data and credits
- Fire detections: NASA FIRMS (MODIS Collection 6.1; VIIRS 375 m S-NPP, NOAA-20, NOAA-21).
- Night Earth and story imagery: NASA Earth Observatory and NASA Worldview (credits in `web/public/static/textures/CREDITS.md`).
- Boundaries: Natural Earth. Biomes: RESOLVE Ecoregions 2017 (CC-BY 4.0). 2D basemap: OpenFreeMap / OpenStreetMap contributors.

Calember is not an official NASA product, and no NASA logos are used. Every number on the site comes from the team's data files or the API.

## License
See [LICENSE](LICENSE).
