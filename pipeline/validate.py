"""Check web/data/*.json against docs/DATA_CONTRACT.md. Returns a list of violations (empty = ok)."""
from __future__ import annotations

import json
import re
from pathlib import Path

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
ISO2 = re.compile(r"^[A-Z]{2}$")
IATA = re.compile(r"^[A-Z]{3}$")


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
        if not v.keys(w, a, ["disease", "level", "effective", "area_zh", "area_en", "iso_sub"]):
            continue
        v.typ(w, a["level"], int, "level")
        if a["level"] not in (1, 2, 3):
            v.err(w, f"level {a['level']} not in 1..3")
        v.pat(w, a["effective"], DATE, "effective")
        for k in ("disease", "area_zh", "area_en", "iso_sub"):
            v.typ(w, a[k], str, k)
        if a["disease"] not in diseases:
            v.err(w, f"disease {a['disease']!r} missing from diseases")
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
            if v.keys(f"{w}.global[{i}]", g, ["disease", "level", "effective", "countries"]):
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
            if isinstance(x, dict) and (x.get("disease"), x.get("level")) in gkeys:
                v.err(cw, f"global-background advisory {x.get('disease')!r} must not be listed per country")
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
    if not v.keys(w, e, ["generated_at", "window_start", "items", "overviews"]):
        return
    v.pat(w, e["generated_at"], TS, "generated_at")
    v.pat(w, e["window_start"], DATE, "window_start")
    items = e["items"]
    if not isinstance(items, list):
        v.err(w, "items must be a list")
        return
    ids, last = set(), None
    per_country: dict[str, int] = {}
    dis = (alerts or {}).get("diseases", {}) if isinstance(alerts, dict) else {}
    req = ["id", "date", "disease_zh", "disease_en", "headline_zh", "headline_en", "summary_zh", "summary_en",
           "description_zh", "description_en", "countries", "area_zh", "area_en", "url", "ai"]
    for i, it in enumerate(items):
        iw = f"{w}.items[{i}]"
        if not v.keys(iw, it, req, ["global"]):
            continue
        for k in req:
            if k in ("countries", "ai"):
                continue
            v.typ(iw, it[k], str, k)
        v.typ(iw, it["ai"], bool, "ai")
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
    if {"meta", "alerts", "epidemics"} <= set(data) and isinstance(data["meta"], dict):
        c = data["meta"].get("counts", {})
        if isinstance(c, dict) and isinstance(data["alerts"], dict):
            if c.get("countries_with_alerts") != len(data["alerts"].get("countries", {})):
                v.err("meta.json", "counts.countries_with_alerts does not match alerts.json")
            if c.get("epidemic_items") != len(data["epidemics"].get("items", [])):
                v.err("meta.json", "counts.epidemic_items does not match epidemics.json")
    return v.errors
