"""Export SQLite -> web/data/*.json following docs/DATA_CONTRACT.md."""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

from . import common as C
from . import db

HUB = {"iata": "TPE", "name_en": "Taiwan Taoyuan International Airport", "name_zh": "臺灣桃園國際機場",
       "lat": 25.0777, "lon": 121.233}

LEVELS = {
    "1": {"zh": "第一級：注意（Watch）", "en": "Level 1: Watch", "instruction_zh": "提醒遵守當地的一般預防措施", "instruction_en": "Practice usual precautions"},
    "2": {"zh": "第二級：警示（Alert）", "en": "Level 2: Alert", "instruction_zh": "對當地採取加強防護", "instruction_en": "Practice enhanced precautions"},
    "3": {"zh": "第三級：警告（Warning）", "en": "Level 3: Warning", "instruction_zh": "避免至當地所有非必要旅遊", "instruction_en": "Avoid all non-essential travel"},
}


# ------------------------------------------------------------------ helpers
def _ts(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    return dt.astimezone(C.TAIPEI) if dt.tzinfo else dt.replace(tzinfo=C.TAIPEI)


def _day(s: str) -> str:
    try:
        return _ts(s).date().isoformat()
    except ValueError:
        return (s or "")[:10]


def _manual(name: str) -> dict:
    d = C.load_json(C.manual_dir() / name, {}) or {}
    return {k: v for k, v in d.items() if not k.startswith("_")}


def first_sentence(desc: str, headline: str, limit: int = 120) -> str:
    if not desc:
        return headline
    s = re.split(r"(?<=[。！？])", desc)[0].strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


class Names:
    """Disease / area English names: manual dictionary > Gemini cache > Chinese original."""

    def __init__(self, conn):
        self.dis = {C.nfkc(k): v for k, v in _manual("diseases.json").items()}
        self.dis_ai = db.names(conn, "disease_names")
        builtin = C.load_json(Path(__file__).with_name("area_names_en.json"), {}) or {}
        self.area = {**{C.nfkc(k): v for k, v in builtin.items()}, **{C.nfkc(k): v for k, v in _manual("areas.json").items()}}
        self.area_ai = db.names(conn, "area_names")

    def disease(self, zh: str) -> str:
        return self.dis.get(zh) or self.dis_ai.get(zh) or zh

    def disease_multi(self, zh: str) -> str:
        parts = C.split_diseases(zh)
        return ", ".join(self.disease(p) for p in parts) if parts else zh

    def area_en(self, zh: str) -> str:
        return self.area.get(zh) or self.area_ai.get(zh) or zh


# ------------------------------------------------------------------- alerts
def resolve_iso(row, territories: dict) -> str:
    iso = (row["ISO3166"] or "").strip().upper()
    if re.fullmatch(r"[A-Z]{2}", iso):
        return iso
    for k in (row["areaDesc_EN"], row["areaDesc"]):
        v = territories.get(k)
        if v:
            return v
    return ""


def active_alerts(conn) -> list[dict]:
    """Latest row per (disease, iso-or-area, areaDetail); ties on timestamp resolve to the higher level;
    lifted (解除) keys are dropped. 嚴重特殊傳染性肺炎 rows are discarded entirely."""
    territories = _manual("territories.json")
    latest: dict[tuple, dict] = {}
    for r in conn.execute("SELECT * FROM alerts_raw WHERE alert_disease != ?", (C.COVID_OLD,)):
        level = C.LEVEL_OF.get(r["severity_level"])
        if level is None:
            C.log.warning("unknown severity_level %r", r["severity_level"])
            continue
        iso = resolve_iso(r, territories)
        key = (r["alert_disease"], iso or r["areaDesc"], r["areaDetail"])
        ts = _ts(r["effective"])
        cur = latest.get(key)
        if cur is None or (ts, level) > (cur["ts"], cur["level"]):
            latest[key] = {"ts": ts, "level": level, "iso": iso, "row": r, "disease": r["alert_disease"],
                           "k": iso or r["areaDesc"]}
    return [v for v in latest.values() if v["level"] > 0]


def build_alerts(conn, generated_at: str, names: Names) -> dict:
    act = active_alerts(conn)
    # global background advisories: same disease+level in >= 150 countries
    groups: dict[tuple, list] = {}
    for a in act:
        groups.setdefault((a["disease"], a["level"]), []).append(a)
    global_keys = {k for k, g in groups.items() if len({a["k"] for a in g}) >= C.GLOBAL_MIN_COUNTRIES}
    glob = [{"disease": d, "level": lv, "effective": max(a["ts"] for a in groups[(d, lv)]).date().isoformat(),
             "countries": len({a["k"] for a in groups[(d, lv)]})} for d, lv in sorted(global_keys)]
    act = [a for a in act if (a["disease"], a["level"]) not in global_keys]

    cnames_geo = C.load_json(C.web_data() / "countries.json", {}) or {}
    cnames_manual = _manual("country_names.json")

    # country names as printed by CDC on rows that carry the alpha-2 themselves (latest wins)
    direct: dict[str, tuple] = {}
    for r in conn.execute("SELECT ISO3166, areaDesc, areaDesc_EN, effective FROM alerts_raw WHERE ISO3166 != ''"):
        iso = r["ISO3166"].upper()
        if re.fullmatch(r"[A-Z]{2}", iso):
            t = _ts(r["effective"])
            if iso not in direct or t > direct[iso][0]:
                direct[iso] = (t, r["areaDesc"], r["areaDesc_EN"])

    def item(a):
        r = a["row"]
        return {"disease": a["disease"], "level": a["level"], "effective": a["ts"].date().isoformat(),
                "area_zh": r["areaDetail"], "area_en": names.area_en(r["areaDetail"]) if r["areaDetail"] else "",
                "iso_sub": r["ISO3166_2"]}

    def sort_key(it):
        return (-it["level"], _neg(it["effective"]), it["disease"], it["area_zh"])

    countries: dict[str, dict] = {}
    unmapped: dict[str, dict] = {}
    for a in act:
        it = item(a)
        if a["iso"]:
            iso = a["iso"]
            c = countries.get(iso)
            if c is None:
                d = direct.get(iso)
                zh = (d[1] if d else "") or cnames_manual.get(iso, {}).get("zh") or cnames_geo.get(iso, {}).get("zh") or iso
                en = (cnames_manual.get(iso, {}).get("en") or cnames_geo.get(iso, {}).get("en")
                      or (C.clean_en_name(d[2]) if d else "") or zh)
                c = countries[iso] = {"name_zh": zh, "name_en": en, "max_level": 0, "alerts": []}
        else:
            r = a["row"]
            nm = r["areaDesc"] or r["areaDesc_EN"]
            c = unmapped.get(nm)
            if c is None:
                c = unmapped[nm] = {"name_zh": r["areaDesc"] or r["areaDesc_EN"],
                                    "name_en": C.clean_en_name(r["areaDesc_EN"]) or r["areaDesc"],
                                    "max_level": 0, "alerts": []}
        c["alerts"].append(it)
        c["max_level"] = max(c["max_level"], it["level"])
    for c in list(countries.values()) + list(unmapped.values()):
        c["alerts"].sort(key=sort_key)
    countries = dict(sorted(countries.items()))
    unmapped_list = sorted(unmapped.values(), key=lambda c: (-c["max_level"], c["name_zh"]))

    return {"generated_at": generated_at, "levels": LEVELS, "diseases": {},  # diseases filled by export_all
            "global": glob, "countries": countries, "unmapped": unmapped_list}


def _neg(datestr: str) -> str:
    """Sort key that reverses a YYYY-MM-DD string."""
    return "".join(chr(0x10FFFF - ord(ch)) for ch in datestr)


# --------------------------------------------------------------- epidemics
def epidemic_rows(conn, start: date):
    rows = conn.execute("SELECT * FROM epidemics").fetchall()
    out = [r for r in rows if _day(r["effective"]) >= start.isoformat()]
    out.sort(key=lambda r: (_ts(r["effective"]), r["id"]), reverse=True)
    return out


def overview_hash(ids) -> str:
    return C.sha1(*sorted(ids))


def build_epidemics(conn, generated_at: str, names: Names, start: date | None = None) -> dict:
    start = start or C.window_start()
    trans = db.get_translations(conn)
    items = []
    for r in epidemic_rows(conn, start):
        t = trans.get(r["content_hash"])
        head, desc = r["headline"], r["description"]
        fb = first_sentence(desc, head)
        isos = [] if r["is_global"] else list(dict.fromkeys(x for x in (r["isos"] or "").split(",") if x))
        it = {
            "id": r["id"], "date": _day(r["effective"]),
            "disease_zh": r["disease"], "disease_en": names.disease_multi(r["disease"]),
            "headline_zh": head, "headline_en": (t and t["headline_en"]) or head,
            "summary_zh": (t and t["summary_zh"]) or fb, "summary_en": (t and t["summary_en"]) or (t and t["summary_zh"]) or fb,
            "description_zh": desc, "description_en": (t and t["description_en"]) or desc,
            "countries": isos, "area_zh": r["area_zh"], "area_en": r["area_en"] or r["area_zh"],
            "url": r["url"], "ai": bool(t),
        }
        if r["is_global"]:
            it["global"] = True
        items.append(it)

    by_c: dict[str, list] = {}
    for it in items:
        for c in it["countries"]:
            by_c.setdefault(c, []).append(it)
    ov_rows = {r["iso"]: r for r in conn.execute("SELECT * FROM overviews")}
    overviews = {}
    for iso in sorted(by_c):
        its = by_c[iso]
        o = ov_rows.get(iso)
        if o and o["zh"] and o["en"]:
            overviews[iso] = {"zh": o["zh"], "en": o["en"], "items": len(its), "updated": o["updated"], "ai": True}
        else:
            overviews[iso] = {
                "zh": f"近兩年共 {len(its)} 則疫情摘要，最新為「{its[0]['headline_zh']}」。",
                "en": f"{len(its)} epidemic digests in the past two years; latest: {its[0]['headline_en']}.",
                "items": len(its), "updated": C.today().isoformat(), "ai": False}
    return {"generated_at": generated_at, "window_start": start.isoformat(), "items": items, "overviews": overviews}


# ------------------------------------------------------------------ flights
def build_flights(conn, generated_at: str, previous: dict | None):
    """Return (flights.json dict or None to keep the previous file, info for meta)."""
    day = db.latest_flights_day(conn)
    st = db.get_source_state(conn, "flights")
    if not day:
        return None, {"url": (previous or {}).get("source") or C.FLIGHT_PAGE_URL,
                      "fetched_at": (previous or {}).get("fetched_at") or generated_at,
                      "date": (previous or {}).get("date") or C.today().isoformat(),
                      "ok": False, "reason": st.get("reason") or "no flight data has been fetched yet"}
    airports = C.load_json(C.web_data() / "airports.json", {}) or {}
    routes, unmatched = [], 0
    src = fetched = None
    for r in conn.execute("SELECT * FROM flights_daily WHERE date=? ORDER BY (departures+arrivals) DESC, iata", (day,)):
        src, fetched = r["source"], r["fetched_at"]
        ap = airports.get(r["iata"])
        if not ap or ap.get("lat") is None or ap.get("lon") is None:
            unmatched += 1
            continue
        routes.append({
            "iata": r["iata"], "city_en": r["city_en"] or ap.get("city") or r["iata"],
            "city_zh": r["city_zh"] or r["city_en"] or ap.get("city") or r["iata"],
            "country": ap.get("country", ""), "lat": ap["lat"], "lon": ap["lon"],
            "departures": r["departures"], "arrivals": r["arrivals"], "airlines": json.loads(r["airlines_json"] or "[]")})
    out = {
        "date": day, "fetched_at": fetched or generated_at, "source": src or C.FLIGHT_PAGE_URL, "hub": HUB, "routes": routes,
        "totals": {"departures": sum(r["departures"] for r in routes), "arrivals": sum(r["arrivals"] for r in routes),
                   "destinations": len(routes), "unmatched": unmatched},
    }
    ok = bool(st.get("ok", 1)) if st else True
    reason = st.get("reason")
    if day != C.today().isoformat():
        ok = False
        reason = reason or f"latest flight data is from {day}"
    info = {"url": out["source"], "fetched_at": out["fetched_at"], "date": day, "ok": ok}
    if not ok:
        info["reason"] = reason or "unknown"
    return out, info


# --------------------------------------------------------------------- meta
def build_meta(conn, generated_at: str, alerts: dict, epid: dict, flights_info: dict) -> dict:
    sa, se = db.get_source_state(conn, "alerts"), db.get_source_state(conn, "epidemics")
    cs = alerts["countries"].values()
    return {
        "generated_at": generated_at, "model": C.model_name(),
        "sources": {
            "alerts": {"url": sa.get("url") or C.ALERTS_URL, "fetched_at": sa.get("fetched_at") or generated_at, "rows": sa.get("rows") or 0},
            "epidemics": {"url": se.get("url") or C.EPID_URL, "fetched_at": se.get("fetched_at") or generated_at, "rows": se.get("rows") or 0},
            "flights": flights_info,
        },
        "counts": {
            "countries_with_alerts": len(alerts["countries"]),
            "level3": sum(c["max_level"] == 3 for c in cs), "level2": sum(c["max_level"] == 2 for c in cs),
            "level1": sum(c["max_level"] == 1 for c in cs),
            "epidemic_items": len(epid["items"]), "ai_translated": sum(1 for i in epid["items"] if i["ai"]),
        },
    }


def export_all(conn, out_dir=None) -> dict:
    out_dir = out_dir or C.web_data()
    gen = C.iso_ts()
    names = Names(conn)
    alerts = build_alerts(conn, gen, names)
    epid = build_epidemics(conn, gen, names)

    # diseases: every name used by alerts.json and epidemics.json
    used = {a["disease"] for c in list(alerts["countries"].values()) + alerts["unmapped"] for a in c["alerts"]}
    used |= {g["disease"] for g in alerts["global"]}
    for it in epid["items"]:
        used.update(C.split_diseases(it["disease_zh"]))
    alerts["diseases"] = {d: {"zh": d, "en": names.disease(d)} for d in sorted(used)}

    prev = C.load_json(out_dir / "flights.json", None)
    flights, finfo = build_flights(conn, gen, prev)
    meta = build_meta(conn, gen, alerts, epid, finfo)

    C.write_json(out_dir / "alerts.json", alerts)
    C.write_json(out_dir / "epidemics.json", epid)
    if flights is not None:
        C.write_json(out_dir / "flights.json", flights)
    C.write_json(out_dir / "meta.json", meta)
    C.log.info("exported: %d countries, %d unmapped, %d epidemic items, %d overviews, flights=%s",
               len(alerts["countries"]), len(alerts["unmapped"]), len(epid["items"]), len(epid["overviews"]),
               "kept" if flights is None else f"{len(flights['routes'])} routes")
    return meta
