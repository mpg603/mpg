#!/usr/bin/env python3
"""Compute the "worst NYC subway wait" snapshot from the seven official NYCT GTFS-realtime feeds.

Metric: for every directional stop (stop_id ending in N or S), take the soonest predicted
passenger departure that is still ahead. Stops are ranked by that wait, longest first, and the
top TOP_N platforms (each one direction of one station) are published; "winner" is the first of them.
Stops with no prediction at all are NOT treated as infinite waits.

The script fails closed: if any feed is unreachable, invalid or stale, or coverage looks
implausibly small, it exits non-zero and writes no snapshot, so the previous one simply ages out.
"""
import argparse, csv, io, json, sys, time, zipfile, urllib.request, pathlib

BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F"
FEEDS = ["gtfs", "gtfs-ace", "gtfs-bdfm", "gtfs-g", "gtfs-jz", "gtfs-l", "gtfs-nqrw"]  # Staten Island Railway excluded
STATIC_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"

# ---- thresholds (named so they can be reviewed in one place) ----
MAX_FEED_AGE = 180          # seconds: a feed whose own timestamp is older than this is stale
MIN_ENTITIES_PER_FEED = 5   # a feed with fewer entities is treated as broken
MIN_DIRECTIONAL_STOPS = 300 # fewer predicted platforms than this = coverage failure
PAST_GRACE = 90             # seconds a past prediction still counts (train dwelling at platform)
MAX_HORIZON = 2 * 3600      # ignore predictions further out than this (garbage guard)
FETCH_TRIES = 3
STATIC_MAX_AGE = 24 * 3600  # re-download station names at most once a day
TOP_N = 3                   # how many of the longest waits to publish
SKIP_TRIP = {3, 6, 7}       # CANCELED, DUPLICATED, DELETED
SKIP_STOP = {1, 2}          # SKIPPED, NO_DATA


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url, tries=FETCH_TRIES, timeout=30):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "subway-wait-snapshot/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def load_static(cache_dir):
    """Return ({stop_id: name}, {trip suffix: headsign}). Falls back to the cached copy."""
    cache = pathlib.Path(cache_dir) / "static_subway.json"
    try:
        d = json.loads(cache.read_text())
        if time.time() - d.get("fetched", 0) < STATIC_MAX_AGE:   # fresh enough: skip the 5 MB download
            return d["stops"], d["heads"]
    except Exception:  # noqa: BLE001
        pass
    try:
        z = zipfile.ZipFile(io.BytesIO(fetch(STATIC_URL)))
        rows = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig"))
        stops = {r["stop_id"]: r["stop_name"] for r in rows("stops.txt")}
        heads = {}
        for r in rows("trips.txt"):
            tid = r["trip_id"]
            heads[tid.split("_", 1)[1] if "_" in tid else tid] = r.get("trip_headsign", "")
        if len(stops) < 400:
            raise RuntimeError("static stops.txt unexpectedly small")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"stops": stops, "heads": heads, "fetched": int(time.time())}))
        return stops, heads
    except Exception as e:  # noqa: BLE001
        log("static download failed, trying cache:", e)
        d = json.loads(cache.read_text())  # raises if no cache: fail closed
        return d["stops"], d["heads"]


def parse_feed(raw, now):
    from google.transit import gtfs_realtime_pb2 as pb
    m = pb.FeedMessage()
    m.ParseFromString(raw)
    ts = m.header.timestamp
    if not ts:
        raise RuntimeError("feed has no timestamp")
    if now - ts > MAX_FEED_AGE:
        raise RuntimeError(f"feed stale by {now - ts}s")
    if m.header.incrementality == pb.FeedHeader.DIFFERENTIAL:
        raise RuntimeError("differential feed not supported")
    if len(m.entity) < MIN_ENTITIES_PER_FEED:
        raise RuntimeError("feed has too few entities")
    return m


def candidates(msg, now):
    """Yield (stop_id, when, route, destination_stop_id) for every usable future stop prediction."""
    for e in msg.entity:
        if not e.HasField("trip_update"):
            continue
        tu = e.trip_update
        if tu.trip.schedule_relationship in SKIP_TRIP:
            continue
        route = tu.trip.route_id
        if route.upper() in ("SI", "SS"):
            continue
        ups = list(tu.stop_time_update)
        if len(ups) < 2:      # a lone update is a terminal arrival or a stub
            continue
        dest = ups[-1].stop_id
        for s in ups[:-1]:    # the last stop is drop-off only, never a boarding point
            if s.schedule_relationship in SKIP_STOP:
                continue
            if not s.stop_id or s.stop_id[-1] not in "NS":
                continue
            when = 0
            if s.HasField("departure") and s.departure.time:
                when = s.departure.time
            elif s.HasField("arrival") and s.arrival.time:
                when = s.arrival.time
            if when < now - PAST_GRACE or when > now + MAX_HORIZON:
                continue
            yield s.stop_id, when, route, dest, tu.trip.trip_id


def compute(raws, stops, heads, now):
    best = {}
    oldest = None
    for name, raw in raws.items():
        msg = parse_feed(raw, now)
        oldest = msg.header.timestamp if oldest is None else min(oldest, msg.header.timestamp)
        for sid, when, route, dest, tid in candidates(msg, now):
            cur = best.get(sid)
            if cur is None or when < cur[0]:
                best[sid] = (when, route, dest, tid)
    if len(best) < MIN_DIRECTIONAL_STOPS:
        raise RuntimeError(f"only {len(best)} directional stops have predictions")
    ranked = []
    for sid, (when, route, dest, tid) in best.items():
        if sid not in stops or dest not in stops:
            log("unnamed stop skipped:", sid, dest)
            continue
        ranked.append((when, sid, route, dest, tid))
    ranked = [r for r in ranked if r[0] > now]      # a wait must still be ahead of us
    ranked.sort(key=lambda r: (-r[0], r[1]))        # longest first; stop_id breaks ties deterministically
    if len(ranked) < TOP_N:
        raise RuntimeError(f"only {len(ranked)} platforms with a future departure")
    for when, sid, route, dest, tid in ranked[:10]:
        hs = heads.get(tid, "?")
        flag = "" if hs in ("?", "") or hs.lower()[:6] == stops[dest].lower()[:6] else "  [headsign differs]"
        log(f"  {round((when - now) / 60):3d} min  {route:>2}  {stops[sid]} ({sid}) -> {stops[dest]}  headsign={hs}{flag}")
    top = [{"station": stops[sid], "destination": stops[dest], "route": route,
            "stop_id": sid, "departure_epoch": int(when)}
           for when, sid, route, dest, tid in ranked[:TOP_N]]
    return {
        "schema": 1,
        "generated_epoch": int(now),
        "oldest_feed_epoch": int(oldest),
        "feeds_checked": len(raws),
        "directional_stops_checked": len(best),
        "top": top,
        "winner": top[0],     # kept for older copies of the widget
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--cache-dir", default=".cache")
    ap.add_argument("--feed-dir", help="read feeds from <dir>/<name>.pb instead of the network (tests)")
    ap.add_argument("--stops-json", help="read {stops, heads} from a json file instead of the network (tests)")
    ap.add_argument("--now", type=int, help="override the clock (tests)")
    a = ap.parse_args()
    now = a.now or int(time.time())
    if a.stops_json:
        d = json.load(open(a.stops_json)); stops, heads = d["stops"], d["heads"]
    else:
        stops, heads = load_static(a.cache_dir)
    raws = {}
    for f in FEEDS:
        raws[f] = pathlib.Path(a.feed_dir, f + ".pb").read_bytes() if a.feed_dir else fetch(BASE + f)
    snap = compute(raws, stops, heads, now)
    pathlib.Path(a.out).write_text(json.dumps(snap, separators=(",", ":")))
    log("wrote", a.out, json.dumps(snap["top"]))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log("FAILED (no snapshot written):", e)
        sys.exit(1)
