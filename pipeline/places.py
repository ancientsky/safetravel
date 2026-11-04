"""Place names for the search boxes (index.html, trip.html): airports and cities with Chinese names, each mapped to
its country. docs/DATA_CONTRACT.md#placesjson

    build(conn, out_dir)  write web/data/places.json

English names and IATA codes of every other airport come from web/data/airports.json, which the page loads alongside
this file the first time a search box is used; this file only adds what that one lacks: Chinese names.
Sources: TDX airport list (SQLite airports_tdx: zh/en, country), pipeline/airport_zh.json, the Chinese city names of
the TPE routes (flights.json) and of the outbreak route watch (watch.json), and the CWA forecast cities (weather.json,
cities without an airport code). Other names an airport answers to (NGO 中部: 名古屋, Nagoya, セントレア) go in its
"alias" list: the names of those sources that lost to "zh", plus pipeline/airport_alias.json.
"""
from __future__ import annotations

import re

from . import common as C

IATA = re.compile(r"^[A-Z]{3}$")
CJK = re.compile(r"[\u3400-\u9fff]")
ISO2 = re.compile(r"^[A-Z]{2}$")


def _clean(s) -> str:
    return re.sub(r"\s+", " ", C.nfkc(s or "")).strip()


def _key(s) -> str:
    """Loose comparison key, like web/js/places.js norm(): case, spaces and punctuation do not count."""
    return re.sub(r"[\s\-_.,'’()（）・·]+", "", s.lower())


def build_doc(conn, out_dir) -> dict:
    geo = C.load_json(C.web_data() / "airports.json", {}) or {}
    tdx = {}
    if conn is not None:
        for r in conn.execute("SELECT iata, zh, en, country FROM airports_tdx"):
            tdx[r["iata"]] = (_clean(r["zh"]), _clean(r["en"]), (r["country"] or "").upper())
    zh_fb = C.load_json(C.ROOT / "pipeline" / "airport_zh.json", {}) or {}
    curated = {k: v for k, v in (C.load_json(C.ROOT / "pipeline" / "airport_alias.json", {}) or {}).items()
               if IATA.match(k) and isinstance(v, list)}
    routes = list((C.load_json(out_dir / "flights.json", {}) or {}).get("routes") or [])
    # outbreak route watch (watch.json): hubs + destinations with Chinese names (e.g. Irkutsk IKT, Kinshasa FIH)
    for ws in (C.load_json(out_dir / "watch.json", {}) or {}).get("sets") or []:
        hub = ws.get("hub") or {}
        routes.append({"iata": hub.get("iata"), "city_zh": ws.get("hub_zh")})
        routes += ws.get("routes") or []
    route_zh = {}
    for r in routes:
        if r.get("iata") and _clean(r.get("city_zh")):
            route_zh.setdefault(r["iata"], _clean(r.get("city_zh")))

    country_zh = {_clean(c.get("zh")) for c in (C.load_json(C.web_data() / "countries.json", {}) or {}).values()}
    airports = []
    for code in sorted(set(tdx) | set(zh_fb) | set(route_zh) | set(curated)):
        if not IATA.match(code or ""):
            continue
        t_zh, t_en, t_iso = tdx.get(code, ("", "", ""))
        g = geo.get(code) or {}
        # prefer a name that is not just a country's name (TDX lists OVB Novosibirsk as "俄羅斯"), but keep it when it
        # is the only one: single-airport places really are called that (HKG 香港, MFM 澳門, BAH 巴林)
        extra = [_clean(a) for a in curated.get(code, []) if isinstance(a, str) and _clean(a)]
        cands = [z for z in (t_zh, _clean(zh_fb.get(code)), route_zh.get(code, "")) if z]
        zh = next((z for z in cands if z not in country_zh), cands[0] if cands else "")
        zh = zh or next((a for a in extra if CJK.search(a)), "")  # last resort: the curated Chinese name (FKS 福島)
        iso = t_iso or (g.get("country") or "").upper()
        if not zh or not ISO2.match(iso) or zh == code:
            continue
        en = t_en or _clean(g.get("city")) or _clean(g.get("name"))
        seen = {_key(x) for x in (code, zh, en)}
        alias = []
        for a in [z for z in cands if z not in country_zh] + extra:
            if _key(a) not in seen:
                seen.add(_key(a))
                alias.append(a)
        p = {"code": code, "iso": iso, "zh": zh, "en": en}
        if alias:
            p["alias"] = alias
        airports.append(p)

    cities = []
    for c in (C.load_json(out_dir / "weather.json", {}) or {}).get("cities") or []:
        iso = (c.get("iso") or "").upper()
        if ISO2.match(iso) and c.get("name_zh"):
            cities.append({"code": "", "iso": iso, "zh": _clean(c["name_zh"]), "en": _clean(c.get("name_en"))})
    return {"version": 1, "generated_at": C.iso_ts(), "places": airports + cities}


def build(conn, out_dir) -> dict:
    doc = build_doc(conn, out_dir)
    prev = C.load_json(out_dir / "places.json", None)
    if prev and prev.get("places") == doc["places"]:
        doc["generated_at"] = prev.get("generated_at", doc["generated_at"])  # idempotent: unchanged list, same file
    C.write_json(out_dir / "places.json", doc)
    return doc
