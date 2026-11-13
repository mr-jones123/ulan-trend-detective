"""Acquire validated IMERG UTC daily data and preserve a native monthly land cube.

Run with ``uv run --frozen scripts/imerg.py`` or add ``--offline`` to use
only verified cache entries. Cache records hash the uncompressed source bytes.
"""

import argparse
import calendar
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from shapely.geometry import MultiPolygon, Polygon, box, shape
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "data" / "sources"
CACHE = ROOT / "data" / "cache" / "imerg"
YEARS = tuple(range(2001, 2026))
MONTHS = tuple(f"{year}-{month:02}" for year in YEARS for month in range(1, 13))
BOUNDARY_HASH = "618b602a10daff2c9ae6310e1e1f68c148caf230edca857222c6c5aa015d0a29"
LAT_ORIGIN = -89.95
LON_ORIGIN = -179.95
GRID_STEP = 0.1
USER_AGENT = "PhilippinesRainfallMap/2.0 (NASA Space Apps)"
API_URL = "https://power.larc.nasa.gov/api/temporal/daily/regional"


@dataclass(frozen=True, order=True)
class Tile:
    south: int
    west: int

    def request_url(self, year):
        return API_URL + "?" + urlencode({
            "latitude-min": self.south, "latitude-max": self.south + 2,
            "longitude-min": self.west, "longitude-max": self.west + 2,
            "parameters": "IMERG_PRECTOT", "community": "AG",
            "start": f"{year}0101", "end": f"{year}1231",
            "format": "JSON", "time-standard": "UTC",
        })

    def cache_path(self, year):
        return CACHE / f"{self.south}_{self.west}_{year}.json.gz"


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temporary = stream.name
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def load_boundary():
    raw = gzip.decompress((SOURCES / "boundary.json.gz").read_bytes())
    if hashlib.sha256(raw).hexdigest() != BOUNDARY_HASH:
        raise ValueError("Pinned ADM0 boundary SHA-256 mismatch")
    data = json.loads(raw)
    if data.get("type") != "FeatureCollection" or not data.get("features"):
        raise ValueError("Boundary must be a nonempty FeatureCollection")
    geometries = [shape(feature["geometry"]) for feature in data["features"]]
    if any(not isinstance(geometry, (Polygon, MultiPolygon)) or not geometry.is_valid
           for geometry in geometries):
        raise ValueError("Boundary contains invalid or non-polygonal geometry")
    boundary = unary_union(geometries)
    if boundary.is_empty or not boundary.is_valid:
        raise ValueError("Boundary union is empty or invalid")
    return boundary


def tile_plan(boundary):
    return tuple(Tile(south, west) for south in range(4, 22, 2)
                 for west in range(114, 128, 2)
                 if boundary.intersects(box(west, south, west + 2, south + 2)))


def grid_index(value, origin):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError(f"Invalid grid coordinate {value!r}")
    index = round((value - origin) / GRID_STEP)
    if abs(value - (origin + GRID_STEP * index)) > 1e-6:
        raise ValueError(f"Coordinate {value!r} is not a native IMERG pixel center")
    return index


def land_pixels(boundary):
    west, south, east, north = boundary.bounds
    prepared = prep(boundary)
    pixels = set()
    for row in range(max(0, math.floor((south + 90) / GRID_STEP)),
                     min(1800, math.ceil((north + 90) / GRID_STEP))):
        for col in range(max(0, math.floor((west + 180) / GRID_STEP)),
                         min(3600, math.ceil((east + 180) / GRID_STEP))):
            pixel = box(-180 + GRID_STEP * col, -90 + GRID_STEP * row,
                        -180 + GRID_STEP * (col + 1), -90 + GRID_STEP * (row + 1))
            if prepared.intersects(pixel) and boundary.intersection(pixel).area > 0:
                pixels.add((row, col))
    return frozenset(pixels)


def calendar_months(year):
    return tuple(tuple(f"{year}{month:02}{day:02}"
                       for day in range(1, calendar.monthrange(year, month)[1] + 1))
                 for month in range(1, 13))


def monthly_reduce(values, year):
    return tuple(round(math.fsum(values[day] for day in days), 2)
                 for days in calendar_months(year))


def parse_response(raw, year, tile):
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise ValueError("IMERG response must be a FeatureCollection")
    header = data.get("header", {})
    if header.get("sources") != ["IMERG"]:
        raise ValueError("Unexpected rainfall source")
    if header.get("time_standard") != "UTC":
        raise ValueError("IMERG response does not use UTC days")
    if header.get("start") != f"{year}0101" or header.get("end") != f"{year}1231":
        raise ValueError("IMERG header does not cover the requested year")
    if data.get("parameters", {}).get("IMERG_PRECTOT", {}).get("units") != "mm/day":
        raise ValueError("Unexpected IMERG precipitation units")
    fill = header.get("fill_value")
    if isinstance(fill, bool) or not isinstance(fill, (float, int)) or not math.isfinite(fill):
        raise ValueError("Missing or invalid declared fill value")
    features = data.get("features")
    if not isinstance(features, list) or len(features) != 400:
        raise ValueError("IMERG tile-year must contain exactly 400 points")
    expected_days = {day for days in calendar_months(year) for day in days}
    first_row = round((tile.south + 90) / GRID_STEP)
    first_col = round((tile.west + 180) / GRID_STEP)
    expected_pixels = {(row, col) for row in range(first_row, first_row + 20)
                       for col in range(first_col, first_col + 20)}
    points = {}
    for feature in features:
        geometry = feature.get("geometry", {})
        coordinates = geometry.get("coordinates")
        if feature.get("type") != "Feature" or geometry.get("type") != "Point":
            raise ValueError("IMERG feature is not a Point")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            raise ValueError("IMERG point is missing coordinates")
        col = grid_index(coordinates[0], LON_ORIGIN)
        row = grid_index(coordinates[1], LAT_ORIGIN)
        index = (row, col)
        if index not in expected_pixels or index in points:
            raise ValueError(f"Unexpected or duplicate tile pixel {row}-{col}")
        values = feature.get("properties", {}).get("parameter", {}).get("IMERG_PRECTOT")
        if not isinstance(values, dict) or values.keys() != expected_days:
            raise ValueError(f"Pixel {row}-{col} does not contain every calendar day in {year}")
        for day, value in values.items():
            if (isinstance(value, bool) or not isinstance(value, (float, int))
                    or not math.isfinite(value) or value == fill or value < 0):
                raise ValueError(f"Invalid rainfall for {row}-{col} on {day}: {value!r}")
        points[index] = monthly_reduce(values, year)
    api = header.get("api", {})
    if not isinstance(api, dict) or not api.get("version") or not api.get("name"):
        raise ValueError("Missing POWER API identity")
    return points, api


def cached_response(path, url):
    sidecar = path.with_suffix(".meta.json")
    try:
        record = json.loads(sidecar.read_bytes())
        raw = gzip.decompress(path.read_bytes())
        if (record["url"] != url or record["bytes"] != len(raw)
                or record["sha256"] != hashlib.sha256(raw).hexdigest()
                or not isinstance(record["retrieved_at"], str)):
            return None
        return raw, record
    except (OSError, EOFError, ValueError, KeyError, TypeError):
        return None


def acquire_request(tile, year, land, offline):
    url = tile.request_url(year)
    path = tile.cache_path(year)
    cached = cached_response(path, url)
    fetched = cached is None
    if cached is not None:
        raw, record = cached
    else:
        if offline:
            raise ValueError("No hash-verified cache entry")
        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urlopen(request, timeout=240) as response:
                raw = response.read()
        except HTTPError as error:
            detail = error.read(4096).decode("utf-8", errors="replace").strip()
            raise ValueError(f"HTTP {error.code}: {detail}") from error
        except (URLError, TimeoutError) as error:
            raise ValueError(f"Request failed: {error}") from error
        record = {
            "url": url, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    points, api = parse_response(raw, year, tile)
    if fetched:
        atomic_write(path, gzip.compress(raw, mtime=0))
        atomic_write(path.with_suffix(".meta.json"), json_bytes(record))
    return {index: totals for index, totals in points.items() if index in land}, record, api, fetched


def build_cube(tiles, land, offline=False):
    started = time.monotonic()
    values = {index: [None] * len(MONTHS) for index in land}
    records = []
    apis = set()
    failures = []
    fetched_count = 0
    cached_count = 0
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(acquire_request, tile, year, land, offline): (tile, year)
                   for tile in tiles for year in YEARS}
        for completed, future in enumerate(as_completed(futures), 1):
            tile, year = futures[future]
            try:
                points, record, api, fetched = future.result()
                offset = (year - YEARS[0]) * 12
                for index, totals in points.items():
                    previous = values[index][offset:offset + 12]
                    if any(value is not None for value in previous) and previous != list(totals):
                        raise ValueError(f"Conflicting monthly values for {index} in {year}")
                    values[index][offset:offset + 12] = totals
                records.append({"south": tile.south, "west": tile.west, "year": year, **record})
                apis.add((api["name"], api["version"]))
                fetched_count += int(fetched)
                cached_count += int(not fetched)
            except Exception as error:
                failures.append({"south": tile.south, "west": tile.west, "year": year,
                                 "url": tile.request_url(year), "error": str(error)})
            if completed % 10 == 0 or completed == len(futures):
                print(f"Requests {completed}/{len(futures)}; fetched {fetched_count}; "
                      f"cached {cached_count}; failures {len(failures)}; "
                      f"elapsed {time.monotonic() - started:.1f}s", flush=True)
    summary = {"tiles": len(tiles), "requests": len(tiles) * len(YEARS),
               "fetched": fetched_count, "cached": cached_count,
               "failures": sorted(failures, key=lambda item: (item["south"], item["west"], item["year"])),
               "wall_seconds": round(time.monotonic() - started, 2)}
    if failures:
        print(json.dumps(summary, sort_keys=True), flush=True)
        raise ValueError(f"{len(failures)} request(s) failed; rerun to fetch only missing requests")
    for (row, col), totals in values.items():
        if any(value is None for value in totals):
            raise ValueError(f"Land pixel {row}-{col} is missing one or more months")
    cube = {
        "grid": {"latitude_origin": LAT_ORIGIN, "longitude_origin": LON_ORIGIN,
                 "latitude_step": GRID_STEP, "longitude_step": GRID_STEP},
        "months": MONTHS,
        "pixels": [{"id": f"{row}-{col}", "row": row, "col": col, "monthly_mm": totals}
                   for (row, col), totals in sorted(values.items())],
    }
    compressed = gzip.compress(json_bytes(cube), mtime=0)
    cube_path = SOURCES / "imerg-monthly.json.gz"
    manifest_path = SOURCES / "imerg-manifest.json"
    manifest = {
        "source": "NASA GPM IMERG via NASA POWER", "parameter": "IMERG_PRECTOT",
        "units": "mm/day", "monthly_units": "mm", "time_standard": "UTC",
        "api": [{"name": name, "version": version} for name, version in sorted(apis)],
        "boundary_sha256": BOUNDARY_HASH,
        "tiles": [{"south": tile.south, "west": tile.west} for tile in tiles],
        "counts": {"tiles": len(tiles), "requests": len(records), "pixels": len(land),
                   "months": len(MONTHS), "years": len(YEARS)},
        "cube": {"file": cube_path.name, "sha256": hashlib.sha256(compressed).hexdigest(),
                 "bytes": len(compressed)},
        "requests": sorted(records, key=lambda item: (item["south"], item["west"], item["year"])),
    }
    atomic_write(cube_path, compressed)
    atomic_write(manifest_path, json_bytes(manifest))
    summary.update({"land_pixels": len(land), "cube_bytes": len(compressed),
                    "cube_sha256": manifest["cube"]["sha256"],
                    "manifest": str(manifest_path.relative_to(ROOT)),
                    "wall_seconds": round(time.monotonic() - started, 2)})
    summary["annual_totals"] = {}
    for latitude in (14.45, 14.55):
        index = (grid_index(latitude, LAT_ORIGIN), grid_index(121.25, LON_ORIGIN))
        totals = values[index]
        summary["annual_totals"][f"121.25E {latitude}N"] = [
            round(math.fsum(totals[offset:offset + 12]), 2) for offset in range(0, len(MONTHS), 12)
        ]
    print(json.dumps(summary, sort_keys=True), flush=True)
    return cube, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Rebuild from hash-verified cache only")
    args = parser.parse_args()
    try:
        boundary = load_boundary()
        tiles = tile_plan(boundary)
        land = land_pixels(boundary)
        if len(tiles) != 36 or len(land) != 3735:
            raise ValueError(f"Pinned boundary coverage differs: {len(tiles)} tiles, {len(land)} land pixels")
        print(f"Pinned ADM0 verified; {len(tiles)} tiles; {len(land)} land pixels", flush=True)
        build_cube(tiles, land, offline=args.offline)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"IMERG acquisition failed: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
