"""Build the 2001-2025 IMERG rainfall story artifact from pinned source snapshots.

A plain run replays the snapshots in data/sources and downloads only snapshots
that are missing. ``--refresh`` downloads every small snapshot again and
rebuilds the IMERG cube through scripts/imerg.py, which reuses hash-verified
cache entries and fetches only missing tile-years.
"""

import argparse
import calendar
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
import re
import statistics
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from shapely.geometry import MultiPolygon, Polygon, box, shape
from shapely.ops import unary_union
from shapely.prepared import prep

if __package__:
    from . import climate, imerg, merra2, modis, tmin
else:
    import climate
    import imerg
    import merra2
    import modis
    import tmin

ROOT = imerg.ROOT
SOURCES = imerg.SOURCES
OUTPUT = ROOT / "public" / "data" / "philippines-rainfall.json"
MANIFEST = SOURCES / "manifest.json"
IMERG_MANIFEST = SOURCES / "imerg-manifest.json"
YEARS = imerg.YEARS
STEP = imerg.GRID_STEP
EDGE_SLACK_CELLS = 1e-9
CENTER_YEAR = 2013
ALPHA = 0.05
ENSO_THRESHOLD = 0.5
REGION_COUNT = 17
AUDIT_POINT = (121.25, 14.5)
PANTABANGAN = (121.14, 15.85)
GIOVANNI = SOURCES / "giovanni" / "imerg-monthly-ph-bbox.csv"
GIOVANNI_BBOX = [116.9, 4.5, 126.7, 21.2]
DIVERGING_EXTENTS = (2, 4, 5, 8, 10, 15, 20, 30, 40, 50, 60, 80, 100)
MEAN_CLASSES = 7
MEAN_STEP = 500
P_DIGITS = 6
POWER = "https://power.larc.nasa.gov/api/temporal"
ADM0_URL = ("https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/"
            "9469f09592ced973a3448cf66b6100b741b64c0d/"
            "releaseData/gbOpen/PHL/ADM0/geoBoundaries-PHL-ADM0_simplified.geojson")
ADM1_URL = ("https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/"
            "41af8f1e141eb6826ab9877e306df6f848b9ff0b/"
            "releaseData/gbOpen/PHL/ADM1/geoBoundaries-PHL-ADM1_simplified.geojson")
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
AUDIT_QUERY = {"community": "AG", "longitude": AUDIT_POINT[0], "latitude": AUDIT_POINT[1],
               "format": "JSON", "time-standard": "UTC"}


@dataclass(frozen=True)
class Snapshot:
    name: str
    url: str
    file: str
    pinned_sha256: str | None = None


SNAPSHOTS = (
    Snapshot("adm0", ADM0_URL, "boundary.json.gz", imerg.BOUNDARY_HASH),
    Snapshot("adm1", ADM1_URL, "adm1.json.gz"),
    Snapshot("oni", ONI_URL, "oni.txt.gz"),
    Snapshot("audit_merra2", f"{POWER}/monthly/point?" + urlencode(
        {"parameters": "PRECTOTCORR", **AUDIT_QUERY, "start": YEARS[0], "end": YEARS[-1]}),
        "audit/merra2-prectotcorr-monthly-point.json.gz"),
    Snapshot("audit_imerg", f"{POWER}/daily/point?" + urlencode(
        {"parameters": "IMERG_PRECTOT", **AUDIT_QUERY,
         "start": f"{YEARS[0]}0101", "end": f"{YEARS[-1]}1231"}),
        "audit/imerg-prectot-daily-point.json.gz"),
)

BOUNDARY_META = {
    "adm0": {"provider": "geoBoundaries gbOpen PHL ADM0", "source": "OCHA Philippines / NAMRIA",
             "revision": "9469f09592ced973a3448cf66b6100b741b64c0d", "license": "CC BY 3.0 IGO"},
    "adm1": {"provider": "geoBoundaries gbOpen PHL ADM1", "source": "NAMRIA / PSA / OCHA",
             "revision": "41af8f1e141eb6826ab9877e306df6f848b9ff0b", "license": "CC BY 3.0 IGO"},
}


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def rnd(value, digits):
    rounded = round(value, digits)
    return rounded + 0.0 if rounded == 0 else rounded


def significant(value):
    return float(f"{value:.6g}")


def download(url):
    print(f"Downloading {url}", flush=True)
    request = Request(url, headers={"User-Agent": imerg.USER_AGENT})
    try:
        with urlopen(request, timeout=240) as response:
            return response.read()
    except HTTPError as error:
        detail = error.read(4096).decode("utf-8", errors="replace").strip()
        raise ValueError(f"Download failed for {url}: HTTP {error.code}: {detail}") from error
    except (URLError, TimeoutError) as error:
        raise ValueError(f"Download failed for {url}: {error}") from error


def acquire(refresh, offline=False):
    manifest = json.loads(MANIFEST.read_bytes()) if MANIFEST.exists() else {}
    raws, records = {}, {}
    for snapshot in SNAPSHOTS:
        path = SOURCES / snapshot.file
        record = manifest.get(snapshot.name)
        if not refresh and path.exists():
            if record is None or record["url"] != snapshot.url or record["file"] != snapshot.file:
                raise ValueError(f"Manifest entry for {snapshot.file} does not match the fixed request")
            raw = gzip.decompress(path.read_bytes())
            if sha256(raw) != record["sha256"] or len(raw) != record["bytes"]:
                raise ValueError(f"Snapshot {snapshot.file} differs from its manifest hash")
        else:
            if offline:
                raise ValueError(f"Missing offline snapshot {snapshot.file}")
            raw = download(snapshot.url)
            record = {"url": snapshot.url, "file": snapshot.file, "sha256": sha256(raw), "bytes": len(raw),
                      "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        if snapshot.pinned_sha256 is not None and record["sha256"] != snapshot.pinned_sha256:
            raise ValueError(f"Snapshot {snapshot.name} differs from its pinned SHA-256")
        raws[snapshot.name] = raw
        records[snapshot.name] = record
    return raws, records


def load_cube():
    manifest_raw = IMERG_MANIFEST.read_bytes()
    manifest = json.loads(manifest_raw)
    cube_path = SOURCES / manifest["cube"]["file"]
    compressed = cube_path.read_bytes()
    if sha256(compressed) != manifest["cube"]["sha256"] or len(compressed) != manifest["cube"]["bytes"]:
        raise ValueError("IMERG cube differs from imerg-manifest.json")
    cube = json.loads(gzip.decompress(compressed))
    annual, jan_apr = cube_series(cube)
    record = {"file": cube_path.name, "sha256": manifest["cube"]["sha256"], "bytes": manifest["cube"]["bytes"],
              "manifest": IMERG_MANIFEST.name, "manifest_sha256": sha256(manifest_raw),
              "tiles": manifest["counts"]["tiles"], "requests": manifest["counts"]["requests"],
              "api": manifest["api"]}
    return annual, jan_apr, record, climate.month_shares(cube)


def cube_series(cube):
    expected_grid = {"latitude_origin": imerg.LAT_ORIGIN, "longitude_origin": imerg.LON_ORIGIN,
                     "latitude_step": STEP, "longitude_step": STEP}
    if cube["grid"] != expected_grid or cube["months"] != list(imerg.MONTHS):
        raise ValueError("IMERG cube grid or month axis is unexpected")
    annual, jan_apr = {}, {}
    for pixel in cube["pixels"]:
        row, col, monthly = pixel["row"], pixel["col"], pixel["monthly_mm"]
        if pixel["id"] != f"{row}-{col}" or len(monthly) != len(imerg.MONTHS):
            raise ValueError(f"Malformed cube pixel {pixel['id']}")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0
               for v in monthly):
            raise ValueError(f"Invalid monthly total in cube pixel {pixel['id']}")
        if (row, col) in annual:
            raise ValueError(f"Duplicate cube pixel {pixel['id']}")
        annual[(row, col)] = [math.fsum(monthly[k * 12:k * 12 + 12]) for k in range(len(YEARS))]
        jan_apr[(row, col)] = [math.fsum(monthly[k * 12:k * 12 + 4]) for k in range(len(YEARS))]
    return annual, jan_apr


def parse_polygons(raw, label):
    data = json.loads(raw)
    if data.get("type") != "FeatureCollection" or not data.get("features"):
        raise ValueError(f"{label} must be a nonempty FeatureCollection")
    features = []
    for feature in data["features"]:
        geometry = shape(feature["geometry"])
        if not isinstance(geometry, (Polygon, MultiPolygon)) or not geometry.is_valid:
            raise ValueError(f"{label} contains invalid or non-polygonal geometry")
        features.append((feature.get("properties", {}), geometry))
    return features


def region_id(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def parse_regions(raw, adm0):
    regions = []
    for properties, geometry in parse_polygons(raw, "ADM1"):
        name = properties.get("shapeName")
        if not isinstance(name, str) or not name:
            raise ValueError("ADM1 feature without shapeName")
        land = geometry.intersection(adm0)
        if land.is_empty or land.area <= 0:
            raise ValueError(f"ADM1 region {name} does not overlap ADM0")
        regions.append({"id": region_id(name), "name": name, "iso": properties.get("shapeISO"), "land": land})
    if len(regions) != REGION_COUNT or len({region["id"] for region in regions}) != REGION_COUNT:
        raise ValueError(f"Expected {REGION_COUNT} uniquely named ADM1 regions")
    return sorted(regions, key=lambda region: region["name"])


def began_el_nino(oni_djf):
    return [value >= ENSO_THRESHOLD for value in oni_djf]


def parse_oni(raw):
    lines = raw.decode("ascii").splitlines()
    if lines[0].split() != ["SEAS", "YR", "TOTAL", "ANOM"]:
        raise ValueError("Unexpected ONI header")
    djf = {}
    for line in lines[1:]:
        season, year, _total, anomaly = line.split()
        if season == "DJF":
            djf[int(year)] = float(anomaly)
    if any(year not in djf for year in YEARS):
        raise ValueError("ONI snapshot lacks a DJF value for every year")
    return [djf[year] for year in YEARS]


def power_point(raw, parameter, source, expected_keys):
    data = json.loads(raw)
    header = data.get("header", {})
    if header.get("sources") != [source] or header.get("time_standard") != "UTC":
        raise ValueError(f"{parameter}: unexpected source or time standard")
    if data.get("parameters", {}).get(parameter, {}).get("units") != "mm/day":
        raise ValueError(f"{parameter}: unexpected units")
    if data.get("geometry", {}).get("coordinates", [])[:2] != list(AUDIT_POINT):
        raise ValueError(f"{parameter}: unexpected point")
    fill = header.get("fill_value")
    values = data.get("properties", {}).get("parameter", {}).get(parameter)
    if not isinstance(values, dict) or not expected_keys <= values.keys():
        raise ValueError(f"{parameter}: incomplete 2001-2025 record")
    for key in expected_keys:
        value = values[key]
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                or value == fill or value < 0):
            raise ValueError(f"{parameter}: invalid value {value!r} at {key}")
    return values


def source_audit(merra2_raw, imerg_raw):
    monthly_keys = {f"{year}{month:02}" for year in YEARS for month in range(1, 13)}
    daily_keys = {day for year in YEARS for days in imerg.calendar_months(year) for day in days}
    merra2 = power_point(merra2_raw, "PRECTOTCORR", "MERRA2", monthly_keys)
    daily = power_point(imerg_raw, "IMERG_PRECTOT", "IMERG", daily_keys)
    merra2_mm = [math.fsum(merra2[f"{year}{month:02}"] * calendar.monthrange(year, month)[1]
                           for month in range(1, 13)) for year in YEARS]
    imerg_mm = [math.fsum(daily[day] for days in imerg.calendar_months(year) for day in days) for year in YEARS]
    ratio = [m / i for m, i in zip(merra2_mm, imerg_mm, strict=True)]
    peak = max(range(len(YEARS)), key=lambda k: ratio[k])
    others = [value for k, value in enumerate(ratio) if k != peak]
    return {
        "point": list(AUDIT_POINT), "years": list(YEARS),
        "merra2_mm": [rnd(v, 1) for v in merra2_mm], "imerg_mm": [rnd(v, 1) for v in imerg_mm],
        "ratio": [rnd(v, 3) for v in ratio], "max_ratio_year": YEARS[peak],
        "other_ratio_range": [rnd(min(others), 3), rnd(max(others), 3)],
        "merra2_source": "audit_merra2", "imerg_source": "audit_imerg",
    }


def giovanni_check(raw, ours, flags):
    """Compare our national January to April IMERG series with a Giovanni area average.

    Giovanni's box includes sea and ours is land-weighted, so totals differ by design;
    the record keeps the pattern, El Nino gap and trend decision for each.
    """
    lines = raw.decode().splitlines()
    header = dict(line.split(",", 1) for line in lines if line[:2] != "20" and "," in line)
    bbox = [float(v) for v in header["User Bounding Box:"].strip('"').split(",")]
    url = header["URL to Reproduce Results:"].strip('"')
    if bbox != GIOVANNI_BBOX or "GPM_3IMERGM_07_precipitation(units%3Dmm%2Fmonth)" not in url:
        raise ValueError("Giovanni CSV must be GPM_3IMERGM v07 in mm/month over the Philippine box")
    months = {(int(line[:4]), int(line[5:7])): float(line.split(",")[1]) for line in lines if line[:2] == "20"}
    if any(months.get((year, month), -1) < 0 for year in YEARS for month in range(1, 5)):
        raise ValueError("Giovanni CSV is missing or has fill values in a January to April month")
    theirs = [math.fsum(months[year, month] for month in range(1, 5)) for year in YEARS]
    mean = math.fsum(theirs) / len(theirs)
    slope, _, _, p = trend(theirs)
    return {
        "file": str(GIOVANNI.relative_to(ROOT)), "sha256": sha256(raw), "bytes": len(raw),
        "url": url, "bbox": bbox, "dataset": "GPM_3IMERGM v07",
        "jan_apr_mm": [rnd(v, 1) for v in theirs], "mean_mm": rnd(mean, 1),
        "anomaly_pct": [rnd(100 * (v - mean) / mean, 2) for v in theirs],
        "r": rnd(statistics.correlation(ours, theirs), 3),
        "enso": comparison_record(enso_comparison(theirs, flags, mean)),
        "sen_pct_decade": rnd(1000 * slope / mean, 3), "p": serial_p(p),
        "direction": direction(slope), "meets_threshold": p < ALPHA,
    }


def sen_slope(values):
    return statistics.median((values[j] - values[i]) / (j - i)
                             for i in range(len(values)) for j in range(i + 1, len(values)))


def sen_intercept(values, slope):
    return statistics.median(v - slope * (YEARS[k] - CENTER_YEAR) for k, v in enumerate(values))


def mann_kendall(values):
    n = len(values)
    s = sum((values[j] > values[i]) - (values[j] < values[i]) for i in range(n) for j in range(i + 1, n))
    ties = sum(t * (t - 1) * (2 * t + 5) for t in Counter(values).values())
    variance = (n * (n - 1) * (2 * n + 5) - ties) / 18
    if s == 0 or variance <= 0:
        return s, 1.0
    z = (s - 1 if s > 0 else s + 1) / math.sqrt(variance)
    return s, math.erfc(abs(z) / math.sqrt(2))


def direction(value):
    return "up" if value > 0 else "down" if value < 0 else "zero"


def serial_p(p):
    shown = rnd(p, P_DIGITS)
    if (shown < ALPHA) != (p < ALPHA):
        raise ValueError(f"p = {p!r} changes sides of alpha when serialized")
    return shown


def trend(values):
    slope = sen_slope(values)
    s, p = mann_kendall(values)
    return slope, sen_intercept(values, slope), s, p


def enso_comparison(values, flags, mean):
    enso = [v for v, flag in zip(values, flags, strict=True) if flag]
    other = [v for v, flag in zip(values, flags, strict=True) if not flag]
    enso_mean, other_mean = math.fsum(enso) / len(enso), math.fsum(other) / len(other)
    if other_mean <= 0:
        raise ValueError("Other-year mean must be positive")
    diff = 100 * (enso_mean / other_mean - 1)
    return {"mean_mm": enso_mean, "other_mean_mm": other_mean, "diff_pct": diff,
            "below_mean": sum(v < mean for v in enso), "group_size": len(enso), "other_size": len(other)}


def comparison_record(enso):
    return {"mean_mm": rnd(enso["mean_mm"], 1), "other_mean_mm": rnd(enso["other_mean_mm"], 1),
            "diff_pct": rnd(enso["diff_pct"], 3), "direction": direction(enso["diff_pct"]),
            "below_mean": enso["below_mean"], "group_size": enso["group_size"],
            "other_size": enso["other_size"]}


def series_record(values, jan_apr, flags):
    mean = math.fsum(values) / len(values)
    slope, mid, s, p = trend(values)
    enso = enso_comparison(values, flags, mean)
    jan_apr_mean = math.fsum(jan_apr) / len(jan_apr)
    jan_slope, jan_mid, _, jan_p = trend(jan_apr)
    jan_apr_enso = enso_comparison(jan_apr, flags, jan_apr_mean)
    wettest = max(range(len(values)), key=lambda k: (values[k], -k))
    driest = min(range(len(values)), key=lambda k: (values[k], k))
    return {
        "annual_mm": [rnd(v, 1) for v in values],
        "anomaly_pct": [rnd(100 * (v - mean) / mean, 2) for v in values],
        "mean_mm": rnd(mean, 1),
        "sen_mm_decade": rnd(10 * slope, 2), "sen_pct_decade": rnd(1000 * slope / mean, 3),
        "sen_mid_mm": rnd(mid, 1), "mk_s": s, "p": serial_p(p),
        "direction": direction(slope), "meets_threshold": p < ALPHA,
        "enso": comparison_record(enso),
        "jan_apr": {"mm": [rnd(v, 1) for v in jan_apr], "mean_mm": rnd(jan_apr_mean, 1),
                    "anomaly_pct": [rnd(100 * (v - jan_apr_mean) / jan_apr_mean, 2) for v in jan_apr],
                    "sen_mm_decade": rnd(10 * jan_slope, 2),
                    "sen_pct_decade": rnd(1000 * jan_slope / jan_apr_mean, 3),
                    "sen_mid_mm": rnd(jan_mid, 1), "p": serial_p(jan_p),
                    "direction": direction(jan_slope), "meets_threshold": jan_p < ALPHA,
                    "enso": comparison_record(jan_apr_enso)},
        "wettest": {"year": YEARS[wettest], "mm": rnd(values[wettest], 1),
                    "anomaly_pct": rnd(100 * (values[wettest] - mean) / mean, 2)},
        "driest": {"year": YEARS[driest], "mm": rnd(values[driest], 1),
                   "anomaly_pct": rnd(100 * (values[driest] - mean) / mean, 2)},
        "_raw": {"mean": mean, "slope": slope, "pct": 1000 * slope / mean, "p": p,
                 "jan_apr_enso_diff": jan_apr_enso["diff_pct"], "wettest": values[wettest], "driest": values[driest]},
    }


def weighted_mean_series(members, annual):
    total = math.fsum(weight for _, weight in members)
    return [math.fsum(weight * annual[index][k] for index, weight in members) / total for k in range(len(YEARS))]


def weighted_quantile(values, weights, q):
    pairs = sorted(zip(values, weights, strict=True))
    target = q * math.fsum(weights)
    cumulative = 0.0
    for value, weight in pairs:
        cumulative += weight
        if cumulative >= target:
            return value
    return pairs[-1][0]


def diverging_breaks(values, weights):
    extent = weighted_quantile([abs(v) for v in values], weights, 0.98)
    chosen = next((e for e in DIVERGING_EXTENTS if e >= extent), None)
    if chosen is None:
        raise ValueError(f"No diverging legend extent covers {extent}")
    return [rnd(chosen * k / 4, 2) for k in range(-4, 5)]


def mean_breaks(values, weights):
    low_q, high_q = weighted_quantile(values, weights, 0.02), weighted_quantile(values, weights, 0.98)
    step = MEAN_STEP
    while True:
        low, high = math.floor(low_q / step) * step, math.ceil(high_q / step) * step
        if (high - low) / step <= MEAN_CLASSES:
            return list(range(low, high + step, step))
        step += MEAN_STEP


def square(row, col):
    return box(-180 + STEP * col, -90 + STEP * row, -180 + STEP * (col + 1), -90 + STEP * (row + 1))


def center(row, col):
    return imerg.LON_ORIGIN + STEP * col, imerg.LAT_ORIGIN + STEP * row


def cell_containing(lon, lat):
    return math.floor((lat + 90) / STEP + EDGE_SLACK_CELLS), math.floor((lon + 180) / STEP + EDGE_SLACK_CELLS)


def shares(classes, weights):
    total = math.fsum(weights)
    keys = ("up", "down", "zero", "meets_up", "meets_down")
    area = {key: math.fsum(w for c, w in zip(classes, weights, strict=True) if key in c) / total for key in keys}
    count = {key: sum(key in c for c in classes) for key in keys}
    return {"area": {key: rnd(value, 5) for key, value in area.items()}, "count": count,
            "total_count": len(classes), "_area": area}


def trend_classes(slope, p):
    labels = {direction(slope)}
    if p < ALPHA and slope != 0:
        labels.add(f"meets_{direction(slope)}")
    return labels


def tied(items, key, pick):
    best = pick(key(item) for item in items)
    return [item["id"] for item in items if key(item) == best]


def bounds(geometry):
    west, south, east, north = geometry.bounds
    return [math.floor(west * 1000) / 1000, math.floor(south * 1000) / 1000,
            math.ceil(east * 1000) / 1000, math.ceil(north * 1000) / 1000]


def strip_raw(record):
    return {key: value for key, value in record.items() if not key.startswith("_")}


def air_series_record(values, flags):
    slope, mid, _, p = trend(values)
    gap = (statistics.mean(v for v, flag in zip(values, flags, strict=True) if flag)
           - statistics.mean(v for v, flag in zip(values, flags, strict=True) if not flag))
    return {"c": [rnd(v, 4) for v in values], "mean_c": rnd(statistics.mean(values), 4),
            "sen_c_decade": rnd(10 * slope, 4), "sen_mid_c": rnd(mid, 4),
            "p": serial_p(p), "direction": direction(slope), "meets_threshold": p < ALPHA,
            "enso_diff_c": rnd(gap, 4), "enso_direction": direction(gap)}


def air_record(monthly, adm0, regions, flags):
    if monthly.keys() != merra2.land_cells(adm0):
        raise ValueError("Air temperature cells differ from the ADM0 intersecting grid")
    indices = sorted(monthly)
    annual = {i: merra2.period_means(monthly[index], range(1, 13)) for i, index in enumerate(indices)}
    jan_apr = {i: merra2.period_means(monthly[index], range(1, 5)) for i, index in enumerate(indices)}
    cells, members = [], [[] for _ in regions]
    prepared = [(prep(region["land"]), region["land"]) for region in regions]
    weights = []
    for i, (row, col) in enumerate(indices):
        lat, lon = row * merra2.LAT_STEP, col * merra2.LON_STEP
        bounds = merra2.cell_bounds(row, col)
        cell = box(*bounds)
        scale = math.cos(math.radians(lat))
        weight = adm0.intersection(cell).area * scale
        weights.append((i, weight))
        for r, (fast, land) in enumerate(prepared):
            area = land.intersection(cell).area if fast.intersects(cell) else 0.0
            if area > 0:
                members[r].append((i, area * scale))
        cells.append({"id": f"{row}-{col}", "lat": lat, "lon": lon, "bounds": bounds,
                      "weight": significant(weight), "annual": air_series_record(annual[i], flags),
                      "jan_apr": air_series_record(jan_apr[i], flags)})
    if not weights or any(not member for member in members):
        raise ValueError("Every national and regional air series requires positive land area")
    region_records = [
        {"id": region["id"], "members": [i for i, _ in member],
         "weights": [significant(weight) for _, weight in member],
         "annual": air_series_record(weighted_mean_series(member, annual), flags),
         "jan_apr": air_series_record(weighted_mean_series(member, jan_apr), flags)}
        for region, member in zip(regions, members, strict=True)]
    return {"grid": merra2.GRID, "source": merra2.SOURCE, "cells": cells,
            "national": {"annual": air_series_record(weighted_mean_series(weights, annual), flags),
                         "jan_apr": air_series_record(weighted_mean_series(weights, jan_apr), flags)},
            "regions": region_records}


def temperature_record(values, flags, unit="c"):
    slope, mid, _, p = trend(values)
    refit = values[:19]
    refit_slope = sen_slope(refit)
    _, refit_p = mann_kendall(refit)
    gap = (statistics.mean(v for v, flag in zip(values, flags, strict=True) if flag)
           - statistics.mean(v for v, flag in zip(values, flags, strict=True) if not flag))
    return {unit: [rnd(v, 4) for v in values], f"mean_{unit}": rnd(statistics.mean(values), 4),
            f"sen_{unit}_decade": rnd(10 * slope, 4), f"sen_mid_{unit}": rnd(mid, 4),
            "p": serial_p(p), "direction": direction(slope), "meets_threshold": p < ALPHA,
            f"enso_diff_{unit}": rnd(gap, 4), "enso_direction": direction(gap),
            "refit": {"start": 2001, "end": 2019, f"sen_{unit}_decade": rnd(10 * refit_slope, 4),
                      "p": serial_p(refit_p), "direction": direction(refit_slope),
                      "meets_threshold": refit_p < ALPHA}}


def farm_record(snapshot, flags, rain):
    sites, raw_series = [], {"day": [], "night": []}
    for site in snapshot["sites"]:
        record = {key: site[key] for key in ("lat", "lon", "cropland_pixels", "outline")}
        for period in ("day", "night"):
            composites = site["composites"][period]
            values = []
            for year in YEARS:
                dates = [f"A{year}{day:03}" for day in range(1, 114, 8)]
                if any(date not in composites for date in dates):
                    raise ValueError("Missing farm composite")
                valid = [composites[date] for date in dates if composites[date] is not None]
                if not valid or any(not math.isfinite(v) for v in valid):
                    raise ValueError("Invalid farm temperature year")
                values.append(statistics.mean(valid))
            raw_series[period].append(values)
            record[period] = temperature_record(values, flags)
        sites.append(record)
    mean = statistics.mean(rain)
    return {"mask_year": 2020, "map_threshold_pct": 10, "sites": sites,
            "rain": {"mm": [rnd(v, 1) for v in rain], "mean_mm": rnd(mean, 1),
                     "enso": comparison_record(enso_comparison(rain, flags, mean))},
            "night_rising_meets": sum(s["night"]["direction"] == "up" and s["night"]["meets_threshold"] for s in sites),
            **{period: temperature_record([statistics.mean(site[k] for site in raw_series[period])
                                           for k in range(len(YEARS))], flags)
               for period in ("day", "night")}}


def build_artifact(raws, records, annual, jan_apr, cube_record, month_shares):
    adm0 = unary_union([geometry for _, geometry in parse_polygons(raws["adm0"], "ADM0")])
    if set(annual) != imerg.land_pixels(adm0):
        raise ValueError("IMERG cube pixels differ from the ADM0 land-intersecting pixels")
    regions = parse_regions(raws["adm1"], adm0)
    oni = parse_oni(raws["oni"])
    flags = began_el_nino(oni)
    audit = source_audit(raws["audit_merra2"], raws["audit_imerg"])

    indices = sorted(annual)
    farm_snapshot, farm_source = modis.load_snapshot()
    air_monthly, air_source = merra2.load_snapshot(adm0)
    air = air_record(air_monthly, adm0, regions, flags)
    if set(farm_snapshot["cells"]) != {f"{row}-{col}" for row, col in indices}:
        raise ValueError("Cropland snapshot must cover every IMERG square")
    cropland_pct = [farm_snapshot["cells"][f"{row}-{col}"] for row, col in indices]
    if any(type(v) is not int or not 0 <= v <= 100 for v in cropland_pct):
        raise ValueError("Cropland shares must be integer percentages")
    prepared = [(prep(region["land"]), region["land"]) for region in regions]
    land_weight, land_pct, dominant = [], [], []
    members = [[] for _ in regions]
    for position, (row, col) in enumerate(indices):
        cell = square(row, col)
        scale = math.cos(math.radians(center(row, col)[1]))
        land_area = adm0.intersection(cell).area
        land_weight.append(land_area * scale)
        land_pct.append(round(100 * land_area / cell.area))
        areas = []
        for r, (fast, land) in enumerate(prepared):
            area = land.intersection(cell).area if fast.intersects(cell) else 0.0
            if area > 0:
                members[r].append((position, area * scale))
                areas.append((area, -r))
        dominant.append(-max(areas)[1] if areas else -1)
    if any(not member for member in members):
        raise ValueError("Every ADM1 region must intersect at least one pixel")

    by_position = {position: annual[index] for position, index in enumerate(indices)}
    jan_apr_by_position = {position: jan_apr[index] for position, index in enumerate(indices)}
    national_members = list(enumerate(land_weight))
    national = series_record(weighted_mean_series(national_members, by_position),
                             weighted_mean_series(national_members, jan_apr_by_position), flags)
    farm = farm_record(farm_snapshot, flags, weighted_mean_series(
        [(i, weight * cropland_pct[i] / 100) for i, weight in national_members], jan_apr_by_position))
    climate_labels, centroids, iterations, inertia = climate.cluster([month_shares[index] for index in indices])
    if (max(range(12), key=lambda m: centroids[0][m]) not in range(5, 9)
            or max(range(12), key=lambda m: centroids[-1][m]) not in (10, 11, 0)):
        raise ValueError("Rain-calendar groups no longer resemble PAGASA Types I and II; review the climate claims")
    groups = []
    for group, (centroid, pagasa) in enumerate(zip(centroids, ("I", "III", "IV", "II"), strict=True)):
        group_members = [(i, w) for i, w in national_members if climate_labels[i] == group]
        series = weighted_mean_series(group_members, jan_apr_by_position)
        groups.append({"pagasa_type": pagasa, "count": len(group_members),
                       "land_share": rnd(math.fsum(w for _, w in group_members) / math.fsum(land_weight), 4),
                       "month_share_pct": [rnd(100 * v, 2) for v in centroid],
                       "jan_apr_share_pct": rnd(100 * sum(centroid[:4]), 1),
                       "wettest_month": max(range(12), key=lambda m: centroid[m]) + 1,
                       "enso": comparison_record(enso_comparison(series, flags, statistics.mean(series)))})
    climate_record = {"k": climate.K, "iterations": iterations, "inertia": rnd(inertia, 4), "groups": groups}
    tmin_snapshot, tmin_source = tmin.load_snapshot()
    if [(s["lat"], s["lon"]) for s in tmin_snapshot["sites"]] != [(s["lat"], s["lon"]) for s in farm["sites"]]:
        raise ValueError("T2M_MIN sites differ from the MODIS farm sites")
    night_air = [temperature_record(s["jan_apr_c"], flags) for s in tmin_snapshot["sites"]]
    farm["night_air"] = temperature_record([statistics.mean(s["jan_apr_c"][k] for s in tmin_snapshot["sites"])
                                            for k in range(len(YEARS))], flags)
    farm["night_air_rising_meets"] = sum(r["direction"] == "up" and r["meets_threshold"] for r in night_air)
    ndvi_snapshot, ndvi_source = modis.load_ndvi_snapshot()
    if [(s["lat"], s["lon"]) for s in ndvi_snapshot["sites"]] != [(s["lat"], s["lon"]) for s in farm["sites"]]:
        raise ValueError("NDVI sites differ from the MODIS farm sites")
    green = []
    for site in ndvi_snapshot["sites"]:
        years = [[v for date, v in site["composites"].items() if date.startswith(f"A{year}") and v is not None]
                 for year in YEARS]
        if any(not v for v in years):
            raise ValueError("Farm NDVI year without a retained composite")
        green.append([statistics.mean(v) for v in years])
    for record, values in zip(farm["sites"], green, strict=True):
        record["green"] = temperature_record(values, flags, "ndvi")
    farm["green"] = temperature_record([statistics.mean(s[k] for s in green) for k in range(len(YEARS))], flags, "ndvi")
    farm["green_lower_sites"] = sum(s["green"]["enso_direction"] == "down" for s in farm["sites"])

    cell_stats = []
    for index in indices:
        values = annual[index]
        mean = math.fsum(values) / len(values)
        slope, mid, s, p = trend(values)
        jan_apr_mean = math.fsum(jan_apr[index]) / len(YEARS)
        enso = enso_comparison(jan_apr[index], flags, jan_apr_mean)
        cell_stats.append({"mean": mean, "jan_apr_mean": jan_apr_mean, "slope": slope, "mid": mid, "p": p, "enso": enso["diff_pct"],
                           "classes": trend_classes(slope, p)})

    national_shares = shares([c["classes"] for c in cell_stats], land_weight)
    region_records = []
    for region, member in zip(regions, members, strict=True):
        record = series_record(weighted_mean_series(member, by_position),
                               weighted_mean_series(member, jan_apr_by_position), flags)
        member_shares = shares([cell_stats[position]["classes"] for position, _ in member],
                               [weight for _, weight in member])
        region_records.append({"id": region["id"], "name": region["name"], "iso": region["iso"],
                               "bounds": bounds(region["land"]),
                               "members": [position for position, _ in member],
                               "weights": [significant(weight / (STEP * STEP)) for _, weight in member],
                               "shares": strip_raw(member_shares), "_shares": member_shares, **record})

    total_weight = math.fsum(land_weight)
    enso_less_share = math.fsum(w for c, w in zip(cell_stats, land_weight, strict=True) if c["enso"] < 0) / total_weight

    def top_meeting(key):
        ranked = sorted((r for r in region_records if r["_shares"]["_area"][key] > 0),
                        key=lambda r: (-r["_shares"]["_area"][key], r["id"]))
        return [{"id": r["id"], "share": rnd(r["_shares"]["_area"][key], 5)} for r in ranked[:3]]

    pantabangan = cell_containing(*PANTABANGAN)
    if pantabangan not in annual:
        raise ValueError("The Pantabangan point is not in a mapped pixel")
    pantabangan_values = annual[pantabangan]
    pantabangan_mean = math.fsum(pantabangan_values) / len(pantabangan_values)
    pantabangan_2024 = pantabangan_values[YEARS.index(2024)]
    pantabangan_enso = enso_comparison(pantabangan_values, flags, pantabangan_mean)["diff_pct"]
    pantabangan_jan_apr = jan_apr[pantabangan]
    pantabangan_jan_apr_mean = math.fsum(pantabangan_jan_apr) / len(YEARS)
    pantabangan_jan_apr_2024 = pantabangan_jan_apr[YEARS.index(2024)]
    pantabangan_jan_apr_enso = enso_comparison(pantabangan_jan_apr, flags, pantabangan_jan_apr_mean)["diff_pct"]
    raw_national = national["_raw"]
    swing_range = raw_national["wettest"] - raw_national["driest"]
    trend_change = abs(raw_national["slope"]) * (YEARS[-1] - YEARS[0])
    facts = {
        "shares": strip_raw(national_shares),
        "enso_less_area_share": rnd(enso_less_share, 5),
        "regions_enso_less": sum(r["_raw"]["jan_apr_enso_diff"] < 0 for r in region_records),
        "regions_meeting": [r["id"] for r in region_records if r["meets_threshold"]],
        "meeting_regions": {"up": top_meeting("meets_up"), "down": top_meeting("meets_down")},
        "swing": {"range_mm": rnd(swing_range, 1), "trend_change_mm": rnd(trend_change, 1),
                  "range_exceeds_trend": swing_range > trend_change},
        "pantabangan": {
            "mean_mm": rnd(pantabangan_mean, 1), "mm_2024": rnd(pantabangan_2024, 1),
            "anomaly_2024_pct": rnd(100 * (pantabangan_2024 - pantabangan_mean) / pantabangan_mean, 2),
            "direction_2024": direction(pantabangan_2024 - pantabangan_mean),
            "enso_diff_pct": rnd(pantabangan_enso, 3), "enso_direction": direction(pantabangan_enso),
            "jan_apr_mean_mm": rnd(pantabangan_jan_apr_mean, 1),
            "jan_apr_mm_2024": rnd(pantabangan_jan_apr_2024, 1),
            "jan_apr_anomaly_2024_pct": rnd(100 * (pantabangan_jan_apr_2024 / pantabangan_jan_apr_mean - 1), 2),
            "jan_apr_direction_2024": direction(pantabangan_jan_apr_2024 - pantabangan_jan_apr_mean),
            "jan_apr_enso_diff_pct": rnd(pantabangan_jan_apr_enso, 3),
            "jan_apr_enso_direction": direction(pantabangan_jan_apr_enso),
        },
        "focus": {
            "wettest_mean_region": tied(region_records, lambda r: r["_raw"]["mean"], max),
            "driest_mean_region": tied(region_records, lambda r: r["_raw"]["mean"], min),
            "enso_region": tied(region_records, lambda r: r["_raw"]["jan_apr_enso_diff"], min),
            "trend_region": tied(region_records, lambda r: abs(r["_raw"]["pct"]), max),
            "pantabangan_cell": f"{pantabangan[0]}-{pantabangan[1]}",
        },
    }

    legend = {
        "mean_mm": mean_breaks([c["mean"] for c in cell_stats], land_weight),
        "jan_apr_mean_mm": mean_breaks([c["jan_apr_mean"] for c in cell_stats], land_weight),
        "trend_pct": diverging_breaks([1000 * c["slope"] / c["mean"] for c in cell_stats], land_weight),
        "enso_pct": diverging_breaks([c["enso"] for c in cell_stats], land_weight),
        "year_pct": diverging_breaks(
            [100 * (v - c["mean"]) / c["mean"] for c, index in zip(cell_stats, indices, strict=True)
             for v in annual[index]],
            [w for w in land_weight for _ in YEARS]),
    }

    cells = {
        "count": len(indices),
        "row": [row for row, _ in indices], "col": [col for _, col in indices],
        "region": dominant, "land_pct": land_pct,
        "cropland_pct": cropland_pct,
        "weight": [significant(w / (STEP * STEP)) for w in land_weight],
        "mean_mm": [round(c["mean"]) for c in cell_stats],
        "annual_mm": [round(v) for index in indices for v in annual[index]],
        "jan_apr_mm": [round(v) for index in indices for v in jan_apr[index]],
        "jan_apr_mean_mm": [round(c["jan_apr_mean"]) for c in cell_stats],
        "sen_mm_decade": [rnd(10 * c["slope"], 1) for c in cell_stats],
        "sen_pct_decade": [rnd(1000 * c["slope"] / c["mean"], 1) for c in cell_stats],
        "sen_mid_mm": [round(c["mid"]) for c in cell_stats],
        "p": [rnd(c["p"], 4) for c in cell_stats],
        "trend_sign": [(c["slope"] > 0) - (c["slope"] < 0) for c in cell_stats],
        "meets": [int(c["p"] < ALPHA) for c in cell_stats],
        "jan_apr_enso_diff_pct": [rnd(c["enso"], 1) for c in cell_stats],
        "jan_apr_enso_sign": [(c["enso"] > 0) - (c["enso"] < 0) for c in cell_stats],
        "climate": climate_labels,
        "month_share": [v for index in indices for v in month_shares[index]],
    }

    boundaries = {name: {**records[name], **BOUNDARY_META[name],
                         "license_url": "https://creativecommons.org/licenses/by/3.0/igo/"}
                  for name in ("adm0", "adm1")}
    api_versions = sorted({entry["version"] for entry in cube_record["api"]})
    return {
        "schema": "ph-rain-imerg-v4",
        "period": {"start": YEARS[0], "end": YEARS[-1], "years": list(YEARS)},
        "alpha": ALPHA,
        "source": {"provider": "NASA POWER", "dataset": "GPM IMERG Final Run", "parameter": "IMERG_PRECTOT",
                   "endpoint": imerg.API_URL, "api_versions": api_versions, "time_standard": "UTC",
                   "units": "mm/day", "tiles": cube_record["tiles"], "requests": cube_record["requests"],
                   "cube_sha256": cube_record["sha256"], "manifest_sha256": cube_record["manifest_sha256"]},
        "grid": {"lat_origin": imerg.LAT_ORIGIN, "lon_origin": imerg.LON_ORIGIN, "step": STEP},
        "bounds": bounds(adm0),
        "boundaries": boundaries,
        "enso": {"rule": "DJF ONI >= +0.5 °C", "threshold": ENSO_THRESHOLD, "oni_djf": oni,
                 "began_el_nino": flags, "years": [y for y, flag in zip(YEARS, flags, strict=True) if flag],
                 "source": {**records["oni"], "provider": "NOAA Climate Prediction Center"}},
        "legend": legend,
        "national": strip_raw(national),
        "farm": farm,
        "climate": climate_record,
        "air": air,
        "regions": [strip_raw(record) for record in region_records],
        "cells": cells,
        "facts": facts,
        "provenance": {"imerg": cube_record, "modis": farm_source, "merra2": air_source, "tmin": tmin_source, "ndvi": ndvi_source,
                       "snapshots": records, "source_audit": audit,
                       "giovanni": giovanni_check(GIOVANNI.read_bytes(), national["jan_apr"]["mm"], flags)},
    }


def publish(raws, records, cube_record, artifact):
    content = imerg.json_bytes(artifact)
    for snapshot in SNAPSHOTS:
        imerg.atomic_write(SOURCES / snapshot.file, gzip.compress(raws[snapshot.name], mtime=0))
    imerg.atomic_write(MANIFEST, imerg.json_bytes({**records, "imerg": cube_record}))
    imerg.atomic_write(OUTPUT, content)
    return content


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--refresh", action="store_true",
                      help="Refresh small snapshots and rebuild IMERG, MERRA-2 and MODIS from verified caches")
    mode.add_argument("--offline", action="store_true", help="Require pinned snapshots; never use the network")
    args = parser.parse_args()
    try:
        raws, records = acquire(args.refresh, args.offline)
        if args.refresh:
            adm0 = unary_union([geometry for _, geometry in parse_polygons(raws["adm0"], "ADM0")])
            imerg.build_cube(imerg.tile_plan(adm0), imerg.land_pixels(adm0))
        annual, jan_apr, cube_record, shares = load_cube()
        if args.refresh or not modis.SNAPSHOT.exists():
            if args.offline:
                raise ValueError("Missing offline MODIS snapshot")
            modis.build_snapshot(imerg.load_boundary())
        if args.refresh or not merra2.SNAPSHOT.exists():
            if args.offline:
                raise ValueError("Missing offline MERRA-2 snapshot")
            merra2.build_snapshot(imerg.load_boundary())
        artifact = build_artifact(raws, records, annual, jan_apr, cube_record, shares)
        content = publish(raws, records, cube_record, artifact)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Rainfall build failed: {error}", file=sys.stderr)
        return 1
    national = artifact["national"]
    print(json.dumps({
        "artifact": str(OUTPUT.relative_to(ROOT)), "bytes": len(content),
        "gzip_bytes": len(gzip.compress(content, mtime=0)), "cells": artifact["cells"]["count"],
        "national": {key: national[key] for key in ("mean_mm", "sen_mm_decade", "sen_pct_decade", "p",
                                                     "direction", "meets_threshold", "enso", "jan_apr")},
        "farm": {key: artifact["farm"][key] for key in ("rain", "day", "night", "night_rising_meets")},
        "air": {"cells": len(artifact["air"]["cells"]), "national": artifact["air"]["national"]},
        "facts": artifact["facts"], "legend": artifact["legend"],
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
