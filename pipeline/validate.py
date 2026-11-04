"""Check web/data/*.json against docs/DATA_CONTRACT.md. Returns a list of violations (empty = ok)."""
from __future__ import annotations

import json
import re
from pathlib import Path

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
ISO2 = re.compile(r"^[A-Z]{2}$")
DETAIL_FILE = re.compile(r"^([A-Z]{2}|_global)\.json$")
CDC_URL = re.compile(r"^https://([a-z0-9-]+\.)*cdc\.gov\.tw/")
IATA = re.compile(r"^[A-Z]{3}$")
TS_ARR = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?[+-]\d{2}:\d{2}$")  # arrivals.json: seconds optional, offset mandatory
ARR_STATUS = ("arrived", "on_time", "early", "delayed", "changed", "cancelled", "other")


class V:
    def __init__(self):
        self.errors: list[str] = []

    def err(self, where: str, msg: str) -> None:
        if len(self.errors) < 200:
            self.errors.append(f"{where}: {msg}")

    def keys(self, where, obj, required, optional=()):
        if not isinstance(obj, dict):
            self.err(where, f"expected object, got {type(obj).__name__}")
            return False
        for k in required:
            if k not in obj:
                self.err(where, f"missing key {k!r}")
        for k in obj:
            if k not in required and k not in optional:
                self.err(where, f"unexpected key {k!r}")
        return True

    def typ(self, where, v, t, label=""):
        ok = isinstance(v, t) and not (t is int and isinstance(v, bool)) if t is not bool else isinstance(v, bool)
        if isinstance(t, tuple):
            ok = isinstance(v, t) and not isinstance(v, bool)
        if not ok:
            self.err(where, f"{label or 'value'} should be {getattr(t, '__name__', t)}, got {type(v).__name__} ({str(v)[:40]!r})")
        return ok

    def pat(self, where, v, rx, label):
        if not isinstance(v, str) or not rx.match(v):
            self.err(where, f"{label} {str(v)[:40]!r} has the wrong format")


def check_meta(v: V, m):
    w = "meta.json"
    if not v.keys(w, m, ["generated_at", "model", "sources", "counts"]):
        return
    v.pat(w, m["generated_at"], TS, "generated_at")
    v.typ(w, m["model"], str, "model")
    s = m["sources"]
    if v.keys(w + ".sources", s, ["alerts", "epidemics", "flights"]):
        for k in ("alerts", "epidemics"):
            if v.keys(f"{w}.sources.{k}", s[k], ["url", "fetched_at", "rows"]):
                v.typ(w, s[k]["url"], str, f"{k}.url")
                v.pat(w, s[k]["fetched_at"], TS, f"{k}.fetched_at")
                v.typ(w, s[k]["rows"], int, f"{k}.rows")
        f = s["flights"]
        if v.keys(w + ".sources.flights", f, ["url", "fetched_at", "date", "ok"], ["reason"]):
            v.typ(w, f["url"], str, "flights.url")
            v.pat(w, f["fetched_at"], TS, "flights.fetched_at")
            v.pat(w, f["date"], DATE, "flights.date")
            v.typ(w, f["ok"], bool, "flights.ok")
            if f["ok"] is False and not f.get("reason"):
                v.err(w, "flights.ok=false requires a reason")
    c = m["counts"]
    keys = ["countries_with_alerts", "level3", "level2", "level1", "epidemic_items", "ai_translated"]
    if v.keys(w + ".counts", c, keys):
        for k in keys:
            v.typ(w, c[k], int, k)


def _alert_items(v, where, alerts, diseases):
    last = None
    for i, a in enumerate(alerts):
        w = f"{where}.alerts[{i}]"
        if not v.keys(w, a, ["disease", "level", "effective", "area_zh", "area_en", "iso_sub"], ["global"]):
            continue
        v.typ(w, a["level"], int, "level")
        if a["level"] not in (1, 2, 3):
            v.err(w, f"level {a['level']} not in 1..3")
        v.pat(w, a["effective"], DATE, "effective")
        for k in ("disease", "area_zh", "area_en", "iso_sub"):
            v.typ(w, a[k], str, k)
        if a["disease"] not in diseases:
            v.err(w, f"disease {a['disease']!r} missing from diseases")
        if "global" in a and a["global"] is not True:
            v.err(w, "global, when present, must be true")
        key = (-a["level"], "".join(chr(0x10FFFF - ord(c)) for c in a["effective"])) if isinstance(a["level"], int) and isinstance(a["effective"], str) else None
        if key and last and key < last:
            v.err(w, "alerts not sorted by level desc, effective desc")
        last = key or last


def check_alerts(v: V, a):
    w = "alerts.json"
    if not v.keys(w, a, ["generated_at", "levels", "diseases", "global", "countries", "unmapped"]):
        return
    v.pat(w, a["generated_at"], TS, "generated_at")
    if v.keys(w + ".levels", a["levels"], ["1", "2", "3"]):
        for k, lv in a["levels"].items():
            if v.keys(f"{w}.levels.{k}", lv, ["zh", "en", "instruction_zh", "instruction_en"]):
                for f in lv.values():
                    v.typ(w, f, str, "level text")
    dis = a["diseases"]
    if isinstance(dis, dict):
        for k, d in dis.items():
            if v.keys(f"{w}.diseases.{k}", d, ["zh", "en"]):
                v.typ(w, d["zh"], str, "zh")
                v.typ(w, d["en"], str, "en")
                if not d["en"]:
                    v.err(w, f"disease {k!r} has empty en")
    else:
        v.err(w, "diseases must be an object")
        dis = {}
    gl = a["global"]
    gkeys = set()
    if isinstance(gl, list):
        for i, g in enumerate(gl):
            if v.keys(f"{w}.global[{i}]", g, ["disease", "level", "effective", "countries"], ["applied_to_all"]):
                v.typ(w, g["level"], int, "global.level")
                v.pat(w, g["effective"], DATE, "global.effective")
                v.typ(w, g["countries"], int, "global.countries")
                if g["disease"] not in dis:
                    v.err(w, f"global disease {g['disease']!r} missing from diseases")
                gkeys.add((g["disease"], g["level"]))
    else:
        v.err(w, "global must be a list")
    cs = a["countries"]
    if not isinstance(cs, dict):
        v.err(w, "countries must be an object")
        cs = {}
    for iso, c in cs.items():
        cw = f"{w}.countries.{iso}"
        if not ISO2.match(iso):
            v.err(cw, "key is not an upper-case ISO alpha-2")
        if not v.keys(cw, c, ["name_zh", "name_en", "max_level", "alerts"]):
            continue
        v.typ(cw, c["name_zh"], str, "name_zh")
        v.typ(cw, c["name_en"], str, "name_en")
        if not c["name_zh"] or not c["name_en"]:
            v.err(cw, "empty country name")
        if not isinstance(c["alerts"], list) or not c["alerts"]:
            v.err(cw, "alerts must be a non-empty list")
            continue
        _alert_items(v, cw, c["alerts"], dis)
        lv = [x.get("level") for x in c["alerts"] if isinstance(x, dict)]
        if lv and c["max_level"] != max(lv):
            v.err(cw, f"max_level {c['max_level']} != max of alerts {max(lv)}")
        for x in c["alerts"]:
            if isinstance(x, dict) and (x.get("disease"), x.get("level")) in gkeys and not x.get("global"):
                v.err(cw, f"global advisory {x.get('disease')!r} must carry global: true")
    um = a["unmapped"]
    if isinstance(um, list):
        for i, c in enumerate(um):
            cw = f"{w}.unmapped[{i}]"
            if v.keys(cw, c, ["name_zh", "name_en", "max_level", "alerts"]):
                _alert_items(v, cw, c["alerts"], dis)
    else:
        v.err(w, "unmapped must be a list")


def check_epidemics(v: V, e, alerts):
    w = "epidemics.json"
    if not v.keys(w, e, ["generated_at", "window_start", "details_dir", "items", "overviews"]):
        return
    v.pat(w, e["generated_at"], TS, "generated_at")
    if e["details_dir"] != "epidemics/":
        v.err(w, f"details_dir must be 'epidemics/', got {e['details_dir']!r}")
    v.pat(w, e["window_start"], DATE, "window_start")
    items = e["items"]
    if not isinstance(items, list):
        v.err(w, "items must be a list")
        return
    ids, last = set(), None
    per_country: dict[str, int] = {}
    dis = (alerts or {}).get("diseases", {}) if isinstance(alerts, dict) else {}
    req = ["id", "date", "disease_zh", "disease_en", "headline_zh", "headline_en", "summary_zh", "summary_en",
           "countries", "area_zh", "area_en", "url", "ai", "has_full"]
    for i, it in enumerate(items):
        iw = f"{w}.items[{i}]"
        if not v.keys(iw, it, req, ["global"]) or any(k not in it for k in req):
            continue
        for k in req:
            if k in ("countries", "ai", "has_full"):
                continue
            v.typ(iw, it[k], str, k)
        v.typ(iw, it["ai"], bool, "ai")
        v.typ(iw, it["has_full"], bool, "has_full")
        if isinstance(it["url"], str) and it["url"] and not CDC_URL.match(it["url"]):
            v.err(iw, f"url must be https on cdc.gov.tw: {it['url'][:60]!r}")
        v.pat(iw, it["date"], DATE, "date")
        if not it["id"] or it["id"] in ids:
            v.err(iw, f"id {it['id']!r} empty or duplicated")
        ids.add(it["id"])
        if isinstance(it["date"], str):
            if last is not None and it["date"] > last:
                v.err(iw, "items not sorted by date desc")
            last = it["date"]
            if isinstance(e["window_start"], str) and it["date"] < e["window_start"]:
                v.err(iw, f"date {it['date']} is before window_start")
        if not it["headline_en"] or not it["summary_zh"] or not it["summary_en"]:
            v.err(iw, "empty headline/summary")
        if not isinstance(it["countries"], list) or not all(isinstance(c, str) and ISO2.match(c) for c in it["countries"]):
            v.err(iw, f"countries must be a list of upper-case alpha-2: {it['countries']!r}")
        else:
            if it.get("global") and it["countries"]:
                v.err(iw, "global item must have empty countries")
            for c in set(it["countries"]):
                per_country[c] = per_country.get(c, 0) + 1
        if "global" in it and it["global"] is not True:
            v.err(iw, "global, when present, must be true")
        if dis:
            from .common import split_diseases
            for d in split_diseases(it["disease_zh"]):
                if d not in dis:
                    v.err(iw, f"disease {d!r} missing from alerts.diseases")
                    break
    ov = e["overviews"]
    if not isinstance(ov, dict):
        v.err(w, "overviews must be an object")
        return
    for iso, o in ov.items():
        ow = f"{w}.overviews.{iso}"
        if not ISO2.match(iso):
            v.err(ow, "key is not an upper-case ISO alpha-2")
        if v.keys(ow, o, ["zh", "en", "items", "updated"], ["ai"]):
            v.typ(ow, o["zh"], str, "zh")
            v.typ(ow, o["en"], str, "en")
            v.typ(ow, o["items"], int, "items")
            v.pat(ow, o["updated"], DATE, "updated")
            if not o["zh"] or not o["en"]:
                v.err(ow, "empty overview text")
            if per_country.get(iso, 0) != o["items"]:
                v.err(ow, f"items={o['items']} but {per_country.get(iso, 0)} items reference this country")
    for iso in per_country:
        if iso not in ov:
            v.err(w, f"country {iso} has items but no overview")


def check_epidemic_details(v: V, d: Path, e):
    """epidemics/<KEY>.json files must agree with epidemics.json (ids, has_full, per-country placement)."""
    w = "epidemics/"
    items = e.get("items") if isinstance(e, dict) else None
    if not isinstance(items, list):
        return
    if not d.is_dir():
        if items:
            v.err(w, "directory is missing")
        return
    files: dict[str, dict] = {}
    for p in sorted(d.iterdir()):
        if not p.is_file() or not DETAIL_FILE.match(p.name):
            v.err(w + p.name, "file name must match <ISO2>.json or _global.json")
            continue
        try:
            body = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError) as ex:
            v.err(w + p.name, f"cannot read/parse: {ex}")
            continue
        if not isinstance(body, dict):
            v.err(w + p.name, "expected object")
            continue
        files[p.stem] = body
        for iid, val in body.items():
            if v.keys(f"{w}{p.name}.{iid}", val, ["zh", "en"]):
                v.typ(f"{w}{p.name}", val["zh"], str, f"{iid}.zh")
                v.typ(f"{w}{p.name}", val["en"], str, f"{iid}.en")
    ids = {it.get("id") for it in items if isinstance(it, dict)}
    for key, body in files.items():
        for iid in body:
            if iid not in ids:
                v.err(f"{w}{key}.json", f"id {iid!r} is not in epidemics.json items")
    for it in items:
        if not isinstance(it, dict) or it.get("has_full") is not True or not isinstance(it.get("countries"), list):
            continue
        for key in (it["countries"] or ["_global"]):
            if it.get("id") not in files.get(key, {}):
                v.err(f"{w}{key}.json", f"missing full text for item {it.get('id')!r}")


def check_flights(v: V, f):
    w = "flights.json"
    if not v.keys(w, f, ["date", "fetched_at", "source", "hub", "routes", "totals"]):
        return
    v.pat(w, f["date"], DATE, "date")
    v.pat(w, f["fetched_at"], TS, "fetched_at")
    v.typ(w, f["source"], str, "source")
    if v.keys(w + ".hub", f["hub"], ["iata", "name_en", "name_zh", "lat", "lon"]):
        h = f["hub"]
        if h["iata"] != "TPE":
            v.err(w, "hub.iata must be TPE")
        v.typ(w, h["lat"], (int, float), "hub.lat")
        v.typ(w, h["lon"], (int, float), "hub.lon")
    routes = f["routes"]
    if not isinstance(routes, list):
        v.err(w, "routes must be a list")
        return
    seen, dep, arr = set(), 0, 0
    for i, r in enumerate(routes):
        rw = f"{w}.routes[{i}]"
        if not v.keys(rw, r, ["iata", "city_en", "city_zh", "country", "lat", "lon", "departures", "arrivals", "airlines"]):
            continue
        v.pat(rw, r["iata"], IATA, "iata")
        if r["iata"] in seen:
            v.err(rw, f"duplicate iata {r['iata']}")
        seen.add(r["iata"])
        for k in ("city_en", "city_zh", "country"):
            v.typ(rw, r[k], str, k)
        if isinstance(r["country"], str) and r["country"] and not ISO2.match(r["country"]):
            v.err(rw, f"country {r['country']!r} is not alpha-2")
        v.typ(rw, r["lat"], (int, float), "lat")
        v.typ(rw, r["lon"], (int, float), "lon")
        if isinstance(r["lat"], (int, float)) and not -90 <= r["lat"] <= 90:
            v.err(rw, "lat out of range")
        if isinstance(r["lon"], (int, float)) and not -180 <= r["lon"] <= 180:
            v.err(rw, "lon out of range")
        for k in ("departures", "arrivals"):
            if v.typ(rw, r[k], int, k) and r[k] < 0:
                v.err(rw, f"negative {k}")
        if not isinstance(r["airlines"], list) or not all(isinstance(x, str) for x in r["airlines"]):
            v.err(rw, "airlines must be a list of strings")
        if isinstance(r["departures"], int) and isinstance(r["arrivals"], int):
            dep += r["departures"]
            arr += r["arrivals"]
    t = f["totals"]
    if v.keys(w + ".totals", t, ["departures", "arrivals", "destinations"], ["unmatched"]):
        if t["departures"] != dep or t["arrivals"] != arr or t["destinations"] != len(routes):
            v.err(w, f"totals {t} do not match routes ({dep}/{arr}/{len(routes)})")


def _ts(v, where=None):
    """datetime of an arrivals.json time string, or None when malformed."""
    from datetime import datetime
    if not isinstance(v, str) or not TS_ARR.match(v):
        return None
    try:
        return datetime.fromisoformat(v)
    except ValueError:
        return None


def check_arrivals(v: V, a):
    w = "arrivals.json"
    top = ["generated_at", "source", "endpoint", "tdx_updated", "window", "refresh_minutes", "quota", "airports", "flights"]
    if not v.keys(w, a, top) or any(k not in a for k in top):
        return
    v.pat(w, a["generated_at"], TS_ARR, "generated_at")
    if a["tdx_updated"] is not None:
        v.pat(w, a["tdx_updated"], TS_ARR, "tdx_updated")
    if a["source"] not in ("tdx", "tdx-anon"):
        v.err(w, f"source {a['source']!r} not in tdx | tdx-anon")
    v.typ(w, a["endpoint"], str, "endpoint")
    win = a["window"]
    if v.keys(w + ".window", win, ["from", "to"]):
        v.pat(w, win["from"], TS_ARR, "window.from")
        v.pat(w, win["to"], TS_ARR, "window.to")
        if _ts(win["from"]) and _ts(win["to"]) and _ts(win["from"]) >= _ts(win["to"]):
            v.err(w, "window.from must be before window.to")
    if v.keys(w + ".refresh_minutes", a["refresh_minutes"], ["day", "night"]):
        for k in ("day", "night"):
            if v.typ(w, a["refresh_minutes"][k], int, f"refresh_minutes.{k}") and a["refresh_minutes"][k] <= 0:
                v.err(w, f"refresh_minutes.{k} must be positive")
    q = a["quota"]
    if v.keys(w + ".quota", q, ["month", "calls_month", "cap_month", "day", "calls_day"]):
        v.pat(w, q["month"], re.compile(r"^\d{4}-\d{2}$"), "quota.month")
        v.pat(w, q["day"], DATE, "quota.day")
        ok = [v.typ(w, q[k], int, f"quota.{k}") for k in ("calls_month", "cap_month", "calls_day")]
        if all(ok):
            if min(q["calls_month"], q["cap_month"], q["calls_day"]) < 0:
                v.err(w, "quota counters must not be negative")
            if q["calls_day"] > q["calls_month"]:
                v.err(w, "quota.calls_day exceeds quota.calls_month")
        if isinstance(q["day"], str) and isinstance(q["month"], str) and not q["day"].startswith(q["month"]):
            v.err(w, "quota.day is not inside quota.month")
    airports = a["airports"]
    if not isinstance(airports, dict):
        v.err(w, "airports must be an object")
        airports = {}
    counts: dict[str, int] = {}
    for iata, ap in airports.items():
        aw = f"{w}.airports.{iata}"
        if not IATA.match(iata):
            v.err(aw, "key is not an IATA code")
        if not v.keys(aw, ap, ["name_zh", "name_en", "lat", "lon", "flights", "checkpoints"]):
            continue
        for k in ("name_zh", "name_en"):
            if v.typ(aw, ap[k], str, k) and not ap[k]:
                v.err(aw, f"empty {k}")
        for k in ("lat", "lon"):
            if ap[k] is not None:
                v.typ(aw, ap[k], (int, float), k)
        if v.typ(aw, ap["flights"], int, "flights") and ap["flights"] < 0:
            v.err(aw, "negative flights")
        cps = ap["checkpoints"]
        if not isinstance(cps, list):
            v.err(aw, "checkpoints must be a list")
        else:
            for j, c in enumerate(cps):
                if v.keys(f"{aw}.checkpoints[{j}]", c, ["id", "terminal"]):
                    if c["id"] not in ("A", "B", "C", "D"):
                        v.err(aw, f"checkpoint id {c['id']!r} not in A-D")
                    v.typ(aw, c["terminal"], str, "checkpoint terminal")
    fl = a["flights"]
    if not isinstance(fl, list):
        v.err(w, "flights must be a list")
        return
    req = ["id", "airport", "flight", "airline", "codeshares", "from", "from_zh", "from_en", "country", "lat", "lon",
           "terminal", "gate", "checkpoint", "apron", "scheduled", "estimated", "actual", "status", "status_zh",
           "status_en", "aircraft"]
    ids, last = set(), None
    for i, f in enumerate(fl):
        fw = f"{w}.flights[{i}]"
        if not v.keys(fw, f, req, ["carousel"]) or any(k not in f for k in req):
            continue
        if "carousel" in f and not (isinstance(f["carousel"], str) and re.fullmatch(r"[0-9A-Z-]{0,4}", f["carousel"])):
            v.err(fw, f"carousel {str(f['carousel'])[:12]!r}: short code like '04' or ''")
        for k in ("id", "airport", "flight", "airline", "from", "from_zh", "from_en", "country", "terminal", "gate",
                  "apron", "status_zh", "status_en", "aircraft"):
            v.typ(fw, f[k], str, k)
        if not isinstance(f["codeshares"], list) or not all(isinstance(x, str) for x in f["codeshares"]):
            v.err(fw, "codeshares must be a list of strings")
        elif f["codeshares"] != sorted(f["codeshares"]):
            v.err(fw, "codeshares not sorted")
        if f["id"] in ids:
            v.err(fw, f"duplicate id {f['id']!r}")
        ids.add(f["id"])
        if f["airport"] not in airports:
            v.err(fw, f"airport {f['airport']!r} missing from airports")
        else:
            counts[f["airport"]] = counts.get(f["airport"], 0) + 1
        v.pat(fw, f["from"], IATA, "from")
        if not f["flight"]:
            v.err(fw, "empty flight")
        if isinstance(f["country"], str) and f["country"] and not ISO2.match(f["country"]):
            v.err(fw, f"country {f['country']!r} is not alpha-2")
        if f["country"] == "TW":
            v.err(fw, "domestic origin (country TW) must not be listed")
        for k, lim in (("lat", 90), ("lon", 180)):
            if f[k] is not None and v.typ(fw, f[k], (int, float), k) and not -lim <= f[k] <= lim:
                v.err(fw, f"{k} out of range")
        if f["checkpoint"] is not None and f["checkpoint"] not in ("A", "B", "C", "D"):
            v.err(fw, f"checkpoint {f['checkpoint']!r} not in A-D | null")
        if f["status"] not in ARR_STATUS:
            v.err(fw, f"status {f['status']!r} not in {'|'.join(ARR_STATUS)}")
        v.pat(fw, f["scheduled"], TS_ARR, "scheduled")
        for k in ("estimated", "actual"):
            if f[k] is not None:
                v.pat(fw, f[k], TS_ARR, k)
        best = _ts(f["scheduled"]) if f["status"] == "cancelled" else (_ts(f["actual"]) or _ts(f["estimated"]) or _ts(f["scheduled"]))
        if best is None:
            continue
        if last is not None and best < last:
            v.err(fw, "flights not sorted by best time ascending")
        last = best
        lo, hi = _ts(win.get("from")) if isinstance(win, dict) else None, _ts(win.get("to")) if isinstance(win, dict) else None
        if lo and hi and not lo <= best <= hi:
            v.err(fw, "best time is outside window")
    for iata, ap in airports.items():
        if isinstance(ap, dict) and ap.get("flights") != counts.get(iata, 0):
            v.err(f"{w}.airports.{iata}", f"flights={ap.get('flights')} but {counts.get(iata, 0)} listed")


def check_watch(v: V, w):
    """web/data/watch.json (outbreak route watch), optional."""
    if not v.keys("watch.json", w, ["sets"]):
        return
    if not isinstance(w["sets"], list):
        v.err("watch.json", "sets should be a list")
        return
    for i, s in enumerate(w["sets"]):
        where = f"watch.json.sets[{i}]"
        if not v.keys(where, s, ["id", "hub", "routes", "totals", "as_of", "title_zh", "title_en", "reason_zh", "reason_en",
                                  "source_zh", "source_en", "hub_zh", "hub_en"], ["source_url"]):
            continue
        if "source_url" in s and not str(s["source_url"]).startswith("https://"):
            v.err(where, "source_url must be an https:// URL")
        h = s["hub"]
        if v.keys(where + ".hub", h, ["iata", "country", "lat", "lon"]):
            v.pat(where + ".hub", h["iata"], IATA, "iata")
            v.typ(where + ".hub", h["lat"], (int, float), "lat")
            v.typ(where + ".hub", h["lon"], (int, float), "lon")
        routes = s["routes"] if isinstance(s["routes"], list) else []
        for j, r in enumerate(routes):
            rw = f"{where}.routes[{j}]"
            if not v.keys(rw, r, ["iata", "city_en", "city_zh", "country", "lat", "lon", "monthly"], ["note_zh", "note_en"]):
                continue
            v.pat(rw, r["iata"], IATA, "iata")
            if r["country"]:
                v.pat(rw, r["country"], ISO2, "country")
            v.typ(rw, r["lat"], (int, float), "lat")
            v.typ(rw, r["lon"], (int, float), "lon")
            v.typ(rw, r["monthly"], int, "monthly")
        t = s["totals"]
        if isinstance(t, dict) and (t.get("destinations") != len(routes)
                                    or t.get("monthly") != sum(r.get("monthly", 0) for r in routes if isinstance(r, dict))):
            v.err(where, "totals do not match routes")


WEATHER_ICONS = {"sun", "partly", "cloud", "overcast", "rain", "showers", "thunder", "snow", "sleet", "fog"}


def check_weather(v: V, w):
    """web/data/weather.json (CWA world-city forecast, docs/DATA_CONTRACT.md#weatherjson), optional."""
    if not v.keys("weather.json", w, ["generated_at", "source", "regions", "days", "cities", "unmapped"]):
        return
    v.pat("weather.json", w["generated_at"], TS, "generated_at")
    if v.keys("weather.json.source", w["source"], ["dataset", "url", "issued", "fetched_at", "ok"]):
        if not str(w["source"]["url"]).startswith("https://opendata.cwa.gov.tw/"):
            v.err("weather.json.source", "url must point to opendata.cwa.gov.tw")
    region_ids = set()
    for i, r in enumerate(w["regions"] or []):
        if v.keys(f"weather.json.regions[{i}]", r, ["id", "zh", "en"]):
            region_ids.add(r["id"])
    for d in w["days"] or []:
        v.pat("weather.json.days", d, DATE, "day")
    if not isinstance(w["cities"], list) or not w["cities"]:
        v.err("weather.json.cities", "expected a non-empty list")
        return
    for i, c in enumerate(w["cities"]):
        where = f"weather.json.cities[{i}]"
        if not v.keys(where, c, ["id", "name_zh", "name_en", "iso", "region", "lat", "lon", "days"]):
            continue
        if not c["name_zh"]:
            v.err(where, "empty name_zh")
        if c["iso"] is not None:
            v.pat(where, c["iso"], ISO2, "iso")
        if c["region"] not in region_ids:
            v.err(where, f"unknown region {c['region']!r}")
        for j, d in enumerate(c["days"] or []):
            dw = f"{where}.days[{j}]"
            if not v.keys(dw, d, ["date", "wx_zh", "wx_en", "code", "icon", "max", "min"]):
                continue
            v.pat(dw, d["date"], DATE, "date")
            if d["icon"] not in WEATHER_ICONS:
                v.err(dw, f"unknown icon {d['icon']!r}")
            for k in ("max", "min"):
                if d[k] is not None and (not isinstance(d[k], int) or isinstance(d[k], bool) or not -90 <= d[k] <= 60):
                    v.err(dw, f"{k} must be an int in -90..60 or null")
            if isinstance(d["max"], int) and isinstance(d["min"], int) and d["max"] < d["min"]:
                v.err(dw, "max below min")


def check_warnings(v: V, w):
    """web/data/warnings.json (MOFA/MAC travel warnings, docs/WARNINGS.md), optional."""
    if not v.keys("warnings.json", w, ["generated_at", "sources", "levels", "regions", "countries", "unmapped", "changes"]):
        return
    lv_ok = lambda x: x is None or (isinstance(x, int) and not isinstance(x, bool) and 0 <= x <= 4)
    for iso, c in (w["countries"] or {}).items():
        where = f"warnings.json.countries.{iso}"
        v.pat(where, iso, ISO2, "country key")
        if not v.keys(where, c, ["source", "region", "name_zh", "name_en", "level", "max_level", "date", "id", "url",
                                 "summary_zh", "areas"], ["confirmed", "summary_en"]):
            continue
        if c["source"] not in ("mofa", "mac"):
            v.err(where, f"source {c['source']!r}")
        if not lv_ok(c["level"]) or not lv_ok(c["max_level"]):
            v.err(where, f"level {c['level']!r} / max_level {c['max_level']!r} out of range")
        elif c["level"] is not None and c["max_level"] is not None and c["level"] > c["max_level"]:
            v.err(where, "level above max_level")
        if c["url"] and not re.match(r"^https://www\.(boca|mac)\.gov\.tw/", c["url"]):
            v.err(where, "url must point to boca.gov.tw or mac.gov.tw")
        for j, a in enumerate(c["areas"] if isinstance(c["areas"], list) else []):
            aw = f"{where}.areas[{j}]"
            if v.keys(aw, a, ["area_zh", "area_en", "level", "date", "id", "url", "summary_zh"], ["summary_en"]) and not lv_ok(a["level"]):
                v.err(aw, f"level {a['level']!r} out of range")
    ch = w["changes"]
    if v.keys("warnings.json.changes", ch, ["mofa", "cdc"]):
        for k in ("mofa", "cdc"):
            for j, x in enumerate(ch[k] if isinstance(ch[k], list) else []):
                if not (isinstance(x, dict) and DATE.match(str(x.get("date", ""))) and lv_ok(x.get("from")) and lv_ok(x.get("to"))):
                    v.err(f"warnings.json.changes.{k}[{j}]", "bad change entry")


def check_epidemics_recent(v: V, doc, epid) -> None:
    """epidemics-recent.json: a recent slice of epidemics.json (same items, dates on or after `since`)."""
    w = "epidemics-recent.json"
    if not v.keys(w, doc, ["generated_at", "days", "since", "details_dir", "items"]):
        return
    v.pat(w, doc["since"], DATE, "since")
    if not isinstance(doc["items"], list):
        v.err(w, "items must be a list")
        return
    full = {it.get("id"): it for it in (epid or {}).get("items", []) if isinstance(it, dict)} if isinstance(epid, dict) else {}
    for i, it in enumerate(doc["items"]):
        iw = f"{w}.items[{i}]"
        if not isinstance(it, dict):
            v.err(iw, "expected object")
            continue
        if full and full.get(it.get("id")) != it:
            v.err(iw, f"id {str(it.get('id'))[:24]!r} differs from (or is missing in) epidemics.json")
        if str(it.get("date", "")) < str(doc["since"]):
            v.err(iw, f"date {it.get('date')!r} is before since {doc['since']!r}")


def check_places(v: V, doc) -> None:
    """web/data/places.json: [{code: IATA or "", iso, zh, en, alias?: [names]}] for the search boxes."""
    w = "places.json"
    if not v.keys(w, doc, ["version", "generated_at", "places"]) or not isinstance(doc.get("places"), list):
        v.err(w, "places must be a list")
        return
    for i, p in enumerate(doc["places"]):
        pw = f"{w}.places[{i}]"
        if not v.keys(pw, p, ["code", "iso", "zh", "en"], ["alias"]) or any(k not in p for k in ("code", "iso", "zh", "en")):
            continue
        al = p.get("alias", [])
        if not (isinstance(al, list) and len(al) <= 24 and all(isinstance(a, str) and 0 < len(a.strip()) <= 40 for a in al)):
            v.err(pw, "alias must be a list of up to 24 non-empty names")
        elif any(re.search(r"<\s*/?\s*[a-zA-Z]", a) for a in al):
            v.err(pw, "alias looks like HTML")
        if not (p["code"] == "" or re.fullmatch(r"[A-Z]{3}", str(p["code"]))):
            v.err(pw, f"code {str(p['code'])[:8]!r} must be an IATA code or ''")
        if not ISO2.match(str(p["iso"])):
            v.err(pw, f"iso {str(p['iso'])[:8]!r}")
        if not (isinstance(p["zh"], str) and p["zh"].strip()) or not isinstance(p["en"], str):
            v.err(pw, "zh must be a non-empty string, en a string")
        elif re.search(r"<\s*/?\s*[a-zA-Z]", p["zh"] + p["en"]):
            v.err(pw, "looks like HTML")


def validate_dir(d: Path) -> list[str]:
    d = Path(d)
    v = V()
    data = {}
    for name in ("meta", "alerts", "epidemics", "flights"):
        p = d / f"{name}.json"
        try:
            data[name] = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            v.err(p.name, f"cannot read/parse: {e}")
    if "meta" in data:
        check_meta(v, data["meta"])
    if "alerts" in data:
        check_alerts(v, data["alerts"])
    if "epidemics" in data:
        check_epidemics(v, data["epidemics"], data.get("alerts"))
    if "flights" in data:
        check_flights(v, data["flights"])
    wn = d / "warnings.json"
    if wn.exists():
        try:
            check_warnings(v, json.loads(wn.read_text(encoding="utf-8")))
        except ValueError as e:
            v.err("warnings.json", f"cannot parse: {e}")
    ww = d / "weather.json"
    if ww.exists():
        try:
            check_weather(v, json.loads(ww.read_text(encoding="utf-8")))
        except json.JSONDecodeError as e:
            v.err("weather.json", f"cannot parse: {e}")
    er = d / "epidemics-recent.json"
    if er.exists():
        try:
            check_epidemics_recent(v, json.loads(er.read_text(encoding="utf-8")), data.get("epidemics"))
        except ValueError as e:
            v.err("epidemics-recent.json", f"cannot parse: {e}")
    pl = d / "places.json"
    if pl.exists():
        try:
            check_places(v, json.loads(pl.read_text(encoding="utf-8")))
        except ValueError as e:
            v.err("places.json", f"cannot parse: {e}")
    wp = d / "watch.json"
    if wp.exists():
        try:
            check_watch(v, json.loads(wp.read_text(encoding="utf-8")))
        except ValueError as e:
            v.err("watch.json", f"cannot parse: {e}")
    if "epidemics" in data:
        check_epidemic_details(v, d / "epidemics", data["epidemics"])
    if {"meta", "alerts", "epidemics"} <= set(data) and isinstance(data["meta"], dict):
        c = data["meta"].get("counts", {})
        if isinstance(c, dict) and isinstance(data["alerts"], dict):
            if c.get("countries_with_alerts") != len(data["alerts"].get("countries", {})):
                v.err("meta.json", "counts.countries_with_alerts does not match alerts.json")
            if c.get("epidemic_items") != len(data["epidemics"].get("items", [])):
                v.err("meta.json", "counts.epidemic_items does not match epidemics.json")
    p = d / "arrivals.json"  # optional: published by arrivals.yml, never committed
    if p.exists():
        try:
            check_arrivals(v, json.loads(p.read_text(encoding="utf-8")))
        except (OSError, ValueError) as e:
            v.err(p.name, f"cannot read/parse: {e}")
    return v.errors


# ---------------------------------------------------------------- web/slides/slides.json (slide.html, docs/SLIDES.md)
SLIDE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$", re.I)
SLIDE_ASSET = re.compile(r"^slides/assets/[A-Za-z0-9._-]+\.(png|webp|jpe?g|svg|gif|avif)$")
SLIDE_HTML = re.compile(r"<\s*/?\s*[a-zA-Z]")
SLIDE_BASE = {"id", "template", "active", "lang", "from", "until", "duration", "alt"}
# template -> (required fields, optional fields)
SLIDE_FIELDS = {
    "alert": ({"kicker", "disease", "country", "rule"},
              {"category", "region_label", "country_en", "iso", "status", "ask", "note", "routes", "route_labels"}),
    "symptoms": ({"title", "symptoms", "steps"}, {"subtitle", "intro", "mascot"}),
    "report": ({"headline", "symptoms", "cta"}, {"tail", "condition", "sign"}),
    "germs": ({"headline", "message"}, {"art"}),
    "image": ({"src", "alt"}, {"brand", "src_landscape"}),
}
REPORT_ICONS = ("fever", "cough", "breath", "unwell")


def _slide_text(v: V, where: str, x, required: bool = True) -> None:
    """Plain string, or highlight segments [{"t": "...", "hl": true}] — never HTML."""
    if isinstance(x, str):
        if required and not x.strip():
            v.err(where, "empty text")
        if SLIDE_HTML.search(x):
            v.err(where, "looks like HTML; text is shown literally (use segments {t, hl} for highlights)")
        return
    if isinstance(x, list) and x:
        for j, seg in enumerate(x):
            sw = f"{where}[{j}]"
            if not isinstance(seg, dict) or not isinstance(seg.get("t"), str):
                v.err(sw, 'segment must be {"t": "text"} or {"t": "text", "hl": true}')
                continue
            for k in seg:
                if k not in ("t", "hl"):
                    v.err(sw, f"unexpected segment key {k!r}")
            if "hl" in seg and not isinstance(seg["hl"], bool):
                v.err(sw, "hl must be true/false")
            if SLIDE_HTML.search(seg["t"]):
                v.err(sw, "looks like HTML; text is shown literally")
        return
    v.err(where, "expected a string or a non-empty list of segments")


def _slide_bi(v: V, where: str, x) -> None:
    """{"zh": text, "en": text}."""
    if v.keys(where, x, ["zh", "en"]):
        _slide_text(v, f"{where}.zh", x["zh"])
        _slide_text(v, f"{where}.en", x["en"])


def _slide_asset(v: V, where: str, p, web: Path) -> None:
    if not isinstance(p, str) or not SLIDE_ASSET.match(p) or ".." in p:
        v.err(where, f"{str(p)[:60]!r}: must be slides/assets/<file>.(png|webp|jpg|svg|gif|avif)")
    elif not (web / p).is_file():
        v.err(where, f"{p} does not exist under web/")


def _slide_routes(v: V, where: str, routes, web: Path) -> None:
    """[["FIH", "CDG", "TPE"], ...]: 1-3 routes of 2-4 IATA codes listed in web/slides/airports.json."""
    try:
        known = {k for k in json.loads((web / "slides" / "airports.json").read_text(encoding="utf-8")) if not k.startswith("_")}
    except (OSError, ValueError) as e:
        v.err(where, f"cannot read slides/airports.json: {e}")
        return
    if not isinstance(routes, list) or not 1 <= len(routes) <= 3:
        v.err(where, "1-3 routes, each a list of airport codes")
        return
    for i, r in enumerate(routes):
        if not isinstance(r, list) or not 2 <= len(r) <= 4:
            v.err(f"{where}[{i}]", "2-4 airport codes, origin first")
            continue
        for c in r:
            if c not in known:
                v.err(f"{where}[{i}]", f"{str(c)[:8]!r} is not in web/slides/airports.json (add it there)")


def _slide_date(v: V, where: str, s) -> str | None:
    import datetime as _dt
    if not isinstance(s, str) or not DATE.match(s):
        v.err(where, f"{str(s)[:20]!r} must be YYYY-MM-DD (Asia/Taipei)")
        return None
    try:
        _dt.date.fromisoformat(s)
    except ValueError:
        v.err(where, f"{s} is not a calendar date")
        return None
    return s


def check_slides(v: V, m, web: Path) -> None:
    w = "slides.json"
    if not v.keys(w, m, ["version", "slides"], ["interval", "brand"]):
        return
    if m["version"] != 1:
        v.err(w, "version must be 1")
    if "interval" in m and not (isinstance(m["interval"], int) and not isinstance(m["interval"], bool) and 3 <= m["interval"] <= 60):
        v.err(w, "interval must be an integer 3..60 (seconds)")
    b = m.get("brand")
    if b is not None and v.keys(f"{w}.brand", b, [], ["logo", "org_zh", "org_en", "hotline_zh", "hotline_en", "hotline", "url"]):
        for k in ("org_zh", "org_en", "hotline_zh", "hotline_en", "hotline"):
            if k in b:
                _slide_text(v, f"{w}.brand.{k}", b[k])
        if "logo" in b:
            _slide_asset(v, f"{w}.brand.logo", b["logo"], web)
        if "url" in b and not (isinstance(b["url"], str) and CDC_URL.match(b["url"])):
            v.err(f"{w}.brand.url", "only https links on cdc.gov.tw are allowed")
    slides = m["slides"]
    if not isinstance(slides, list) or not slides:
        v.err(w, "slides must be a non-empty list")
        return
    seen: set[str] = set()
    for i, s in enumerate(slides):
        where = f"{w}.slides[{i}]"
        if not isinstance(s, dict):
            v.err(where, "expected object")
            continue
        sid = s.get("id")
        if isinstance(sid, str):
            where = f"{w}[{sid}]"
        if not isinstance(sid, str) or not SLIDE_ID.match(sid):
            v.err(where, "id must be 1-64 letters, digits, '-' or '_'")
        elif sid in seen:
            v.err(where, "duplicate id")
        else:
            seen.add(sid)
        tpl = s.get("template")
        if tpl not in SLIDE_FIELDS:
            v.err(where, f"unknown template {tpl!r} (one of {', '.join(SLIDE_FIELDS)})")
            continue
        req, opt = SLIDE_FIELDS[tpl]
        keys = {k for k in s if not k.startswith("_")}  # "_comment" etc. are ignored
        for k in sorted(({"id", "template", "active", "lang"} | req) - keys):
            v.err(where, f"missing key {k!r}")
        for k in sorted(keys - SLIDE_BASE - req - opt):
            v.err(where, f"unexpected key {k!r} for template {tpl}")
        if "active" in s and not isinstance(s["active"], bool):
            v.err(where, "active must be true/false")
        if s.get("lang") not in ("zh", "en", "bi"):
            v.err(where, "lang must be 'zh', 'en' or 'bi'")
        d1 = _slide_date(v, f"{where}.from", s["from"]) if "from" in s else None
        d2 = _slide_date(v, f"{where}.until", s["until"]) if "until" in s else None
        if d1 and d2 and d1 > d2:
            v.err(where, "from is after until")
        if "duration" in s and not (isinstance(s["duration"], int) and not isinstance(s["duration"], bool) and 2 <= s["duration"] <= 600):
            v.err(where, "duration must be an integer 2..600 (seconds)")
        if "alt" in s and not isinstance(s["alt"], str):
            v.err(where, "alt must be a string")
        g = lambda k: s.get(k)  # noqa: E731
        if tpl == "alert":
            for k in ("kicker", "disease", "country", "rule", "category", "region_label", "country_en", "status", "ask", "note"):
                if k in s:
                    _slide_text(v, f"{where}.{k}", g(k))
            if "iso" in s and not (isinstance(g("iso"), str) and ISO2.match(g("iso"))):
                v.err(f"{where}.iso", "must be an ISO 3166 alpha-2 code like 'CD'")
            if "routes" in s:
                _slide_routes(v, f"{where}.routes", g("routes"), web)
            if "route_labels" in s and not isinstance(g("route_labels"), bool):
                v.err(f"{where}.route_labels", "route_labels must be true/false")
        elif tpl == "symptoms":
            for k in ("title", "subtitle"):
                if k in s:
                    _slide_text(v, f"{where}.{k}", g(k))
            if "intro" in s:
                _slide_bi(v, f"{where}.intro", g("intro"))
            if "mascot" in s:
                _slide_asset(v, f"{where}.mascot", g("mascot"), web)
            if not isinstance(g("symptoms"), list) or not g("symptoms"):
                v.err(f"{where}.symptoms", "must be a non-empty list")
            else:
                for j, x in enumerate(g("symptoms")):
                    if v.keys(f"{where}.symptoms[{j}]", x, ["icon", "zh", "en"]):
                        _slide_asset(v, f"{where}.symptoms[{j}].icon", x["icon"], web)
                        _slide_text(v, f"{where}.symptoms[{j}].zh", x["zh"])
                        _slide_text(v, f"{where}.symptoms[{j}].en", x["en"])
            if not isinstance(g("steps"), list) or not g("steps"):
                v.err(f"{where}.steps", "must be a non-empty list")
            else:
                for j, x in enumerate(g("steps")):
                    if v.keys(f"{where}.steps[{j}]", x, ["zh", "en"], ["note"]):
                        _slide_text(v, f"{where}.steps[{j}].zh", x["zh"])
                        _slide_text(v, f"{where}.steps[{j}].en", x["en"])
                        if "note" in x:
                            _slide_bi(v, f"{where}.steps[{j}].note", x["note"])
        elif tpl == "report":
            for k in ("headline", "cta", "tail", "condition"):
                if k in s:
                    _slide_text(v, f"{where}.{k}", g(k))
            if "sign" in s:
                _slide_bi(v, f"{where}.sign", g("sign"))
            if not isinstance(g("symptoms"), list) or not g("symptoms"):
                v.err(f"{where}.symptoms", "must be a non-empty list")
            else:
                for j, x in enumerate(g("symptoms")):
                    if v.keys(f"{where}.symptoms[{j}]", x, ["icon", "t"]):
                        if x["icon"] not in REPORT_ICONS:
                            v.err(f"{where}.symptoms[{j}].icon", f"one of {', '.join(REPORT_ICONS)}")
                        _slide_text(v, f"{where}.symptoms[{j}].t", x["t"])
        elif tpl == "germs":
            _slide_bi(v, f"{where}.headline", g("headline"))
            _slide_bi(v, f"{where}.message", g("message"))
            if "art" in s:
                _slide_asset(v, f"{where}.art", g("art"), web)
        elif tpl == "image":
            _slide_asset(v, f"{where}.src", g("src"), web)
            if "src_landscape" in s:
                _slide_asset(v, f"{where}.src_landscape", g("src_landscape"), web)
            _slide_text(v, f"{where}.alt", g("alt"))
            if "brand" in s and not isinstance(g("brand"), bool):
                v.err(f"{where}.brand", "brand must be true/false")


AUTO_SRC = re.compile(r"^slides/auto/[A-Za-z0-9._~%-]+\.(png|webp|jpe?g|gif|avif)$", re.I)
AUTO_KEYS = {"id", "template", "auto", "src", "alt", "active", "file"}
AUTO_OPT = {"src_landscape", "file_landscape", "from", "until", "duration", "lang", "brand"}


def _auto_src(v: V, where: str, p, web: Path) -> None:
    from urllib.parse import unquote
    if not isinstance(p, str) or not AUTO_SRC.match(p) or ".." in p:
        v.err(where, f"{str(p)[:60]!r}: must be slides/auto/<url-encoded file name>")
    elif not (web / unquote(p)).is_file():
        v.err(where, f"{unquote(p)} does not exist under web/")


def check_auto(v: V, a, web: Path, taken: set) -> None:
    """web/slides/auto/index.json, generated by python -m pipeline.slides_auto (image posters dropped in the folder)."""
    w = "slides/auto/index.json"
    if not v.keys(w, a, ["version", "folder", "slides"]):
        return
    if a["version"] != 1 or not isinstance(a["slides"], list):
        v.err(w, "version must be 1 and slides a list")
        return
    for i, s in enumerate(a["slides"]):
        where = f"{w}.slides[{i}]"
        if not v.keys(where, s, sorted(AUTO_KEYS), sorted(AUTO_OPT)) or any(k not in s for k in AUTO_KEYS):
            continue
        if not (isinstance(s["id"], str) and SLIDE_ID.match(s["id"]) and s["id"].startswith("auto-")):
            v.err(f"{where}.id", "must be auto-<hex>")
        elif s["id"] in taken:
            v.err(f"{where}.id", f"duplicate id {s['id']}")
        taken.add(s["id"])
        if s["template"] != "image" or s["auto"] is not True or s["active"] is not True:
            v.err(where, "template must be image, auto and active true")
        _auto_src(v, f"{where}.src", s["src"], web)
        if "src_landscape" in s:
            _auto_src(v, f"{where}.src_landscape", s["src_landscape"], web)
        _slide_text(v, f"{where}.alt", s["alt"])
        fr = _slide_date(v, f"{where}.from", s["from"]) if "from" in s else None
        un = _slide_date(v, f"{where}.until", s["until"]) if "until" in s else None
        if fr and un and fr > un:
            v.err(where, "from is after until")
        if "duration" in s and not (isinstance(s["duration"], int) and not isinstance(s["duration"], bool) and 3 <= s["duration"] <= 60):
            v.err(f"{where}.duration", "integer 3..60")
        if "lang" in s and s["lang"] not in ("zh", "en", "bi"):
            v.err(f"{where}.lang", "zh, en or bi")
        if "brand" in s and s["brand"] is not True:
            v.err(f"{where}.brand", "true when present")


def validate_slides(web: Path) -> list[str]:
    """Check web/slides/slides.json (the poster carousel manifest) and the generated web/slides/auto/index.json.
    Returns violations (empty = ok)."""
    web = Path(web)
    v = V()
    p = web / "slides" / "slides.json"
    try:
        m = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        v.err("slides.json", f"cannot read/parse: {e}")
        return v.errors
    check_slides(v, m, web)
    ap = web / "slides" / "auto" / "index.json"
    if ap.exists():
        taken = {s.get("id") for s in (m.get("slides") or []) if isinstance(s, dict)} if isinstance(m, dict) else set()
        try:
            check_auto(v, json.loads(ap.read_text(encoding="utf-8")), web, taken)
        except (OSError, ValueError) as e:
            v.err("slides/auto/index.json", f"cannot read/parse: {e}")
    return v.errors


if __name__ == "__main__":  # python -m pipeline.validate [web-dir]: slides manifest only (stdlib, no pipeline deps)
    import sys
    errs = validate_slides(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "web"))
    for e in errs:
        print("VIOLATION:", e)
    print("validate slides:", "FAILED" if errs else "ok", f"({len(errs)} violations)")
    sys.exit(1 if errs else 0)
