import json
import math
import unittest

from scripts import imerg
from scripts.build_rainfall import (
    ALPHA, PANTABANGAN, YEARS, began_el_nino, cell_containing, cube_series, diverging_breaks, enso_comparison,
    mann_kendall, parse_oni, power_point, sen_intercept, sen_slope, serial_p, tied, trend_classes,
    series_record, weighted_mean_series,
)

POINT_SERIES = [2611, 2549, 1870, 2175, 2726, 2282, 2390, 3069, 3287, 2196, 3329, 3467, 3029, 2426, 2101,
                2405, 3029, 2759, 2047, 2865, 2463, 3003, 2758, 2836, 3488]


class TrendTests(unittest.TestCase):
    def test_sen_and_mann_kendall_match_the_independent_point_series(self):
        self.assertAlmostEqual(10 * sen_slope(POINT_SERIES), 192.083, places=3)
        s, p = mann_kendall(POINT_SERIES)
        self.assertEqual(s, 61)
        self.assertAlmostEqual(p, 0.1611, delta=1e-3)

    def test_ties_reduce_the_mann_kendall_variance(self):
        tied_series = [1, 2, 2, 3, 3, 3, 4, 5]
        s, p_tied = mann_kendall(tied_series)
        n = len(tied_series)
        untied_variance = n * (n - 1) * (2 * n + 5) / 18
        untied_p = math.erfc(abs((s - 1) / math.sqrt(untied_variance)) / math.sqrt(2))
        self.assertLess(p_tied, untied_p)

    def test_flat_series_has_zero_slope_and_p_one(self):
        flat = [2500.0] * len(YEARS)
        self.assertEqual(sen_slope(flat), 0)
        self.assertEqual(mann_kendall(flat), (0, 1.0))
        self.assertEqual(sen_intercept(flat, 0), 2500.0)

    def test_linear_series_recovers_slope_and_center_value(self):
        line = [2000 + 12.5 * (year - 2013) for year in YEARS]
        self.assertAlmostEqual(sen_slope(line), 12.5)
        self.assertAlmostEqual(sen_intercept(line, 12.5), 2000)

    def test_classification_uses_unrounded_p(self):
        self.assertEqual(trend_classes(1.0, 0.0499), {"up", "meets_up"})
        self.assertEqual(trend_classes(-1.0, 0.0499), {"down", "meets_down"})
        self.assertEqual(trend_classes(1.0, ALPHA), {"up"})
        with self.assertRaises(ValueError):
            serial_p(0.04999999999)


class DailyInputTests(unittest.TestCase):
    def test_leap_year_sums_every_day(self):
        days = {day: 1.0 for month in imerg.calendar_months(2024) for day in month}
        self.assertEqual(math.fsum(imerg.monthly_reduce(days, 2024)), 366)
        days = {day: 1.0 for month in imerg.calendar_months(2025) for day in month}
        self.assertEqual(math.fsum(imerg.monthly_reduce(days, 2025)), 365)

    def test_missing_day_fails(self):
        days = {day: 1.0 for month in imerg.calendar_months(2024) for day in month}
        del days["20240229"]
        with self.assertRaises(KeyError):
            imerg.monthly_reduce(days, 2024)

    def test_audit_point_rejects_fill_values(self):
        header = {"sources": ["IMERG"], "time_standard": "UTC", "fill_value": -999.0}
        body = {"header": header, "parameters": {"IMERG_PRECTOT": {"units": "mm/day"}},
                "geometry": {"coordinates": [121.25, 14.5, 0]},
                "properties": {"parameter": {"IMERG_PRECTOT": {"20010101": -999.0}}}}
        with self.assertRaises(ValueError):
            power_point(json.dumps(body).encode(), "IMERG_PRECTOT", "IMERG", {"20010101"})


class AggregationTests(unittest.TestCase):
    def synthetic_cube(self):
        return {
            "grid": {"latitude_origin": imerg.LAT_ORIGIN, "longitude_origin": imerg.LON_ORIGIN,
                     "latitude_step": imerg.GRID_STEP, "longitude_step": imerg.GRID_STEP},
            "months": list(imerg.MONTHS),
            "pixels": [
                {"id": "1058-3011", "row": 1058, "col": 3011,
                 "monthly_mm": [100 * year + month for year in range(len(YEARS)) for month in range(1, 13)]},
                {"id": "1058-3012", "row": 1058, "col": 3012,
                 "monthly_mm": [10.0] * len(imerg.MONTHS)},
            ],
        }

    def test_january_to_april_sums_same_calendar_year_only(self):
        annual, jan_apr = cube_series(self.synthetic_cube())
        self.assertEqual(jan_apr[(1058, 3011)], [400 * year + 10 for year in range(len(YEARS))])
        self.assertEqual(annual[(1058, 3011)], [1200 * year + 78 for year in range(len(YEARS))])
        self.assertEqual(jan_apr[(1058, 3012)], [40.0] * len(YEARS))
        weighted = weighted_mean_series([((1058, 3011), 3.0), ((1058, 3012), 1.0)], jan_apr)
        self.assertEqual(weighted, [300 * year + 17.5 for year in range(len(YEARS))])

    def test_january_to_april_comparison_is_not_annual_comparison(self):
        cube = self.synthetic_cube()
        flags = [year % 2 == 0 for year in range(len(YEARS))]
        cube["pixels"][0]["monthly_mm"] = [
            value for flag in flags for value in ([10.0] * 4 + [200.0] * 8 if flag else [25.0] * 4 + [100.0] * 8)
        ]
        annual, jan_apr = cube_series(cube)
        record = series_record(annual[(1058, 3011)], jan_apr[(1058, 3011)], flags)
        comparison = record["jan_apr"]["enso"]
        self.assertEqual(comparison["mean_mm"], 40)
        self.assertEqual(comparison["other_mean_mm"], 100)
        self.assertEqual(comparison["diff_pct"], -60)
        self.assertEqual(comparison["direction"], "down")
        self.assertEqual(comparison["below_mean"], sum(flags))
        self.assertEqual(comparison["other_size"], len(flags) - sum(flags))
        self.assertEqual(record["enso"]["direction"], "up")
        self.assertAlmostEqual(record["jan_apr"]["mean_mm"], 68.8)
        self.assertEqual(record["jan_apr"]["anomaly_pct"][0], -41.86)

    def test_weighted_mean_uses_area_weights(self):
        annual = {0: [1000.0] * len(YEARS), 1: [4000.0] * len(YEARS)}
        series = weighted_mean_series([(0, 3.0), (1, 1.0)], annual)
        self.assertEqual(series[0], 1750.0)

    def test_el_nino_threshold_is_inclusive(self):
        self.assertEqual(began_el_nino([0.49, 0.5, 0.51, -1.0]), [False, True, True, False])

    def test_oni_parser_reads_djf_rows(self):
        rows = ["SEAS  YR   TOTAL   ANOM"] + [f"  DJF {year}  27.00   {0.5 if year == 2003 else -0.1:.2f}" for year in YEARS]
        rows.insert(2, "  JFM 2001  27.00   9.99")
        oni = parse_oni("\n".join(rows).encode())
        self.assertEqual(oni[YEARS.index(2003)], 0.5)
        self.assertEqual(len(oni), len(YEARS))

    def test_enso_comparison_counts_years_below_the_mean(self):
        values = [1000.0, 3000.0, 1500.0, 2500.0]
        comparison = enso_comparison(values, [True, False, True, False], sum(values) / 4)
        self.assertEqual(comparison["below_mean"], 2)
        self.assertAlmostEqual(comparison["diff_pct"], 100 * (1250 / 2750 - 1))

    def test_point_on_a_square_edge_belongs_to_the_square_north_and_east(self):
        self.assertEqual(cell_containing(121.2, 14.5), (1045, 3012))
        self.assertEqual(cell_containing(121.25, 14.45), (1044, 3012))

    def test_pantabangan_point_is_in_the_lake_square(self):
        self.assertEqual(cell_containing(*PANTABANGAN), (1058, 3011))

    def test_diverging_breaks_are_symmetric_and_cover_the_98th_percentile(self):
        breaks = diverging_breaks([-3.0, 1.0, 2.0, 4.5], [1.0, 1.0, 1.0, 1.0])
        self.assertEqual(breaks, [-5.0, -3.75, -2.5, -1.25, 0.0, 1.25, 2.5, 3.75, 5.0])

    def test_ties_name_every_extreme_region(self):
        regions = [{"id": "a", "v": 2}, {"id": "b", "v": 5}, {"id": "c", "v": 5}]
        self.assertEqual(tied(regions, lambda r: r["v"], max), ["b", "c"])


if __name__ == "__main__":
    unittest.main()
