"""Parse Taoyuan Airport (TPE) flight data: a_flight_v4.txt, the timetable HTML and embedded JSON.

Everything here is pure (no network) so it can be exercised offline against saved raw responses in
data/raw/flights/. Parsers are deliberately defensive: the exact markup of the site is only known from
real fetches in GitHub Actions.
"""
from __future__ import annotations

import csv
import io
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from . import common as C

try:  # optional: normalise simplified -> traditional city names
    from opencc import OpenCC
    _CC = OpenCC("s2t")
except Exception:  # pragma: no cover
    _CC = None

HERE = Path(__file__).parent


@dataclass
class Rec:
    direction: str            # 'D' departure from TPE, 'A' arrival at TPE
    iata: str
    flight: str = ""          # e.g. CI802
    airline: str = ""         # IATA airline code, e.g. CI
    city_en: str = ""
    city_zh: str = ""
    date: str = ""            # YYYY-MM-DD (scheduled), may be empty for HTML
    time: str = ""            # HH:MM scheduled, may be empty
    op: bool = True           # airline is the operating carrier (False: unknown/codeshare-only)


# ----------------------------------------------------------------- helpers
def decode_bytes(raw: bytes) -> str:
    """UTF-8 (with/without BOM) first, then Big5 variants, finally lossy."""
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    for enc in ("utf-8", "cp950", "big5hkscs"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def norm_direction(v: str) -> str:
    v = (v or "").strip().upper()
    if v in ("D", "DEP", "DEPARTURE", "DEPARTURES", "DEPART", "出境", "出發", "離境", "O", "OUT"):
        return "D"
    if v in ("A", "ARR", "ARRIVAL", "ARRIVALS", "ARRIVE", "入境", "抵達", "到達", "I", "IN"):
        return "A"
    return ""


def norm_date(v: str) -> str:
    m = re.search(r"(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})", v or "")
    if not m:
        return ""
    y, mo, d = (int(x) for x in m.groups())
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return ""


def norm_time(v: str) -> str:
    m = re.search(r"\b([01]?\d|2[0-3]):?([0-5]\d)\b", v or "")
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def tidy_city(s: str) -> str:
    s = re.sub(r"\s+", " ", s or "").strip(" ,/-")
    s = re.sub(r"(?<=[A-Za-z])\(", " (", s)
    if s and s.upper() == s and re.search(r"[A-Z]{3}", s):
        s = s.title()
    return s


def to_trad(s: str) -> str:
    return _CC.convert(s) if (_CC and s) else s


def airline_of(flight: str, airline: str = "") -> str:
    a = (airline or "").strip().upper()
    if re.fullmatch(r"[A-Z0-9]{2,3}", a):
        return a
    m = re.match(r"([A-Z][A-Z0-9]|[0-9][A-Z])\d", (flight or "").upper())
    return m.group(1) if m else ""


# ------------------------------------------------------- a_flight_v4.txt
def parse_flight_file(data: bytes | str) -> list[Rec]:
    """20 delimited fields: terminal, A/D, airline IATA, airline zh, flight no, gate, sched date, sched time,
    est date, est time, dest/origin IATA, dest EN, dest ZH, status, aircraft, via IATA, via EN, via ZH, belt, counter."""
    text = decode_bytes(data) if isinstance(data, (bytes, bytearray)) else data
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return []
    sample = "\n".join(lines[:20])
    delim = max([",", "\t", "|", ";"], key=sample.count)
    recs: list[Rec] = []
    for row in csv.reader(lines, delimiter=delim):
        row = [c.strip() for c in row]
        if len(row) < 11:
            continue
        off = None
        for i in (1, 0, 2):  # normally field index 1; tolerate a missing/extra leading column
            if norm_direction(row[i]) in ("A", "D") and len(row[i]) <= 12:
                off = i - 1
                break
        if off is None:
            continue

        def f(i, row=row, off=off):
            j = i + off
            return row[j] if 0 <= j < len(row) else ""

        iata = f(10).upper()
        if not re.fullmatch(r"[A-Z]{3}", iata):
            continue
        fl = f(4).upper().replace(" ", "")
        al = f(2).upper()
        if fl.isdigit() and al:
            fl = al + fl
        recs.append(Rec(direction=norm_direction(f(1)), iata=iata, flight=fl, airline=airline_of(fl, al),
                        city_en=tidy_city(f(11)), city_zh=tidy_city(f(12)), date=norm_date(f(6)), time=norm_time(f(7))))
    return recs


def looks_like_flight_file(text: str) -> bool:
    head = [ln for ln in text.splitlines()[:30] if ln.strip()]
    if not head or "<html" in text[:2000].lower() or text.lstrip()[:1] in "{[":
        return False
    ok = sum(1 for ln in head if ln.count(",") >= 10 or ln.count("\t") >= 10)
    return ok >= max(1, len(head) // 2)


# ------------------------------------------------------------- HTML / JSON
FLIGHT_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{2,4})[A-Z]?(?![A-Za-z0-9])")
IATA_RE = re.compile(r"(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])")
IATA_STOP = {"TPE", "ETA", "ETD", "DEP", "ARR", "GAT", "NEW", "THE", "AIR", "FLT", "LCC", "TBA", "TBD", "ALL", "NOW", "MAP", "FAQ", "VIP", "USA", "EVA", "CAL", "PDF"}
_DEP = r"(?:departures?|departing|出境|出發|離境)"
_ARR = r"(?:arrivals?|arriving|入境|抵達|到達)"
_TAIL = r"(?:\s*(?:flights?|timetable|schedule|航班|班機|時刻表|資訊))?"
DEP_LABEL = re.compile(rf"^\W*{_DEP}{_TAIL}\W*$", re.I)
ARR_LABEL = re.compile(rf"^\W*{_ARR}{_TAIL}\W*$", re.I)
DEP_ATTR = re.compile(r"depart|(?<![a-z])dep(?![a-z])|outbound|出境|出發", re.I)
ARR_ATTR = re.compile(r"arriv|(?<![a-z])arr(?![a-z])|inbound|入境|抵達", re.I)


def _attr_dir(el) -> str:
    vals = [str(el.get("id") or "")]
    cls = el.get("class")
    vals += cls if isinstance(cls, list) else [str(cls or "")]
    for k, v in (el.attrs or {}).items():
        if isinstance(k, str) and (k.startswith("data-") or k in ("name", "aria-label", "aria-labelledby", "title")):
            vals.append(str(v))
    s = " ".join(vals)
    d, a = bool(DEP_ATTR.search(s)), bool(ARR_ATTR.search(s))
    return "D" if d and not a else "A" if a and not d else ""


def _label_dir(text: str) -> str:
    t = (text or "").strip()
    if not t or len(t) > 30:
        return ""
    if DEP_LABEL.match(t):
        return "D"
    if ARR_LABEL.match(t):
        return "A"
    return ""


def _row_direction(el) -> str:
    # 1) explicit marker in the row (cell text or attribute)
    for cell in el.find_all(["td", "th", "span", "div"], recursive=True)[:40]:
        if cell.find(True):  # only leaf elements
            continue
        t = cell.get_text(strip=True)
        d = _label_dir(t)
        if d:
            return d
        if t in ("A", "D") and cell.name in ("td", "th"):
            return t
    d = _attr_dir(el)
    if d:
        return d
    # 2) attributes of ancestors (tab panes, sections)
    for anc in list(el.parents)[:8]:
        if getattr(anc, "attrs", None) is not None:
            d = _attr_dir(anc)
            if d:
                return d
    # 3) nearest preceding heading-like label
    for i, s in enumerate(el.find_all_previous(string=True)):
        if i > 600:
            break
        d = _label_dir(str(s))
        if d:
            return d
    return ""


def _iata_in(text: str, airports: dict | None) -> tuple[str, str]:
    """Return (iata, remaining text). A code in its own token / parentheses wins over loose matches."""
    cands = [m for m in IATA_RE.finditer(text) if m.group(1) not in IATA_STOP and
             (airports is None or m.group(1) in airports)]
    if not cands:
        return "", text
    m = cands[0]
    return m.group(1), (text[:m.start()] + " " + text[m.end():])


def _clean_name(s: str) -> str:
    s = s.replace("（", "(").replace("）", ")")
    s = re.sub(r"[\[\]/|]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip(" -,")
    if s.count("(") != s.count(")"):
        s = s.replace("(", " ").replace(")", " ").strip()
    if re.search(r"\d", s) or len(s) > 40:
        return ""
    return s


def parse_timetable_html(html: str, lang: str = "en", airports: dict | None = None) -> list[Rec]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    recs: list[Rec] = []
    seen_rows = set()
    for node in soup.find_all(string=FLIGHT_RE):
        if node.parent and node.parent.name in ("script", "style", "noscript", "head", "title"):
            continue
        el = node.parent
        row = None
        while el is not None and getattr(el, "name", None) not in (None, "body", "html", "[document]", "table", "tbody", "thead", "ul", "ol"):
            text = el.get_text(" ", strip=True)
            if el.name != "tr" and len({m.group(0) for m in FLIGHT_RE.finditer(text)}) > 2:
                break  # climbed into a container holding several rows
            iata, _ = _iata_in(text, airports)
            if iata:
                row = el
                break
            if el.name == "tr":
                break
            el = el.parent
        if row is None or id(row) in seen_rows:
            continue
        seen_rows.add(id(row))
        text = row.get_text(" ", strip=True)
        m = FLIGHT_RE.search(text)
        flight = (m.group(1) + m.group(2)) if m else ""
        iata, rest = _iata_in(text, airports)
        # city: text of the element/cell that holds the IATA code, minus the code
        city = ""
        pat = rf"(?<![A-Za-z]){iata}(?![A-Za-z])"
        for cell in row.find_all(True):
            if cell.find(True) or not re.search(pat, cell.get_text(" ", strip=True)):
                continue
            el2 = cell  # the leaf holding the code; widen to its cell/item until a name shows up
            while el2 is not None and el2 is not row and el2.name not in ("tr", "tbody", "table", "ul", "ol"):
                city = _clean_name(re.sub(pat, " ", el2.get_text(" ", strip=True)))
                if city:
                    break
                el2 = el2.parent
            if not city:  # code alone in its cell: try class-hinted neighbours
                for sib in row.find_all(class_=re.compile(r"dest|city|origin|airport|route|地點|目的", re.I)):
                    city = _clean_name(re.sub(pat, " ", sib.get_text(" ", strip=True)))
                    if city:
                        break
            break
        d = _row_direction(row)
        if not d:
            continue
        recs.append(Rec(direction=d, iata=iata, flight=flight, airline=airline_of(flight),
                        city_en=tidy_city(city) if lang == "en" else "",
                        city_zh=to_trad(city) if lang == "zh" else "", time=norm_time(text)))
    return recs


KEYMAP = {
    "flight": ("flightno", "flight_no", "flightnumber", "flight", "fltno", "flightnum", "航班", "班次", "航班編號"),
    "dir": ("ad", "a_d", "type", "direction", "flighttype", "arrdep", "depart_arrive", "出入境"),
    "iata": ("airportcode", "destinationcode", "origincode", "destcode", "iata", "airport_iata", "airportiata",
             "destinationairportcode", "originairportcode", "targetairport", "目的地代碼", "起降機場代碼", "到達機場代碼"),
    "city_en": ("airportnameen", "destinationen", "originen", "cityen", "airportname", "destination", "origin", "airporten"),
    "city_zh": ("airportnamezh", "destinationzh", "originzh", "cityzh", "airportnamecn", "起降地點", "目的地", "出發地"),
    "airline": ("airlinecode", "airlineiata", "airline", "carrier", "航空公司代碼", "航空公司"),
    "date": ("scheduledate", "schedulerdate", "scheduleddate", "date", "預定日期"),
    "time": ("scheduletime", "scheduledtime", "time", "預定時間"),
}


def _walk_lists(obj):
    if isinstance(obj, list):
        if obj and all(isinstance(x, dict) for x in obj[:5]):
            yield obj
        for x in obj:
            yield from _walk_lists(x)
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_lists(v)


def parse_json_records(obj, airports: dict | None = None, default_direction: str = "") -> list[Rec]:
    """Heuristic: any list of dicts whose keys look like flight records."""
    recs: list[Rec] = []
    for lst in _walk_lists(obj):
        keys = {re.sub(r"[\s_\-]", "", str(k)).lower(): k for k in lst[0].keys()}

        def pick(name, keys=keys):
            for cand in KEYMAP[name]:
                c = re.sub(r"[\s_\-]", "", cand).lower()
                if c in keys:
                    return keys[c]
            return None

        kf, ki = pick("flight"), pick("iata")
        if not kf or not ki:
            continue
        kd, kce, kcz, kal, kdt, ktm = (pick(n) for n in ("dir", "city_en", "city_zh", "airline", "date", "time"))
        for r in lst:
            iata = str(r.get(ki, "")).strip().upper()
            if not re.fullmatch(r"[A-Z]{3}", iata) or (airports is not None and iata not in airports):
                continue
            d = norm_direction(str(r.get(kd, ""))) if kd else ""
            d = d or default_direction
            if not d:
                continue
            fl = str(r.get(kf, "")).upper().replace(" ", "")
            recs.append(Rec(direction=d, iata=iata, flight=fl, airline=airline_of(fl, str(r.get(kal, "")) if kal else ""),
                            city_en=tidy_city(str(r.get(kce, ""))) if kce else "", city_zh=tidy_city(str(r.get(kcz, ""))) if kcz else "",
                            date=norm_date(str(r.get(kdt, ""))) if kdt else "", time=norm_time(str(r.get(ktm, ""))) if ktm else ""))
    return recs


def extract_embedded_json(html: str) -> list:
    """JSON blobs inside <script> tags: application/json, __NEXT_DATA__, __NUXT__/__INITIAL_STATE__ assignments."""
    from bs4 import BeautifulSoup

    out = []
    dec = json.JSONDecoder()
    for sc in BeautifulSoup(html, "lxml").find_all("script"):
        txt = (sc.string or sc.get_text() or "").strip()
        if not txt or len(txt) < 20:
            continue
        typ = (sc.get("type") or "").lower()
        if "json" in typ or sc.get("id") == "__NEXT_DATA__":
            try:
                out.append(json.loads(txt))
                continue
            except ValueError:
                pass
        for m in re.finditer(r"(?:window\.)?(__NUXT__|__INITIAL_STATE__|__APP_DATA__|initialData|flightData|flights?)\s*=\s*([\[{])", txt):
            try:
                obj, _ = dec.raw_decode(txt[m.start(2):])
                out.append(obj)
            except ValueError:
                continue
        for m in re.finditer(r"JSON\.parse\(\s*(['\"])(.+?)\1\s*\)", txt):
            try:
                out.append(json.loads(bytes(m.group(2), "utf-8").decode("unicode_escape")))
            except Exception:
                continue
    return out


def parse_any(raw: bytes | str, lang: str = "en", airports: dict | None = None) -> tuple[str, list[Rec]]:
    """Sniff the content type. Returns (kind, records) with kind in file|json|html|unknown."""
    text = decode_bytes(raw) if isinstance(raw, (bytes, bytearray)) else raw
    stripped = text.lstrip()
    if stripped[:1] in "{[":
        try:
            obj = json.loads(stripped)
            from . import tdx  # lazy: tdx imports this module
            if tdx.looks_like_fids(obj):
                return "tdx", tdx.parse_fids(obj)
            return "json", parse_json_records(obj, airports)
        except ValueError:
            pass
    if looks_like_flight_file(text):
        recs = parse_flight_file(text)
        if recs:
            return "file", recs
    if "<" in stripped[:5000]:
        recs: list[Rec] = []
        for blob in extract_embedded_json(text):
            recs += parse_json_records(blob, airports)
        if recs:
            return "html-json", recs
        return "html", parse_timetable_html(text, lang, airports)
    return "unknown", []


# ------------------------------------------------------------ aggregation
def choose_day(recs: list[Rec], today: str) -> str:
    days = Counter(r.date for r in recs if r.date)
    if not days or today in days:
        return today
    return days.most_common(1)[0][0]


def aggregate(recs: list[Rec], day: str, zh_fallback: dict | None = None, name_sources: list[list[Rec]] | None = None,
              names: dict | None = None) -> list[dict]:
    """Per destination IATA: distinct departures / arrivals on `day`, airlines by frequency, source names.
    `names` ({iata: (en, zh)}, e.g. from TDX) beats names found in the records, which beat the built-in zh table."""
    zh_fallback = zh_fallback if zh_fallback is not None else C.load_json(HERE / "airport_zh.json", {}) or {}
    names = names or {}
    seen = set()
    dep: Counter = Counter()
    arr: Counter = Counter()
    op_airlines: dict[str, Counter] = defaultdict(Counter)
    any_airlines: dict[str, Counter] = defaultdict(Counter)
    for r in recs:
        if r.date and r.date != day:
            continue
        key = (r.direction, r.iata, r.flight or id(r), r.date, r.time)
        if key in seen:
            continue
        seen.add(key)
        (dep if r.direction == "D" else arr)[r.iata] += 1
        if r.airline:
            any_airlines[r.iata][r.airline] += 1
            if r.op:
                op_airlines[r.iata][r.airline] += 1
    en: dict[str, Counter] = defaultdict(Counter)
    zh: dict[str, Counter] = defaultdict(Counter)
    for rs in [recs] + (name_sources or []):
        for r in rs:
            if r.city_en:
                en[r.iata][r.city_en] += 1
            if r.city_zh:
                zh[r.iata][r.city_zh] += 1
    routes = []
    for iata in sorted(set(dep) | set(arr)):
        al = op_airlines[iata] or any_airlines[iata]
        nen, nzh = names.get(iata, ("", ""))
        routes.append({
            "iata": iata,
            "departures": dep[iata], "arrivals": arr[iata],
            "airlines": [a for a, _ in sorted(al.items(), key=lambda kv: (-kv[1], kv[0]))][:12],
            "city_en": nen or (en[iata].most_common(1)[0][0] if en[iata] else ""),
            "city_zh": nzh or (to_trad(zh[iata].most_common(1)[0][0]) if zh[iata] else zh_fallback.get(iata, "")),
        })
    routes.sort(key=lambda r: (-(r["departures"] + r["arrivals"]), r["iata"]))
    return routes


def load_airports() -> dict:
    return C.load_json(C.web_data() / "airports.json", {}) or {}


def parse_saved_file(path: Path, lang: str | None = None) -> tuple[str, list[Rec]]:
    """Parse a raw file saved by fetch (used by `flights --from-file`)."""
    path = Path(path)
    if lang is None:
        lang = "zh" if re.search(r"(?:[_.-]|lang=)zh", path.name, re.I) else "en"
    return parse_any(path.read_bytes(), lang, load_airports())
