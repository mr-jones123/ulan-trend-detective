"""Pin NASA POWER MERRA-2 daily minimum air temperature at the 12 MODIS farm sites.

One daily point request per site, 2001-2025, UTC days. Each site-year is the
mean of the daily minima from 1 January to 30 April. POWER answers a point
request with the MERRA-2 cell containing it, so each site is one native
0.5 by 0.625 degree cell, much coarser than the 25 km MODIS window.
Run ``uv run --frozen scripts/tmin.py``; ``--offline`` replays the raw cache.
"""

import argparse
from datetime import date, datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
from urllib.parse import urlencode
from urllib.request import Request, urlopen

if __package__:
    from . import imerg, modis
else:
    import imerg
    import modis

API_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
CACHE = imerg.ROOT / "data" / "cache" / "tmin"
SNAPSHOT = imerg.SOURCES / "merra2-tmin-sites.json.gz"
MANIFEST = imerg.SOURCES / "merra2-tmin-manifest.json"


def request_url(lat, lon):
    return API_URL + "?" + urlencode({
        "parameters": "T2M_MIN", "community": "AG", "longitude": lon, "latitude": lat,
        "start": f"{imerg.YEARS[0]}0101", "end": f"{imerg.YEARS[-1]}1231",
        "format": "JSON", "time-standard": "UTC"})


def jan_apr_days(year):
    day = date(year, 1, 1)
    while day.month <= 4:
        yield day.strftime("%Y%m%d")
        day += timedelta(days=1)


def parse(raw, lat, lon):
    data = json.loads(raw)
    header = data["header"]
    if "MERRA2" not in header["sources"] or header["time_standard"] != "UTC":
        raise ValueError("T2M_MIN: unexpected source or time standard")
    if data["parameters"]["T2M_MIN"]["units"] != "C" or data["geometry"]["coordinates"][:2] != [lon, lat]:
        raise ValueError("T2M_MIN: unexpected units or point")
    values, fill = data["properties"]["parameter"]["T2M_MIN"], header["fill_value"]
    means = []
    for year in imerg.YEARS:
        days = [values.get(day) for day in jan_apr_days(year)]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
               or v == fill or not -10 < v < 40 for v in days):
            raise ValueError(f"T2M_MIN: missing or invalid day in {year} at {lat}, {lon}")
        means.append(math.fsum(days) / len(days))
    return means


def acquire(url, offline):
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".json.gz")
    cached = imerg.cached_response(path, url)
    if cached:
        return cached
    if offline:
        raise ValueError(f"No hash-verified T2M_MIN cache for {url}")
    with urlopen(Request(url, headers={"User-Agent": imerg.USER_AGENT, "Accept": "application/json"}),
                 timeout=240) as response:
        raw = response.read()
    record = {"url": url, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
              "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    imerg.atomic_write(path, gzip.compress(raw, mtime=0))
    imerg.atomic_write(path.with_suffix(".meta.json"), imerg.json_bytes(record))
    return raw, record


def build_snapshot(offline=False):
    farm, _ = modis.load_snapshot()
    sites, records = [], []
    for site in farm["sites"]:
        url = request_url(site["lat"], site["lon"])
        raw, record = acquire(url, offline)
        sites.append({"lat": site["lat"], "lon": site["lon"],
                      "jan_apr_c": [round(v, 4) for v in parse(raw, site["lat"], site["lon"])]})
        records.append(record)
        print(f"T2M_MIN requests {len(records)}/{len(farm['sites'])}", flush=True)
    snapshot = {"schema": "merra2-tmin-sites-v1", "years": list(imerg.YEARS), "sites": sites}
    compressed = gzip.compress(imerg.json_bytes(snapshot), mtime=0)
    manifest = {"source": {"provider": "NASA POWER", "dataset": "MERRA-2", "parameter": "T2M_MIN",
                           "units": "C", "time_standard": "UTC", "endpoint": API_URL},
                "snapshot": {"file": SNAPSHOT.name, "sha256": hashlib.sha256(compressed).hexdigest(),
                             "bytes": len(compressed)},
                "requests": sorted(records, key=lambda r: r["url"])}
    imerg.atomic_write(SNAPSHOT, compressed)
    imerg.atomic_write(MANIFEST, imerg.json_bytes(manifest))
    return snapshot


def load_snapshot():
    raw, manifest_raw = SNAPSHOT.read_bytes(), MANIFEST.read_bytes()
    manifest = json.loads(manifest_raw)
    if manifest["snapshot"]["sha256"] != hashlib.sha256(raw).hexdigest() or manifest["snapshot"]["bytes"] != len(raw):
        raise ValueError("T2M_MIN snapshot hash mismatch")
    snapshot = json.loads(gzip.decompress(raw))
    if (snapshot["schema"] != "merra2-tmin-sites-v1" or snapshot["years"] != list(imerg.YEARS)
            or len(snapshot["sites"]) != 12 or any(len(s["jan_apr_c"]) != len(imerg.YEARS) for s in snapshot["sites"])):
        raise ValueError("Invalid T2M_MIN snapshot schema")
    return snapshot, {**manifest["snapshot"], "manifest_sha256": hashlib.sha256(manifest_raw).hexdigest(),
                      "requests": len(manifest["requests"]), "source": manifest["source"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    build_snapshot(parser.parse_args().offline)
