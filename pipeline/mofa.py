"""Travel warnings: MOFA/BOCA 國外旅遊警示 (RSS + list page) and MAC 陸港澳旅遊警示 (manual). docs/WARNINGS.md

    fetch()            download the RSS and the list page into data/raw/boca/ (kept only when they parse)
    load(conn)         parse the raw files and record level changes in SQLite (mofa_levels / mofa_changes)
    export(conn, dir)  write web/data/warnings.json and web/data/warnings-text.json
"""
from __future__ import annotations

import email.utils
import html
import json
import re
from collections import defaultdict
from datetime import date, datetime, timedelta

from . import common as C
from . import http

RSS_URL = "https://www.boca.gov.tw/sp-trwa-rss-1.xml"
LIST_URL = "https://www.boca.gov.tw/sp-trwa-list-1.html"
BASE = "https://www.boca.gov.tw"
MIN_ITEMS = 100  # a smaller download is treated as broken and the previous raw files are kept
CHANGE_DAYS = 60
SUMMARY_MAX = 220

LEVELS = {
    "0": {"zh": "未發布旅遊警示分級", "en": "No warning issued", "short_zh": "未發布", "short_en": "None"},
    "1": {"zh": "第一級：灰色提醒", "en": "Level 1: Grey – be aware", "short_zh": "灰色提醒", "short_en": "Grey"},
    "2": {"zh": "第二級：黃色注意", "en": "Level 2: Yellow – exercise caution", "short_zh": "黃色注意", "short_en": "Yellow"},
    "3": {"zh": "第三級：橙色避免前往", "en": "Level 3: Orange – avoid non-essential travel", "short_zh": "橙色避免前往", "short_en": "Orange"},
    "4": {"zh": "第四級：紅色儘速離境", "en": "Level 4: Red – leave as soon as possible", "short_zh": "紅色儘速離境", "short_en": "Red"},
}
REGIONS = {
    "AsiaPacific": ("亞太地區", "Asia-Pacific"), "AsiaMiddleEast": ("亞西地區", "West Asia"),
    "Africa": ("非洲地區", "Africa"), "Europe": ("歐洲地區", "Europe"),
    "NorthAmerica": ("北美地區", "North America"), "LatinAmerica": ("拉丁美洲暨加勒比海地區", "Latin America & Caribbean"),
}
MAC_ISOS = ("CN", "HK", "MO")
_NUM = {"一": 1, "二": 2, "三": 3, "四": 4}


def raw_dir():
    return C.raw_dir() / "boca"


def parse_level(text: str) -> int | None:
    m = re.search(r"第([一二三四])級", text or "")
    if m:
        return _NUM[m.group(1)]
    return 0 if "未發布" in (text or "") else None


def _text(fragment: str) -> str:
    return re.sub(r"\s+", " ", C.nfkc(html.unescape(re.sub(r"<[^>]+>", " ", fragment or "")))).strip()


def split_zh_en(t: str) -> tuple[str, str]:
    """'柬埔寨 Cambodia' -> ('柬埔寨', 'Cambodia'); text without Latin letters -> (text, '')."""
    m = re.search(r"[A-Za-z]", t)
    return (t[:m.start()].strip(" -"), t[m.start():].strip()) if m else (t.strip(), "")


# ---------------------------------------------------------------- parsing
def parse_list(page: str) -> list[dict]:
    """Rows of the BOCA table: region, country cell (zh + en), area cell, level, content id/url."""
    rows, region = [], ""
    for m in re.finditer(r'<h3 class="title" id ?="(\w+)">|<tr>(.*?)</tr>', page, re.S):
        if m.group(1):
            region = m.group(1)
            continue
        tds = re.findall(r"<td[^>]*>(.*?)</td>", m.group(2), re.S)
        if len(tds) < 3:
            continue
        a = re.search(r'href="(/sp-trwa-content-(\d+)-\w+-1\.html)"[^>]*\bid="([^"]*)"', tds[0])
        lvl = parse_level(_text(tds[2]))
        if lvl is None:
            continue
        rows.append({"region": region, "country": _text(tds[0]), "area": _text(tds[1]), "level": lvl,
                     "id": a.group(2) if a else "", "url": BASE + a.group(1) if a else "",
                     "anchor": a.group(3).replace("_", " ") if a else ""})
    return rows


def _plain(desc_html: str) -> str:
    s = re.sub(r"<br\s*/?>|</p>|</li>", "\n", desc_html or "", flags=re.I)
    lines = [_text(x) for x in s.split("\n")]
    return "\n".join(x for x in lines if x)


def summary(text: str, limit: int = SUMMARY_MAX) -> str:
    first = next((x for x in text.split("\n") if x.strip()), "")
    first = re.sub(r"^[一二三四五六七八九十]+、\s*", "", first)
    return first if len(first) <= limit else first[: limit - 1] + "…"


def _pubdate(s: str) -> str:
    try:
        return email.utils.parsedate_to_datetime(s).astimezone(C.TAIPEI).date().isoformat()
    except (TypeError, ValueError):
        return ""


def parse_rss(xml_text: str) -> dict[str, dict]:
    """{content id: {title, level, date, text, url}} from the RSS."""
    import xml.etree.ElementTree as ET
    out = {}
    channel = ET.fromstring(xml_text).find("channel")
    for it in channel.findall("item") if channel is not None else []:
        url = (it.findtext("link") or "").strip()
        m = re.search(r"sp-trwa-content-(\d+)-", url)
        if not m:
            continue
        title = C.nfkc(it.findtext("title") or "")
        out[m.group(1)] = {"title": title, "level": parse_level(title), "date": _pubdate(it.findtext("pubDate") or ""),
                           "text": _plain(it.findtext("description") or ""), "url": url}
    return out


# ---------------------------------------------------------------- names -> ISO
def _norm_zh(z: str) -> str:
    z = re.sub(r"[(（][^)）]*[)）]", "", z)
    z = re.sub(r"^(英屬|美屬|法屬|荷屬)", "", z)
    return re.sub(r"(共和國|王國|侯國|大公國|自治政府)$", "", z).strip()


def _norm_en(e: str) -> str:
    e = e.lower().replace(",", " ")
    e = re.sub(r"\b(republic of the|republic of|kingdom of|the)\b", " ", e)
    return re.sub(r"\s+", " ", e).strip()


def name_resolver(conn):
    """resolve(zh, en) -> ISO2 or ''; sources in priority order per docs/WARNINGS.md."""
    zh2: dict[str, str] = {}
    en2: dict[str, str] = {}
    for k, v in (C.load_json(C.ROOT / "data" / "manual" / "boca_names.json", {}) or {}).items():
        if not k.startswith("_"):
            zh2[C.nfkc(k)] = v
            en2[C.nfkc(k).lower()] = v
    for k, v in (C.load_json(C.web_data() / "countries.json", {}) or {}).items():
        zh2.setdefault(C.nfkc(v.get("zh", "")), k)
        en2.setdefault(C.nfkc(v.get("en", "")).lower(), k)
    if conn is not None:
        for z, e, iso in conn.execute("SELECT DISTINCT areaDesc, areaDesc_EN, ISO3166 FROM alerts_raw WHERE length(ISO3166) = 2"):
            zh2.setdefault(C.nfkc(z), iso.upper())
            en2.setdefault(C.nfkc(e).lower(), iso.upper())
    for k, v in (C.load_json(C.ROOT / "data" / "manual" / "country_names.json", {}) or {}).items():
        if isinstance(v, dict):
            if v.get("zh"):
                zh2.setdefault(C.nfkc(v["zh"]), k)
            if v.get("en"):
                en2.setdefault(C.nfkc(v["en"]).lower(), k)
    zh2.pop("", None)
    en2.pop("", None)
    zhn = {_norm_zh(k): v for k, v in zh2.items()}
    enn = {_norm_en(k): v for k, v in en2.items()}

    def resolve(zh: str, en: str = "", anchor: str = "") -> str:
        return (zh2.get(zh) or en2.get(en.lower()) or en2.get(anchor.lower()) or zhn.get(_norm_zh(zh))
                or enn.get(_norm_en(en)) or enn.get(_norm_en(anchor)) or "")
    return resolve


# ---------------------------------------------------------------- build
def build(rows: list[dict], rss: dict[str, dict], resolve, mac: dict | None = None, names: dict | None = None) -> dict:
    """-> {"countries": {...}, "unmapped": [...], "texts": {id: text}, "snapshot": {key: level}}
    `names` ({ISO: {zh, en}}, countries.json) names countries that have only regional items."""
    by_iso: dict[str, list[dict]] = defaultdict(list)
    unmapped, texts = [], {}
    for r in rows:
        czh, cen = split_zh_en(r["country"])
        r["iso"] = resolve(czh, cen, r["anchor"])
        r["czh"], r["cen"] = czh, cen
        it = rss.get(r["id"]) or {}
        r["date"], r["text"] = it.get("date", ""), it.get("text", "")
        if r["id"] and r["text"]:
            texts[r["id"]] = r["text"]
        if r["iso"] in MAC_ISOS:
            continue  # rated by MAC
        if r["iso"]:
            by_iso[r["iso"]].append(r)
        else:
            unmapped.append({"title": f'{r["country"]} · {r["area"]}', "level": r["level"], "url": r["url"]})
    countries, snapshot = {}, {}
    for iso, rs in by_iso.items():
        for r in rs:
            azh, aen = split_zh_en(r["area"])
            r["national"] = resolve(azh, aen) == iso or len(rs) == 1
        nat = [r for r in rs if r["national"]]
        if len(nat) != 1:  # ambiguous (e.g. two islands of one ISO code): treat all as areas
            for r in nat:
                r["national"] = False
            nat = []
        n = nat[0] if nat else None
        areas = []
        for r in rs:
            if r is n:
                continue
            azh, aen = split_zh_en(r["area"])
            areas.append({"area_zh": azh or r["area"], "area_en": aen, "level": r["level"], "date": r["date"],
                          "id": r["id"], "url": r["url"], "summary_zh": summary(r["text"])})
            snapshot[f"{iso}|{azh or r['area']}"] = r["level"]
        areas.sort(key=lambda a: (-a["level"], a["area_zh"]))
        first = n or rs[0]
        levels = [r["level"] for r in rs]
        own = (names or {}).get(iso) or {}
        name_zh = first["czh"] if n else own.get("zh") or first["czh"]
        name_en = (first["cen"] or first["anchor"]) if n else own.get("en") or first["cen"]
        c = {"source": "mofa", "region": first["region"], "name_zh": name_zh, "name_en": name_en,
             "level": n["level"] if n else None, "max_level": max(levels),
             "date": max((r["date"] for r in rs if r["date"]), default=""),
             "id": n["id"] if n else "", "url": n["url"] if n else "", "summary_zh": summary(n["text"]) if n else "",
             "areas": areas}
        countries[iso] = c
        if n:
            snapshot[f"{iso}|"] = n["level"]
    for iso, m in ((mac or {}).get("countries") or {}).items():
        countries[iso] = {"source": "mac", "region": "AsiaPacific", "name_zh": m.get("name_zh") or "", "name_en": m.get("name_en") or "",
                          "level": m["level"], "max_level": m["level"], "date": m.get("since", ""),
                          "confirmed": (mac or {}).get("confirmed", ""), "id": "", "url": (mac or {}).get("source_url", ""),
                          "summary_zh": m.get("summary_zh", ""), "summary_en": m.get("summary_en", ""), "areas": []}
    return {"countries": dict(sorted(countries.items())), "unmapped": unmapped, "texts": texts, "snapshot": snapshot}


def _mac() -> dict:
    mac = C.load_json(C.ROOT / "data" / "manual" / "mac_warnings.json", {}) or {}
    names = C.load_json(C.web_data() / "countries.json", {}) or {}
    defaults = {"CN": ("中國大陸", "Mainland China"), "HK": ("香港", "Hong Kong"), "MO": ("澳門", "Macau")}
    for iso, m in (mac.get("countries") or {}).items():
        zh, en = defaults.get(iso, (names.get(iso, {}).get("zh", iso), names.get(iso, {}).get("en", iso)))
        m.setdefault("name_zh", zh)
        m.setdefault("name_en", en)
    return mac


def read_raw():
    d = raw_dir()
    rss_p, list_p = d / "sp-trwa-rss-1.xml", d / "sp-trwa-list-1.html"
    if not rss_p.exists() or not list_p.exists():
        return None
    return parse_list(list_p.read_text(encoding="utf-8")), parse_rss(rss_p.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- fetch
def fetch(session=None) -> dict:
    """Download both files; keep the previous raw files unless the new ones parse with enough rows."""
    st = {"url": LIST_URL, "rss": RSS_URL, "ok": False, "fetched_at": C.iso_ts(), "reason": None}
    try:
        rss_b = http.get(RSS_URL, session=session, tries=2, timeout=(10, 60)).content
        page_b = http.get(LIST_URL, session=session, tries=2, timeout=(10, 60)).content
        rows = parse_list(page_b.decode("utf-8", "replace"))
        rss = parse_rss(rss_b.decode("utf-8", "replace"))
        if len(rows) < MIN_ITEMS or len(rss) < MIN_ITEMS:
            raise ValueError(f"too few warnings (list {len(rows)}, rss {len(rss)})")
    except Exception as e:  # network / parser trouble must never break the data update
        st["reason"] = f"{type(e).__name__}: {e}"
        C.log.warning("BOCA travel warnings not refreshed: %s", st["reason"])
        return st
    d = raw_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / "sp-trwa-rss-1.xml").write_bytes(rss_b)
    (d / "sp-trwa-list-1.html").write_bytes(page_b)
    st.update(ok=True, items=len(rows))
    C.log.info("BOCA travel warnings: %d rows, %d RSS items", len(rows), len(rss))
    return st


# ---------------------------------------------------------------- history
def record(conn, snapshot: dict[str, int], today: str | None = None) -> int:
    """Compare a snapshot with mofa_levels; append changes. First run = baseline only. -> number of changes."""
    today = today or C.today().isoformat()
    prev = {r["key"]: r["level"] for r in conn.execute("SELECT key, level FROM mofa_levels")}
    baseline = not prev
    changes = 0
    for key, lvl in snapshot.items():
        iso, area = key.split("|", 1)
        if key in prev:
            if prev[key] != lvl:
                conn.execute("INSERT INTO mofa_changes(date, iso, area_zh, from_level, to_level) VALUES(?,?,?,?,?)",
                             (today, iso, area, prev[key], lvl))
                changes += 1
            conn.execute("UPDATE mofa_levels SET level=?, last_seen=? WHERE key=?", (lvl, today, key))
        else:
            if not baseline:
                conn.execute("INSERT INTO mofa_changes(date, iso, area_zh, from_level, to_level) VALUES(?,?,?,?,?)",
                             (today, iso, area, None, lvl))
                changes += 1
            conn.execute("INSERT INTO mofa_levels(key, iso, area_zh, level, first_seen, last_seen) VALUES(?,?,?,?,?,?)",
                         (key, iso, area, lvl, today, today))
    for key, lvl in prev.items():
        if key not in snapshot and lvl is not None:
            iso, area = key.split("|", 1)
            conn.execute("INSERT INTO mofa_changes(date, iso, area_zh, from_level, to_level) VALUES(?,?,?,?,?)",
                         (today, iso, area, lvl, None))
            conn.execute("UPDATE mofa_levels SET level=NULL, last_seen=? WHERE key=?", (today, key))
            changes += 1
    conn.commit()
    return changes


def load(conn) -> dict:
    raw = read_raw()
    if raw is None:
        C.log.warning("BOCA raw files missing: travel warnings not loaded")
        return {"ok": False}
    rows, rss = raw
    b = build(rows, rss, name_resolver(conn), _mac(), C.load_json(C.web_data() / "countries.json", {}))
    n = record(conn, b["snapshot"])
    C.log.info("travel warnings: %d countries, %d unmapped, %d level changes", len(b["countries"]), len(b["unmapped"]), n)
    return {"ok": True, "countries": len(b["countries"]), "unmapped": len(b["unmapped"]), "changes": n}


def cdc_changes(conn, since: date) -> list[dict]:
    """CDC advisory changes since a date: new advisory, level change, or lifted (to 0); global diseases excluded."""
    from . import export as X
    territories = X._manual("territories.json")
    hist: dict[tuple, list] = defaultdict(list)
    for r in conn.execute("SELECT * FROM alerts_raw WHERE alert_disease != ?", (C.COVID_OLD,)):
        lvl = C.LEVEL_OF.get(r["severity_level"])
        if lvl is None:
            continue
        iso = X.resolve_iso(r, territories)
        hist[(r["alert_disease"], iso or r["areaDesc"], r["areaDetail"])].append((X._ts(r["effective"]), lvl, iso, r))
    out = []
    for (disease, _k, area), rows in hist.items():
        rows.sort(key=lambda x: (x[0], x[1]))
        for i, (ts, lvl, iso, _r) in enumerate(rows):
            if ts.date() < since or not iso:
                continue
            prev = rows[i - 1][1] if i else None
            if prev == lvl:
                continue
            out.append({"date": ts.date().isoformat(), "iso": iso, "disease": disease, "area_zh": area or "",
                        "from": prev, "to": lvl})
    counts = defaultdict(set)  # drop global background advisories (same disease applied to >= 150 countries)
    for c in out:
        counts[(c["disease"], c["date"])].add(c["iso"])
    out = [c for c in out if len(counts[(c["disease"], c["date"])]) < C.GLOBAL_MIN_COUNTRIES]
    out.sort(key=lambda c: (c["date"], c["iso"]), reverse=True)
    return out


def export(conn, out_dir) -> dict | None:
    raw = read_raw()
    if raw is None:
        return None
    rows, rss = raw
    b = build(rows, rss, name_resolver(conn), _mac(), C.load_json(C.web_data() / "countries.json", {}))
    st = {r["name"]: dict(r) for r in conn.execute("SELECT * FROM source_state")} if conn is not None else {}
    since = C.today() - timedelta(days=CHANGE_DAYS)
    mofa_changes = [{"date": r["date"], "iso": r["iso"], "area_zh": r["area_zh"] or "", "from": r["from_level"], "to": r["to_level"]}
                    for r in conn.execute("SELECT * FROM mofa_changes WHERE date >= ? ORDER BY date DESC, iso", (since.isoformat(),))]
    mac = _mac()
    boca_st = st.get("boca") or {}
    doc = {
        "generated_at": C.iso_ts(),
        "sources": {
            "mofa": {"url": LIST_URL, "rss": RSS_URL, "fetched_at": boca_st.get("fetched_at") or "",
                     "items": len(rows), "ok": bool(boca_st.get("ok", 1))},
            "mac": {"url": mac.get("source_url", ""), "confirmed": mac.get("confirmed", ""), "manual": True},
        },
        "levels": LEVELS,
        "regions": {k: {"zh": v[0], "en": v[1]} for k, v in REGIONS.items()},
        "countries": b["countries"],
        "unmapped": b["unmapped"],
        "changes": {"mofa": mofa_changes, "cdc": cdc_changes(conn, since)},
    }
    C.write_json(out_dir / "warnings.json", doc)
    C.write_json(out_dir / "warnings-text.json", b["texts"])
    return doc


def main(argv=None) -> int:
    from . import db
    conn = db.connect()
    print(json.dumps(load(conn), ensure_ascii=False))
    doc = export(conn, C.web_data())
    if doc:
        lv = defaultdict(int)
        for c in doc["countries"].values():
            lv[c["level"]] += 1
        print(f"warnings.json: {len(doc['countries'])} countries, levels {dict(lv)}, unmapped {len(doc['unmapped'])}, "
              f"changes mofa {len(doc['changes']['mofa'])} cdc {len(doc['changes']['cdc'])}")
    return 0
