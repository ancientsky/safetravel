"""TDX (Ministry of Transportation open data) FIDS client for Taoyuan Airport flights.

Auth is OAuth2 client credentials (env TDX_CLIENT_ID / TDX_CLIENT_SECRET, GitHub secrets). Without credentials the
API is called anonymously, which TDX allows for a small number of calls per IP and day.

Combined endpoint payload: [{"AirportID": "TPE", "FIDSDeparture": [...], "FIDSArrival": [...], "UpdateTime": ...}]
holding yesterday, today and tomorrow, with one row per marketing flight (codeshares included). Rows of the same
physical flight share (schedule time, other airport); the operating carrier's row carries `AcType`.
Parsing degrades gracefully when fields are renamed: unknown rows are skipped, not fatal.
"""
from __future__ import annotations

import os
import re

import requests

from . import common as C
from . import flights as F
from . import http

TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
BASE = "https://tdx.transportdata.tw/api/basic/v2/Air"
FIDS_URL = f"{BASE}/FIDS/Airport/TPE?%24format=JSON"
AIRPORTS_URL = f"{BASE}/Airport?%24format=JSON"
CANCEL = re.compile(r"取消|cancel", re.I)


def get_token(session: requests.Session | None = None) -> tuple[str | None, str]:
    """Returns (token or None, human-readable status for the notes file). Never logs the secret."""
    cid, secret = os.environ.get("TDX_CLIENT_ID", "").strip(), os.environ.get("TDX_CLIENT_SECRET", "").strip()
    if not cid or not secret:
        return None, "no TDX credentials in env: calling anonymously"
    s = session or http.new_session()
    try:
        r = s.post(TOKEN_URL, data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret},
                   headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=(10, 30))
    except requests.RequestException as e:
        return None, f"token request failed: {type(e).__name__}"
    if r.status_code != 200:
        return None, f"token request failed: HTTP {r.status_code}"
    try:
        tok = r.json().get("access_token")
    except ValueError:
        tok = None
    return (tok, "token ok") if tok else (None, "token response had no access_token")


def _val(rec: dict, *names):
    low = {k.lower(): v for k, v in rec.items()}
    for n in names:
        v = low.get(n.lower())
        if v not in (None, ""):
            return v
    return None


def _lists(obj) -> tuple[list[dict], list[dict]]:
    """(departure rows, arrival rows) from the combined payload, from a bare array, or from a wrapper dict."""
    dep: list[dict] = []
    arr: list[dict] = []
    items = obj if isinstance(obj, list) else [obj]
    for it in items:
        if not isinstance(it, dict):
            continue
        if "FIDSDeparture" in it or "FIDSArrival" in it:
            dep += [r for r in it.get("FIDSDeparture") or [] if isinstance(r, dict)]
            arr += [r for r in it.get("FIDSArrival") or [] if isinstance(r, dict)]
        elif "ScheduleDepartureTime" in it or "ScheduleArrivalTime" in it or "DepartureAirportID" in it:
            (arr if str(it.get("ArrivalAirportID", "")).upper() == "TPE" and "ScheduleDepartureTime" not in it else dep).append(it)
    return dep, arr


def looks_like_fids(obj) -> bool:
    dep, arr = _lists(obj)
    return bool(dep or arr)


def _physical(rows: list[dict], d: str) -> list[F.Rec]:
    """Collapse codeshare rows into physical flights. Cargo rows are dropped; a flight whose operating row (the one
    with AcType) is cancelled, or whose rows are all cancelled, is dropped."""
    groups: dict[tuple, list[tuple[dict, bool]]] = {}
    for r in rows:
        if _val(r, "IsCargo") is True:
            continue
        remark = str(_val(r, "DepartureRemark" if d == "D" else "ArrivalRemark", "Remark") or "")
        sched = str(_val(r, "ScheduleDepartureTime" if d == "D" else "ScheduleArrivalTime", "ScheduleTime") or "")
        other = str(_val(r, "ArrivalAirportID" if d == "D" else "DepartureAirportID") or "").upper()
        own = str(_val(r, "DepartureAirportID" if d == "D" else "ArrivalAirportID") or "TPE").upper()
        if own != "TPE" or not re.fullmatch(r"[A-Z]{3}", other):
            continue
        groups.setdefault((sched, other), []).append((r, bool(CANCEL.search(remark))))
    recs = []
    for (sched, other), rs in groups.items():
        if any(c and _val(r, "AcType") for r, c in rs):
            continue
        live = [r for r, c in rs if not c]
        if not live:
            continue
        ops = [r for r in live if _val(r, "AcType")]
        r = (ops or live)[0]
        airline = str(_val(r, "AirlineID", "AirlineIATA") or "").upper()
        fl = str(_val(r, "FlightNumber", "FlightNo") or "").upper().replace(" ", "")
        if fl.isdigit() and airline:
            fl = airline + fl
        tm = re.search(r"T(\d{2}:\d{2})", sched)
        recs.append(F.Rec(direction=d, iata=other, flight=fl, airline=F.airline_of(fl, airline),
                          date=F.norm_date(str(_val(r, "FlightDate") or "")) or F.norm_date(sched),
                          time=tm.group(1) if tm else "", op=bool(ops)))
    return recs


def parse_fids(obj) -> list[F.Rec]:
    dep, arr = _lists(obj)
    return _physical(dep, "D") + _physical(arr, "A")


def parse_airports(obj) -> dict[str, tuple[str, str, str]]:
    """TDX Air/Airport -> {iata: (en, zh, country)} with 'Airport'/'機場' suffixes stripped."""
    out = {}
    for r in obj if isinstance(obj, list) else []:
        if not isinstance(r, dict):
            continue
        iata = str(r.get("AirportIATA") or r.get("AirportID") or "").upper()
        if not re.fullmatch(r"[A-Z]{3}", iata):
            continue
        nm = r.get("AirportName") if isinstance(r.get("AirportName"), dict) else {}
        zh = re.sub(r"(國際|國內)?機場$", "", str(nm.get("Zh_tw") or "").strip()).strip()
        en = re.sub(r"\s+(International\s+)?Airport$", "", str(nm.get("En") or "").strip(), flags=re.I)
        out[iata] = (F.tidy_city(en), F.tidy_city(zh), str(r.get("AirportNationality") or "").upper())
    return out
