# Ulan, measured

A static data story about 25 years of NASA satellite rainfall over the Philippines, 2001 to 2025. It maps 3,735 native IMERG squares, fits one trend method to every square, region and the country, and compares years that began in El Niño with the other years. A reader can then find their own square and read its 25 annual totals.

The site is one Astro page and one Python data builder. It has no backend and makes no NASA request from the browser. Every number in the prose is rendered into static HTML at build time from the same JSON file the map loads.

## Commands

The lockfiles are `package-lock.json` and `uv.lock`. The project uses Node 22.22.0 or later and Python 3.14. This version was built with Node 24.13.0, npm 11.6.2 and uv 0.9.27.

```sh
npm ci
uv sync --frozen
npm run dev
```

Run the numerical tests, the type checker and the production build:

```sh
uv run --frozen python -m unittest discover -s tests
npm run check
npm run build
npm run preview -- --host 127.0.0.1
```

Rebuild the artifact from the pinned snapshots. This needs no network.

```sh
uv run --frozen --offline scripts/build_rainfall.py
```

A plain run downloads a snapshot only when its file is missing. `--refresh` downloads every small snapshot again and then rebuilds the IMERG cube through `scripts/imerg.py`, which reuses hash-verified cache entries in `data/cache/imerg/` and fetches only missing tile-years.

```sh
uv run --frozen scripts/build_rainfall.py --refresh
```

To refetch the raw IMERG tiles on their own, run `uv run --frozen scripts/imerg.py`. Add `--offline` to rebuild the cube from the cache only. The raw cache is about 360 MB and is ignored by git.

The builder validates every input before it replaces any file. Each write is atomic. A failed download or validation exits with an error and publishes nothing. Output JSON has sorted keys and fixed rounding, and the provenance records keep their original retrieval times, so an offline replay reproduces `public/data/philippines-rainfall.json` byte for byte.

## Dependencies

JavaScript: Astro 7.4.1, MapLibre GL JS 6.15.0, Zod 4.6.7, `@fontsource/imbue` 5.3.0 and `@fontsource/albert-sans` 5.3.0. Development: `@astrojs/check` 0.9.11, TypeScript ~6.0.3, `@types/node` 24.19.2 for the page's build-time file read, and `@maplibre/maplibre-gl-style-spec` 26.4.4, which supplies the style and expression types that `maplibre-gl` 6 does not re-export.

Python: Shapely 2.2 only. Its wheel pulls in NumPy. The statistics use the Python standard library.

## Sources and licenses

| Snapshot | Source | License or terms |
| --- | --- | --- |
| `data/sources/imerg-monthly.json.gz` | NASA POWER daily regional API, parameter `IMERG_PRECTOT` (GPM IMERG Final Run), UTC days, 36 tiles of 2° by 2° for each of 25 years, 900 requests | NASA data, no credentials |
| `data/sources/boundary.json.gz` | geoBoundaries gbOpen PHL ADM0, revision `9469f09592ced973a3448cf66b6100b741b64c0d` | CC BY 3.0 IGO |
| `data/sources/adm1.json.gz` | geoBoundaries gbOpen PHL ADM1, revision `41af8f1e141eb6826ab9877e306df6f848b9ff0b`, 17 regions | CC BY 3.0 IGO |
| `data/sources/oni.txt.gz` | NOAA CPC Oceanic Niño Index, `oni.ascii.txt` | US government data |
| `data/sources/audit/*.json.gz` | NASA POWER point requests at 121.25° E, 14.5° N used only for the source audit below | NASA data |

`data/sources/manifest.json` records each snapshot's URL, SHA-256 of the uncompressed bytes, byte length and retrieval time. Its `imerg` entry points to `imerg-manifest.json`, which lists all 900 tile requests with their hashes. Each `.gz` file stores the original response bytes.

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

**Annual totals.** `scripts/imerg.py` sums each pixel's daily values into calendar months, and the builder sums twelve months into each year. A daily value in mm/day counts as that many millimetres for one UTC day. Leap days are included. Missing days, fill values, negative values and off-grid centres fail acquisition.

**Squares.** A pixel's id is `row-col` on IMERG's global 0.1° grid. Its centre is latitude −89.95 + 0.1 × row and longitude −179.95 + 0.1 × col. The map draws each pixel as its full 0.1° square, not clipped to the coast. The set of squares is every square with a positive-area intersection with the pinned ADM0 boundary. The builder checks that this set equals the cube's 3,735 pixels.

**Weights.** A square's national weight is the area of its intersection with ADM0, in square degrees, times the cosine of its centre latitude. A square's weight in a region is the area of its intersection with that region and ADM0, times the same cosine. A square on a border counts toward every region it touches. The national and regional series are the weighted means of the squares' annual totals. The artifact ships every region's member list and weights, so anyone can rebuild the series.

**Trend.** For each series, the Sen slope is the median of the 300 pairwise slopes between years. The page reports it in mm per decade and as a percentage of the 2001-2025 mean per decade. The Mann-Kendall test uses tie-corrected variance, the continuity correction and a two-sided normal p-value, with n = 25 and no autocorrelation correction. A change "meets the test" when p < 0.05. The builder decides direction, the test result, area shares and rankings on unrounded values and writes those decisions into the artifact. The browser never re-tests a rounded p. When a printed p would round onto the wrong side of 0.05, the page prints more digits.

**El Niño-start years.** A year began in El Niño when NOAA's December-to-February ONI for that year is +0.5 °C or more. The comparison reports the two group means, the difference as a percentage of the other years' mean, and how many El Niño-start years fell below the 2001-2025 mean. It is descriptive and has no test.

**Story copy.** `src/lib/story.ts` picks every scientific sentence from a table of wordings keyed by the computed result. `assertClaims` fails the build when a claim is missing, when a sentence uses a direction word that contradicts its result, or when a heading is longer than 44 characters. Each claim renders with `data-claim` and `data-verdict`.

## Results at build time

These are the values in the current artifact. They come from the builder's output, not from hand entry.

- National average year: 2,617 mm. Sen slope +180 mm per decade, +6.9% of the mean per decade, p = 0.168. It does not meet the test.
- 91.0% of land lies in squares with a rising slope. 13.5% lies in the 533 squares whose rise meets the test. No square's fall meets it.
- Nine years began in El Niño: 2003, 2005, 2007, 2010, 2015, 2016, 2019, 2020 and 2024. They averaged 2,322 mm against 2,783 mm for the other 16 years, 16.6% less. All nine were below the 2001-2025 mean.
- All 17 regions had less rain in El Niño-start years. The widest gap is Eastern Visayas, −33.6%.
- Mimaropa has the largest fitted change of the 17 regions, +10.8% per decade, p = 0.047. Calabarzon and Mimaropa are the two regions that meet the test.

## Why the map moved from MERRA-2 to IMERG

The first version of this map used NASA POWER's MERRA-2 `PRECTOTCORR`. At 121.25° E, 14.5° N, its 2020 annual total was 6,664 mm, against 2,865 mm from IMERG at the same point, a ratio of 2.33. In the other 24 years the ratio stayed between 0.92 and 1.15. MERRA-2's dry-season months in 2020 were the cause, not an aggregation error. 2020 also began in El Niño, so that one year would have bent both the trend and the El Niño comparison. The project was rebuilt on IMERG, and MERRA-2 no longer appears in the explorer.

The builder recomputes this audit from the two preserved point responses in `data/sources/audit/` and stores it as `provenance.source_audit`. The "Why we use IMERG" disclosure on the page shows the 25-year table from that record.

## Limits

Annual totals cannot show extremes, dry-season timing or typhoon intensity. Coastal squares include sea. The trend test assumes independent years, and testing 3,735 neighbouring squares means about 5% of land could meet the test by chance even with no trend, as a rough guide only. The El Niño comparison does not separate El Niño from other causes. Nothing on the page is a forecast. The boundary files mark the area the data covers and do not state a position on territorial claims. The ADM1 file still names the Bangsamoro region ARMM.

## Map behaviour

- The map is one MapLibre instance in a sticky column. The story chapters and the explorer share it.
- On desktop and trackpad, plain wheel zoom always works. Pinch, double-click, the zoom buttons and the keyboard work too. Rotation and pitch are off. Zoom runs from 3.5 to 11 inside 108° E to 134° E and 0° to 25° N.
- On touch screens during the story, MapLibre's cooperative gestures keep one-finger page scrolling free. In the explorer every gesture works.
- A manual zoom, pan or selection hands the map to the reader. Scrolling then updates the active chapter but leaves the camera alone. A chapter link, a "Next" link or "Back to the story view" returns the map to the story.
- The label transform replaces every place-name `text-field` with English, then Latin-script names, keeps road shields, and removes the two `water_name` layers. The client fetches and transforms the style before it creates the map. If the style fails or takes longer than 8 seconds, a plain local style keeps the rainfall squares usable.
- The root element carries `data-state`, `data-basemap`, `data-phase`, `data-chapter`, `data-owner`, `data-mode`, `data-year`, `data-focus`, `data-camera` and `data-cells` for browser checks.

## Sizes

- `public/data/philippines-rainfall.json` is 787,608 bytes, 271,951 bytes gzipped.
- `data/sources/imerg-monthly.json.gz` is 3,008,202 bytes.
- The five pictures total 1,715,781 bytes.

## File ownership

- `scripts/imerg.py` owns IMERG acquisition, the raw cache and the monthly cube.
- `scripts/build_rainfall.py` owns snapshot pinning, weights, statistics, legend breaks, story facts and the artifact.
- `data/sources/` holds the preserved snapshots and their manifests.
- `src/lib/rainfall.ts` owns the artifact schema, its types and the cell grid.
- `src/lib/story.ts` owns formatting, the claim registry and the direction-word guard.
- `src/lib/view.ts` owns the chapter table, the view state and its reducer.
- `src/lib/basemap.ts`, `src/lib/colour.ts`, `src/lib/chart.ts` and `src/lib/place.ts` own the label transform, the colour scales, the place chart and place summaries.
- `src/scripts/main.ts` wires loading, scrolling, controls and geolocation. `src/scripts/map.ts` owns the MapLibre instance. `src/scripts/panel.ts` renders the legend and explorer. `src/scripts/compare.ts` and `src/scripts/reveal.ts` own the image slider and section entrances.
- `src/components/Story.astro` and `src/pages/index.astro` own the markup and fixed copy. `src/styles/global.css` owns the layout.
- `tests/test_build_rainfall.py` covers Sen and Mann-Kendall against the independent point series, ties, flat series, leap days, missing days, fill values, weighted means, the El Niño threshold, edge containment, legend breaks and tied regions.
