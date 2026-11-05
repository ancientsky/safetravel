"""Taiwan CDC travel medicine open data (od.cdc.gov.tw, monthly): travel clinics, their opening hours and the
per-country "travel prescription" (vaccines, preventive advice, prevalent diseases).

    fetch()   download the three CSVs into data/raw/travelmed/ (keeps the previous file when a download looks wrong)
    build()   parse them into web/data/travelmed.json (docs/DATA_CONTRACT.md); English from data/manual/travelmed_en.json

Run in GitHub Actions only (no network to cdc.gov.tw from the dev sandbox). Never blocks the data update.
od.cdc.gov.tw (like data.gov.tw) does not answer GitHub-hosted runners (connect timeout, 2026-11): files placed in
data/raw/travelmed/ by hand are kept and used; a connect failure skips the remaining files so a run loses ~8 s, not 90.
The full per-country text comes from the www.cdc.gov.tw web pages instead (travelmed_pages.py), which runners can reach.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from pathlib import Path
from urllib.parse import urlparse

from . import common as C
from . import http

SOURCES = {
    # name: (url, file, columns that must be in the header, minimum data rows)
    "clinics": ("https://od.cdc.gov.tw/quarantine/TMClinicsList.csv", "TMClinicsList.csv",
                ["醫事機構代碼", "合約醫院名稱", "所在縣市"], 10),
    "hours": ("https://od.cdc.gov.tw/quarantine/ClinicsTime.csv", "ClinicsTime.csv",
              ["醫事機構代碼", "星期", "時段"], 50),
    "prescription": ("https://od.cdc.gov.tw/quarantine/TMPrescription.csv", "TMPrescription.csv",
                     ["疾病", "疫苗"], 200),
}
def raw_dir() -> Path:
    return C.ROOT / "data" / "raw" / "travelmed"


def _norm(s: str) -> str:
    return C.nfkc(s or "").replace(" ", "").strip()


def check(body: bytes, columns: list[str], min_rows: int) -> tuple[int, str | None]:
    """(data rows, problem or None): UTF-8 (BOM allowed), a header holding every expected column, enough rows."""
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = body.decode("cp950")
        except UnicodeDecodeError:
            return 0, "not UTF-8 / Big5 text"
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return 0, "empty file"
    head = [_norm(h) for h in rows[0]]
    missing = [c for c in columns if not any(_norm(c) in h for h in head)]
    if missing:
        return 0, f"header lacks {', '.join(missing)}"
    n = sum(1 for r in rows[1:] if any(x.strip() for x in r))
    if n < min_rows:
        return n, f"only {n} rows (expected at least {min_rows})"
    return n, None


def fetch(session=None) -> dict:
    """Download the three files; each is replaced only when the new copy passes check()."""
    st = {"url": SOURCES["prescription"][0], "ok": False, "fetched_at": C.iso_ts(), "reason": None, "files": {}}
    d = raw_dir()
    d.mkdir(parents=True, exist_ok=True)
    problems = []
    unreachable = False
    for name, (url, fname, cols, min_rows) in SOURCES.items():
        if unreachable:  # one host for all three: do not spend another connect timeout per file
            problems.append(f"{name}: skipped (host unreachable)")
            continue
        try:
            body = http.get(url, session=session, tries=1, timeout=(8, 60)).content
            n, problem = check(body, cols, min_rows)
            if problem:
                raise ValueError(problem)
            (d / fname).write_bytes(body)
            st["files"][name] = n
        except Exception as e:  # network / format trouble: keep the previous file, report, carry on
            unreachable = unreachable or "Connect" in type(e).__name__ or "Connect" in str(e)
            problems.append(f"{name}: {type(e).__name__}: {e}")
            C.log.warning("travel medicine %s not refreshed: %s", name, e)
    st["ok"] = not problems
    st["reason"] = "; ".join(problems) or None
    C.log.info("travel medicine: %s", st["files"])
    return st


# ------------------------------------------------------------------- build web/data/travelmed.json
FILES = {name: fname for name, (_u, fname, _c, _m) in SOURCES.items()}
DIS_GROUPS = {"蟲媒傳染": "vector", "食物或飲水傳染": "food", "接觸傳染": "contact", "其他類": "other"}
ADV_GROUPS = {"預防蚊蟲叮咬-建議": "bites", "注意飲食安全-建議": "food", "避免接觸動物-建議": "animals",
              "感染血吸蟲風險-建議": "water", "其他類-建議": "other"}
VAX_GROUP = "預防接種規定及建議"
DIS_MAIN = "當地其他相關疾病"
LEVEL_MAIN = "國際旅遊疫情建議等級"  # duplicates alerts.json (the live CDC advisory feed): not exported
QUAL = re.compile(r"^(.+?)\((.+)\)$")
SLOTS = {"早": 0, "午": 1, "夜": 2}


def _rows(path: Path) -> list[dict]:
    text = path.read_bytes().decode("utf-8-sig")
    rd = csv.reader(io.StringIO(text))
    head = [_norm(h) for h in next(rd, [])]
    return [dict(zip(head, (C.nfkc(x) for x in r))) for r in rd if any(x.strip() for x in r)]


def _col(row: dict, *names: str) -> str:
    for n in names:
        n = _norm(n)
        if n in row:
            return row[n]
        for k in row:  # header with extra decoration, e.g. "ISO3166-1(numeric)"
            if n in k:
                return row[k]
    return ""


def _day(s: str) -> str:
    m = re.fullmatch(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", s or "")
    return f"{int(m[1]):04d}-{int(m[2]):02d}-{int(m[3]):02d}" if m else ""


def _href(u: str) -> str:
    """http(s) URL without credentials, else ''. Hospital sites are not all https."""
    try:
        x = urlparse(u or "")
    except ValueError:
        return ""
    return u if x.scheme in ("http", "https") and x.hostname and not x.username and not x.password else ""


def _float(s: str):
    try:
        return round(float(s), 6)
    except ValueError:
        return None


class _Terms:
    """Disease and advice strings, stored once and referenced by index (advice repeats in ~200 countries)."""

    def __init__(self, en: dict, disease_en):
        self.items: list[dict] = []
        self.idx: dict[str, int] = {}
        self.en = en
        self.disease_en = disease_en
        self.missing: set[str] = set()

    def _add(self, zh: str, en: str, base: str | None = None) -> int:
        if zh not in self.idx:
            self.idx[zh] = len(self.items)
            self.items.append({"zh": C.zh_punct(zh), "en": en, **({"base": base} if base else {})})
        return self.idx[zh]

    def advice(self, zh: str) -> int:
        en = self.en["advice"].get(zh)
        if not en:
            self.missing.add(zh)
        return self._add(zh, en or zh)

    def disease(self, zh: str) -> int:
        m = QUAL.match(zh)
        base, qual = (m[1].strip(), m[2].strip()) if m else (zh, "")
        b_en = self.disease_en(base)
        q_en = self.en["qualifiers"].get(qual, "") if qual else ""
        if b_en == base or (qual and not q_en):
            self.missing.add(zh)
        en = f"{b_en} ({q_en or qual})" if qual else b_en
        return self._add(zh, en, base if qual else None)


def _place_index() -> tuple[dict, dict, dict]:
    countries = C.load_json(C.web_data() / "countries.json", {}) or {}
    by_zh = {C.nfkc(v.get("zh")): k for k, v in countries.items()}
    by_en = {C.nfkc(v.get("en")).lower(): k for k, v in countries.items()}
    ter = C.load_json(C.manual_dir() / "territories.json", {}) or {}
    by_en.update({C.nfkc(k).lower(): v for k, v in ter.items() if not k.startswith("_") and v})
    return countries, by_zh, by_en


def _sha(d: Path) -> str:
    h = hashlib.sha1()
    for f in FILES.values():
        p = d / f
        h.update(p.read_bytes() if p.exists() else b"")
    return h.hexdigest()


def build(out_dir: Path | None = None, raw: Path | None = None) -> dict | None:
    """Write travelmed.json from the raw CSVs; None (and nothing written) when they are missing or unusable."""
    raw = raw or raw_dir()
    out_dir = out_dir or C.web_data()
    if not all((raw / f).exists() for f in FILES.values()):
        C.log.info("travel medicine: raw files missing in %s, travelmed.json not rebuilt", raw)
        return None
    en = C.load_json(C.manual_dir() / "travelmed_en.json", {}) or {}
    for k in ("advice", "vaccines", "diseases", "qualifiers", "cities", "departments", "clinics", "places"):
        en.setdefault(k, {})
    manual_dis = {C.nfkc(k): v for k, v in (C.load_json(C.manual_dir() / "diseases.json", {}) or {}).items()
                  if not k.startswith("_")}
    alerts_dis = {k: v.get("en") for k, v in ((C.load_json(out_dir / "alerts.json", {}) or {}).get("diseases") or {}).items()}

    def disease_en(zh: str) -> str:
        return en["diseases"].get(zh) or manual_dis.get(zh) or alerts_dis.get(zh) or zh

    terms = _Terms(en, disease_en)
    countries_geo, by_zh, by_en = _place_index()
    places = {C.nfkc(k): v for k, v in en["places"].items() if not k.startswith("_")}

    # ---- prescription: one block per CDC place, in file order
    blocks: dict[str, dict] = {}
    unknown_main: set[str] = set()
    for r in _rows(raw / FILES["prescription"]):
        zh, en_name = _col(r, "國名(中)"), _col(r, "國名(英)")
        if not zh:
            continue
        b = blocks.setdefault(zh, {"zh": zh, "en": en_name, "vax": [], "dis": {}, "adv": {}})
        main, sub = _col(r, "主類別"), _col(r, "次類別")
        if main == LEVEL_MAIN:
            continue
        if main == VAX_GROUP:
            v = _col(r, "疫苗")
            if v and v not in b["vax"]:
                b["vax"].append(v)
        elif main == DIS_MAIN:
            d = _col(r, "疾病")
            if d:
                lst = b["dis"].setdefault(DIS_GROUPS.get(sub, "other"), [])
                i = terms.disease(d)
                if i not in lst:
                    lst.append(i)
        elif main in ADV_GROUPS:
            if sub:
                lst = b["adv"].setdefault(ADV_GROUPS[main], [])
                i = terms.advice(sub)
                if i not in lst:
                    lst.append(i)
        else:
            unknown_main.add(main)
    if unknown_main:
        C.log.warning("travel medicine: unknown 主類別 skipped: %s", ", ".join(sorted(unknown_main)))

    # ---- places → ISO alpha-2; parts of a country (Canary Islands …) become "subs" of their parent
    def resolve(zh: str, en_name: str):
        """("main", ISO) | ("sub", parent ISO) | None"""
        if zh in places:
            p = places[zh]
            if p is None:
                return None
            if isinstance(p, dict):
                return ("sub", p.get("sub", ""))
            return ("main", p)
        iso = by_zh.get(zh) or by_en.get(C.nfkc(en_name).lower())
        return ("main", iso) if iso else None

    countries: dict[str, dict] = {}
    subs: list[tuple[str, dict]] = []
    unmapped: list[str] = []
    where: dict[str, tuple] = {}
    for zh, b in blocks.items():
        r = resolve(zh, b["en"])
        if r is None:
            if zh not in places:
                unmapped.append(zh)
            continue
        kind, iso = r
        if kind == "sub":
            subs.append((iso, b))
            continue
        if iso not in countries_geo:
            unmapped.append(zh)
            continue
        if iso in countries:  # a second CDC place on the same ISO code: the one named like the country is the main
            geo = countries_geo[iso]
            if C.nfkc(geo.get("zh")) == zh or C.nfkc(geo.get("en")).lower() == C.nfkc(b["en"]).lower():
                subs.append((iso, countries[iso]))
                countries[iso] = b
            else:
                subs.append((iso, b))
            continue
        countries[iso] = b
    for iso, b in subs:
        if iso in countries:
            countries[iso].setdefault("subs", []).append(b)
        else:
            unmapped.append(b["zh"])
    for iso, b in countries.items():
        where[b["zh"]] = ("main", iso)
        for sb in b.get("subs", []):
            where[sb["zh"]] = ("sub", iso)
    if unmapped:
        C.log.warning("travel medicine: %d places without an ISO code: %s", len(unmapped), ", ".join(unmapped))

    # ---- full web-page text per country (travelmed_pages.crawl) → web/data/travelmed/<ISO>.json
    details = _page_details(resolve, where, countries, set(places))
    page_vax: set[str] = set()
    for iso, det in details.items():
        countries[iso]["page"] = det["checked"]
        for pg in [det["page"]] + [sb["page"] for sb in det["subs"]]:
            page_vax.update(v["name"] for v in pg["vaccines"])
    all_vax = {v for b in blocks.values() for v in b["vax"]} | page_vax
    unknown_vax = sorted(all_vax - set(en["vaccines"]))
    vaccines = {v: {"zh": v, "en": (en["vaccines"].get(v) or {}).get("en") or v,
                    "for": list((en["vaccines"].get(v) or {}).get("for") or [])}
                for v in sorted(all_vax)}

    # ---- clinics and their weekly sessions (Mon..Sun x morning/afternoon/evening)
    hours: dict[str, list[list[int]]] = {}
    for r in _rows(raw / FILES["hours"]):
        code, name = _col(r, "醫事機構代碼"), _col(r, "合約醫院名稱")
        try:
            day = int(_col(r, "星期")) - 1
        except ValueError:
            continue
        slot = SLOTS.get(_col(r, "時段"))
        if slot is None or not 0 <= day < 7:
            continue
        for key in (code, "name:" + name):
            g = hours.setdefault(key, [[0, 0, 0] for _ in range(7)])
            g[day][slot] = 1 if _col(r, "是否看診") == "1" else 0
    clinics = []
    no_hours = []
    for r in _rows(raw / FILES["clinics"]):
        code, name = _col(r, "醫事機構代碼"), _col(r, "合約醫院名稱")
        if not code or not name:
            continue
        g = hours.get(code) or hours.get("name:" + name)  # the two files disagree on one code (Penghu, 2026-11)
        if g is None:
            no_hours.append(name)
        city, dept = _col(r, "所在縣市"), _col(r, "看診科別")
        clinics.append({
            "id": code, "name": name, "name_en": en["clinics"].get(code, ""),
            "city": city, "zip": _col(r, "郵遞區號"), "addr": _col(r, "合約醫院地址"),
            "lat": _float(_col(r, "緯度")), "lon": _float(_col(r, "經度")),
            "dept": dept, "dept_en": en["departments"].get(dept, ""),
            "tel": _col(r, "合約醫院電話"), "url": _href(_col(r, "合約醫院網站")),
            "since": _day(_col(r, "開辦日期")), "mpox": _col(r, "M痘疫苗接種") == "1",
            "hours": ["".join(str(x) for x in day) for day in g] if g else None,
        })
    if no_hours:
        C.log.warning("travel medicine: no opening hours for %s", ", ".join(no_hours))
    order = list(en["cities"])
    clinics.sort(key=lambda c: (order.index(c["city"]) if c["city"] in order else len(order), c["city"], c["name"]))
    cities = [{"zh": c, "en": en["cities"].get(c, c)} for c in dict.fromkeys(x["city"] for x in clinics)]

    if terms.missing or unknown_vax:
        C.log.warning("travel medicine: no English for %s", "; ".join(sorted(terms.missing | set(unknown_vax))))

    sha = _sha(raw)
    prev = C.load_json(out_dir / "travelmed.json", {}) or {}
    updated = prev.get("updated") if prev.get("sha") == sha and prev.get("updated") else C.today().isoformat()
    doc = {
        "generated_at": C.iso_ts(), "updated": updated, "sha": sha,
        "sources": {k: SOURCES[k][0] for k in SOURCES},
        "terms": terms.items, "vaccines": vaccines,
        "countries": dict(sorted(countries.items())), "unmapped": sorted(unmapped),
        "cities": cities, "clinics": clinics,
    }
    if len(countries) < 150 or len(clinics) < 10:
        C.log.warning("travel medicine: only %d countries / %d clinics, travelmed.json not rebuilt", len(countries), len(clinics))
        return None
    C.write_json(out_dir / "travelmed.json", doc)
    _write_details(out_dir / "travelmed", details)
    C.log.info("travel medicine: %d countries (%d unmapped), %d clinics, %d terms",
               len(countries), len(unmapped), len(clinics), len(terms.items))
    return doc


def _page_details(resolve, where: dict, countries: dict, explicit: set) -> dict[str, dict]:
    """ISO → {"iso", "cid", "zh", "en", "checked", "url", "page", "subs"} from data/raw/travelmed/pages."""
    from . import travelmed_pages as P
    d = P.pages_dir()
    index = C.load_json(d / "index.json", {}) or {}
    state = C.load_json(d / "state.json", {}) or {}
    out: dict[str, dict] = {}
    pending_subs: list[tuple[str, dict]] = []
    missing: list[str] = []
    for cid, info in index.items():
        f = d / f"{cid}.html"
        if not f.exists():
            continue
        zh, en_name = C.nfkc(info.get("zh")), C.nfkc(info.get("en"))
        r = where.get(zh) or resolve(zh, en_name)
        if not r or not r[1] or r[1] not in countries:
            missing.append(zh)
            continue
        try:
            page = P.parse(f.read_text(encoding="utf-8"))
        except Exception as e:  # one broken page never stops the export
            C.log.warning("travel prescription page %s (%s) not parsed: %s", cid, zh, e)
            continue
        if not page["vaccines"] and not page["sections"]:
            continue
        checked = ((state.get(cid) or {}).get("checked") or "")[:10] or C.today().isoformat()
        entry = {"cid": cid, "zh": zh, "en": en_name, "checked": checked, "page": page}
        kind, iso = r
        if kind == "sub":
            pending_subs.append((iso, entry))
        elif iso in out:  # two pages for one country: the one named in the places table wins
            if zh in explicit and out[iso]["zh"] not in explicit:
                out[iso] = {"iso": iso, **entry, "url": P.PAGE_URL, "subs": out[iso]["subs"]}
        else:
            out[iso] = {"iso": iso, **entry, "url": P.PAGE_URL, "subs": []}
    for iso, entry in pending_subs:
        if iso in out:
            out[iso]["subs"].append(entry)
    if missing:
        C.log.info("travel prescription pages without a country: %s", ", ".join(missing))
    return out


def _write_details(d: Path, details: dict[str, dict]) -> None:
    d.mkdir(parents=True, exist_ok=True)
    for iso, det in details.items():
        C.write_json(d / f"{iso}.json", det)
    for p in d.glob("*.json"):
        if p.stem not in details:
            p.unlink()
