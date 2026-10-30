"""World-city weather: CWA 全球都市天氣預報 (F-C0032-007), 80 cities × 7 days. docs/DATA_CONTRACT.md#weatherjson

    fetch()            download the dataset into data/raw/cwa/ (needs CWA_API_KEY; kept only when it parses)
    build(raw)         parse the raw JSON into the weather.json document
    export(conn, dir)  write web/data/weather.json from the raw file (works offline from the committed fixture)
"""
from __future__ import annotations

import json
import os

from . import common as C
from . import http

DATASET = "F-C0032-007"
API_URL = f"https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/{DATASET}?downloadType=WEB&format=JSON"
PAGE_URL = f"https://opendata.cwa.gov.tw/dataset/forecast/{DATASET}"
MIN_CITIES = 50  # a smaller download is treated as broken and the previous raw file is kept

# CWA weather phrases → English; unknown phrases fall back to the English name of their icon category.
WX_EN = {
    "晴天": "Sunny", "晴時多雲": "Mostly sunny", "多雲時晴": "Partly cloudy", "多雲": "Cloudy",
    "多雲時陰": "Mostly cloudy", "陰時多雲": "Overcast, some breaks", "陰天": "Overcast",
    "雨天": "Rain", "陣雨": "Showers", "短暫雨": "Brief rain", "雷陣雨": "Thunderstorms", "雷雨": "Thunderstorms",
    "午後雷陣雨": "Afternoon thunderstorms", "下雪": "Snow", "雨夾雪": "Sleet", "有雨或雪": "Rain or snow",
    "霧": "Fog", "有霧": "Fog", "晴有霧": "Sunny, fog",
}
ICON_EN = {"sun": "Sunny", "partly": "Partly cloudy", "cloud": "Cloudy", "overcast": "Overcast", "rain": "Rain",
           "showers": "Showers", "thunder": "Thunderstorms", "snow": "Snow", "sleet": "Sleet", "fog": "Fog"}


def icon_for(wx: str) -> str:
    """Icon category from the Chinese phrase (robust to codes CWA adds later)."""
    if "雷" in wx:
        return "thunder"
    if "雪" in wx:
        return "sleet" if "雨" in wx else "snow"
    if "陣雨" in wx:
        return "showers"
    if "雨" in wx:
        return "rain"
    if "霧" in wx:
        return "fog"
    if "晴" in wx:
        return "partly" if "雲" in wx else "sun"
    if wx.startswith("陰"):
        return "overcast"
    return "cloud"


def raw_path():
    return C.raw_dir() / "cwa" / f"{DATASET}.json"


def _locations(raw: dict) -> list[dict]:
    loc = raw["cwaopendata"]["Dataset"]["Locations"]["Location"]
    return loc if isinstance(loc, list) else [loc]


def _int(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def build(raw: dict, manual: dict | None = None) -> dict:
    """weather.json document (without generated_at / fetched_at) from the raw CWA JSON."""
    manual = manual if manual is not None else C.load_json(C.ROOT / "data" / "manual" / "cwa_cities.json", {})
    known = manual.get("cities") or {}
    regions = manual.get("regions") or {}
    ds = raw["cwaopendata"]["Dataset"]
    cities, unmapped, region_order, all_days = [], [], [], set()
    for loc in _locations(raw):
        sid = str(loc.get("StationID") or "").strip()
        name_zh = C.nfkc(loc.get("LocationName"))
        reg_zh = C.nfkc(loc.get("Region"))
        reg = regions.get(reg_zh) or {"id": f"r{len(region_order)}", "en": reg_zh}
        if reg_zh not in [r["zh"] for r in region_order]:
            region_order.append({"id": reg["id"], "zh": reg_zh, "en": reg["en"]})
        days: dict[str, dict] = {}
        for el in loc.get("WeatherElement") or []:
            name = el.get("ElementName")
            for t in el.get("Time") or []:
                day = str(t.get("StartTime") or "")[:10]  # Taiwan date (+08:00) of the 24-hour period
                if not day:
                    continue
                v = t.get("ElementValue") or {}
                d = days.setdefault(day, {"date": day})
                if name == "天氣現象":
                    wx = C.nfkc(v.get("Weather"))
                    icon = icon_for(wx)
                    d.update(wx_zh=wx, wx_en=WX_EN.get(wx) or ICON_EN[icon], code=str(v.get("WeatherCode") or ""), icon=icon)
                elif name == "最高溫度":
                    d["max"] = _int(v.get("MaxTemperature"))
                elif name == "最低溫度":
                    d["min"] = _int(v.get("MinTemperature"))
        day_list = [days[k] for k in sorted(days) if "wx_zh" in days[k]]
        for d in day_list:
            d.setdefault("max", None)
            d.setdefault("min", None)
        all_days.update(d["date"] for d in day_list)
        m = known.get(sid)
        if not m:
            unmapped.append({"id": sid, "name_zh": name_zh, "region": reg_zh})
            C.log.warning("CWA station %s (%s) is not in data/manual/cwa_cities.json", sid, name_zh)
        cities.append({
            "id": sid, "name_zh": name_zh, "name_en": (m or {}).get("en") or "", "iso": (m or {}).get("iso"),
            "region": reg["id"], "lat": (m or {}).get("lat"), "lon": (m or {}).get("lon"), "days": day_list,
        })
    info = ds.get("DatasetInfo") or {}
    return {
        "source": {"dataset": DATASET, "url": PAGE_URL, "issued": info.get("IssueTime") or raw["cwaopendata"].get("Sent") or ""},
        "regions": region_order,
        "days": sorted(all_days),
        "cities": cities,
        "unmapped": unmapped,
    }


def fetch(session=None) -> dict:
    """Download the dataset; keep the previous raw file unless the new one parses with enough cities."""
    st = {"url": PAGE_URL, "ok": False, "fetched_at": C.iso_ts(), "reason": None}
    key = (os.environ.get("CWA_API_KEY") or "").strip()
    if not key:
        st["reason"] = "CWA_API_KEY not set"
        C.log.info("CWA weather not refreshed: %s", st["reason"])
        return st
    try:
        body = http.get(f"{API_URL}&Authorization={key}", session=session, tries=2, timeout=(10, 90)).content
        raw = json.loads(body.decode("utf-8-sig"))
        n = len(build(raw)["cities"])
        if n < MIN_CITIES:
            raise ValueError(f"too few cities ({n})")
    except Exception as e:  # network / parser trouble must never break the data update
        st["reason"] = f"{type(e).__name__}: {e}".replace(key, "***")  # the key travels in the URL: never log or store it
        C.log.warning("CWA weather not refreshed: %s", st["reason"])
        return st
    p = raw_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    st.update(ok=True, items=n)
    C.log.info("CWA weather: %d cities", n)
    return st


def export(conn, out_dir) -> dict | None:
    p = raw_path()
    if not p.exists():
        return None
    doc = build(json.loads(p.read_text(encoding="utf-8-sig")))
    st = {}
    if conn is not None:
        row = conn.execute("SELECT * FROM source_state WHERE name='cwa'").fetchone()
        st = dict(row) if row else {}
    doc = {"generated_at": C.iso_ts(), **doc}
    doc["source"].update(fetched_at=st.get("fetched_at") or "", ok=bool(st.get("ok", 1)))
    C.write_json(out_dir / "weather.json", doc)
    return doc


def main(argv=None) -> int:
    from . import db
    conn = db.connect()
    st = fetch()
    if st["ok"]:
        db.set_source_state(conn, "cwa", url=st["url"], fetched_at=st["fetched_at"], ok=1, reason=None)
    doc = export(conn, C.web_data())
    if doc:
        print(f"weather.json: {len(doc['cities'])} cities × {len(doc['days'])} days, issued {doc['source']['issued']}, "
              f"unmapped {len(doc['unmapped'])}")
    return 0
