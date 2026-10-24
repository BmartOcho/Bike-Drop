#!/usr/bin/env python3
"""
Bike Drop data pipeline.

Turns one month of Citi Bike trip data into a single "day pack" the game can
play, plus an updated schedule.json.

Usage
-----
    # Download the most recent complete month from the S3 index, pick an
    # ordinary Tue–Thu, and write public/data/days/<date>.json:
    python3 scripts/build_day.py

    # Use a specific month / day, or an already-downloaded zip:
    python3 scripts/build_day.py --month 202609 --date 2026-09-16
    python3 scripts/build_day.py --zip scripts/raw/202609-citibike-tripdata.zip

    # Also assign the new day to a play date in schedule.json:
    python3 scripts/build_day.py --play-date 2026-10-24

Steps (see README "Data pipeline"):
 1. List https://s3.amazonaws.com/tripdata/, download the most recent complete
    NYC month (not the JC-* Jersey City files).
 2. Fetch station names, coordinates, capacity from the GBFS feed.
 3. Keep stations in Manhattan south of 59th St; pick the ~50 busiest by
    6–10 AM activity on the chosen day, enforcing a minimum spacing so the
    picks spread across neighborhoods.
 4. Starting inventory at 11 PM = 50% of capacity + net flow (arrivals −
    departures) from 6–11 PM the previous evening, clamped to 0..capacity.
 5. Keep 6–10 AM trips that start or end at a selected station.
 6. Write public/data/days/YYYY-MM-DD.json and update public/data/schedule.json.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import os
import re
import sys
import urllib.request
import zipfile

import pandas as pd

S3_INDEX = "https://s3.amazonaws.com/tripdata/"
GBFS_STATIONS = "https://gbfs.citibikenyc.com/gbfs/en/station_information.json"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "scripts", "raw")
DATA_DIR = os.path.join(ROOT, "public", "data")
DAYS_DIR = os.path.join(DATA_DIR, "days")

# Rough lon/lat outline of lower/midtown Manhattan (clockwise from the Hudson),
# used to drop Roosevelt Island, DUMBO, Jersey City and Governors Island. The
# northern cut is made separately by the 59th St line below.
MANHATTAN_OUTLINE = [
    (-73.9960, 40.7760),  # Hudson, ~W 64th
    (-74.0010, 40.7620),  # Hudson, ~W 42nd
    (-74.0100, 40.7480),  # ~W 23rd
    (-74.0135, 40.7290),  # Christopher St pier
    (-74.0170, 40.7170),  # Canal / Tribeca
    (-74.0195, 40.7060),  # Battery Park City
    (-74.0175, 40.6990),  # The Battery
    (-74.0095, 40.6995),  # Staten Island ferry
    (-74.0020, 40.7035),  # South St Seaport
    (-73.9965, 40.7090),  # Brooklyn Bridge
    (-73.9900, 40.7125),  # Manhattan Bridge
    (-73.9770, 40.7110),  # Corlears Hook
    (-73.9725, 40.7220),  # East River Park
    (-73.9715, 40.7360),  # Stuyvesant Cove
    (-73.9690, 40.7480),  # UN / E 42nd
    (-73.9600, 40.7560),  # ~E 53rd
    (-73.9560, 40.7640),  # East River, ~E 63rd
    (-73.9640, 40.7720),  # ~E 68th & 5th (inside the park)
    (-73.9790, 40.7780),  # ~W 69th & Columbus
]

# "South of 59th St": Manhattan's grid is tilted ~29° off north, so 59th St
# is a sloped line in lon/lat. This one runs from Columbus Circle to Sutton
# Place, nudged ~90 m north so stations *on* 59th St / Central Park South count.
_L1 = (-73.9819, 40.7680)   # Columbus Circle (59th & 8th)
_L2 = (-73.9603, 40.7590)   # Sutton Pl & E 59th
_SLOPE = (_L2[1] - _L1[1]) / (_L2[0] - _L1[0])
_NUDGE = 0.0008


def south_of_59th(lon, lat):
    line_lat = _L1[1] + _SLOPE * (lon - _L1[0]) + _NUDGE
    return lat <= line_lat and point_in_poly(lon, lat, MANHATTAN_OUTLINE)


SEL_TARGET = 50          # stations to pick
MIN_SPACING_M = 320      # spread picks: no two selected stations closer than this
AM_START, AM_END = 6 * 3600, 10 * 3600      # 6:00–10:00 AM, seconds from midnight
PM_START, PM_END = 18 * 3600, 23 * 3600     # 6–11 PM previous evening
MAX_PACK_BYTES = 500_000


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def log(*a):
    print(*a, file=sys.stderr, flush=True)


def point_in_poly(lon, lat, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > lat) != (yj > lat):
            x = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x:
                inside = not inside
        j = i
    return inside


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nth_weekday(year, month, weekday, n):
    """n-th (1-based) weekday (Mon=0) of a month; n=-1 means last."""
    if n > 0:
        d = dt.date(year, month, 1)
        off = (weekday - d.weekday()) % 7
        return d + dt.timedelta(days=off + 7 * (n - 1))
    d = dt.date(year + (month == 12), (month % 12) + 1, 1) - dt.timedelta(days=1)
    off = (d.weekday() - weekday) % 7
    return d - dt.timedelta(days=off)


def us_federal_holidays(year):
    def observed(d):
        if d.weekday() == 5:
            return d - dt.timedelta(days=1)
        if d.weekday() == 6:
            return d + dt.timedelta(days=1)
        return d

    fixed = [dt.date(year, 1, 1), dt.date(year, 6, 19), dt.date(year, 7, 4),
             dt.date(year, 11, 11), dt.date(year, 12, 25)]
    hol = {observed(d) for d in fixed}
    hol |= {
        nth_weekday(year, 1, 0, 3),    # MLK
        nth_weekday(year, 2, 0, 3),    # Presidents
        nth_weekday(year, 5, 0, -1),   # Memorial
        nth_weekday(year, 9, 0, 1),    # Labor
        nth_weekday(year, 10, 0, 2),   # Columbus / Indigenous Peoples
        nth_weekday(year, 11, 3, 4),   # Thanksgiving
    }
    return hol


def fetch(url, binary=False):
    log(f"GET {url}")
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    return data if binary else data.decode("utf-8")


# --------------------------------------------------------------------------- #
# step 1: trip data
# --------------------------------------------------------------------------- #
def latest_month_key():
    xml = fetch(S3_INDEX)
    keys = re.findall(r"<Key>([^<]+)</Key>", xml)
    months = sorted(k for k in keys if re.fullmatch(r"\d{6}-citibike-tripdata\.zip", k))
    if not months:
        raise SystemExit("no monthly archives found in S3 index")
    return months[-1]


def download_month(key):
    os.makedirs(RAW_DIR, exist_ok=True)
    path = os.path.join(RAW_DIR, key)
    if os.path.exists(path):
        log(f"using cached {path}")
        return path
    url = S3_INDEX + key
    log(f"downloading {url} …")
    urllib.request.urlretrieve(url, path)
    return path


def load_trips(zip_path):
    """Load every trip in the archive with just the columns we need."""
    usecols = ["started_at", "ended_at", "start_station_id", "end_station_id",
               "start_lat", "start_lng", "end_lat", "end_lng"]
    frames = []
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".csv") and "__MACOSX" not in n]
        for n in sorted(names):
            log(f"reading {n}")
            with z.open(n) as f:
                df = pd.read_csv(io.TextIOWrapper(f, encoding="utf-8"), usecols=usecols,
                                 dtype={"start_station_id": "string", "end_station_id": "string"})
            frames.append(df)
    trips = pd.concat(frames, ignore_index=True)
    del frames
    trips["started_at"] = pd.to_datetime(trips["started_at"], format="mixed")
    trips["ended_at"] = pd.to_datetime(trips["ended_at"], format="mixed")
    trips = trips.dropna(subset=["started_at", "ended_at"])
    trips["dur"] = (trips["ended_at"] - trips["started_at"]).dt.total_seconds().astype("int64")
    trips = trips[(trips["dur"] > 0) & (trips["dur"] < 4 * 3600)]
    trips["day"] = trips["started_at"].dt.date
    trips["ssec"] = (trips["started_at"].dt.hour * 3600 + trips["started_at"].dt.minute * 60
                     + trips["started_at"].dt.second).astype("int64")
    log(f"{len(trips):,} trips loaded")
    return trips


def pick_day(trips):
    """An ordinary Tue–Thu: not a federal holiday or adjacent to one, with a
    previous evening inside the archive. Among candidates, take the one with
    the median 6–10 AM trip volume (avoids both washouts and freak peaks)."""
    days = sorted(trips["day"].unique())
    hol = us_federal_holidays(days[0].year) | us_federal_holidays(days[-1].year)
    cands = []
    for d in days:
        if d.weekday() not in (1, 2, 3):
            continue
        if d in hol or (d - dt.timedelta(days=1)) in hol or (d + dt.timedelta(days=1)) in hol:
            continue
        if (d - dt.timedelta(days=1)) not in set(days):
            continue
        am = trips[(trips["day"] == d) & (trips["ssec"] >= AM_START) & (trips["ssec"] < AM_END)]
        cands.append((len(am), d))
    if not cands:
        raise SystemExit("no candidate days")
    cands.sort()
    for c, d in cands:
        log(f"  candidate {d} ({d.strftime('%a')}): {c:,} AM trips")
    return cands[len(cands) // 2][1]


# --------------------------------------------------------------------------- #
# step 2–3: stations
# --------------------------------------------------------------------------- #
def load_gbfs_stations():
    data = json.loads(fetch(GBFS_STATIONS))
    out = {}
    for s in data["data"]["stations"]:
        sn = s.get("short_name")
        cap = int(s.get("capacity") or 0)
        if not sn or cap <= 0:
            continue
        out[sn] = {"id": sn, "name": s["name"], "lat": float(s["lat"]),
                   "lon": float(s["lon"]), "cap": cap}
    log(f"{len(out)} GBFS stations with capacity")
    return out


def select_stations(am_trips, gbfs):
    """~50 busiest Manhattan-below-59th stations by 6–10 AM activity, with a
    minimum spacing so one hot block doesn't eat the whole list."""
    starts = am_trips["start_station_id"].value_counts()
    ends = am_trips["end_station_id"].value_counts()
    activity = starts.add(ends, fill_value=0).sort_values(ascending=False)
    picked = []
    for sid, act in activity.items():
        st = gbfs.get(sid)
        if not st or not south_of_59th(st["lon"], st["lat"]):
            continue
        if any(haversine_m(st["lat"], st["lon"], p["lat"], p["lon"]) < MIN_SPACING_M for p in picked):
            continue
        picked.append({**st, "activity": int(act)})
        if len(picked) >= SEL_TARGET:
            break
    # Order north→south for a tidy station list.
    picked.sort(key=lambda s: -s["lat"])
    return picked


# --------------------------------------------------------------------------- #
# step 4: starting inventory
# --------------------------------------------------------------------------- #
def starting_inventory(stations, pm_trips):
    idx = {s["id"]: i for i, s in enumerate(stations)}
    net = [0] * len(stations)
    for sid in pm_trips["end_station_id"].dropna():
        if sid in idx:
            net[idx[sid]] += 1
    for sid in pm_trips["start_station_id"].dropna():
        if sid in idx:
            net[idx[sid]] -= 1
    inv = []
    for s, n in zip(stations, net):
        base = round(s["cap"] * 0.5)
        inv.append(max(0, min(s["cap"], base + n)))
    return inv, net


# --------------------------------------------------------------------------- #
# step 5–6: trips + output
# --------------------------------------------------------------------------- #
def build_pack(date, stations, inv, net, am_trips, gbfs, source):
    idx = {s["id"]: i for i, s in enumerate(stations)}
    ext = []          # unselected endpoints: coords only, referenced as -(k+1)
    ext_idx = {}

    def endpoint(sid, lat, lon):
        if isinstance(sid, str) and sid in idx:
            return idx[sid]
        # Unselected end. Prefer GBFS coords, else the trip's own coords,
        # rounded to ~10 m. -1 if we have nothing.
        if isinstance(sid, str) and sid in gbfs:
            key = sid
            lat, lon = gbfs[sid]["lat"], gbfs[sid]["lon"]
        elif pd.notna(lat) and pd.notna(lon):
            lat, lon = round(float(lat), 4), round(float(lon), 4)
            key = f"{lat},{lon}"
        else:
            return -1
        if key not in ext_idx:
            ext_idx[key] = len(ext)
            ext.append([round(lat, 5), round(lon, 5)])
        return -(ext_idx[key] + 1)

    rows = []
    for r in am_trips.itertuples(index=False):
        o_sel = isinstance(r.start_station_id, str) and r.start_station_id in idx
        d_sel = isinstance(r.end_station_id, str) and r.end_station_id in idx
        if not (o_sel or d_sel):
            continue
        o = endpoint(r.start_station_id, r.start_lat, r.start_lng)
        d = endpoint(r.end_station_id, r.end_lat, r.end_lng)
        rows.append([int(r.ssec), o, d, int(r.dur)])
    rows.sort()

    pack = {
        "date": date.isoformat(),
        "weekday": date.strftime("%A"),
        "source": source,
        "window": {"start": AM_START, "end": AM_END},
        "vanCapacity": 20,
        "stops": 8,
        "stations": [{"id": s["id"], "name": s["name"], "lat": round(s["lat"], 5),
                      "lon": round(s["lon"], 5), "cap": s["cap"]} for s in stations],
        "inventory": inv,
        "eveningNet": net,
        "ext": ext,
        "trips": rows,
    }
    return pack


def compact_json(obj):
    """JSON with one trip per line so diffs stay readable but size stays small."""
    head = {k: v for k, v in obj.items() if k not in ("trips", "ext")}
    s = json.dumps(head, separators=(",", ":"))[:-1]
    s += ',"ext":' + json.dumps(obj["ext"], separators=(",", ":"))
    s += ',"trips":[\n' + ",\n".join(json.dumps(t, separators=(",", ":")) for t in obj["trips"]) + "\n]}\n"
    return s


def update_schedule(day_iso, play_date):
    path = os.path.join(DATA_DIR, "schedule.json")
    sched = {"days": [], "byDate": {}}
    if os.path.exists(path):
        with open(path) as f:
            sched = json.load(f)
    if day_iso not in sched["days"]:
        sched["days"].append(day_iso)
    sched["days"].sort()
    if play_date:
        sched["byDate"][play_date] = day_iso
    sched["byDate"] = dict(sorted(sched["byDate"].items()))
    sched.setdefault("epoch", play_date or min(sched["byDate"], default=dt.date.today().isoformat()))
    with open(path, "w") as f:
        json.dump(sched, f, indent=2)
        f.write("\n")
    log(f"wrote {path}")


def main():
    global SEL_TARGET
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--month", help="YYYYMM to download (default: latest complete month)")
    ap.add_argument("--zip", help="path to an already-downloaded monthly zip")
    ap.add_argument("--date", help="YYYY-MM-DD data day (default: median-volume Tue–Thu)")
    ap.add_argument("--play-date", help="assign the day to this play date in schedule.json")
    ap.add_argument("--stations", type=int, default=SEL_TARGET)
    args = ap.parse_args()
    SEL_TARGET = args.stations

    if args.zip:
        zip_path = args.zip
    else:
        key = f"{args.month}-citibike-tripdata.zip" if args.month else latest_month_key()
        zip_path = download_month(key)
    source = os.path.basename(zip_path)

    trips = load_trips(zip_path)
    date = dt.date.fromisoformat(args.date) if args.date else pick_day(trips)
    log(f"data day: {date} ({date.strftime('%A')})")
    prev = date - dt.timedelta(days=1)

    am = trips[(trips["day"] == date) & (trips["ssec"] >= AM_START) & (trips["ssec"] < AM_END)]
    pm = trips[(trips["day"] == prev) & (trips["ssec"] >= PM_START) & (trips["ssec"] < PM_END)]
    log(f"{len(am):,} AM trips system-wide, {len(pm):,} previous-evening trips")

    gbfs = load_gbfs_stations()
    stations = select_stations(am, gbfs)
    log(f"selected {len(stations)} stations")
    inv, net = starting_inventory(stations, pm)
    pack = build_pack(date, stations, inv, net, am, gbfs, source)
    log(f"{len(pack['trips']):,} trips kept, {len(pack['ext'])} external endpoints")

    os.makedirs(DAYS_DIR, exist_ok=True)
    out = os.path.join(DAYS_DIR, f"{date.isoformat()}.json")
    text = compact_json(pack)
    if len(text.encode()) > MAX_PACK_BYTES:
        raise SystemExit(f"day pack is {len(text):,} bytes, over the {MAX_PACK_BYTES:,} limit")
    with open(out, "w") as f:
        f.write(text)
    log(f"wrote {out} ({len(text.encode()):,} bytes)")
    update_schedule(date.isoformat(), args.play_date)


if __name__ == "__main__":
    main()
