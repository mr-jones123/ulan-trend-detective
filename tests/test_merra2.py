import calendar
import copy
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from shapely.geometry import box

from scripts import imerg, merra2
from scripts.build_rainfall import air_record, air_series_record, series_record


FLAGS = [k % 3 == 0 for k in range(25)]


def response_body(tile):
    return {
        "type": "FeatureCollection",
        "header": {"sources": ["MERRA2"], "time_standard": "UTC", "start": "20010101",
                   "end": "20251231", "fill_value": -999,
                   "api": {"name": "POWER Monthly and Annual API", "version": "test"}},
        "parameters": {"T2M": {"units": "C", "longname": "Temperature at 2 Meters"}},
        "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [col * 0.625, row * 0.5]},
                      "properties": {"parameter": {"T2M": {key: 25.0 for key in merra2.KEYS}}}}
                     for row, col in sorted(tile.indices())],
    }


class MonthlyInputTests(unittest.TestCase):
    def setUp(self):
        self.tile = merra2.Tile(10, 10, 120, 120)
        self.body = response_body(self.tile)

    def parse(self, body):
        return merra2.parse_response(json.dumps(body).encode(), self.tile)[0]

    def test_complete_native_point_accepts_negative_celsius(self):
        self.body["features"][0]["properties"]["parameter"]["T2M"]["200101"] = -3.5
        points = self.parse(self.body)
        self.assertEqual(set(points), {(20, 192)})
        self.assertEqual(points[(20, 192)][0], -3.5)

    def test_missing_extra_fill_nonfinite_and_boolean_values_fail(self):
        for mutation in ("missing", "extra", -999, float("nan"), float("inf"), True):
            with self.subTest(mutation=mutation):
                body = copy.deepcopy(self.body)
                values = body["features"][0]["properties"]["parameter"]["T2M"]
                if mutation == "missing":
                    del values["202002"]
                elif mutation == "extra":
                    values["202614"] = 25
                else:
                    values["202002"] = mutation
                with self.assertRaises(ValueError):
                    self.parse(body)

    def test_annual_summary_must_also_be_present_and_valid(self):
        for value in (None, -999):
            body = copy.deepcopy(self.body)
            values = body["features"][0]["properties"]["parameter"]["T2M"]
            if value is None:
                del values["202013"]
            else:
                values["202013"] = value
            with self.assertRaises(ValueError):
                self.parse(body)

    def test_unexpected_source_units_clock_and_dates_fail(self):
        for key, value in (("sources", ["IMERG"]), ("time_standard", "LST"),
                           ("start", "20020101"), ("end", "20241231"), ("fill_value", None)):
            body = copy.deepcopy(self.body)
            body["header"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.parse(body)
        self.body["parameters"]["T2M"]["units"] = "K"
        with self.assertRaises(ValueError):
            self.parse(self.body)

    def test_offgrid_outside_missing_and_duplicate_points_fail(self):
        for mutation in ("offgrid", "outside", "missing", "duplicate"):
            body = copy.deepcopy(self.body)
            if mutation == "offgrid":
                body["features"][0]["geometry"]["coordinates"][0] += 0.1
            elif mutation == "outside":
                body["features"][0]["geometry"]["coordinates"][0] += 0.625
            elif mutation == "missing":
                body["features"] = []
            else:
                body["features"].append(copy.deepcopy(body["features"][0]))
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.parse(body)

    def test_overlapping_requests_deduplicate_only_identical_records(self):
        points = self.parse(self.body)
        merged = dict(points)
        merra2.merge_points(merged, points)
        self.assertEqual(len(merged), 1)
        changed = list(points[(20, 192)])
        changed[-1] += 0.01
        with self.assertRaises(ValueError):
            merra2.merge_points(merged, {(20, 192): tuple(changed)})


class TemperatureAggregationTests(unittest.TestCase):
    def test_calendar_day_weighting_preserves_leap_year_and_year_boundaries(self):
        monthly = [value for k in range(25) for value in [k, 100 + k] + [k] * 10]
        annual = merra2.period_means(monthly, range(1, 13))
        jan_apr = merra2.period_means(monthly, range(1, 5))
        for k, year in enumerate(imerg.YEARS):
            february = 29 if calendar.isleap(year) else 28
            self.assertAlmostEqual(annual[k], k + 100 * february / (366 if february == 29 else 365))
            self.assertAlmostEqual(jan_apr[k], k + 100 * february / (121 if february == 29 else 120))

    def test_annual_summary_is_not_a_thirteenth_month(self):
        tile = merra2.Tile(10, 10, 120, 120)
        body = response_body(tile)
        values = body["features"][0]["properties"]["parameter"]["T2M"]
        for year in imerg.YEARS:
            values[f"{year}13"] = 99
        points, _ = merra2.parse_response(json.dumps(body).encode(), tile)
        boundary = box(119.9, 9.9, 120.1, 10.1)
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "snapshot.gz"
            manifest = Path(directory) / "manifest.json"
            with patch.object(merra2, "TILES", (tile,)), patch.object(merra2, "SNAPSHOT", snapshot), \
                    patch.object(merra2, "MANIFEST", manifest), patch.object(merra2, "acquire_request", return_value=(
                        points, {"url": tile.request_url()}, {"name": "POWER", "version": "test"})):
                data, _ = merra2.build_snapshot(boundary)
        self.assertEqual(data["cells"][0]["monthly_c"], [25] * 300)

    def test_positive_negative_and_flat_air_trends_have_no_terra_refit(self):
        for slope, direction in ((0.1, "up"), (-0.1, "down"), (0, "zero")):
            values = [25 + slope * (year - 2013) for year in imerg.YEARS]
            record = air_series_record(values, FLAGS)
            self.assertEqual(record["direction"], direction)
            self.assertEqual(record["sen_c_decade"], slope * 10)
            self.assertEqual(record["sen_mid_c"], 25)
            self.assertEqual(record["meets_threshold"], slope != 0)
            self.assertNotIn("refit", record)
        self.assertEqual(air_series_record([25] * 25, FLAGS)["p"], 1)

    def test_coastal_cells_and_partial_region_area_control_aggregation(self):
        boundary = box(0.2, -0.1, 0.6, 0.1)
        region = {"id": "west", "land": box(0.2, -0.1, 0.4, 0.1)}
        monthly = {(0, 0): [10] * 300, (0, 1): [30] * 300}
        self.assertEqual(merra2.land_cells(boundary), set(monthly))
        record = air_record(monthly, boundary, [region], FLAGS)
        self.assertEqual([cell["id"] for cell in record["cells"]], ["0-0", "0-1"])
        self.assertEqual(record["cells"][0]["bounds"], [-0.3125, -0.25, 0.3125, 0.25])
        self.assertAlmostEqual(record["cells"][0]["weight"], 0.1125 * 0.2)
        self.assertEqual(record["national"]["annual"]["mean_c"], 24.375)
        self.assertEqual(record["regions"][0]["annual"]["mean_c"], 18.75)
        self.assertEqual(record["regions"][0]["members"], [0, 1])
        self.assertEqual(record["regions"][0]["weights"], [0.0225, 0.0175])
        with self.assertRaises(ValueError):
            air_record({(0, 0): [10] * 300}, boundary, [region], FLAGS)

    def test_aggregate_trend_uses_unrounded_cell_values(self):
        boundary = box(-0.3, -0.1, 0.9, 0.1)
        monthly = {(0, 0): [25 + k * 0.000001 for k in range(25) for _ in range(12)],
                   (0, 1): [25 + k * 0.000002 for k in range(25) for _ in range(12)]}
        record = air_record(monthly, boundary, [{"id": "all", "land": boundary}], FLAGS)
        self.assertEqual(record["national"]["annual"]["direction"], "up")
        self.assertTrue(record["national"]["annual"]["meets_threshold"])
        self.assertEqual(record["national"]["annual"]["sen_c_decade"], 0)

    def test_air_annual_and_january_april_use_separate_months(self):
        boundary = box(-0.1, -0.1, 0.1, 0.1)
        monthly = {(0, 0): [value for k in range(25) for value in [25 + 0.1 * k] * 4 + [25 - 0.1 * k] * 8]}
        record = air_record(monthly, boundary, [{"id": "all", "land": boundary}], FLAGS)
        self.assertEqual(record["national"]["annual"]["direction"], "down")
        self.assertEqual(record["national"]["jan_apr"]["direction"], "up")
        self.assertEqual(record["national"]["jan_apr"]["sen_c_decade"], 1)
        self.assertEqual(record["national"]["jan_apr"]["mean_c"], 26.2)

    def test_rain_annual_and_january_april_trends_can_oppose(self):
        record = series_record([2000 + k * 10 for k in range(25)], [500 - k * 2 for k in range(25)], FLAGS)
        self.assertEqual(record["direction"], "up")
        self.assertEqual(record["jan_apr"]["direction"], "down")
        self.assertEqual(record["jan_apr"]["sen_mm_decade"], -20)
        self.assertEqual(record["jan_apr"]["sen_mid_mm"], 476)
        self.assertTrue(record["jan_apr"]["meets_threshold"])
        self.assertAlmostEqual(record["jan_apr"]["sen_pct_decade"], -4.202)


class PinnedReplayTests(unittest.TestCase):
    def test_verified_raw_cache_reuses_original_retrieval_time(self):
        tile = merra2.Tile(10, 10, 120, 120)
        raw = imerg.json_bytes(response_body(tile))
        url = tile.request_url()
        record = {"url": url, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                  "retrieved_at": "2026-10-20T00:00:00+00:00"}
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            path = cache / (hashlib.sha256(url.encode()).hexdigest() + ".json.gz")
            path.write_bytes(gzip.compress(raw, mtime=0))
            sidecar = path.with_suffix(".meta.json")
            sidecar.write_bytes(imerg.json_bytes(record))
            with patch.object(merra2, "CACHE", cache), \
                    patch.object(merra2, "urlopen", side_effect=AssertionError("Network forbidden")):
                points, reused, _ = merra2.acquire_request(tile)
            self.assertEqual(points[(20, 192)], (25,) * 325)
            self.assertEqual(reused, record)
            self.assertEqual(json.loads(sidecar.read_bytes()), record)
            path.write_bytes(gzip.compress(raw + b" ", mtime=0))
            self.assertIsNone(imerg.cached_response(path, url))

    def test_real_snapshot_replays_without_network_and_keeps_2020(self):
        with patch.object(merra2, "urlopen", side_effect=AssertionError("Network forbidden")):
            monthly, provenance = merra2.load_snapshot()
        self.assertEqual(len(monthly), 223)
        self.assertEqual(provenance["requests"], 4)
        self.assertTrue(all(len(values) == 300 for values in monthly.values()))
        self.assertTrue(all(merra2.valid_value(values[19 * 12 + month]) for values in monthly.values()
                            for month in range(12)))

    def test_missing_and_corrupted_snapshot_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.gz"
            with patch.object(merra2, "SNAPSHOT", path), \
                    patch.object(merra2, "urlopen", side_effect=AssertionError("Network forbidden")):
                with self.assertRaises(FileNotFoundError):
                    merra2.load_snapshot()
                path.write_bytes(b"corrupted")
                with self.assertRaises(ValueError):
                    merra2.load_snapshot()

    def test_hash_valid_but_incomplete_snapshot_fails_spatial_coverage(self):
        data = json.loads(gzip.decompress(merra2.SNAPSHOT.read_bytes()))
        manifest = json.loads(merra2.MANIFEST.read_bytes())
        data["cells"].pop()
        compressed = gzip.compress(imerg.json_bytes(data), mtime=0)
        manifest["snapshot"].update(sha256=hashlib.sha256(compressed).hexdigest(), bytes=len(compressed))
        with tempfile.TemporaryDirectory() as directory:
            snapshot_path = Path(directory) / merra2.SNAPSHOT.name
            manifest_path = Path(directory) / merra2.MANIFEST.name
            snapshot_path.write_bytes(compressed)
            manifest_path.write_bytes(imerg.json_bytes(manifest))
            with patch.object(merra2, "SNAPSHOT", snapshot_path), patch.object(merra2, "MANIFEST", manifest_path):
                with self.assertRaises(ValueError):
                    merra2.load_snapshot()

    def test_missing_and_malformed_api_provenance_fail_closed(self):
        manifest = json.loads(merra2.MANIFEST.read_bytes())
        for apis in (None, [], ["POWER"], [{"name": "", "version": "v1"}],
                     [{"name": "POWER", "version": None}]):
            with self.subTest(apis=apis), tempfile.TemporaryDirectory() as directory:
                changed = {**manifest, "api": apis}
                path = Path(directory) / "manifest.json"
                path.write_bytes(imerg.json_bytes(changed))
                with patch.object(merra2, "MANIFEST", path):
                    with self.assertRaisesRegex(ValueError, "API identity"):
                        merra2.load_snapshot()


if __name__ == "__main__":
    unittest.main()
