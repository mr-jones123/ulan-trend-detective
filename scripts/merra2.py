"""Pin NASA POWER MERRA-2 monthly T2M at its native 0.5 by 0.625 degree grid.

Run ``uv run --frozen scripts/merra2.py`` to acquire or reuse verified raw
responses. ``--offline`` only replays the committed snapshot and manifest.
Cell IDs are ``row-col`` with row = latitude / 0.5 and col = longitude / 0.625.
Monthly temperatures remain in Celsius. Annual summary keys are validated but
excluded from the twelve calendar months used for day-weighted means.
"""

import argparse
import calendar
from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from shapely.geometry import box

if __package__:
    from . import imerg
else:
    import imerg

LAT_STEP = 0.5
LON_STEP = 0.625
GRID = {"lat_step": LAT_STEP, "lon_step": LON_STEP}
API_URL = "https://power.larc.nasa.gov/api/temporal/monthly/regional"
SOURCE = {"provider": "NASA POWER", "dataset": "MERRA-2", "parameter": "T2M",
          "units": "C", "time_standard": "UTC", "endpoint": API_URL}
CACHE = imerg.ROOT / "data" / "cache" / "merra2"
SNAPSHOT = imerg.SOURCES / "merra2-monthly.json.gz"
MANIFEST = imerg.SOURCES / "merra2-manifest.json"
KEYS = tuple(f"{year}{month:02}" for year in imerg.YEARS for month in range(1, 14))


@dataclass(frozen=True)
class Tile:
    south: int
    north: int
    west: int
    east: int

    def request_url(self):
        return API_URL + "?" + urlencode({
            "latitude-min": self.south, "latitude-max": self.north,
            "longitude-min": self.west, "longitude-max": self.east,
            "parameters": "T2M", "community": "AG", "start": imerg.YEARS[0],
            "end": imerg.YEARS[-1], "format": "JSON", "time-standard": "UTC"})

    def indices(self):
        return {(row, col) for row in range(math.ceil(self.south / LAT_STEP), math.floor(self.north / LAT_STEP) + 1)
                for col in range(math.ceil(self.west / LON_STEP), math.floor(self.east / LON_STEP) + 1)}


TILES = tuple(Tile(south, north, west, east) for south, north in ((4, 14), (14, 22))
              for west, east in ((114, 124), (124, 128)))


def grid_index(value, step):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Invalid MERRA-2 coordinate")
    index = round(value / step)
    if abs(value - index * step) > 1e-6:
        raise ValueError("Coordinate is not a native MERRA-2 cell centre")
    return index


def cell_bounds(row, col):
    lat, lon = row * LAT_STEP, col * LON_STEP
    return [lon - LON_STEP / 2, lat - LAT_STEP / 2, lon + LON_STEP / 2, lat + LAT_STEP / 2]


def land_cells(boundary):
    west, south, east, north = boundary.bounds
    return frozenset((row, col)
                     for row in range(math.floor(south / LAT_STEP - 0.5), math.ceil(north / LAT_STEP + 0.5) + 1)
                     for col in range(math.floor(west / LON_STEP - 0.5), math.ceil(east / LON_STEP + 0.5) + 1)
                     if boundary.intersection(box(*cell_bounds(row, col))).area > 0)


def valid_value(value, fill=-999):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and value != fill and value != -999)


def parse_response(raw, tile):
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise ValueError("MERRA-2 response must be a FeatureCollection")
    header = data.get("header", {})
    if (header.get("sources") != ["MERRA2"] or header.get("time_standard") != "UTC"
            or header.get("start") != "20010101" or header.get("end") != "20251231"):
        raise ValueError("Unexpected MERRA-2 source, time standard, or date range")
    parameter = data.get("parameters", {}).get("T2M", {})
    if parameter.get("units") != "C" or parameter.get("longname") != "Temperature at 2 Meters":
        raise ValueError("Unexpected T2M units or parameter identity")
    fill = header.get("fill_value")
    if isinstance(fill, bool) or not isinstance(fill, (int, float)) or not math.isfinite(fill):
        raise ValueError("Missing or invalid declared fill value")
    api = header.get("api", {})
    if not isinstance(api, dict) or not api.get("name") or not api.get("version"):
        raise ValueError("Missing POWER API identity")
    features = data.get("features")
    if not isinstance(features, list):
        raise ValueError("Missing MERRA-2 features")
    points = {}
    expected = tile.indices()
    for feature in features:
        geometry = feature.get("geometry", {})
        coords = geometry.get("coordinates")
        if (feature.get("type") != "Feature" or geometry.get("type") != "Point"
                or not isinstance(coords, list) or len(coords) < 2):
            raise ValueError("MERRA-2 feature is not a coordinate Point")
        index = grid_index(coords[1], LAT_STEP), grid_index(coords[0], LON_STEP)
        if index not in expected or index in points:
            raise ValueError(f"Unexpected or duplicate MERRA-2 cell {index}")
        values = feature.get("properties", {}).get("parameter", {}).get("T2M")
        if not isinstance(values, dict) or values.keys() != set(KEYS):
            raise ValueError(f"Incomplete monthly and annual T2M keys for {index}")
        if any(not valid_value(value, fill) for value in values.values()):
            raise ValueError(f"Invalid or missing T2M value for {index}")
        points[index] = tuple(values[key] for key in KEYS)
    if points.keys() != expected:
        raise ValueError("Incomplete native MERRA-2 request grid")
    return points, api


def merge_points(target, points):
    for index, values in points.items():
        if index in target and target[index] != values:
            raise ValueError(f"Conflicting duplicate MERRA-2 cell {index}")
        target[index] = values


def acquire_request(tile):
    url = tile.request_url()
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".json.gz")
    cached = imerg.cached_response(path, url)
    if cached is None:
        request = Request(url, headers={"User-Agent": imerg.USER_AGENT, "Accept": "application/json"})
        try:
            with urlopen(request, timeout=240) as response:
                raw = response.read()
        except HTTPError as error:
            raise ValueError(f"HTTP {error.code}: {error.read(4096).decode(errors='replace')}") from error
        except (URLError, TimeoutError) as error:
            raise ValueError(f"MERRA-2 request failed: {error}") from error
        record = {"url": url, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                  "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    else:
        raw, record = cached
    points, api = parse_response(raw, tile)
    if cached is None:
        imerg.atomic_write(path, gzip.compress(raw, mtime=0))
        imerg.atomic_write(path.with_suffix(".meta.json"), imerg.json_bytes(record))
    return points, record, api


def build_snapshot(boundary):
    points, records, apis = {}, [], set()
    for tile in TILES:
        values, record, api = acquire_request(tile)
        merge_points(points, values)
        records.append(record)
        apis.add((api["name"], api["version"]))
        print(f"MERRA-2 requests {len(records)}/{len(TILES)}", flush=True)
    land = land_cells(boundary)
    if not land <= points.keys():
        raise ValueError("MERRA-2 requests do not cover every positive-area coastal cell")
    snapshot = {"schema": "merra2-t2m-monthly-v1", "grid": GRID, "months": list(imerg.MONTHS),
                "cells": [{"id": f"{row}-{col}", "row": row, "col": col,
                           "monthly_c": [value for k, value in enumerate(points[(row, col)]) if k % 13 != 12]}
                          for row, col in sorted(land)]}
    compressed = gzip.compress(imerg.json_bytes(snapshot), mtime=0)
    manifest = {"source": SOURCE, "boundary_sha256": imerg.BOUNDARY_HASH,
                "api": [{"name": name, "version": version} for name, version in sorted(apis)],
                "snapshot": {"file": SNAPSHOT.name, "sha256": hashlib.sha256(compressed).hexdigest(),
                             "bytes": len(compressed)},
                "counts": {"requests": len(records), "cells": len(land), "months": len(imerg.MONTHS)},
                "requests": sorted(records, key=lambda record: record["url"])}
    imerg.atomic_write(SNAPSHOT, compressed)
    imerg.atomic_write(MANIFEST, imerg.json_bytes(manifest))
    return snapshot, manifest


def snapshot_monthly(snapshot, boundary):
    if (snapshot.get("schema") != "merra2-t2m-monthly-v1" or snapshot.get("grid") != GRID
            or snapshot.get("months") != list(imerg.MONTHS)):
        raise ValueError("Invalid MERRA-2 snapshot schema or axes")
    monthly = {}
    for cell in snapshot["cells"]:
        row, col = cell["row"], cell["col"]
        if type(row) is not int or type(col) is not int or cell["id"] != f"{row}-{col}":
            raise ValueError("Invalid MERRA-2 snapshot cell identity")
        values = cell["monthly_c"]
        if (not isinstance(values, list) or len(values) != len(imerg.MONTHS)
                or any(not valid_value(value) for value in values) or (row, col) in monthly):
            raise ValueError("Invalid or duplicate MERRA-2 monthly snapshot cell")
        monthly[(row, col)] = values
    if monthly.keys() != land_cells(boundary):
        raise ValueError("MERRA-2 snapshot does not cover exactly the ADM0 intersecting grid")
    return monthly


def load_snapshot(boundary=None):
    compressed, manifest_raw = SNAPSHOT.read_bytes(), MANIFEST.read_bytes()
    manifest = json.loads(manifest_raw)
    record = manifest["snapshot"]
    if (record["file"] != SNAPSHOT.name or record["sha256"] != hashlib.sha256(compressed).hexdigest()
            or record["bytes"] != len(compressed) or manifest["boundary_sha256"] != imerg.BOUNDARY_HASH
            or manifest["source"] != SOURCE):
        raise ValueError("MERRA-2 snapshot hash, source, or boundary mismatch")
    apis = manifest.get("api")
    if (not isinstance(apis, list) or not apis
            or any(not isinstance(api, dict)
                   or any(not isinstance(api.get(key), str) or not api[key].strip()
                          for key in ("name", "version"))
                   for api in apis)):
        raise ValueError("Invalid MERRA-2 manifest API identity")
    requests = manifest["requests"]
    if (len(requests) != len(TILES)
            or {record["url"] for record in requests} != {tile.request_url() for tile in TILES}):
        raise ValueError("MERRA-2 manifest differs from the fixed request plan")
    for request in requests:
        if (type(request["bytes"]) is not int or request["bytes"] <= 0
                or not isinstance(request["sha256"], str) or len(request["sha256"]) != 64
                or any(c not in "0123456789abcdef" for c in request["sha256"])
                or datetime.fromisoformat(request["retrieved_at"]).utcoffset() is None):
            raise ValueError("Invalid MERRA-2 request provenance")
    snapshot = json.loads(gzip.decompress(compressed))
    monthly = snapshot_monthly(snapshot, imerg.load_boundary() if boundary is None else boundary)
    if manifest["counts"] != {"requests": len(TILES), "cells": len(monthly), "months": len(imerg.MONTHS)}:
        raise ValueError("MERRA-2 manifest counts differ from snapshot")
    return monthly, {**record, "manifest": MANIFEST.name,
                     "manifest_sha256": hashlib.sha256(manifest_raw).hexdigest(), "manifest_bytes": len(manifest_raw),
                     "requests": len(requests), "boundary_sha256": imerg.BOUNDARY_HASH,
                     "source": SOURCE, "api": manifest["api"]}


def period_means(monthly, months):
    return [math.fsum(monthly[k * 12 + month - 1] * calendar.monthrange(year, month)[1] for month in months)
            / sum(calendar.monthrange(year, month)[1] for month in months)
            for k, year in enumerate(imerg.YEARS)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Replay pinned snapshot without network access")
    args = parser.parse_args()
    try:
        boundary = imerg.load_boundary()
        if not args.offline:
            build_snapshot(boundary)
        monthly, provenance = load_snapshot(boundary)
        print(json.dumps({"cells": len(monthly), **provenance}, indent=2))
    except (OSError, EOFError, ValueError, KeyError, TypeError) as error:
        print(f"MERRA-2 acquisition failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
