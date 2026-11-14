"""Preserve MODIS cropland and clear-sky surface-temperature observations."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from shapely import contains_xy
from shapely.geometry import box

if __package__:
    from . import imerg
else:
    import imerg

CACHE = imerg.ROOT / "data/cache/modis"
SNAPSHOT = imerg.SOURCES / "modis-farm.json.gz"
MANIFEST = imerg.SOURCES / "modis-manifest.json"
NDVI_SNAPSHOT = imerg.SOURCES / "modis-ndvi.json.gz"
NDVI_MANIFEST = imerg.SOURCES / "modis-ndvi-manifest.json"
NDVI_BAND = "250m_16_days_NDVI"
RELIABILITY_BAND = "250m_16_days_pixel_reliability"
RADIUS = 6371007.181
CELL = 463.312716528
# band: (cell size, valid raw values, fill, units, scale); None skips the check
BANDS = {
    "LC_Type1": (CELL, range(1, 18), 255, None, None),
    "LST_Day_1km": (CELL * 2, range(7500, 65536), 0, "Kelvin", 0.02),
    "LST_Night_1km": (CELL * 2, range(7500, 65536), 0, "Kelvin", 0.02),
    NDVI_BAND: (CELL / 2, range(-2000, 10001), -3000, None, 0.0001),
    RELIABILITY_BAND: (CELL / 2, range(0, 4), -1, None, None),
}
API = "https://modis.ornl.gov/rst/api/v1"


def pixel_index(window, row, col):
    size = float(window["cellsize"])
    return (round(float(window["xllcorner"]) / size) + col,
            round(float(window["yllcorner"]) / size) + window["nrows"] - row - 1)


def pixel_lonlat(ix, iy, size=CELL):
    lat = (iy + 0.5) * size / RADIUS
    return math.degrees((ix + 0.5) * size / (RADIUS * math.cos(lat))), math.degrees(lat)


def cropland_pixel(ix, iy, crop):
    return sum((2 * ix + dx, 2 * iy + dy) in crop for dx in (0, 1) for dy in (0, 1)) >= 3


def composite_mean(values, positions):
    valid = [values[k] for k in positions if values[k] != 0]
    if not positions or len(valid) / len(positions) < 0.3:
        return None
    return math.fsum(valid) / len(valid) * 0.02 - 273.15


def select_sites(density, count=12):
    selected = []
    for (lat, lon), pixels in sorted(density.items(), key=lambda item: (-item[1], item[0])):
        if all(abs(lat - s[0]) >= 1 or abs(lon - s[1]) >= 1 for s in selected):
            selected.append((lat, lon))
            if len(selected) == count:
                return selected
    raise ValueError(f"Only {len(selected)} separated cropland sites")


def request_url(product, band, lat, lon, radius, start, end):
    return f"{API}/{product}/subset?" + urlencode({
        "band": band, "startDate": start, "endDate": end, "latitude": lat,
        "longitude": lon, "kmAboveBelow": radius, "kmLeftRight": radius})


def parse_window(raw, band, dates):
    data = json.loads(raw)
    size, valid_range, fill, units, scale = BANDS[band]
    if (data["band"] != band or abs(float(data["cellsize"]) - size) > 0.001
            or not isinstance(data["nrows"], int) or not isinstance(data["ncols"], int)
            or data["nrows"] <= 0 or data["ncols"] <= 0):
        raise ValueError("Unexpected MODIS grid or band")
    if units is not None and data["units"] != units or scale is not None and float(data["scale"]) != scale:
        raise ValueError("Unexpected MODIS units or scale")
    if [s["modis_date"] for s in data["subset"]] != dates:
        raise ValueError("Missing, duplicate or unordered MODIS composites")
    for subset in data["subset"]:
        values = subset["data"]
        if (subset["band"] != band or len(values) != data["nrows"] * data["ncols"]
                or any(type(v) is not int or v not in valid_range and v != fill for v in values)):
            raise ValueError("Invalid MODIS pixel values")
    for key in ("xllcorner", "yllcorner"):
        if not math.isfinite(float(data[key])):
            raise ValueError("Invalid MODIS origin")
        index = float(data[key]) / size
        if abs(index - round(index)) > 0.001:
            raise ValueError("MODIS origin is not on its sinusoidal grid")
    return data


def acquire(url, band, dates, offline=False):
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".json.gz")
    cached = imerg.cached_response(path, url)
    if cached:
        raw, record = cached
        return parse_window(raw, band, dates), record
    if offline:
        raise ValueError(f"No hash-verified MODIS cache for {url}")
    for attempt in range(5):
        try:
            with urlopen(Request(url, headers={"Accept": "application/json", "User-Agent": imerg.USER_AGENT}), timeout=240) as response:
                raw = response.read()
            data = parse_window(raw, band, dates)
            break
        except (OSError, ValueError, KeyError, TypeError):
            if attempt == 4:
                raise
            time.sleep(2 ** (attempt + 1))
    record = {"url": url, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
              "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    imerg.atomic_write(path, gzip.compress(raw, mtime=0))
    imerg.atomic_write(path.with_suffix(".meta.json"), imerg.json_bytes(record))
    return data, record


def land_cover(boundary, offline=False):
    """Deduplicated 2020 MCD12Q1 classes for 500 m pixels inside ADM0, keyed by sinusoidal index."""
    windows = [(round(5.5 + 1.8 * i, 1), round(117.8 + 1.8 * j, 1))
               for i in range(9) for j in range(6)
               if boundary.intersects(box(117.8 + 1.8 * j - 1, 5.5 + 1.8 * i - 0.95,
                                          117.8 + 1.8 * j + 1, 5.5 + 1.8 * i + 0.95))]
    pixels = {}
    records = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(acquire, request_url("MCD12Q1", "LC_Type1", lat, lon, 100,
                                                    "A2020001", "A2020001"), "LC_Type1", ["A2020001"], offline)
                   for lat, lon in windows]
        for future in as_completed(futures):
            window, record = future.result()
            records.append(record)
            rows, cols = np.indices((window["nrows"], window["ncols"]))
            ix = round(float(window["xllcorner"]) / CELL) + cols.ravel()
            iy = round(float(window["yllcorner"]) / CELL) + window["nrows"] - rows.ravel() - 1
            latitude = (iy + 0.5) * CELL / RADIUS
            longitude = np.degrees((ix + 0.5) * CELL / (RADIUS * np.cos(latitude)))
            latitude = np.degrees(latitude)
            inside = contains_xy(boundary, longitude, latitude)
            values = window["subset"][0]["data"]
            for k in np.flatnonzero(inside):
                key = (int(ix[k]), int(iy[k]))
                value = values[k]
                if key in pixels and pixels[key] != value:
                    raise ValueError("Conflicting overlapping land-cover pixels")
                pixels[key] = value
    return pixels, records


def build_snapshot(boundary, offline=False):
    pixels, records = land_cover(boundary, offline)
    crop = {key for key, value in pixels.items() if value == 12}
    totals, crops, density = Counter(), Counter(), Counter()
    for (ix, iy), value in pixels.items():
        lon, lat = pixel_lonlat(ix, iy)
        cell = (math.floor((lat + 90) * 10), math.floor((lon + 180) * 10))
        totals[cell] += 1
        if value == 12:
            crops[cell] += 1
            density[(round(lat * 2) / 2, round(lon * 2) / 2)] += 1
    centres = select_sites(density)
    sites = [{"lat": lat, "lon": lon, "composites": {"day": {}, "night": {}}} for lat, lon in centres]
    print(f"MODIS mask {len(pixels)} land pixels; {len(crop)} cropland; sites {centres}", flush=True)
    jobs = []
    for site in range(len(sites)):
        for year in imerg.YEARS:
            for period, band in (("day", "LST_Day_1km"), ("night", "LST_Night_1km")):
                for start, end in ((1, 73), (81, 113)):
                    dates = [f"A{year}{d:03}" for d in range(start, end + 1, 8)]
                    url = request_url("MOD11A2", band, sites[site]["lat"], sites[site]["lon"], 25, dates[0], dates[-1])
                    jobs.append((site, period, dates, band, url))
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(acquire, url, band, dates, offline): (site, period)
                   for site, period, dates, band, url in jobs}
        for completed, future in enumerate(as_completed(futures), 1):
            site, period = futures[future]
            window, record = future.result()
            records.append(record)
            positions = [row * window["ncols"] + col for row in range(window["nrows"])
                         for col in range(window["ncols"])
                         if cropland_pixel(*pixel_index(window, row, col), crop)]
            if not positions:
                raise ValueError("Site has no cropland temperature pixels")
            count = len(positions)
            if sites[site].get("cropland_pixels", count) != count:
                raise ValueError("Temperature window changed between requests")
            sites[site]["cropland_pixels"] = count
            x0, y0 = pixel_index(window, window["nrows"] - 1, 0)
            size = float(window["cellsize"])
            ring = []
            for x, y in ((x0, y0), (x0 + window["ncols"], y0),
                         (x0 + window["ncols"], y0 + window["nrows"]), (x0, y0 + window["nrows"]), (x0, y0)):
                lat = y * size / RADIUS
                ring.append([round(math.degrees(x * size / (RADIUS * math.cos(lat))), 6), round(math.degrees(lat), 6)])
            if sites[site].get("outline", ring) != ring:
                raise ValueError("Temperature window geometry changed between requests")
            sites[site]["outline"] = ring
            for subset in window["subset"]:
                sites[site]["composites"][period][subset["modis_date"]] = composite_mean(subset["data"], positions)
            if completed % 25 == 0 or completed == len(futures):
                print(f"MODIS temperature requests {completed}/{len(futures)}", flush=True)
    land = imerg.land_pixels(boundary)
    snapshot = {"schema": "modis-farm-v1", "years": list(imerg.YEARS), "mask_year": 2020,
                "cells": {f"{r}-{c}": round(100 * crops[(r, c)] / totals[(r, c)]) if totals[(r, c)] else 0
                          for r, c in sorted(land)}, "sites": sites,
                "land_pixels": len(pixels), "cropland_pixels": len(crop)}
    for site in sites:
        for period in ("day", "night"):
            for year in imerg.YEARS:
                if not any(value is not None for date, value in site["composites"][period].items() if date.startswith(f"A{year}")):
                    raise ValueError(f"No valid {period} observations for site {site['lat']}, {year}")
    compressed = gzip.compress(imerg.json_bytes(snapshot), mtime=0)
    manifest = {"boundary_sha256": imerg.BOUNDARY_HASH,
                "snapshot": {"file": SNAPSHOT.name, "sha256": hashlib.sha256(compressed).hexdigest(), "bytes": len(compressed)},
                "requests": sorted(records, key=lambda r: r["url"])}
    imerg.atomic_write(SNAPSHOT, compressed)
    imerg.atomic_write(MANIFEST, imerg.json_bytes(manifest))
    return snapshot, manifest


def ndvi_mean(ndvi, reliability, positions):
    """Mean NDVI of good or marginal cropland pixels; None below the 30% validity rule."""
    valid = [ndvi[k] for k in positions if reliability[k] in (0, 1) and ndvi[k] != -3000]
    if not positions or len(valid) / len(positions) < 0.3:
        return None
    return math.fsum(valid) / len(valid) * 0.0001


def build_ndvi_snapshot(boundary, offline=False):
    """MOD13Q1 January to April NDVI over cropland at the 12 farm sites, same 25 km windows as LST."""
    pixels, records = land_cover(boundary, offline=True)
    crop = {key for key, value in pixels.items() if value == 12}
    farm, _ = load_snapshot()
    sites = [{"lat": s["lat"], "lon": s["lon"], "composites": {}} for s in farm["sites"]]
    jobs = []
    for site in range(len(sites)):
        dates_by_year = {year: [f"A{year}{d:03}" for d in range(1, 114, 16)] for year in imerg.YEARS}
        for year, dates in dates_by_year.items():
            for band in (NDVI_BAND, RELIABILITY_BAND):
                url = request_url("MOD13Q1", band, sites[site]["lat"], sites[site]["lon"], 25, dates[0], dates[-1])
                jobs.append((site, year, band, dates, url))
    windows = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(acquire, url, band, dates, offline): (site, year, band)
                   for site, year, band, dates, url in jobs}
        for completed, future in enumerate(as_completed(futures), 1):
            window, record = future.result()
            records.append(record)
            windows[futures[future]] = window
            if completed % 25 == 0 or completed == len(futures):
                print(f"MODIS NDVI requests {completed}/{len(futures)}", flush=True)
    for (site, year, band), window in windows.items():
        if band != NDVI_BAND:
            continue
        quality = windows[(site, year, RELIABILITY_BAND)]
        if any(quality[k] != window[k] for k in ("xllcorner", "yllcorner", "nrows", "ncols")):
            raise ValueError("NDVI and reliability windows differ")
        positions = [row * window["ncols"] + col for row in range(window["nrows"]) for col in range(window["ncols"])
                     if (lambda ix, iy: (ix // 2, iy // 2) in crop)(*pixel_index(window, row, col))]
        count = len(positions)
        if not count or sites[site].setdefault("cropland_pixels", count) != count:
            raise ValueError("NDVI cropland window is empty or changed between requests")
        for subset, qa in zip(window["subset"], quality["subset"], strict=True):
            sites[site]["composites"][subset["modis_date"]] = ndvi_mean(subset["data"], qa["data"], positions)
    for site in sites:
        site["composites"] = dict(sorted(site["composites"].items()))
        for year in imerg.YEARS:
            if not any(v is not None for date, v in site["composites"].items() if date.startswith(f"A{year}")):
                raise ValueError(f"No valid NDVI for site {site['lat']}, {year}")
    snapshot = {"schema": "modis-ndvi-v1", "product": "MOD13Q1", "years": list(imerg.YEARS),
                "mask_year": 2020, "sites": sites}
    compressed = gzip.compress(imerg.json_bytes(snapshot), mtime=0)
    manifest = {"boundary_sha256": imerg.BOUNDARY_HASH,
                "snapshot": {"file": NDVI_SNAPSHOT.name, "sha256": hashlib.sha256(compressed).hexdigest(),
                             "bytes": len(compressed)},
                "requests": sorted(records, key=lambda r: r["url"])}
    imerg.atomic_write(NDVI_SNAPSHOT, compressed)
    imerg.atomic_write(NDVI_MANIFEST, imerg.json_bytes(manifest))
    return snapshot, manifest


def load_ndvi_snapshot():
    raw, manifest_raw = NDVI_SNAPSHOT.read_bytes(), NDVI_MANIFEST.read_bytes()
    manifest = json.loads(manifest_raw)
    if (manifest["boundary_sha256"] != imerg.BOUNDARY_HASH
            or manifest["snapshot"]["sha256"] != hashlib.sha256(raw).hexdigest()
            or manifest["snapshot"]["bytes"] != len(raw)):
        raise ValueError("NDVI snapshot hash or boundary mismatch")
    snapshot = json.loads(gzip.decompress(raw))
    if snapshot["schema"] != "modis-ndvi-v1" or snapshot["years"] != list(imerg.YEARS) or len(snapshot["sites"]) != 12:
        raise ValueError("Invalid NDVI snapshot schema")
    return snapshot, {**manifest["snapshot"], "manifest_sha256": hashlib.sha256(manifest_raw).hexdigest(),
                      "requests": len(manifest["requests"]), "boundary_sha256": imerg.BOUNDARY_HASH}


def load_snapshot():
    raw = SNAPSHOT.read_bytes()
    manifest_raw = MANIFEST.read_bytes()
    manifest = json.loads(manifest_raw)
    if (manifest["boundary_sha256"] != imerg.BOUNDARY_HASH
            or manifest["snapshot"]["sha256"] != hashlib.sha256(raw).hexdigest()
            or manifest["snapshot"]["bytes"] != len(raw)):
        raise ValueError("MODIS snapshot hash or boundary mismatch")
    snapshot = json.loads(gzip.decompress(raw))
    if snapshot["schema"] != "modis-farm-v1" or snapshot["years"] != list(imerg.YEARS) or len(snapshot["sites"]) != 12:
        raise ValueError("Invalid MODIS snapshot schema")
    return snapshot, {**manifest["snapshot"], "manifest_sha256": hashlib.sha256(manifest_raw).hexdigest(),
                      "requests": len(manifest["requests"]), "boundary_sha256": imerg.BOUNDARY_HASH}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--ndvi", action="store_true", help="Build the MOD13Q1 NDVI snapshot at the farm sites")
    args = parser.parse_args()
    (build_ndvi_snapshot if args.ndvi else build_snapshot)(imerg.load_boundary(), args.offline)
