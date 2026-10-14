"""Inbound international flights for the quarantine-station board (web/data/arrivals.json, contract: docs/ARRIVALS.md).

One TDX call (all airports, or TPE only as fallback) per run; the call budget is tracked in the published file itself
(`quota`), so the guard needs no other state: `python -m pipeline arrivals --check-only --prev <live file>` says whether a
run may spend a call. `parse()` is pure (no network, no clock): feed it the payload, the clock and the lookup tables.
"""
from __future__ import annotations

import calendar
import copy
import json
import math
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

from . import common as C
from . import flights as F
from . import http, tdx

ENDPOINT_ALL = f"{tdx.BASE}/FIDS/Airport/Arrival"
ENDPOINT_TPE = f"{tdx.BASE}/FIDS/Airport/Arrival/TPE"
QUERY = "?IsCargo=false&%24format=JSON"
DEFAULT_CAP = 4200
DAILY_MAX = 130
AGE_DAY_MIN, AGE_NIGHT_MIN = 9, 29
REFRESH = {"day": 10, "night": 30}
WINDOW_BEFORE, WINDOW_AFTER = timedelta(hours=2), timedelta(hours=4)

# Every Taiwan airport that appears in TDX FIDS; also the safety net for the "international only" rule.
TW_AIRPORTS = ("TPE", "TSA", "KHH", "RMQ", "TNN", "HUN", "TTT", "MZG", "KNH", "LZN", "MFK", "CYI", "GNI", "KYD", "WOT", "CMJ")
SHORT_NAMES = {  # iata: (zh, en)
    "TPE": ("桃園", "Taoyuan"), "TSA": ("松山", "Songshan"), "KHH": ("高雄", "Kaohsiung"), "RMQ": ("臺中", "Taichung"),
    "TNN": ("臺南", "Tainan"), "HUN": ("花蓮", "Hualien"), "TTT": ("臺東", "Taitung"), "MZG": ("澎湖", "Penghu"),
    "KNH": ("金門", "Kinmen"), "LZN": ("南竿", "Nangan"), "MFK": ("北竿", "Beigan"), "CYI": ("嘉義", "Chiayi"),
    "GNI": ("綠島", "Green Island"), "KYD": ("蘭嶼", "Lanyu"), "WOT": ("望安", "Wang-an"), "CMJ": ("七美", "Qimei"),
}
TPE_CHECKPOINTS = (("A", "1"), ("B", "1"), ("C", "2"), ("D", "2"))
STATUSES = ("arrived", "on_time", "early", "delayed", "changed", "cancelled", "other")

_STATUS_RULES = (  # first match wins; cancelled before the rest so "CANCELLED" never reads as anything else
    ("cancelled", re.compile(r"CANCEL|取消")),
    ("arrived", re.compile(r"ARRIV|已到")),
    ("delayed", re.compile(r"DELAY|延遲|延誤")),
    ("changed", re.compile(r"CHANGE|更改")),
    ("early", re.compile(r"EARLY|提早|提前")),
    ("on_time", re.compile(r"ON\s*TIME|準時")),
)


class FetchError(Exception):
    """TDX could not deliver a usable payload. `calls` = HTTP requests that were sent (they may have used quota)."""

    def __init__(self, msg: str, calls: int = 0):
        super().__init__(msg)
        self.calls = calls


# ---------------------------------------------------------------- small helpers
def _str(v) -> str:
    return str(v).strip() if v is not None else ""


def _local(v) -> datetime | None:
    """TDX local time ('2026-10-14T18:05', no offset) -> aware Asia/Taipei datetime; None when missing/unparseable."""
    s = _str(v)
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.replace(tzinfo=C.TAIPEI) if dt.tzinfo is None else dt.astimezone(C.TAIPEI)


def _fmt(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.isoformat(timespec="seconds" if dt.second else "minutes")


def _flight_sort_key(r: dict) -> tuple:
    num = _str(r.get("FlightNumber"))
    digits = re.sub(r"\D", "", num)
    return (int(digits) if digits else 10 ** 9, _str(r.get("AirlineID")), num)


def _split_remark(remark: str) -> tuple[str, str]:
    """'時間更改SCHEDULE CHANGE' -> ('時間更改', 'SCHEDULE CHANGE'), split at the first Latin letter."""
    m = re.search(r"[A-Za-z]", remark)
    if not m:
        return remark.strip(), ""
    return remark[:m.start()].strip(), remark[m.start():].strip()


def _status(remark: str, remark_en: str) -> tuple[str, str, str]:
    zh, en = _split_remark(_str(remark))
    en = _str(remark_en) or en
    text = f"{zh} {en}".upper()
    for key, rx in _STATUS_RULES:
        if rx.search(text):
            return key, zh, en
    return "other", zh, en


def arrival_rows(obj) -> list[dict]:
    """Arrival rows from the combined payload ([{AirportID, FIDSArrival: [...]}]), from the flat list returned by
    /FIDS/Airport/Arrival[/{IATA}], or from a single wrapper dict."""
    out: list[dict] = []
    for it in obj if isinstance(obj, list) else [obj]:
        if not isinstance(it, dict):
            continue
        if "FIDSArrival" in it:
            out += [r for r in it.get("FIDSArrival") or [] if isinstance(r, dict)]
        elif "ScheduleArrivalTime" in it:
            out.append(it)
    return out


def tdx_updated(obj) -> str | None:
    """Newest UpdateTime in the payload as +08:00 ISO string."""
    stamps = [r.get("UpdateTime") for r in arrival_rows(obj)]
    stamps += [it.get("UpdateTime") for it in obj if isinstance(it, dict)] if isinstance(obj, list) else []
    found = [d for d in map(_local, stamps) if d]
    return _fmt(max(found)) if found else None


def _best_time(f: dict) -> datetime:
    if f["status"] == "cancelled":
        return datetime.fromisoformat(f["scheduled"])
    return datetime.fromisoformat(f["actual"] or f["estimated"] or f["scheduled"])


def _coord(geo: dict, iata: str, key: str) -> float | None:
    v = (geo.get(iata) or {}).get(key)
    return round(float(v), 4) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def new_quota(now: datetime, cap: int = DEFAULT_CAP) -> dict:
    return {"month": now.strftime("%Y-%m"), "calls_month": 0, "cap_month": int(cap),
            "day": now.strftime("%Y-%m-%d"), "calls_day": 0}


# ---------------------------------------------------------------- parse
def parse(obj, airports_country: dict | None, tdx_names: dict | None, now: datetime, *, geo: dict | None = None,
          source: str = "tdx", endpoint: str = ENDPOINT_ALL, quota: dict | None = None) -> dict:
    """Build the arrivals.json document.

    airports_country: {iata: alpha-2} (origin country); missing -> taken from `geo`, else '' (flight kept).
    tdx_names: {iata: (en, zh)} as returned by db.get_airport_names; preferred for origin city names.
    geo: airports.json content (coordinates, city fallback); defaults to web/data/airports.json."""
    geo = F.load_airports() if geo is None else geo
    countries = dict(airports_country or {})
    names = tdx_names or {}
    zh_fallback = C.load_json(F.HERE / "airport_zh.json", {}) or {}
    now = now.astimezone(C.TAIPEI)
    w_from = now.replace(second=0, microsecond=0) - WINDOW_BEFORE
    w_to = now.replace(second=0, microsecond=0) + WINDOW_AFTER

    def country_of(iata: str) -> str:
        return (countries.get(iata) or (geo.get(iata) or {}).get("country") or "").upper()

    # 1) group rows into physical flights: (arrival airport, origin, scheduled time)
    groups: dict[tuple, list[dict]] = {}
    tw_with_arrivals: set[str] = {"TPE"}
    for r in arrival_rows(obj):
        if r.get("IsCargo") is True:
            continue
        dst, org = _str(r.get("ArrivalAirportID")).upper(), _str(r.get("DepartureAirportID")).upper()
        sched = _local(r.get("ScheduleArrivalTime"))
        if sched is None or not re.fullmatch(r"[A-Z]{3}", org) or not re.fullmatch(r"[A-Z]{3}", dst):
            continue
        if dst not in TW_AIRPORTS and country_of(dst) != "TW":
            continue
        if org in TW_AIRPORTS or country_of(org) == "TW":
            continue
        tw_with_arrivals.add(dst)
        groups.setdefault((dst, org, sched), []).append(r)

    # 2) one flight per group
    out: list[dict] = []
    for (dst, org, sched), rows in groups.items():
        ops = [r for r in rows if _str(r.get("AcType"))]
        main = min(ops or rows, key=_flight_sort_key)
        airline = _str(main.get("AirlineID")).upper()
        label = lambda r: f"{_str(r.get('AirlineID')).upper()} {_str(r.get('FlightNumber')).upper().replace(' ', '')}".strip()
        codeshares = sorted({label(r) for r in rows if r is not main} - {label(main)})
        status, st_zh, st_en = _status(main.get("ArrivalRemark"), main.get("ArrivalRemarkEn"))
        est, act = _local(main.get("EstimatedArrivalTime")), _local(main.get("ActualArrivalTime"))
        gate = _str(main.get("Gate"))
        cp = gate[:1].upper() if dst == "TPE" and gate[:1].upper() in tuple("ABCD") else None
        nen, nzh = names.get(org, ("", ""))
        city = _str((geo.get(org) or {}).get("city"))
        f = {
            "id": f"{dst}|{org}|{sched.strftime('%Y-%m-%dT%H:%M')}",
            "airport": dst,
            "flight": label(main), "airline": airline, "codeshares": codeshares,
            "from": org, "from_zh": nzh or zh_fallback.get(org) or city or org, "from_en": nen or city or org,
            "country": country_of(org),
            "lat": _coord(geo, org, "lat"), "lon": _coord(geo, org, "lon"),
            "terminal": _str(main.get("Terminal")), "gate": gate, "checkpoint": cp, "apron": _str(main.get("Apron")),
            "scheduled": _fmt(sched), "estimated": _fmt(est), "actual": _fmt(act),
            "status": status, "status_zh": st_zh, "status_en": st_en,
            "aircraft": _str(main.get("AcType")),
        }
        t = _best_time(f)
        if w_from <= t <= w_to:
            out.append(f)
    out.sort(key=lambda f: (_best_time(f), f["airport"], f["flight"]))

    # 3) airports block
    airports = {}
    for iata in [a for a in TW_AIRPORTS if a in tw_with_arrivals] + sorted(tw_with_arrivals - set(TW_AIRPORTS)):
        zh, en = SHORT_NAMES.get(iata) or (names.get(iata, ("", ""))[1] or iata, names.get(iata, ("", ""))[0] or iata)
        airports[iata] = {
            "name_zh": zh, "name_en": en, "lat": _coord(geo, iata, "lat"), "lon": _coord(geo, iata, "lon"),
            "flights": sum(1 for f in out if f["airport"] == iata),
            "checkpoints": [{"id": i, "terminal": t} for i, t in TPE_CHECKPOINTS] if iata == "TPE" else [],
        }
    return {
        "generated_at": C.iso_ts(now),
        "source": source,
        "endpoint": endpoint,
        "tdx_updated": tdx_updated(obj),
        "window": {"from": w_from.isoformat(timespec="seconds"), "to": w_to.isoformat(timespec="seconds")},
        "refresh_minutes": dict(REFRESH),
        "quota": quota or new_quota(now),
        "airports": airports,
        "flights": out,
    }


# ---------------------------------------------------------------- guard
def _int(v) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _counters(prev, now: datetime, cap: int) -> dict:
    """prev quota carried forward: reset on a new month (both counters) or a new day (daily counter)."""
    q = new_quota(now, cap)
    pq = prev.get("quota") if isinstance(prev, dict) else None
    if isinstance(pq, dict):
        cm, cd = _int(pq.get("calls_month")), _int(pq.get("calls_day"))
        if pq.get("month") == q["month"] and cm is not None:
            q["calls_month"] = cm
            if pq.get("day") == q["day"] and cd is not None:
                q["calls_day"] = min(cd, cm)
    return q


def daily_allowance(quota: dict, now: datetime, cap: int) -> int:
    before_today = quota["calls_month"] - quota["calls_day"]
    days_left = calendar.monthrange(now.year, now.month)[1] - now.day + 1
    return min(DAILY_MAX, math.floor((cap - before_today) / days_left))


def guard(prev: dict | None, now: datetime, cap: int, force: bool = False) -> tuple[bool, str, dict]:
    """May this run call TDX? -> (ok, reason, quota counters as of now, before this run's calls are added).
    `force` skips the age rule only; the monthly and daily caps always apply."""
    now = now.astimezone(C.TAIPEI)
    quota = _counters(prev, now, cap)
    if quota["calls_month"] >= cap:
        return False, f"monthly cap reached ({quota['calls_month']}/{cap})", quota
    allow = daily_allowance(quota, now, cap)
    if quota["calls_day"] >= allow:
        return False, f"daily allowance used ({quota['calls_day']}/{max(allow, 0)})", quota
    if not force:
        gen = _local(prev.get("generated_at")) if isinstance(prev, dict) else None
        if gen is not None:
            age = (now - gen).total_seconds() / 60
            need = AGE_NIGHT_MIN if now.hour < 5 else AGE_DAY_MIN
            if -5 <= age < need:  # a timestamp further in the future is treated as corrupt
                return False, f"published data is {age:.1f} min old (< {need} min)", quota
    return True, "ok", quota


# ---------------------------------------------------------------- fetch
def _get_rows(session, url: str, headers: dict | None):
    r = http.get(url, session=session, tries=1, timeout=(10, 90), headers=headers)
    body = r.json()
    if not isinstance(body, list) or not arrival_rows(body):
        raise ValueError("empty or unexpected payload")
    return body


def fetch(session, token: str | None) -> tuple[list, int, str, str]:
    """-> (payload, calls_made, endpoint_used, source). With a token: all airports first, TPE only as fallback;
    without: TPE only (anonymous). Raises FetchError (with the number of requests sent) when nothing usable came back."""
    hdr = {"Authorization": f"Bearer {token}"} if token else None
    plan = [(ENDPOINT_ALL, "tdx"), (ENDPOINT_TPE, "tdx")] if token else [(ENDPOINT_TPE, "tdx-anon")]
    calls, last = 0, ""
    for endpoint, source in plan:
        calls += 1
        try:
            return _get_rows(session, endpoint + QUERY, hdr), calls, endpoint, source
        except http.HttpError as e:
            last = f"{endpoint.rsplit('/', 1)[-1]}: {e}".replace(QUERY, "")
        except ValueError as e:
            last = f"{endpoint.rsplit('/', 1)[-1]}: invalid response ({e})"
        C.log.warning("arrivals: %s", last)
    raise FetchError(last or "no endpoint tried", calls)


# ---------------------------------------------------------------- lookup tables
def lookups(db_file: Path | None = None) -> tuple[dict, dict, dict]:
    """(iata -> country, iata -> (en, zh), airports.json). Country: airports.json first, then the TDX list in SQLite."""
    geo = F.load_airports()
    countries = {k: v.get("country", "") for k, v in geo.items() if isinstance(v, dict)}
    names: dict = {}
    path = Path(db_file or C.db_path())
    if path.exists():
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                for iata, zh, en, country in con.execute("SELECT iata, zh, en, country FROM airports_tdx"):
                    names[iata] = (en or "", zh or "")
                    if country and not countries.get(iata):
                        countries[iata] = country
            finally:
                con.close()
        except sqlite3.Error as e:
            C.log.warning("arrivals: cannot read airports_tdx (%s)", type(e).__name__)
    return countries, names, geo


# ---------------------------------------------------------------- dev helper
def shift_to_now(obj, now: datetime) -> list[dict]:
    """Copy of the fixture rows (flat list) with every time moved so that the fixture's own 'as of' moment (newest
    UpdateTime, else the median scheduled time) lands on `now`: statuses (arrived / on time) stay consistent."""
    rows = copy.deepcopy(arrival_rows(obj))
    updates = [d for d in (_local(r.get("UpdateTime")) for r in rows) if d]
    scheds = sorted(d for d in (_local(r.get("ScheduleArrivalTime")) for r in rows) if d)
    if not updates and not scheds:
        return rows
    anchor = max(updates) if updates else scheds[len(scheds) // 2]
    delta = timedelta(minutes=round((now.astimezone(C.TAIPEI) - anchor).total_seconds() / 60))
    for r in rows:
        for k in ("ScheduleArrivalTime", "EstimatedArrivalTime", "ActualArrivalTime"):
            if d := _local(r.get(k)):
                r[k] = (d + delta).strftime("%Y-%m-%dT%H:%M")
        if d := _local(_str(r.get("FlightDate")) and _str(r["FlightDate"]) + "T00:00"):
            r["FlightDate"] = (d + delta).strftime("%Y-%m-%d")
        if d := _local(r.get("UpdateTime")):
            r["UpdateTime"] = (d + delta).isoformat(timespec="seconds")
    return rows


# ---------------------------------------------------------------- CLI
def _now(arg: str | None) -> datetime:
    if not arg:
        return C.now()
    dt = datetime.fromisoformat(arg)
    return dt.astimezone(C.TAIPEI) if dt.tzinfo else dt.replace(tzinfo=C.TAIPEI)


def _cap(arg: int | None) -> int:
    if arg:
        return arg
    try:
        return int(os.environ.get("ARRIVALS_MONTHLY_CAP", "").strip() or DEFAULT_CAP)
    except ValueError:
        return DEFAULT_CAP


def _load_prev(path: str | None) -> dict | None:
    if not path or not Path(path).exists():
        return None
    prev = C.load_json(Path(path))
    return prev if isinstance(prev, dict) else None


def _set_output(line: str) -> None:
    target = os.environ.get("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def run(args) -> int:
    now, cap = _now(args.now), _cap(args.cap)
    prev = _load_prev(args.prev)
    out = Path(args.out) if args.out else C.web_data() / "arrivals.json"
    ok, reason, quota = guard(prev, now, cap, force=args.force)

    if args.check_only:
        print(json.dumps({"ok": ok, "reason": reason}, ensure_ascii=False))
        _set_output(f"fetch={'true' if ok else 'false'}")
        return 0

    countries, names, geo = lookups()
    if args.offline:
        obj = json.loads(Path(args.offline).read_text(encoding="utf-8"))
        if args.shift_to_now:
            obj = shift_to_now(obj, now)
        doc = parse(obj, countries, names, now, geo=geo, source="tdx", endpoint=ENDPOINT_TPE, quota=quota)
    else:
        if not ok:
            print(f"arrivals: not fetching: {reason}")
            return 0
        session = http.new_session()
        token, status = tdx.get_token(session)
        C.log.info("arrivals: tdx auth: %s", status)
        try:
            obj, calls, endpoint, source = fetch(session, token)
        except FetchError as e:
            print(f"arrivals: TDX failed after {e.calls} request(s): {e}; keeping the published file", file=sys.stderr)
            return 1
        quota["calls_month"] += calls
        quota["calls_day"] += calls
        doc = parse(obj, countries, names, now, geo=geo, source=source, endpoint=endpoint, quota=quota)

    C.write_json(out, doc)
    q = doc["quota"]
    print(f"arrivals: wrote {out} ({out.stat().st_size} bytes): {len(doc['flights'])} flights, airports "
          f"{','.join(doc['airports'])}, source={doc['source']}, calls month {q['calls_month']}/{q['cap_month']} day {q['calls_day']}")
    return 0
