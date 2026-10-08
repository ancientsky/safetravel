"""Network fetchers (CDC CSVs, TPE flight data). Every function degrades gracefully: on failure the previous
files on disk are kept and a status dict explains why. Tests run these against mocked HTTP."""
from __future__ import annotations

import csv
import io
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

from . import common as C
from . import flights as F
from . import http
from . import tdx

MIN_ROW_RATIO = 0.8


# ------------------------------------------------------------------- CDC CSV
def validate_csv(raw: bytes, expected_cols: list[str], prev_rows: int | None) -> tuple[int, str | None]:
    """Return (rows, problem). problem is None when the download looks complete."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return 0, "not valid UTF-8"
    try:
        return _validate_rows(text, expected_cols, prev_rows)
    except csv.Error as e:  # e.g. "field larger than field limit"
        return 0, f"malformed CSV: {e}"


def _validate_rows(text: str, expected_cols: list[str], prev_rows: int | None) -> tuple[int, str | None]:
    rd = csv.reader(io.StringIO(text, newline=""))
    try:
        header = next(rd)
    except StopIteration:
        return 0, "empty file"
    header = [h.strip() for h in header]
    missing = [c for c in expected_cols if c not in header]
    if missing:
        return 0, f"header mismatch (missing {missing[:3]}...)"
    n = 0
    last_len = len(header)
    for row in rd:
        if not row:
            continue
        n += 1
        last_len = len(row)
    if n == 0:
        return 0, "no data rows"
    if last_len != len(header):
        return n, f"last row truncated ({last_len}/{len(header)} fields)"
    if prev_rows and n < MIN_ROW_RATIO * prev_rows and not os.environ.get("SAFETRAVEL_ACCEPT_SHRINK"):
        return n, f"far fewer rows than before ({n} vs {prev_rows})"
    return n, None


def count_rows(path: Path) -> int | None:
    try:
        n, _ = validate_csv(path.read_bytes(), [], None)
        return n
    except OSError:
        return None


def fetch_csv(name: str, url: str, dest: Path, expected_cols: list[str], session=None) -> dict:
    status = {"name": name, "url": url, "ok": False, "changed": False, "rows": None, "reason": None, "fetched_at": None}
    prev_rows = count_rows(dest) if dest.exists() else None
    try:
        r = http.get(url, session=session, tries=3, timeout=(10, 90))
    except http.HttpError as e:
        status["reason"] = f"download failed: {e}"
        C.log.warning("%s: %s; keeping previous file", name, status["reason"])
        return status
    rows, problem = validate_csv(r.content, expected_cols, prev_rows)
    if problem:
        status["reason"] = f"rejected download: {problem}"
        C.log.warning("%s: %s; keeping previous file", name, status["reason"])
        return status
    old = dest.read_bytes() if dest.exists() else None
    status.update(ok=True, rows=rows, fetched_at=C.iso_ts(), changed=(old != r.content))
    if status["changed"]:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".csv.tmp")
        tmp.write_bytes(r.content)
        tmp.replace(dest)
    C.log.info("%s: %d rows (%s)", name, rows, "updated" if status["changed"] else "unchanged")
    return status


def fetch_cdc(session=None) -> dict:
    d = C.raw_dir()
    return {
        "alerts": fetch_csv("alerts", C.ALERTS_URL, d / "TCDCTravelAlertAll.csv", C.ALERT_COLUMNS, session),
        "epidemics": fetch_csv("epidemics", C.EPID_URL, d / "TCDCIntlEpid.csv", C.EPID_COLUMNS, session),
    }


# ------------------------------------------------------------------- flights
# Primary source: TDX FIDS API (tdx.py). The Taoyuan main site sits behind a Cloudflare challenge and the open-data
# portal is unreachable from GitHub runners, so those remain optional best-effort attempts with short timeouts.
DATAGOV = ["https://data.gov.tw/api/v2/rest/dataset/26194", "https://data.gov.tw/api/v2/rest/dataset/177644"]
GUESSES = ["https://www.taoyuan-airport.com/uploads/flight/a_flight_v4.txt", "https://www.taoyuan-airport.com/a_flight_v4.txt"]
PAGES = [("timetable_en", "https://www.taoyuan-airport.com/flight_timetable?lang=en", "en"),
         ("timetable_zh", "https://www.taoyuan-airport.com/flight_timetable?lang=zh", "zh")]
KEEP_DAYS = 7
MIN_FLIGHTS = 10
FAST = {"tries": 1, "timeout": (5, 15)}


def _ext(content_type: str, url: str, body: bytes) -> str:
    ct = (content_type or "").lower()
    if "json" in ct:
        return "json"
    if "html" in ct or body[:200].lstrip().lower().startswith((b"<!doctype", b"<html")):
        return "html"
    if "xml" in ct:
        return "xml"
    m = re.search(r"\.(txt|csv|json|html)$", urlparse(url).path.lower())
    return m.group(1) if m else "txt"


ALLOWED_HOSTS = frozenset({"data.gov.tw", "www.taoyuan-airport.com", "odp.taoyuan-airport.com"})


def _allowed_url(url: str) -> bool:
    """https only, hostname on the allowlist (no userinfo tricks: hostname is parsed, not substring-matched)."""
    try:
        u = urlparse(url)
        return u.scheme == "https" and (u.hostname or "") in ALLOWED_HOSTS
    except ValueError:
        return False


def _datagov_urls(body: bytes) -> list[str]:
    """resourceDownloadUrl (and any a_flight URL) from a data.gov.tw dataset API response; https + allowlisted hosts only."""
    urls: list[str] = []
    text = F.decode_bytes(body)
    try:
        obj = json.loads(text)
    except ValueError:
        obj = None

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, str) and k.lower() in ("resourcedownloadurl", "downloadurl", "accessurl") and v.startswith("http"):
                    urls.append(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)
    if obj is not None:
        walk(obj)
    urls += re.findall(r"https?://[^\s\"'<>\\]*a_flight[^\s\"'<>\\]*", text)
    kept = [u for u in dict.fromkeys(urls) if _allowed_url(u)]
    if len(kept) != len(set(urls)):
        C.log.warning("flights: dropped %d discovered URL(s) that are not https on an allowed host", len(set(urls)) - len(kept))
    return kept


def _flight_file_override() -> list[str]:
    """FLIGHT_FILE_URL must be https (a local file: path is allowed for tests)."""
    u = os.environ.get("FLIGHT_FILE_URL", "").strip()
    if not u:
        return []
    if u.startswith("https://") or u.startswith("file:"):
        return [u]
    C.log.warning("flights: ignoring FLIGHT_FILE_URL (must be https or file:)")
    return []


class RawSaver:
    def __init__(self, day: str):
        self.dir = C.raw_dir() / "flights" / day
        self.latest = C.raw_dir() / "flights" / "latest"
        self.notes: list[str] = [f"# flight fetch {C.iso_ts()}"]
        self.files: list[Path] = []
        if self.dir.exists():
            shutil.rmtree(self.dir)
        self.dir.mkdir(parents=True, exist_ok=True)

    def note(self, line: str) -> None:
        self.notes.append(line)
        C.log.info("flights: %s", line)

    def save(self, name: str, body: bytes, ext: str) -> Path:
        p = self.dir / f"{name}.{ext}"
        p.write_bytes(body)
        self.files.append(p)
        return p

    def finish(self) -> None:
        (self.dir / "notes.txt").write_text("\n".join(self.notes) + "\n", encoding="utf-8")
        if self.latest.exists():
            shutil.rmtree(self.latest)
        shutil.copytree(self.dir, self.latest)
        days = sorted(p for p in (C.raw_dir() / "flights").iterdir() if p.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.name))
        for old in days[:-KEEP_DAYS]:
            shutil.rmtree(old, ignore_errors=True)


def _summarise(recs: list, day: str, name_sources=None) -> tuple[list[dict], str]:
    d = F.choose_day(recs, day)
    return F.aggregate(recs, d, name_sources=name_sources), d


def fetch_flights(session=None, cached_names: dict | None = None) -> dict:
    """Fetch + save every flight-related response, then parse. Returns
    {ok, reason, warn, day, routes, source, fetched_at, kind, files}. ok=False means nothing usable was found."""
    day = C.today().isoformat()
    sv = RawSaver(day)
    airports = F.load_airports()
    s = session or http.new_session()
    result = {"ok": False, "reason": None, "warn": None, "day": day, "routes": [], "source": None,
              "fetched_at": C.iso_ts(), "kind": None, "files": []}
    try:
        # 1) TDX FIDS: one call returns departures + arrivals for yesterday/today/tomorrow
        token, status = tdx.get_token(s)
        sv.note(f"tdx auth: {status}")
        hdr = {"Authorization": f"Bearer {token}"} if token else None
        names = dict(cached_names or {})
        try:
            r = http.get(tdx.FIDS_URL, session=s, tries=2, timeout=(10, 90), headers=hdr)
            sv.save("tdx_fids_tpe", r.content, "json")
            recs = tdx.parse_fids(r.json())
            sv.note(f"tdx_fids_tpe\t{tdx.FIDS_URL}\t200\t{len(r.content)} bytes\t{len(recs)} physical flights (all days)")
        except http.HttpError as e:
            recs = []
            sv.note(f"tdx_fids_tpe\t{tdx.FIDS_URL}\tFAILED\t{e}")
        except ValueError as e:
            recs = []
            sv.note(f"tdx_fids_tpe: invalid JSON ({e})")
        if recs:
            try:  # airport names (once per run); failures only cost nicer names
                ar = http.get(tdx.AIRPORTS_URL, session=s, tries=2, timeout=(10, 60), headers=hdr)
                sv.save("tdx_airports", ar.content, "json")
                fresh = tdx.parse_airports(ar.json())
                sv.note(f"tdx_airports\t{len(fresh)} airports")
                result["airport_names"] = fresh
                names.update({k: (v[0], v[1]) for k, v in fresh.items()})
            except (http.HttpError, ValueError) as e:
                sv.note(f"tdx_airports FAILED {e}")
            d = F.choose_day(recs, day)
            routes = F.aggregate(recs, d, names=names)
            if sum(x["departures"] + x["arrivals"] for x in routes) >= MIN_FLIGHTS:
                missing = [n for k, n in (("D", "departures"), ("A", "arrivals")) if not any(x.direction == k and x.date == d for x in recs)]
                result.update(ok=True, routes=routes, source=tdx.FIDS_URL.split("?")[0], kind="tdx", day=d,
                              warn=f"partial TDX data: no {', '.join(missing)}" if missing else None)
                return result

        # 2) best effort: Taoyuan site / open-data file (usually Cloudflare-blocked or geo-blocked)
        parsed: list[tuple[str, str, list]] = []

        def attempt(label, url, lang="en", parse=True):
            try:
                r = http.get(url, session=s, **FAST)
            except http.HttpError as e:
                sv.note(f"{label}\t{url}\tFAILED\t{e}")
                return None
            p = sv.save(label, r.content, _ext(r.headers.get("Content-Type", ""), url, r.content))
            sv.note(f"{label}\t{url}\t200\t{r.headers.get('Content-Type', '')}\t{len(r.content)} bytes\t{p.name}")
            if parse:
                try:
                    kind, recs = F.parse_any(r.content, lang, airports)
                except Exception as e:  # parser bugs must not kill the run
                    sv.note(f"  parse error: {type(e).__name__}: {e}")
                    return r
                sv.note(f"  parsed as {kind}: {len(recs)} records")
                if recs:
                    parsed.append((url, kind, recs))
            return r

        file_urls = _flight_file_override()
        for api in DATAGOV:
            r = attempt(f"datagov_{api.rsplit('/', 1)[-1]}", api, parse=False)
            if r is not None:
                file_urls += _datagov_urls(r.content)
        file_urls += GUESSES
        for i, u in enumerate(dict.fromkeys(file_urls)):
            attempt(f"a_flight_v4_{i}", u)
            if parsed:
                break
        for label, url, lang in PAGES:
            attempt(label, url, lang)
        parsed.sort(key=lambda t: ({"file": 0, "json": 1, "html-json": 1}.get(t[1], 2), -len(t[2])))
        if parsed:
            url, kind, recs = parsed[0]
            routes, d = _summarise(recs, day, [t[2] for t in parsed[1:]])
            if sum(r["departures"] + r["arrivals"] for r in routes) >= MIN_FLIGHTS:
                result.update(ok=True, routes=routes, source=url, kind=kind, day=d)
                return result
        result["reason"] = "no live flight data: TDX returned nothing usable and the Taoyuan site/open-data attempts failed"
        return result
    finally:
        sv.note(f"RESULT ok={result['ok']} source={result['source']} kind={result['kind']} day={result['day']} "
                f"routes={len(result['routes'])} reason={result['reason']} warn={result['warn']}")
        sv.finish()
        result["files"] = [str(p) for p in sv.files]
