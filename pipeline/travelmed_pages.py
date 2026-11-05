"""Taiwan CDC 國際旅遊處方箋 web pages (www.cdc.gov.tw): the full per-country text behind TMPrescription.csv —
what each vaccine is for and the entry rules, malaria risk areas and drug resistance, the detailed prevention advice,
care during the trip (the Taiwan mission's emergency number), after-return advice, and the notes for six kinds of
traveller (infants, pregnancy, chronic illness, immunocompromised, long stays, aid workers).

    crawl()   refresh a few pages per run (oldest first, each about every REFRESH_DAYS, ≤ TIME_BUDGET s): data/raw/travelmed/pages/<cid>.html
              holds only the prescription part of the print view (no live alerts, no attributes), so files change only
              when CDC edits the text; state.json records when each page was last checked.
    parse()   one trimmed page → {"sections": {...}, "vaccines": [...], "hotline": ...} of plain-text lines.

The CSV (od.cdc.gov.tw) does not answer GitHub runners; www.cdc.gov.tw does. Requests are spaced REQUEST_GAP seconds
apart and a run stops at the first connection failure. Never blocks the data update.
"""
from __future__ import annotations

import hashlib
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString, Tag

from . import common as C
from . import http

BASE = "https://www.cdc.gov.tw"
FORM_URL = f"{BASE}/Internationaltravel/Index/ZkNLTkRxQ0NyQmc5Rk50dmZZZlI2Zz09"
LIST_URL = f"{BASE}/Internationaltravel/CounterList"
# every traveller group ticked: their notes are tagged in the text, the page shows them on request
GROUP_IDS = "1,2,4,5,9,6"
PRINT_URL = f"{BASE}/InternationalTravel/Print?cid={{cid}}&specificGroupIds={GROUP_IDS.replace(',', '%2C')}&Type=full"
PAGE_URL = FORM_URL  # human-facing link (the page needs a country picked from its form)

GROUPS = {
    "與嬰幼兒同行": "infants", "懷孕婦女": "pregnancy", "慢性病患者": "chronic", "免疫不全症患者": "immuno",
    "長期差旅及居留(6個月以上)": "longstay", "海外服務志工/救援工作者": "aid",
}
KEEP = {  # print-view card title → section key
    "旅遊前的準備": "before", "預防接種規定及建議": "vaccines", "當地其他相關疾病": "diseases",
    "旅途中的健康照護": "during", "返國後注意事項": "after",
}
REFRESH_DAYS = 20
INDEX_DAYS = 7
MAX_PAGES = 15
TIME_BUDGET = 180  # seconds per run: the site answers in ~10 s per page
REQUEST_GAP = 1.5
MIN_HTML = 1500

# "label：text" with a short label (no sentence punctuation inside the label)
LABEL = re.compile(r"^([^:：,，。;；()（）「」]{2,18})[:：]\s*(.*)$")
# paragraphs that always address every traveller: they end a traveller-group block (yellow fever has two of them)
RESET = ("入境預防接種規定", "當地預防接種建議")

INLINE = {"span", "strong", "b", "a", "em", "i", "u", "font", "sup", "sub", "small", "label", "abbr"}
BOLD = {"strong", "b"}


def pages_dir() -> Path:
    return C.ROOT / "data" / "raw" / "travelmed" / "pages"


# ------------------------------------------------------------------- crawl
def _sleep(s: float) -> None:  # patched in tests
    time.sleep(s)


def split_name(text: str) -> tuple[str, str]:
    """'Thailand 泰國' → ('泰國', 'Thailand'); the Chinese part is the trailing run that starts with a CJK character."""
    t = C.nfkc(text)
    m = re.search(r"[㐀-鿿豈-﫿].*$", t)
    if not m:
        return t, t
    return m.group(0).strip(), t[: m.start()].strip()


def fetch_index(session) -> dict[str, dict]:
    """cid → {zh, en, area} from the form's area list and its CounterList endpoint."""
    html = http.get(FORM_URL, session=session, tries=1, timeout=(10, 60)).text
    soup = BeautifulSoup(html, "lxml")
    sel = soup.find("select", id="AreaList")
    areas = [o.get("value") for o in sel.find_all("option")] if sel else []
    areas = [a for a in areas if a and re.fullmatch(r"\d{1,4}", a)]
    if not areas:
        raise ValueError("area list not found on the form page")
    out: dict[str, dict] = {}
    for a in areas:
        _sleep(REQUEST_GAP)
        r = session.post(LIST_URL, data={"Id": a}, timeout=(10, 60))
        r.raise_for_status()
        for o in r.json():
            cid = str(o.get("Value") or "")
            if re.fullmatch(r"\d{1,6}", cid):
                zh, en = split_name(o.get("Text") or "")
                out.setdefault(cid, {"zh": zh, "en": en, "area": a})
    if len(out) < 150:
        raise ValueError(f"only {len(out)} countries in the index")
    return out


def trim(html: str) -> str:
    """Only the prescription cards we use, without scripts, styles or attributes (stable across visits)."""
    soup = BeautifulSoup(html, "lxml")
    parts = []
    for card in soup.select("div.card"):
        title = card.select_one(".card-title")
        body = card.select_one(".card-body")
        if not title or not body:
            continue
        name = C.nfkc(title.get_text(" ", strip=True))
        if name not in KEEP:
            continue
        for bad in body.find_all(["script", "style", "noscript", "iframe", "img", "button", "input", "form"]):
            bad.decompose()
        for el in body.find_all(True):
            el.attrs = {}
        body.attrs = {}
        parts.append(f"<section><h3>{name}</h3>{body}</section>")
    return "\n".join(parts)


def _load_state(d: Path) -> dict:
    return C.load_json(d / "state.json", {}) or {}


def crawl(session=None, *, max_pages: int = MAX_PAGES, budget: float = TIME_BUDGET, now: datetime | None = None) -> dict:
    """Refresh up to max_pages stale pages (and the index weekly). Returns a status dict; never raises."""
    session = session or http.new_session()
    d = pages_dir()
    d.mkdir(parents=True, exist_ok=True)
    now = now or C.now()
    state = _load_state(d)
    st = {"ok": True, "index": None, "checked": 0, "changed": 0, "reason": None}
    try:
        idx_at = state.get("_index_at")
        index = C.load_json(d / "index.json", {}) or {}
        if not index or not idx_at or now - datetime.fromisoformat(idx_at) > timedelta(days=INDEX_DAYS):
            index = fetch_index(session)
            C.write_json(d / "index.json", dict(sorted(index.items(), key=lambda kv: int(kv[0]))), indent=1)
            state["_index_at"] = C.iso_ts(now)
            st["index"] = len(index)
        due = []
        for cid in index:
            seen = (state.get(cid) or {}).get("checked")
            if not seen or not (d / f"{cid}.html").exists():
                due.append(("", cid))
            elif now - datetime.fromisoformat(seen) > timedelta(days=REFRESH_DAYS):
                due.append((seen, cid))
        due.sort()
        t0 = time.monotonic()
        for _, cid in due[:max_pages]:
            if time.monotonic() - t0 > budget:
                break
            _sleep(REQUEST_GAP)
            html = http.get(PRINT_URL.format(cid=cid), session=session, tries=1, timeout=(10, 60)).text
            body = trim(html)
            if len(body) < MIN_HTML or "預防接種" not in body:
                C.log.warning("travel prescription page %s looks wrong (%d chars), kept the previous copy", cid, len(body))
                continue
            sha = hashlib.sha1(body.encode("utf-8")).hexdigest()
            p = d / f"{cid}.html"
            if not p.exists() or (state.get(cid) or {}).get("sha") != sha:
                p.write_text(body + "\n", encoding="utf-8")
                st["changed"] += 1
            state[cid] = {"checked": C.iso_ts(now), "sha": sha}
            st["checked"] += 1
            if st["checked"] % 10 == 0:  # a killed run keeps what it already checked
                C.write_json(d / "state.json", dict(sorted(state.items())), indent=1)
    except Exception as e:  # network / format trouble: keep what we have, report, carry on
        st["ok"] = False
        st["reason"] = f"{type(e).__name__}: {e}"
        C.log.warning("travel prescription pages: %s", st["reason"])
    C.write_json(d / "state.json", dict(sorted(state.items())), indent=1)
    C.log.info("travel prescription pages: checked %d, changed %d%s", st["checked"], st["changed"],
               f", index {st['index']}" if st["index"] else "")
    return st


# ------------------------------------------------------------------- parse
def _clean(s: str) -> str:
    s = C.nfkc(s.replace("﻿", "").replace("​", ""))
    return re.sub(r"\s+", " ", s).strip()


class _Lines:
    """Flatten rich text into lines: {"t": text, "d": list depth, "h": 1 if a heading, "k": bold label, "g": group}."""

    def __init__(self):
        self.out: list[dict] = []
        self.buf: list[tuple[str, bool]] = []
        self.depth = 0
        self.group = None

    def add(self, text: str, bold: bool, group, depth: int):
        if not self.buf:
            self.group, self.depth = group, depth
        self.buf.append((text, bold))

    def flush(self):
        if not self.buf:
            return
        text = _clean("".join(t for t, _ in self.buf))
        if text and text not in ("建議:", "建議："):
            line: dict = {"t": text}
            if self.depth:
                line["d"] = self.depth
            bold_text = _clean("".join(t for t, b in self.buf if b))
            m = LABEL.match(text)
            if bold_text == text and len(text) <= 40 and not (m and m.group(2)):
                line["h"] = 1  # a short line in bold: sub-heading ("預防蚊蟲叮咬", "瘧疾警示")
                line["t"] = text.rstrip(":：").strip()
            elif m and m.group(2):  # "label：text" ("重要流行疾病：…", "腹瀉：…", "外館急難救助專線：…")
                line["k"], line["t"] = m.group(1).strip(), m.group(2).strip()
            line["t"] = C.zh_punct(line["t"])
            if "k" in line:
                line["k"] = C.zh_punct(line["k"])
            if self.group:
                line["g"] = self.group
            if not (self.out and self.out[-1] == line):
                self.out.append(line)
        self.buf = []

    def walk(self, node: Tag, depth: int = 0, group=None, bold: bool = False):
        local = group
        for ch in node.children:
            if isinstance(ch, NavigableString):
                if local and _clean(ch).startswith(RESET):
                    self.flush()
                    local = None
                if ch.strip() or self.buf:
                    self.add(str(ch), bold, local, depth)
                continue
            if not isinstance(ch, Tag):
                continue
            name = ch.name
            if name in BOLD and _clean(ch.get_text()).rstrip(":：") in GROUPS:
                self.flush()
                local = GROUPS[_clean(ch.get_text()).rstrip(":：")]
                continue
            if name == "br":
                self.flush()
                continue
            if name in INLINE:
                self.walk(ch, depth, local, bold or name in BOLD)
                continue
            # block element
            self.flush()
            if name in ("ul", "ol"):
                self.walk(ch, depth + 1, local)
            else:
                self.walk(ch, depth, local)
            self.flush()


def lines_of(node: Tag) -> list[dict]:
    w = _Lines()
    w.walk(node)
    w.flush()
    return w.out


def _dedupe(lines: list[dict]) -> list[dict]:
    seen, out = set(), []
    for ln in lines:
        key = (ln.get("g"), ln.get("k"), ln["t"])
        if ln.get("g") and key in seen:  # yellow fever repeats the group notes under both of its paragraphs
            continue
        seen.add(key)
        out.append(ln)
    return out


# "外館急難救助專線：+66-81-666-4006", "外館急難救助專線(河內)：+84-913-219-986" (one line per mission)
HOTLINE = re.compile(r"外館急難救助專線\s*(?:\(([^)]{1,20})\))?\s*[:：]?\s*([+\d][\d\s()\-+]{5,30}\d)")


def parse(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    doc: dict = {"sections": {}, "vaccines": [], "hotline": []}
    for sec in soup.find_all("section"):
        h = sec.find("h3")
        key = KEEP.get(_clean(h.get_text())) if h else None
        if not key:
            continue
        h.decompose()
        if key == "vaccines":
            table = sec.find("table")
            if table:
                for tr in table.find_all("tr"):
                    tds = tr.find_all("td")
                    if len(tds) < 2:
                        continue
                    name = _clean(tds[0].get_text())
                    if name:
                        doc["vaccines"].append({"name": name, "lines": _dedupe(lines_of(tds[1]))})
                table.decompose()
        lines = lines_of(sec)
        if lines:
            doc["sections"][key] = lines
    for ln in doc["sections"].get("during", []):
        text = f"{ln['k']}：{ln['t']}" if ln.get("k") else ln["t"]
        for m in HOTLINE.finditer(text):
            tel = re.sub(r"\s+", "", m.group(2))
            if not any(h["tel"] == tel for h in doc["hotline"]):
                doc["hotline"].append({"where": (m.group(1) or "").strip(), "tel": tel})
    return doc
