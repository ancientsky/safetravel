import json
import re

import responses

from pipeline import common as C
from pipeline import db, export, fetch, tdx, validate
from pipeline.__main__ import _store_flights

from .conftest import FIX

HDR = ",".join(C.ALERT_COLUMNS)


def csv_body(n, truncated=False, header=HDR):
    rows = [header] + [",".join(f"v{i}_{j}" for j in range(len(C.ALERT_COLUMNS))) for i in range(n)]
    body = "\n".join(rows) + "\n"
    return (body[:-12] if truncated else body).encode("utf-8")


@responses.activate
def test_csv_download_replaces_file(tmp_path):
    dest = tmp_path / "a.csv"
    responses.add(responses.GET, C.ALERTS_URL, body=csv_body(100))
    st = fetch.fetch_csv("alerts", C.ALERTS_URL, dest, C.ALERT_COLUMNS)
    assert st["ok"] and st["rows"] == 100 and st["changed"] and dest.exists()
    assert "Mozilla" in responses.calls[0].request.headers["User-Agent"]
    st = fetch.fetch_csv("alerts", C.ALERTS_URL, dest, C.ALERT_COLUMNS)
    assert st["ok"] and not st["changed"]


@responses.activate
def test_csv_bad_downloads_keep_previous_file(tmp_path):
    dest = tmp_path / "a.csv"
    good = csv_body(100)
    dest.write_bytes(good)
    cases = {
        "truncated": csv_body(100, truncated=True),
        "header": csv_body(100, header="a,b,c"),
        "shrunk": csv_body(10),
        "html": b"<html>Just a moment...</html>",
        "empty": b"",
    }
    for name, body in cases.items():
        responses.replace(responses.GET, C.ALERTS_URL, body=body) if responses.calls else responses.add(responses.GET, C.ALERTS_URL, body=body)
        st = fetch.fetch_csv("alerts", C.ALERTS_URL, dest, C.ALERT_COLUMNS)
        assert not st["ok"] and st["reason"], name
        assert dest.read_bytes() == good, name


@responses.activate
def test_csv_http_failure_retries_then_keeps_file(tmp_path):
    dest = tmp_path / "a.csv"
    dest.write_bytes(csv_body(5))
    responses.add(responses.GET, C.ALERTS_URL, status=503)
    st = fetch.fetch_csv("alerts", C.ALERTS_URL, dest, C.ALERT_COLUMNS)
    assert not st["ok"] and "503" in st["reason"] and len(responses.calls) == 3
    assert dest.read_bytes() == csv_body(5)


def _mock_tdx(status=200):
    body = (FIX / "tdx_fids_sample.json").read_bytes()
    responses.add(responses.GET, re.compile(r"https://tdx\.transportdata\.tw/api/basic/v2/Air/FIDS/Airport/TPE.*"), body=body,
                  status=status, content_type="application/json")
    responses.add(responses.GET, re.compile(r"https://tdx\.transportdata\.tw/api/basic/v2/Air/Airport\?.*"),
                  body=(FIX / "tdx_airports_sample.json").read_bytes(), content_type="application/json")


def _mock_blocked():
    responses.add(responses.GET, re.compile(r"https://tdx\.transportdata\.tw/api/.*"), status=429)
    responses.add(responses.GET, re.compile(r"https://data\.gov\.tw/.*"), status=500)
    responses.add(responses.GET, re.compile(r"https://www\.taoyuan-airport\.com/.*"), status=403,
                  body="<html><title>Just a moment...</title></html>", content_type="text/html")


@responses.activate
def test_tdx_flow_saves_raw_stores_and_exports(loaded):
    _mock_tdx()
    res = fetch.fetch_flights()
    assert res["ok"] and res["kind"] == "tdx" and res["day"] == "2026-10-08" and res["warn"] is None
    d = C.raw_dir() / "flights" / "2026-10-08"
    assert (d / "tdx_fids_tpe.json").exists() and (C.raw_dir() / "flights" / "latest" / "tdx_fids_tpe.json").exists()
    assert "RESULT ok=True" in (d / "notes.txt").read_text(encoding="utf-8")
    _store_flights(loaded, res)
    out = export.export_all(loaded)
    f = json.loads((C.web_data() / "flights.json").read_text(encoding="utf-8"))
    assert f["date"] == "2026-10-08" and f["totals"]["destinations"] == 4 and f["totals"]["departures"] == 78
    assert f["source"].startswith("https://tdx.transportdata.tw/") and out["sources"]["flights"]["ok"] is True
    assert {r["iata"] for r in f["routes"]} == {"HKG", "NRT", "BKK", "SFO"}
    assert validate.validate_dir(C.web_data()) == []


@responses.activate
def test_tdx_sends_bearer_token_when_credentials_exist(monkeypatch, root):
    monkeypatch.setenv("TDX_CLIENT_ID", "id")
    monkeypatch.setenv("TDX_CLIENT_SECRET", "secret")
    responses.add(responses.POST, tdx.TOKEN_URL, json={"access_token": "TOK"})
    _mock_tdx()
    res = fetch.fetch_flights()
    assert res["ok"]
    api = [c for c in responses.calls if "Air/FIDS" in c.request.url][0].request
    assert api.headers["Authorization"] == "Bearer TOK"
    notes = (C.raw_dir() / "flights" / "latest" / "notes.txt").read_text(encoding="utf-8")
    assert "secret" not in notes and "TOK" not in notes


@responses.activate
def test_blocked_everywhere_falls_back_to_static_routes(loaded):
    _mock_blocked()
    res = fetch.fetch_flights()
    assert not res["ok"] and res["reason"]
    notes = (C.raw_dir() / "flights" / "latest" / "notes.txt").read_text(encoding="utf-8")
    assert "FAILED" in notes and "RESULT ok=False" in notes
    _store_flights(loaded, res)
    meta = export.export_all(loaded)
    f = json.loads((C.web_data() / "flights.json").read_text(encoding="utf-8"))
    assert f["source"] == "openflights-static" and len(f["routes"]) > 50
    assert meta["sources"]["flights"]["ok"] is False
    assert meta["sources"]["flights"]["reason"] == "fallback: OpenFlights static routes"
    assert validate.validate_dir(C.web_data()) == []


@responses.activate
def test_failed_fetch_never_replaces_real_data_with_static(loaded):
    _mock_tdx()
    _store_flights(loaded, fetch.fetch_flights())
    responses.reset()
    _mock_blocked()
    _store_flights(loaded, fetch.fetch_flights())
    assert loaded.execute("SELECT COUNT(*) FROM flights_daily WHERE source LIKE '%static%'").fetchone()[0] == 0
    meta = export.export_all(loaded)
    assert meta["sources"]["flights"]["ok"] is False
    assert json.loads((C.web_data() / "flights.json").read_text(encoding="utf-8"))["totals"]["destinations"] == 4


@responses.activate
def test_site_attempt_parses_when_tdx_is_down(loaded):
    """If the airport file ever becomes reachable it is parsed (UTF-8 here)."""
    responses.add(responses.GET, re.compile(r"https://tdx\.transportdata\.tw/.*"), status=429)
    responses.add(responses.GET, re.compile(r"https://data\.gov\.tw/api/v2/rest/dataset/26194"),
                  body=(FIX / "datagov_dataset.json").read_bytes(), content_type="application/json")
    responses.add(responses.GET, re.compile(r"https://data\.gov\.tw/.*"), status=404)
    responses.add(responses.GET, "https://www.taoyuan-airport.com/uploads/fos/a_flight_v4.txt",
                  body=(FIX / "a_flight_v4_sample.txt").read_bytes(), content_type="text/plain")
    responses.add(responses.GET, re.compile(r"https://www\.taoyuan-airport\.com/flight_timetable.*"),
                  body=(FIX / "timetable_list_zh.html").read_bytes(), content_type="text/html")
    res = fetch.fetch_flights()
    assert res["ok"] and res["kind"] == "file" and len(res["routes"]) == 8
    r = {x["iata"]: x for x in res["routes"]}
    assert r["NRT"]["city_zh"] == "東京(成田)"
    assert any(p.endswith("timetable_zh.html") for p in res["files"])


def test_old_flight_folders_are_pruned(root):
    base = C.raw_dir() / "flights"
    for d in range(1, 12):
        (base / f"2026-09-{d:02d}").mkdir(parents=True)
    sv = fetch.RawSaver("2026-10-08")
    sv.finish()
    left = sorted(p.name for p in base.iterdir() if p.is_dir())
    assert "latest" in left and len([n for n in left if n.startswith("2026")]) == fetch.KEEP_DAYS


def test_oversized_csv_field_is_rejected_not_crashing():
    big = ('"' + "x" * 11_000_000 + '"')
    body = (HDR + "\n" + ",".join([big] + ["v"] * (len(C.ALERT_COLUMNS) - 1)) + "\n").encode("utf-8")
    rows, problem = fetch.validate_csv(body, C.ALERT_COLUMNS, None)
    assert rows == 0 and problem.startswith("malformed CSV:")


@responses.activate
def test_oversized_csv_keeps_previous_file(tmp_path):
    dest = tmp_path / "a.csv"
    dest.write_bytes(csv_body(5))
    body = (HDR + "\n" + ",".join(['"' + "x" * 11_000_000 + '"'] + ["v"] * (len(C.ALERT_COLUMNS) - 1)) + "\n").encode("utf-8")
    responses.add(responses.GET, C.ALERTS_URL, body=body)
    st = fetch.fetch_csv("alerts", C.ALERTS_URL, dest, C.ALERT_COLUMNS)
    assert not st["ok"] and "malformed CSV" in st["reason"]
    assert dest.read_bytes() == csv_body(5)


def test_datagov_urls_are_https_and_allowlisted():
    body = json.dumps({"result": {"distribution": [
        {"resourceDownloadUrl": "https://odp.taoyuan-airport.com/a_flight_v4.txt"},
        {"resourceDownloadUrl": "http://odp.taoyuan-airport.com/plain.txt"},
        {"resourceDownloadUrl": "https://evil.example.com/a_flight_v4.txt"},
        {"downloadUrl": "https://data.gov.tw.evil.example.com/x.csv"},
        {"accessUrl": "https://user@evil.example.com/x"},
        {"downloadUrl": "https://data.gov.tw/files/x.csv"},
    ]}, "note": "see http://www.taoyuan-airport.com/a_flight_v4.txt"}).encode()
    assert fetch._datagov_urls(body) == ["https://odp.taoyuan-airport.com/a_flight_v4.txt", "https://data.gov.tw/files/x.csv"]


def test_flight_file_url_requires_https(monkeypatch):
    for url, expected in (("https://example.com/a.txt", ["https://example.com/a.txt"]), ("http://example.com/a.txt", []),
                          ("file:///tmp/a.txt", ["file:///tmp/a.txt"]), ("ftp://x/a", []), ("", [])):
        monkeypatch.setenv("FLIGHT_FILE_URL", url)
        assert fetch._flight_file_override() == expected


@responses.activate
def test_http_get_caps_response_size():
    from pipeline import http
    responses.add(responses.GET, "https://example.com/big", body=b"x" * 5000)
    assert len(http.get("https://example.com/big", max_bytes=10_000).content) == 5000
    try:
        http.get("https://example.com/big", max_bytes=1000)
        raise AssertionError("expected HttpError")
    except http.HttpError as e:
        assert "response too large" in str(e)


def test_do_fetch_survives_cdc_crash(conn, monkeypatch):
    from pipeline.__main__ import do_fetch

    def boom(session=None):
        raise RuntimeError("kaboom")
    monkeypatch.setattr(fetch, "fetch_cdc", boom)
    out = do_fetch(conn, "cdc")
    assert not out["cdc"]["alerts"]["ok"] and "kaboom" in out["cdc"]["alerts"]["reason"]
    assert db.get_source_state(conn, "alerts")["ok"] == 0


def _fids_row(own, other, d, hhmm, flight, day="2026-10-08"):
    k = ("Departure", "Arrival") if d == "D" else ("Arrival", "Departure")
    return {f"{k[0]}AirportID": own, f"{k[1]}AirportID": other, f"Schedule{k[0]}Time": f"{day}T{hhmm}",
            "AirlineID": flight[:2], "FlightNumber": flight[2:], "AcType": "A321", "FlightDate": day, f"{k[0]}Remark": "準時"}


def _hub_payload(hub, rows):
    return {"AirportID": hub, "FIDSDeparture": [r for d, r in rows if d == "D"], "FIDSArrival": [r for d, r in rows if d == "A"]}


@responses.activate
def test_other_taiwan_airports_from_one_all_airports_call(loaded):
    """KHH and TSA come from the all-airports payload; RMQ is missing there and is fetched on its own; TNN fails.
    Domestic routes (KHH-MZG) are left out; the hubs end up in flights.json `hubs` and validate."""
    _mock_tdx()
    khh = [("D", _fids_row("KHH", "NRT", "D", "08:00", "CI102")), ("A", _fids_row("KHH", "NRT", "A", "13:00", "CI103")),
           ("D", _fids_row("KHH", "MZG", "D", "09:00", "AE301")), ("A", _fids_row("KHH", "BKK", "A", "17:00", "TG634"))]
    tsa = [("D", _fids_row("TSA", "HND", "D", "08:30", "BR192"))]
    rmq = [("A", _fids_row("RMQ", "HKG", "A", "11:00", "CX564"))]
    responses.add(responses.GET, tdx.FIDS_ALL_URL, json=[_hub_payload("TPE", []), _hub_payload("KHH", khh), _hub_payload("TSA", tsa)])
    responses.add(responses.GET, tdx.fids_url("RMQ"), json=[_hub_payload("RMQ", rmq)])
    responses.add(responses.GET, tdx.fids_url("TNN"), status=404)
    res = fetch.fetch_flights()
    assert res["ok"]
    h = res["hubs"]
    assert h["KHH"]["ok"] and {r["iata"] for r in h["KHH"]["routes"]} == {"NRT", "BKK"}
    assert h["TSA"]["ok"] and h["RMQ"]["ok"] and h["RMQ"]["source"].endswith("/FIDS/Airport/RMQ")
    assert not h["TNN"]["ok"]
    assert len([c for c in responses.calls if "/FIDS/Airport?" in c.request.url]) == 1
    _store_flights(loaded, res)
    export.export_all(loaded)
    f = json.loads((C.web_data() / "flights.json").read_text(encoding="utf-8"))
    assert list(f["hubs"]) == ["TSA", "RMQ", "KHH"]  # flights.HUBS order, TNN (no data) left out
    k = f["hubs"]["KHH"]
    assert k["hub"]["short_zh"] == "高雄" and k["hub"]["site"].startswith("https://www.kia.gov.tw/")
    assert k["totals"] == {"departures": 1, "arrivals": 2, "destinations": 2, "unmatched": 0}
    assert {r["iata"] for r in f["routes"]} == {"HKG", "NRT", "BKK", "SFO"}  # Taoyuan unchanged
    assert validate.validate_dir(C.web_data()) == []
    bad = dict(f, hubs={"XXX": k})
    v = validate.V()
    validate.check_flights(v, bad)
    assert any("unknown hub" in e for e in v.errors)


@responses.activate
def test_hub_failures_never_block_taoyuan(loaded):
    _mock_tdx()
    responses.add(responses.GET, tdx.FIDS_ALL_URL, body="not json", content_type="application/json")
    for hub in ("TSA", "RMQ", "TNN", "KHH"):
        responses.add(responses.GET, tdx.fids_url(hub), status=500)
    res = fetch.fetch_flights()
    assert res["ok"] and not any(h["ok"] for h in res["hubs"].values())
    _store_flights(loaded, res)
    export.export_all(loaded)
    f = json.loads((C.web_data() / "flights.json").read_text(encoding="utf-8"))
    assert "hubs" not in f and f["totals"]["destinations"] == 4


def test_a_day_without_international_flights_is_shown_as_such_not_as_yesterday(loaded):
    """Tainan flies some weekdays only: a later day on which TDX answers with no international flights must be exported
    as that day with no routes, not as the previous day's routes."""
    route = {"iata": "OKA", "departures": 1, "arrivals": 1, "airlines": ["IT"], "city_en": "Okinawa", "city_zh": "沖繩"}
    src = "https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport"
    airports = json.loads((C.web_data() / "airports.json").read_text(encoding="utf-8"))
    fri = {"ok": False, "hubs": {"TNN": {"ok": True, "day": "2026-10-07", "routes": [route], "flights": 2, "source": src}},
           "fetched_at": "2026-10-07T11:17:00+08:00"}
    _store_flights(loaded, fri)
    assert export.build_hubs(loaded, airports, "2026-10-07")["TNN"]["totals"]["destinations"] == 1
    sat = {"ok": False, "hubs": {"TNN": {"ok": True, "day": "2026-10-08", "routes": [], "flights": 0, "source": src}},
           "fetched_at": "2026-10-08T11:17:00+08:00"}
    _store_flights(loaded, sat)
    h = export.build_hubs(loaded, airports, "2026-10-08")["TNN"]
    assert h["date"] == "2026-10-08" and h["routes"] == [] and h["totals"]["arrivals"] == 0
    failed = {"ok": False, "hubs": {"TNN": {"ok": False, "reason": "HTTP 500"}}, "fetched_at": "2026-10-09T11:17:00+08:00"}
    _store_flights(loaded, failed)  # a failed fetch changes nothing
    assert export.build_hubs(loaded, airports, "2026-10-09")["TNN"]["date"] == "2026-10-08"
