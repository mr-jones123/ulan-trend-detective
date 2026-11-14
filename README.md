# Ulan, measured

A static NASA data story and trend explorer for the Philippines, 2001 to 2025. It maps 3,735 native IMERG rainfall squares and compares January to April rainfall in years that began in El Niño with the other years. MERRA-2 adds modelled air temperature at two metres on its native 0.5° latitude by 0.625° longitude grid. A 2020 MODIS cropland mask adds farmland-weighted rain and clear-sky day and night surface temperatures at 12 sampled cropland sites. Variable selection keeps those different spatial footprints explicit. Two guided investigations demonstrate the comparisons, and a glossary explains the measurements and statistics.

The site is one Astro page and one Python data builder. It has no backend and makes no NASA request from the browser. Every number in the prose is rendered into static HTML at build time from the same JSON file the map loads.

## Commands

The lockfiles are `package-lock.json` and `uv.lock`. The project uses Node 22.22.0 or later and Python 3.14. This version was built with Node 24.13.0, npm 11.6.2 and uv 0.9.27.

```sh
npm ci
uv sync --frozen
npm run dev
```

Run the numerical tests, explorer transition tests, type checker, and production build. The explorer tests use the locally installed Bun runner with Node's test and assertion APIs.

```sh
uv run --frozen python -m unittest discover -s tests
bun test tests/view.test.ts
npm run check
npm run build
npm run preview -- --host 127.0.0.1
```

Rebuild the artifact from the pinned snapshots. This needs no network.

```sh
uv run --frozen --offline scripts/build_rainfall.py --offline
```

A plain run downloads a snapshot only when its file is missing. `--refresh` downloads every small snapshot again and rebuilds IMERG, MODIS, and MERRA-2 snapshots from their hash-verified raw caches. The builder's `--offline` flag rejects missing snapshots without making a network request. The `uv --offline` flag alone controls dependency resolution, not Python's network access.

```sh
uv run --frozen scripts/build_rainfall.py --refresh
```

To refetch the raw IMERG tiles on their own, run `uv run --frozen scripts/imerg.py`. Add `--offline` to rebuild the cube from the cache only. The raw cache is about 360 MB and is ignored by git.

MODIS acquisition uses three concurrent requests with up to five attempts and exponential backoff. `uv run --frozen scripts/modis.py --offline` rebuilds the farm snapshot from the raw cache without the network. Each raw response is stored in `data/cache/modis/` with its URL, retrieval time, byte length and SHA-256 in a sidecar. The cache is ignored by git. The compact committed snapshot contains the per-square shares, site windows, cropland pixel counts and all retained or rejected day and night composite means. A rejected composite is `null`, not zero.

The builder validates inputs before replacing the artifact. Each file write is atomic. A failed acquisition can retain verified cache entries and completed source snapshots, but it does not publish a new artifact. Output JSON has sorted keys and fixed rounding, and the provenance records keep their original retrieval times, so an offline replay reproduces `public/data/philippines-rainfall.json` byte for byte.

## Dependencies

JavaScript: Astro 7.4.1, MapLibre GL JS 6.15.0, Zod 4.6.7, `@fontsource/imbue` 5.3.0 and `@fontsource/albert-sans` 5.3.0. Development: `@astrojs/check` 0.9.11, TypeScript ~6.0.3, `@types/node` 24.19.2 for the page's build-time file read, and `@maplibre/maplibre-gl-style-spec` 26.4.4, which supplies the style and expression types that `maplibre-gl` 6 does not re-export.

Python uses Shapely 2.2 and NumPy 2.5.4. NumPy arrays support the MODIS sinusoidal pixel mapping. The statistics use the Python standard library.

## Sources and licenses

| Snapshot | Source | License or terms |
| --- | --- | --- |
| `data/sources/imerg-monthly.json.gz` | NASA POWER daily regional API, parameter `IMERG_PRECTOT` (GPM IMERG Final Run), UTC days, 36 tiles of 2° by 2° for each of 25 years, 900 requests | NASA data, no credentials |
| `data/sources/boundary.json.gz` | geoBoundaries gbOpen PHL ADM0, revision `9469f09592ced973a3448cf66b6100b741b64c0d` | CC BY 3.0 IGO |
| `data/sources/adm1.json.gz` | geoBoundaries gbOpen PHL ADM1, revision `41af8f1e141eb6826ab9877e306df6f848b9ff0b`, 17 regions | CC BY 3.0 IGO |
| `data/sources/oni.txt.gz` | NOAA CPC Oceanic Niño Index, `oni.ascii.txt` | US government data |
| `data/sources/audit/*.json.gz` | NASA POWER point requests at 121.25° E, 14.5° N used only for the source audit below | NASA data |
| `data/sources/modis-farm.json.gz` | [ORNL DAAC MODIS REST API](https://modis.ornl.gov/rst/api/v1/), derived from LP DAAC [MCD12Q1 land cover](https://doi.org/10.5067/MODIS/MCD12Q1.061), Friedl and Sulla-Menashe (2022), and [MOD11A2 surface temperature](https://doi.org/10.5067/MODIS/MOD11A2.061), Wan, Hook and Hulley (2021) | NASA open data, no credentials for subsets |
| `data/sources/merra2-monthly.json.gz` | [NASA POWER monthly regional API](https://power.larc.nasa.gov/docs/services/api/temporal/monthly/), MERRA-2 `T2M`, UTC, 2001-2025, four overlapping bounding boxes, 223 land-intersecting native cells | NASA open data, no credentials |
| `data/sources/modis-ndvi.json.gz` | [ORNL DAAC MODIS REST API](https://modis.ornl.gov/rst/api/v1/), [MOD13Q1 vegetation indices](https://doi.org/10.5067/MODIS/MOD13Q1.061), 250 m, 16-day `250m_16_days_NDVI` and `250m_16_days_pixel_reliability`, January to April 2001-2025 at the 12 farm sites, 600 requests | NASA open data, no credentials for subsets |
| `data/sources/merra2-tmin-sites.json.gz` | [NASA POWER daily point API](https://power.larc.nasa.gov/docs/services/api/temporal/daily/), MERRA-2 `T2M_MIN`, UTC, 2001-2025, one request per farm site | NASA open data, no credentials |

`data/sources/manifest.json` records each small snapshot's URL, SHA-256 of the uncompressed bytes, byte length and retrieval time. Its `imerg` entry points to `imerg-manifest.json`, which lists all 900 tile requests with their hashes. These small `.gz` files store the original response bytes. `modis-manifest.json` lists every land-cover and temperature request URL and the SHA-256 of its raw response bytes. It also records the compressed derived snapshot hash and pinned ADM0 hash. The artifact preserves both the MODIS snapshot hash and manifest hash.

`merra2-manifest.json` records four exact request URLs, raw-response hashes, byte counts, retrieval timestamps, the derived monthly snapshot hash, and the pinned ADM0 hash. Raw responses remain in the ignored `data/cache/merra2/`. Cell IDs are `row-col`, where `row = latitude / 0.5` and `col = longitude / 0.625`. The snapshot contains 300 monthly means per cell. Loading it verifies the complete positive-area land-intersection cell set, including coastal cells whose centres lie outside the land boundary.

The basemap is OpenFreeMap's Positron style, built on OpenMapTiles and OpenStreetMap data. MapLibre shows its attribution on the map. The project does not proxy, prefetch or download tiles. See the [OpenFreeMap terms](https://openfreemap.org/tos/).

The five pictures in `public/images/` are NASA Earth Observatory files, downloaded unchanged. Each is credited on the page next to the picture.

| File | Original | Credit |
| --- | --- | --- |
| `lando-imerg-2015.png` | `imagerecords/86000/86857/koppu_mrg_2015294.png` | Joshua Stevens and Jesse Allen, IMERG data from the GPM Precipitation Processing System |
| `pampanga-flood-2015.jpg` | `imagerecords/86000/86857/manila_tmo_2015294.jpg` | Joshua Stevens, LANCE/EOSDIS Rapid Response |
| `cagayan-flood-2020.jpg` | `imagerecords/147000/147554/philippines_amo_2020323.jpg` | Joshua Stevens, MODIS data from NASA EOSDIS/LANCE and GIBS/Worldview |
| `pantabangan-2023.jpg`, `pantabangan-2024.jpg` | `imagerecords/152000/152787/pantabangan_lake_oli2_20230429.jpg` and `_20240415.jpg` | Michala Garrison, Landsat data from the U.S. Geological Survey |

The two Pantabangan files are both 720 by 480 pixels, so the comparison slider overlays them exactly. The Lando map is NASA's published image and keeps its own sea labels.

Imbue and Albert Sans are under the SIL Open Font License 1.1. The page loads only their Latin subsets: Imbue 400, and Albert Sans 400 and 600. All three files contain ñ, ° and the minus sign. Neither family has tabular figures in these subsets, so numeric columns are right-aligned instead.

## Method

**Annual and January to April totals.** `scripts/imerg.py` sums each pixel's daily values into calendar months. The builder sums twelve months into each annual total and months 1 through 4 of the same calendar year into each January to April total. A daily value in mm/day counts as that many millimetres for one UTC day. Leap days are included. Missing days, fill values, negative values and off-grid centres fail acquisition. January to April covers much of the country's dry cropping season, but eastern Type II areas, including Eastern Visayas and Caraga, are wet then.

**Squares.** A pixel's id is `row-col` on IMERG's global 0.1° grid. Its centre is latitude −89.95 + 0.1 × row and longitude −179.95 + 0.1 × col. The map draws each pixel as its full 0.1° square, not clipped to the coast. The set of squares is every square with a positive-area intersection with the pinned ADM0 boundary. The builder checks that this set equals the cube's 3,735 pixels.

**Weights.** A square's national weight is the area of its intersection with ADM0, in square degrees, times the cosine of its centre latitude. A square's weight in a region is the area of its intersection with that region and ADM0, times the same cosine. A square on a border counts toward every region it touches. National and regional annual and January to April series use these same weights. The artifact ships every region's member list and weights, so anyone can rebuild the series.

**Rainfall trends.** Sen's slope is the median of the 300 pairwise slopes between the 25 years. The page reports rainfall slopes in mm per decade and as a percentage of the 2001-2025 mean per decade. Annual trends exist for every square, region, and the country. January to April trends exist for the country and regions, so the regional comparison can show when direction depends on the measurement window. Neither an opposite sign nor a nonzero slope establishes statistical significance.

**Significance.** The Mann-Kendall test uses tie-corrected variance, the continuity correction, and a two-sided normal p-value, with n = 25 and no autocorrelation correction. A change "meets the test" when p < 0.05. The builder decides direction, test results, area shares, and rankings on unrounded values. The browser does not re-test a rounded p. When a printed p would round onto the wrong side of 0.05, the page prints more digits. A p-value measures how unusual the test statistic would be under the no-trend model and its assumptions. It is not the probability that the no-trend model is true.

**Seasonal comparison.** Each January to April value covers the same calendar months in each year. This keeps the comparison window consistent, but it does not remove a fitted seasonal cycle or perform full deseasonalization. January to April is not uniformly dry across the Philippines.

**Air temperature.** NASA POWER's [monthly API](https://power.larc.nasa.gov/docs/services/api/temporal/monthly/) supplies MERRA-2 `T2M`, mean air temperature at two metres, in °C and UTC. Each native cell spans 0.5° latitude by 0.625° longitude. We multiply each monthly mean by its number of calendar days, sum those products, and divide by the total days in the annual or January to April window. February has 29 days in leap years. The API's month-13 annual field is not a thirteenth month. National and regional series average native cells using their intersecting land area times the cosine of the cell's centre latitude. The trend is fitted to the weighted series, not to an average of cell slopes.

Air temperature is a model reanalysis that combines observations and a physical model. It is not a direct satellite thermometer measurement. Coastal model cells include sea, and a regional average cannot recover features finer than the native grid. The explorer retains the coarse footprints rather than displaying a model value as thousands of independent rainfall-square measurements.

**El Niño-start years.** A year began in El Niño when NOAA's December-to-February ONI for that year is +0.5 °C or more. The comparison reports the two group means, the difference as a percentage of the other years' mean, and how many El Niño-start years fell below the 2001-2025 mean for the same window. The map, regional rankings and land shares use January to April. National and regional annual comparisons remain as context. The comparison is descriptive and has no test.

**Cropland.** MCD12Q1 `LC_Type1`, year 2020, class 12 defines cropland. The acquisition reads 100 km windows on centres `(5.5 + 1.8i, 117.8 + 1.8j)`, for `i < 9`, `j < 6`, keeping windows whose ±1° longitude by ±0.95° latitude box intersects ADM0. It deduplicates pixels by their global sinusoidal indices. Pixel centres use a sphere of radius 6,371,007.181 m, `lat = y/R`, `lon = x/(R cos(lat))`. Rows run north to south. Each IMERG square gets the rounded integer percentage of its 500 m pixel centres inside ADM0 that are class 12. Tiny coastal slivers without a pixel centre get zero. The national cropland rain weight is the existing land weight multiplied by that integer share. The farmland map ghosts squares with less than 10% cropland. It still colours visible squares by the unchanged January to April El Niño rain comparison.

**Farm sites and temperature.** Cropland pixel centres are binned to the nearest half degree with Python's `round(value * 2) / 2`. Bins are ranked by cropland pixel count, with latitude then longitude breaking ties. A bin is kept when every earlier site is at least 1° away in latitude or longitude, until 12 sites are selected. MOD11A2 windows extend 25 km in each direction from those centres. Their actual sinusoidal window outlines are shipped to the map. A 1 km pixel `(IX, IY)` covers the four 500 m pixels with indices `(2IX + dx, 2IY + dy)`, where `dx` and `dy` are 0 or 1. At least three must be cropland inside ADM0.

Day and night temperature use separate `LST_Day_1km` and `LST_Night_1km` requests for days 001-073 and 081-113, at most ten 8-day composites per request. Values are multiplied by 0.02 K and converted to °C. Zero is fill. No additional QC-band filter is applied. A composite is retained only when at least 30% of the site's cropland pixels have valid values. Its value is their arithmetic mean. Each site-year is the arithmetic mean of retained composites, not a day-weighted average. Every site-year must have a retained composite. The national temperature series is the equal-weight mean of those 12 site-years, not a countrywide area mean. The builder stores Sen slopes in °C per decade, Mann-Kendall p, unrounded direction and test decisions, and the descriptive El Niño-start minus other-years gap in °C. It also refits 2001-2019 before Terra's post-2020 orbit drift.

**Story copy.** `src/lib/story.ts` picks every scientific sentence from a table of wordings keyed by the computed result. `assertClaims` fails the build when a claim is missing, when a sentence uses a direction word that contradicts its result, or when a heading is longer than 44 characters. Each claim renders with `data-claim` and `data-verdict`.

**Artifact schema.** `ph-rain-imerg-v4` retains the annual and January to April IMERG records, integer `cells.cropland_pct`, and MODIS `farm` records. National and regional rainfall `jan_apr` records also contain trend estimates and test results. `farm.rain` holds cropland-weighted January to April rain. `farm.day`, `farm.night`, and `farm.sites` hold surface-temperature series, trends, El Niño differences, and the 2001-2019 refits. The `air` record holds native MERRA-2 cells and land-area-weighted national and regional air-temperature series for annual and January to April windows. Temperature differences are in °C, never percentages of Celsius values. Provenance pins each derived snapshot and request manifest.

Temperature charts show each year's difference in °C from that series' 2001-2025 mean. Bars extend above or below the zero line at the mean, and fitted trends use the same anomaly scale. The caption gives the absolute mean. Scale bounds and trend labels occupy separate rows so they cannot overlap. Rainfall charts keep their zero-based mm scale.

## Results at build time

These are the values in the current artifact. They come from the builder's output, not from hand entry.

- National average year: 2,617 mm. Sen slope +180 mm per decade, +6.9% of the mean per decade, p = 0.168. It does not meet the test.
- 91.0% of land lies in squares with a rising slope. 13.5% lies in the 533 squares whose rise meets the test. No square's fall meets it.
- Nine years began in El Niño: 2003, 2005, 2007, 2010, 2015, 2016, 2019, 2020 and 2024. Their January to April totals averaged 269 mm against 668 mm for the other 16 years, 59.8% less. All nine were below the 2001-2025 January to April mean of 524 mm. Across the whole year the gap was 16.6%, with 2,322 mm against 2,783 mm.
- All 17 regions and 100.0% of land had less January to April rain in El Niño-start years. The widest regional gap is Eastern Visayas, −73.1%.
- The Pantabangan square received 121 mm from January to April 2024 against its 212 mm average, a 42.9% deficit. Its January to April El Niño comparison is −56.8%. Its annual 2024 total was 1.6% above average.
- Mimaropa has the largest fitted change of the 17 regions, +10.8% per decade, p = 0.047. Calabarzon and Mimaropa are the two regions that meet the test.
- Class 12 Croplands account for 95,183 of 1,222,310 deduplicated 500 m pixel centres inside ADM0, 7.79%. Class 14 cropland/natural vegetation mosaics are excluded, not partially counted. This differs from a cropland-equivalent estimate that includes mosaics.
- Cropland-weighted January to April rain averaged 171.3 mm in El Niño-start years against 436.1 mm in other years, 60.7% less.
- The 12-site mean daytime January to April surface temperature was 1.23 °C warmer in El Niño-start years. Its 2001-2025 slope was −0.29 °C per decade, p = 0.168, which does not meet the test.
- Night surface temperature rose 0.26 °C per decade, p = 0.029855. Seven of the 12 sites had a rising night slope that met the test. The 2001-2019 site-mean refit was +0.22 °C per decade, p = 0.294, which does not meet the test. Night temperatures in El Niño-start years averaged 0.17 °C warmer than in other years.
- MERRA-2 annual air temperature has a national mean of 26.0292 °C and a Sen slope of +0.2624 °C per decade, p = 0.000096. All 17 regional annual air-temperature slopes are positive and meet the unadjusted test.
- MERRA-2 January to April air temperature has a slope of +0.0938 °C per decade, p = 0.315252. It does not meet the test. Its descriptive El Niño-start versus other-years difference is +0.3020 °C.
- Soccsksargen is the only region with opposite annual and January to April rainfall directions. The annual slope is −1.92 mm per decade, p = 0.981367. The January to April slope is +34.84 mm per decade, p = 0.440876. Neither meets the test.

## Why the map moved from MERRA-2 to IMERG

The first version of this map used NASA POWER's MERRA-2 `PRECTOTCORR`. At 121.25° E, 14.5° N, its 2020 annual total was 6,664 mm, against 2,865 mm from IMERG at the same point, a ratio of 2.33. In the other 24 years the ratio stayed between 0.92 and 1.15. MERRA-2's dry-season months in 2020 were the cause, not an aggregation error. That year also began in El Niño, so it would have bent both the trend and the El Niño comparison. Rainfall now uses IMERG. The separate MERRA-2 `T2M` air-temperature variable remains available. A discrepancy in rainfall does not establish that temperature is invalid.

The builder recomputes this audit from the two preserved point responses in `data/sources/audit/` and stores it as `provenance.source_audit`. The "Why we use IMERG" disclosure on the page shows the 25-year table from that record.

## Rain calendars (k-means)

`scripts/climate.py` describes every IMERG square by its average 2001-2025 year as 12 monthly shares of its rain, stored as integers per ten thousand in `cells.month_share`. k-means with k = 4 groups those shapes, not totals. Initialisation is deterministic: the square with the largest January to April share, then repeatedly the square farthest from the chosen centres (maximin). Each round assigns squares to the nearest centre by squared distance and moves centres to their members' mean, until no square changes group. Groups are ordered by January to April share and named after the PAGASA climate type they resemble; the builder fails if the driest group no longer peaks in June to September or the wettest no longer peaks in November to January. Each group's El Niño-start comparison uses its land-weighted January to April series.

`src/lib/kmeans.ts` repeats the same arithmetic in the same order. The chapter's widget steps it live over all 3,735 squares and repaints the map through MapLibre feature state; Reset with k = 4 reproduces the published groups, and `tests/kmeans.test.ts` checks that square by square.

At build time it settled after 35 rounds, inertia 9.64. January to April shares: Type I 6.1%, Type III 12.9%, Type IV 24.6%, Type II 31.8%. El Niño-start January to April gaps: −62.9%, −65.8%, −55.1% and −60.4%. k = 4 is chosen to compare with PAGASA's four types; the algorithm does not choose it, and group edges differ from PAGASA's map in places.

## Farm greenness and night air

**Greenness.** `uv run --frozen scripts/modis.py --ndvi` reads MOD13Q1 NDVI and its pixel-reliability band for the same 25 km windows as the surface temperatures, January to April composites (days 001-113, every 16 days). A 250 m pixel counts as cropland when its parent 500 m MCD12Q1 pixel `(ix // 2, iy // 2)` is class 12. A composite keeps reliability 0 or 1 pixels and is retained only when at least 30% of the site's cropland pixels are valid. Site-years are means of retained composites; the 12-site series is an equal-weight mean. NDVI is also from Terra, so the 2001-2019 refit is reported beside the full-record trend.

**Night air.** `uv run --frozen scripts/tmin.py` requests MERRA-2 daily minimum air temperature at each site centre. Each site-year is the mean of its 1 January to 30 April daily minima. POWER answers with the containing 0.5° by 0.625° model cell, much coarser than a farm window. The page uses it as an orbit-free check on the MODIS night surface trend.

At build time: in El Niño-start years, January to April NDVI was 0.035 lower than other years (site mean 0.597), and lower at all 12 sites. The 2001-2025 NDVI slope is +0.011 per decade, p = 0.047, but the 2001-2019 refit is +0.003, p = 0.726. Minimum air temperature changed by +0.19 °C per decade, p = 0.088, and −0.04 °C per decade over 2001-2019; neither meets the test, so the air record does not confirm the night surface warming.

## Cross-check against NASA Giovanni

`data/sources/giovanni/imerg-monthly-ph-bbox.csv` is a Giovanni area-averaged time series of `GPM_3IMERGM` v07 Final Run, mm/month, over the box 116.9° E to 126.7° E, 4.5° N to 21.2° N, January 2001 to April 2025. Giovanni needs an Earthdata login, so the file is downloaded by hand from the URL in its header and committed. The builder verifies the box, product and units, then stores the comparison as `provenance.giovanni` with the file's SHA-256. The box includes sea and our series is land-area weighted, so absolute totals differ; the page shows both as percentages of their own means in the "Checked against NASA Giovanni" disclosure.

- January to April: year-to-year correlation r = 0.976. El Niño-start gap −59.8% here, −57.2% in Giovanni. Neither trend meets the test (p = 0.657 and 0.559).
- Annual, 2001-2024, not stored in the artifact: r = 0.951. El Niño-start gap −15.6% and −11.3%. Neither trend meets the test (p = 0.359 and 0.189).

Both sources read IMERG, so agreement checks our processing, not IMERG itself. Rain gauges are the independent check.

## Limits

Annual and January to April totals cannot show daily extremes, rainfall timing within either window or typhoon intensity. Rainfall over the Pantabangan square is not reservoir storage and does not measure catchment inflows, releases or evaporation. The January to April 2024 total includes days after the 15 April photograph. Coastal squares include sea. The trend test assumes independent years, and testing 3,735 neighbouring squares means about 5% of land could meet the test by chance even with no trend, as a rough guide only. The El Niño comparison does not separate El Niño from other causes. Nothing on the page is a forecast. The boundary files mark the area the data covers and do not state a position on territorial claims. The ADM1 file still names the Bangsamoro region ARMM.

MODIS land surface temperature is not air temperature. Clear-sky sampling excludes cloud-covered fields. The fixed 2020 mask does not describe land-use change during 2001-2025, and the 12 dense cropland sites are not a representative sample of all farms. Terra's orbit drift moved overpasses earlier after 2020, so the full-record temperature trend cannot separate climate from observation-time effects. The 2001-2019 refit is disclosed beside the full-record trend. [Peng et al. (2004)](https://doi.org/10.1073/pnas.0403720101), PNAS 101(27), 9971-9975, reported about 10% less dry-season rice grain yield per +1 °C of minimum air temperature at IRRI in Los Baños. That study is context only. This page does not estimate Philippine yield loss.

MERRA-2 air temperature and MODIS clear-sky surface temperature measure different quantities over different footprints and sampling times. A difference between their trends is not proof that either dataset is wrong. The air-temperature grid cannot resolve individual fields, city blocks, pollution effects, or a local urban heat island. Celsius differences and slopes are meaningful, but percentages of Celsius temperatures are not.

## Map behaviour

- The map is one MapLibre instance in a sticky column. The story chapters and the explorer share it.
- On desktop and trackpad, plain wheel zoom always works. Pinch, double-click, the zoom buttons and the keyboard work too. Rotation and pitch are off. Zoom runs from 3.5 to 11 inside 108° E to 134° E and 0° to 25° N.
- On touch screens during the story, MapLibre's cooperative gestures keep one-finger page scrolling free. In the explorer every gesture works.
- A manual zoom, pan or selection hands the map to the reader. Scrolling then updates the active chapter but leaves the camera alone. A chapter link, a "Next" link or "Back to the story view" returns the map to the story.
- The label transform replaces every place-name `text-field` with English, then Latin-script names, keeps road shields, and removes the two `water_name` layers. The client fetches and transforms the style before it creates the map. If the style fails or takes longer than 8 seconds, a plain local style keeps the rainfall squares usable.
- Rainfall farmland mode shows January to April rain gaps, with squares below 10% cropland ghosted and all 12 temperature windows outlined. The explorer also selects MERRA-2 air temperature or farm day and night surface temperatures. Air maps show native coarse polygons. Farm temperature maps show only sampled windows, with a site selector and an equal-site mean instead of regional farm averages.
- Rainfall January to April trend maps show regional aggregate slopes, not per-cell slopes. Selecting a square in that view selects its assigned region. January to April average maps use a separate rainfall scale instead of annual-total breaks.
- Guided demos have explicit Back, Next, and Exit controls. Changing a variable, year, location, or map camera exits the demo. Plain Explore links retain the current investigation. Share URLs record variable, window, mode, year when relevant, and the selected native cell, site, or region.
- The root element carries `data-state`, `data-basemap`, `data-phase`, `data-chapter`, `data-owner`, `data-variable`, `data-window`, `data-demo`, `data-mode`, `data-year`, `data-focus`, `data-camera`, and `data-cells` for browser checks.

## Sizes

- `public/data/philippines-rainfall.json` is 1,416,243 bytes, 494,868 bytes gzipped.
- `data/sources/imerg-monthly.json.gz` is 3,008,202 bytes.
- `data/sources/modis-farm.json.gz` is 88,912 bytes. Its 1,239-request manifest is 380,839 bytes. The two committed additions total 469,751 bytes.
- The ignored MODIS raw cache and sidecars total 27,457,996 bytes. Acquisition made 39 land-cover requests and 1,200 temperature requests.
- `data/sources/merra2-monthly.json.gz` is 107,473 bytes. Its four-request manifest is 1,923 bytes.
- The five pictures total 1,715,781 bytes.

## File ownership

- `scripts/imerg.py` owns IMERG acquisition, the raw cache and the monthly cube.
- `scripts/modis.py` owns MODIS acquisition, response validation, the hash-verified raw cache, cropland mapping, deterministic site selection and composite reduction.
- `scripts/merra2.py` owns native-grid T2M acquisition, monthly validation, day-weighted time windows, and pinned source replay.
- `scripts/build_rainfall.py` owns snapshot pinning, weights, rainfall and temperature statistics, legend breaks, story facts and the artifact.
- `data/sources/` holds the preserved snapshots and their manifests.
- `src/lib/rainfall.ts` owns the artifact schema, its types and the cell grid.
- `src/lib/story.ts` owns formatting, the claim registry and the direction-word guard.
- `src/lib/view.ts` owns the chapter table, the view state and its reducer.
- `src/lib/variable.ts` owns variable definitions, units, supported map modes, and native-cell or sampled-window coverage.
- `src/lib/basemap.ts`, `src/lib/colour.ts`, `src/lib/chart.ts` and `src/lib/place.ts` own the label transform, the colour scales, the place chart and place summaries.
- `src/scripts/main.ts` wires loading, scrolling, controls and geolocation. `src/scripts/map.ts` owns the MapLibre instance. `src/scripts/panel.ts` renders the legend and explorer. `src/scripts/compare.ts` and `src/scripts/reveal.ts` own the image slider and section entrances.
- `src/components/Story.astro` and `src/pages/index.astro` own the markup and fixed copy. `src/styles/global.css` owns the layout.
- `tests/test_build_rainfall.py` covers Sen and Mann-Kendall against the independent point series, ties, flat series, leap days, missing days, fill values, weighted means, same-calendar-year January to April aggregation, seasonal versus annual El Niño comparisons, the El Niño threshold, edge containment, legend breaks, tied regions, sinusoidal geolocation, nested MODIS pixels, cropland and composite-validity thresholds, site spacing and temperature refits.
- `tests/test_merra2.py` covers native-cell coverage, bad source responses, overlapping requests, calendar-day weighting, leap years, coastline weights, unrounded aggregate trends, and pinned offline replay.
- `tests/kmeans.test.ts` checks that the browser k-means reproduces the published groups and round count.
- `tests/view.test.ts` covers variable normalization, playback, demo transitions, spatial coverage, unavailable per-cell seasonal trends, and malformed artifact rejection.

## Use of Super Intelligence (SI) tools

This project follows the NASA Space Apps Challenge rules on Super Intelligence (SI) tools. SI was used in these places:

- **Code.** The data builder and acquisition scripts (`scripts/`), the website (`src/`), the tests (`tests/`) and this README were written with Claude Code running Claude Opus 5.5 (Anthropic), working from my instructions and reviewed by me. Commits it helped write carry a `Co-Authored-By: Claude Opus 5.5` trailer.
- **Data processing.** Every statistic, the k-means rain-calendar grouping and the story sentences are computed by that SI-written code from the NASA and partner datasets listed above. The datasets themselves are unmodified downloads, pinned with their hashes in `data/sources/`.
- **Video.** Both demo videos were scripted, operated and recorded by Claude Code, and each carries a visible SI-GENERATED watermark in every frame. `demo/ulan-demo.mp4` is a 30-second tour of the website, driven by `demo/record-site.cjs` (Playwright in Chrome). `demo/ulan-terminal.mp4` shows the headline numbers and tests in a terminal, recorded with VHS from `demo/demo.tape`. `demo/watermark.sh` burns the watermark into both.
- **Metadata.** `package.json`, `pyproject.toml` and the site's `<meta name="ai-assistance">` tag also record SI use.

No SI-generated images are used. The five photographs and maps on the site are unmodified NASA Earth Observatory files with their original credits. The project does not use or modify NASA logos, flags or mission identifiers.

---

*I used Claude Code with Claude Opus 5.5 for this project, and I take ownership of the code it generated.*
