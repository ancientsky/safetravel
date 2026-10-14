import json
from datetime import datetime
from pathlib import Path

import pytest
import responses

from pipeline import arrivals as A
from pipeline import common as C
from pipeline import http, tdx, validate
from pipeline.__main__ import main

REPO = Path(__file__).resolve().parents[2]
PROBE = REPO / "data" / "raw" / "flights" / "probe3" / "tdx_fids_arr.json"
LATEST = REPO / "data" / "raw" / "flights" / "latest" / "tdx_fids_tpe.json"
NOW = datetime(2026, 10, 14, 18, 40, 12, tzinfo=C.TAIPEI)

GEO = {
    "NRT": {"city": "Tokyo", "country": "JP", "lat": 35.7647, "lon": 140.386},
    "HKG": {"city": "Hong Kong", "country": "HK", "lat": 22.308, "lon": 113.9185},
    "ICN": {"city": "Seoul", "country": "KR", "lat": 37.4691, "lon": 126.451},
    "TPE": {"city": "Taipei", "country": "TW", "lat": 25.0777, "lon": 121.233},
    "TSA": {"city": "Taipei", "country": "TW", "lat": 25.0694, "lon": 121.5525},
    "KHH": {"city": "Kaohsiung", "country": "TW", "lat": 22.5771, "lon": 120.35},
}
COUNTRY = {k: v["country"] for k, v in GEO.items()}


def row(flight="101", airline="CI", org="NRT", dst="TPE", sched="2026-10-14T18:05", est=None, act=None,
        remark="準時ON TIME", gate=" A5", ac="A350-900", **kw):
    r = {"FlightDate": sched[:10], "FlightNumber": flight, "AirlineID": airline, "DepartureAirportID": org,
         "ArrivalAirportID": dst, "ScheduleArrivalTime": sched, "ArrivalRemark": remark, "Terminal": "1",
         "IsCargo": False, "UpdateTime": "2026-10-14T18:39:58+08:00"}
    if est:
        r["EstimatedArrivalTime"] = est
    if act:
        r["ActualArrivalTime"] = act
    if gate is not None:
        r["Gate"] = gate
    if ac:
        r["AcType"] = ac
    r.update(kw)
    return r


def parse(rows, now=NOW, names=None, **kw):
    return A.parse(rows, COUNTRY, names or {}, now, geo=GEO, **kw)


def one(r, **kw):
    doc = parse([r], **kw)
    assert len(doc["flights"]) == 1, doc["flights"]
    return doc["flights"][0]


# ---------------------------------------------------------------- parse: shapes and fixtures
def test_flat_and_wrapped_shapes_agree():
    rows = json.loads(PROBE.read_text(encoding="utf-8"))
    now = datetime(2026, 10, 7, 0, 30, tzinfo=C.TAIPEI)
    flat = A.parse(rows, None, {}, now, geo=GEO)
    wrapped = A.parse([{"AirportID": "TPE", "FIDSDeparture": [], "FIDSArrival": rows}], None, {}, now, geo=GEO)
    assert [f["flight"] for f in flat["flights"]] == ["LJ 763", "ZE 987", "KE 5759"]  # sorted by actual time
    assert flat["flights"] == wrapped["flights"]
    assert flat["airports"]["TPE"]["flights"] == 3
    assert flat["tdx_updated"] == "2026-10-08T13:41:36+08:00"
    f = flat["flights"][0]
    assert (f["gate"], f["checkpoint"], f["status"], f["status_zh"], f["status_en"]) == ("A4", "A", "arrived", "已到", "ARRIVED")
    assert f["scheduled"] == "2026-10-07T00:15+08:00" and f["actual"] == "2026-10-06T23:19+08:00"
    assert f["aircraft"] == "B737-900" and f["from"] == "CJU"


def test_latest_fixture_parses_and_validates():
    raw = json.loads(LATEST.read_text(encoding="utf-8"))
    now = datetime.fromisoformat(raw[0]["UpdateTime"]).astimezone(C.TAIPEI)  # the fixture's own 'as of' moment
    doc = A.parse(raw, None, {}, now, geo=json.loads((REPO / "web/data/airports.json").read_text(encoding="utf-8")))
    assert doc["flights"] and set(doc["airports"]) == {"TPE"}
    assert all(f["country"] != "TW" and f["checkpoint"] in (None, "A", "B", "C", "D") for f in doc["flights"])
    assert len({f["id"] for f in doc["flights"]}) == len(doc["flights"])
    assert not any(f["flight"] == "" for f in doc["flights"])
    v = validate.V()
    validate.check_arrivals(v, doc)
    assert v.errors == []


def test_shift_to_now_moves_fixture_to_the_clock():
    raw = json.loads(LATEST.read_text(encoding="utf-8"))
    now = datetime(2027, 3, 5, 9, 15, tzinfo=C.TAIPEI)
    shifted = A.shift_to_now(raw, now)
    doc = A.parse(shifted, None, {}, now, geo=GEO)
    assert doc["tdx_updated"].startswith("2027-03-05T09:1")  # 'as of' moment lands on now (minute precision)
    assert doc["flights"] and all(f["scheduled"].startswith("2027-03-0") for f in doc["flights"])


# ---------------------------------------------------------------- parse: rules
def test_codeshares_collapse_to_operating_carrier():
    rows = [row("2101", "BR", ac=None), row("101", "CI"), row("7015", "B7", ac=None), row("5511", "CA", ac=None)]
    doc = parse(rows)
    assert len(doc["flights"]) == 1
    f = doc["flights"][0]
    assert f["flight"] == "CI 101" and f["airline"] == "CI"
    assert f["codeshares"] == ["B7 7015", "BR 2101", "CA 5511"]
    assert f["aircraft"] == "A350-900"
    assert f["id"] == "TPE|NRT|2026-10-14T18:05"


def test_codeshares_without_operating_row_use_lowest_number():
    rows = [row("2101", "BR", ac=None), row("101", "CI", ac=None), row("99", "JL", ac=None)]
    f = one_of(rows)
    assert f["flight"] == "JL 99" and f["codeshares"] == ["BR 2101", "CI 101"] and f["aircraft"] == ""


def one_of(rows):
    doc = parse(rows)
    assert len(doc["flights"]) == 1
    return doc["flights"][0]


def test_different_time_or_origin_is_not_collapsed():
    doc = parse([row("101", sched="2026-10-14T18:05"), row("103", sched="2026-10-14T19:05"), row("201", org="HKG")])
    assert len(doc["flights"]) == 3


@pytest.mark.parametrize("gate,cp", [(" A8", "A"), ("B1R", "B"), ("D12", "D"), (" C7", "C"), ("", None), (None, None),
                                     ("   ", None), ("E3", None), ("12", None)])
def test_tpe_checkpoint_from_gate(gate, cp):
    f = one(row(gate=gate))
    assert f["checkpoint"] == cp
    assert f["gate"] == (gate or "").strip()


def test_other_airports_have_no_checkpoints():
    doc = parse([row(dst="TSA", gate="A1", org="ICN"), row("102")])
    tsa = next(f for f in doc["flights"] if f["airport"] == "TSA")
    assert tsa["checkpoint"] is None and tsa["gate"] == "A1"
    assert doc["airports"]["TSA"]["checkpoints"] == []
    assert [c["id"] for c in doc["airports"]["TPE"]["checkpoints"]] == list("ABCD")
    assert doc["airports"]["TPE"]["checkpoints"][2] == {"id": "C", "terminal": "2"}
    assert doc["airports"]["TSA"]["name_zh"] == "松山" and doc["airports"]["TSA"]["lat"] == 25.0694


def test_domestic_and_cargo_are_excluded():
    rows = [row("1", org="TSA", dst="KHH"), row("2", org="KHH", dst="TPE"), row("3", IsCargo=True), row("4", org="ICN")]
    doc = parse(rows)
    assert [f["flight"] for f in doc["flights"]] == ["CI 4"]
    # safety net: a Taiwan airport is domestic even if the country table says otherwise
    doc = A.parse([row("5", org="MZG")], {"MZG": "JP"}, {}, NOW, geo=GEO)
    assert doc["flights"] == []


def test_unknown_origin_country_is_kept_and_unknown_coordinates_are_null():
    f = one(row(org="XYZ"))
    assert f["country"] == "" and f["lat"] is None and f["lon"] is None
    assert f["from_zh"] == "XYZ" and f["from_en"] == "XYZ"
    known = one(row(org="NRT"))
    assert known["lat"] == 35.7647 and known["lon"] == 140.386 and known["country"] == "JP"


def test_origin_names_prefer_tdx_then_airports_json():
    f = one(row(org="NRT"), names={"NRT": ("Tokyo-Narita Intl", "東京成田")})
    assert (f["from_zh"], f["from_en"]) == ("東京成田", "Tokyo-Narita Intl")
    f = one(row(org="NRT"))
    assert f["from_en"] == "Tokyo" and f["from_zh"]  # airports.json city / zh table


def test_window_edges_and_best_time():
    start, end = "2026-10-14T16:40", "2026-10-14T22:40"  # NOW -2h / +4h (minute precision)
    rows = [row("1", sched="2026-10-14T16:39"), row("2", sched=start), row("3", sched=end), row("4", sched="2026-10-14T22:41"),
            # late flight: scheduled before the window but estimated inside -> listed (best time = estimated)
            row("5", sched="2026-10-14T15:00", est="2026-10-14T17:00"),
            # arrived early: scheduled inside, actual before the window -> dropped (best time = actual)
            row("6", sched="2026-10-14T17:00", act="2026-10-14T16:00", est="2026-10-14T16:00", remark="已到ARRIVED")]
    doc = parse(rows)
    assert sorted(f["flight"] for f in doc["flights"]) == ["CI 2", "CI 3", "CI 5"]
    assert doc["window"] == {"from": "2026-10-14T16:40:00+08:00", "to": "2026-10-14T22:40:00+08:00"}
    assert doc["generated_at"] == "2026-10-14T18:40:12+08:00"
    assert [f["flight"] for f in doc["flights"]] == ["CI 2", "CI 5", "CI 3"]


def test_airports_block_counts_window_but_lists_all_airports_in_payload():
    rows = [row("1"), row("2", dst="KHH", org="HKG", sched="2026-10-13T08:00"),  # KHH arrival far outside the window
            row("3", dst="TSA", org="NRT")]
    doc = parse(rows)
    assert list(doc["airports"]) == ["TPE", "TSA", "KHH"]
    assert [doc["airports"][k]["flights"] for k in doc["airports"]] == [1, 1, 0]
    assert list(parse([])["airports"]) == ["TPE"]  # TPE is always there
    assert parse([])["flights"] == [] and parse([])["tdx_updated"] is None


@pytest.mark.parametrize("remark,en,status,zh,eng", [
    ("已到ARRIVED", None, "arrived", "已到", "ARRIVED"),
    ("準時ON TIME", None, "on_time", "準時", "ON TIME"),
    ("延遲DELAY", None, "delayed", "延遲", "DELAY"),
    ("時間更改SCHEDULE CHANGE", None, "changed", "時間更改", "SCHEDULE CHANGE"),
    ("取消CANCELLED", None, "cancelled", "取消", "CANCELLED"),
    ("提早EARLY", None, "early", "提早", "EARLY"),
    ("", None, "other", "", ""),
    ("備降DIVERTED", None, "other", "備降", "DIVERTED"),
    ("延遲", "DELAY", "delayed", "延遲", "DELAY"),  # ArrivalRemarkEn wins for the English part
    ("ARRIVED", None, "arrived", "", "ARRIVED"),
])
def test_status_mapping(remark, en, status, zh, eng):
    kw = {"ArrivalRemarkEn": en} if en else {}
    f = one(row(remark=remark, **kw))
    assert (f["status"], f["status_zh"], f["status_en"]) == (status, zh, eng)


def test_cancelled_flight_uses_scheduled_time():
    r = row(remark="取消CANCELLED", sched="2026-10-14T18:05", est="2026-10-14T23:50")  # stale estimate outside the window
    f = one(r)
    assert f["status"] == "cancelled" and f["estimated"] == "2026-10-14T23:50+08:00"
    r = row(remark="取消CANCELLED", sched="2026-10-14T23:50", est="2026-10-14T18:05")
    assert parse([r])["flights"] == []


def test_times_have_offset_and_missing_is_null():
    f = one(row(sched="2026-10-14T18:05"))
    assert f["scheduled"] == "2026-10-14T18:05+08:00" and f["estimated"] is None and f["actual"] is None
    assert parse([row(sched="")])["flights"] == []  # unusable row is skipped, not fatal
    assert parse(["junk", {"x": 1}, None])["flights"] == []


def test_output_is_small_and_json_serialisable():
    rows = [row(str(n), org="NRT", sched=f"2026-10-14T{18 + n // 60:02d}:{n % 60:02d}") for n in range(0, 200, 2)]
    assert len(json.dumps(parse(rows), ensure_ascii=False)) < 150_000


# ---------------------------------------------------------------- guard
def prev_doc(generated, month="2026-10", cm=100, day="2026-10-14", cd=10):
    return {"generated_at": generated, "quota": {"month": month, "calls_month": cm, "cap_month": 4200, "day": day, "calls_day": cd}}


def at(h, m=0, day=14, month=10):
    return datetime(2026, month, day, h, m, tzinfo=C.TAIPEI)


def test_guard_age_day_and_night():
    p = prev_doc("2026-10-14T12:00:00+08:00")
    assert A.guard(p, at(12, 8), 4200)[0] is False
    assert A.guard(p, at(12, 9), 4200)[0] is True
    p = prev_doc("2026-10-14T03:00:00+08:00")
    ok, reason, _ = A.guard(p, at(3, 28), 4200)
    assert not ok and "29" in reason
    assert A.guard(p, at(3, 29), 4200)[0] is True
    # 04:59 is still night, 05:00 is day
    p = prev_doc("2026-10-14T04:40:00+08:00")
    assert A.guard(p, at(4, 59), 4200)[0] is False
    p = prev_doc("2026-10-14T04:50:00+08:00")
    assert A.guard(p, at(5, 0), 4200)[0] is True  # 10 min old, day rule 9
    # 23:59 is day
    assert A.guard(prev_doc("2026-10-14T23:50:00+08:00"), at(23, 59), 4200)[0] is True


def test_guard_force_skips_age_only():
    p = prev_doc("2026-10-14T12:00:00+08:00")
    assert A.guard(p, at(12, 1), 4200, force=True)[0] is True
    p = prev_doc("2026-10-14T12:00:00+08:00", cm=4200, cd=5)
    assert A.guard(p, at(12, 30), 4200, force=True)[0] is False
    p = prev_doc("2026-10-14T12:00:00+08:00", cm=500, cd=130)
    assert A.guard(p, at(12, 30), 4200, force=True)[0] is False


def test_guard_monthly_cap():
    # last day of the month: the monthly cap is the only thing left (4199 used, 1 call left)
    ok, reason, q = A.guard(prev_doc("2026-10-30T01:00:00+08:00", cm=4199, cd=100, day="2026-10-31"), at(12, day=31), 4200)
    assert ok and q["calls_month"] == 4199
    ok, reason, _ = A.guard(prev_doc("2026-10-14T01:00:00+08:00", cm=4200, cd=1), at(12), 4200)
    assert not ok and "monthly" in reason
    assert A.guard(prev_doc("2026-10-14T01:00:00+08:00", cm=4200, cd=1), at(12), 5000)[0] is True


def test_daily_allowance_math():
    # 14 Oct: 18 days left including today. cap 4200, 1000 used before today -> floor(3200/18)=177 -> min(130, 177)
    q = {"calls_month": 1050, "calls_day": 50}
    assert A.daily_allowance(q, at(12), 4200) == 130
    # running hot: 3600 used before today -> floor(600/18) = 33
    q = {"calls_month": 3650, "calls_day": 50}
    assert A.daily_allowance(q, at(12), 4200) == 33
    assert A.guard(prev_doc("2026-10-14T01:00:00+08:00", cm=3633, cd=33), at(12), 4200)[0] is False
    assert A.guard(prev_doc("2026-10-14T01:00:00+08:00", cm=3632, cd=32), at(12), 4200)[0] is True
    # last day of a month: all that is left, capped at 130
    q = {"calls_month": 4100, "calls_day": 0}
    assert A.daily_allowance(q, at(12, day=31), 4200) == 100
    # over budget before today: negative allowance -> blocked
    p = prev_doc("2026-10-14T01:00:00+08:00", cm=4300, cd=0)
    assert A.guard(p, at(12), 4300)[0] is False


def test_guard_resets_counters_on_new_day_and_month():
    p = prev_doc("2026-10-13T23:50:00+08:00", cm=2000, cd=130, day="2026-10-13")
    ok, _, q = A.guard(p, at(0, 5), 4200)
    assert q["day"] == "2026-10-14" and q["calls_day"] == 0 and q["calls_month"] == 2000
    p = prev_doc("2026-09-30T23:50:00+08:00", month="2026-09", cm=4100, cd=100, day="2026-09-30")
    ok, _, q = A.guard(p, at(12, 0, day=1, month=10), 4200)
    assert ok and q == {"month": "2026-10", "calls_month": 0, "cap_month": 4200, "day": "2026-10-01", "calls_day": 0}


@pytest.mark.parametrize("prev", [None, {}, [], "x", {"generated_at": "garbage"}, {"generated_at": 5, "quota": 7},
                                  {"quota": {"month": "2026-10", "calls_month": "many", "calls_day": None}},
                                  {"generated_at": "2099-01-01T00:00:00+08:00"}])
def test_guard_missing_or_corrupt_prev_is_ok_with_fresh_counters(prev):
    ok, reason, q = A.guard(prev, at(12), 4200)
    assert ok and reason == "ok"
    assert q == {"month": "2026-10", "calls_month": 0, "cap_month": 4200, "day": "2026-10-14", "calls_day": 0}


# ---------------------------------------------------------------- fetch
ALL = A.ENDPOINT_ALL + A.QUERY.replace("%24", "$")
TPE = A.ENDPOINT_TPE + A.QUERY.replace("%24", "$")
BODY = [row()]


def url_matcher(url):
    return responses.matchers.query_string_matcher(url.split("?", 1)[1].replace("%24", "$"))


@responses.activate
def test_fetch_with_token_uses_one_all_airports_call():
    responses.add(responses.GET, A.ENDPOINT_ALL, json=BODY)
    obj, calls, endpoint, source = A.fetch(http.new_session(), "tok")
    assert (calls, endpoint, source) == (1, A.ENDPOINT_ALL, "tdx") and obj == BODY
    req = responses.calls[0].request
    assert req.headers["Authorization"] == "Bearer tok"
    assert "IsCargo=false" in req.url and "format=JSON" in req.url


@responses.activate
@pytest.mark.parametrize("bad", [dict(status=500), dict(status=401), dict(body="<html>", status=200), dict(json=[], status=200),
                                 dict(json={"message": "x"}, status=200)])
def test_fetch_falls_back_to_tpe_once(bad):
    responses.add(responses.GET, A.ENDPOINT_ALL, **bad)
    responses.add(responses.GET, A.ENDPOINT_TPE, json=BODY)
    obj, calls, endpoint, source = A.fetch(http.new_session(), "tok")
    assert (calls, endpoint, source) == (2, A.ENDPOINT_TPE, "tdx")
    assert len(responses.calls) == 2  # no retries on 5xx: every request costs quota
    assert responses.calls[1].request.headers["Authorization"] == "Bearer tok"


@responses.activate
def test_fetch_without_token_calls_tpe_only():
    responses.add(responses.GET, A.ENDPOINT_TPE, json=BODY)
    obj, calls, endpoint, source = A.fetch(http.new_session(), None)
    assert (calls, endpoint, source) == (1, A.ENDPOINT_TPE, "tdx-anon")
    assert "Authorization" not in responses.calls[0].request.headers


@responses.activate
def test_fetch_total_failure_raises_with_call_count():
    responses.add(responses.GET, A.ENDPOINT_ALL, status=503)
    responses.add(responses.GET, A.ENDPOINT_TPE, status=503)
    with pytest.raises(A.FetchError) as e:
        A.fetch(http.new_session(), "secret-token")
    assert e.value.calls == 2 and "secret-token" not in str(e.value)
    responses.replace(responses.GET, A.ENDPOINT_TPE, status=429)
    with pytest.raises(A.FetchError) as e:
        A.fetch(http.new_session(), None)
    assert e.value.calls == 1


# ---------------------------------------------------------------- CLI
def run_cli(*args):
    return main(["arrivals", *args])


def test_cli_offline_writes_valid_file(root, tmp_path, capsys):
    out = tmp_path / "arrivals.json"
    prev = tmp_path / "prev.json"
    prev.write_text(json.dumps(prev_doc("2026-10-07T00:00:00+08:00", month="2026-10", cm=77, day="2026-10-07", cd=5)))
    rc = run_cli("--offline", str(PROBE), "--now", "2026-10-07T00:30:00+08:00", "--out", str(out), "--prev", str(prev))
    assert rc == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["quota"]["calls_month"] == 77 and doc["quota"]["calls_day"] == 5  # unchanged: no TDX call was made
    assert len(doc["flights"]) == 3
    assert errors_of(doc) == []
    # validate_dir picks the file up when present
    d = C.web_data()
    (d / "arrivals.json").write_text(out.read_text(encoding="utf-8"), encoding="utf-8")
    assert not [e for e in validate.validate_dir(d) if e.startswith("arrivals.json")]


def test_cli_check_only_reports_and_writes_github_output(root, tmp_path, monkeypatch, capsys):
    gh = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(gh))
    prev = tmp_path / "prev.json"
    prev.write_text(json.dumps(prev_doc("2026-10-14T12:00:00+08:00")))
    assert run_cli("--check-only", "--prev", str(prev), "--now", "2026-10-14T12:03:00+08:00") == 0
    assert json.loads(capsys.readouterr().out)["ok"] is False
    assert run_cli("--check-only", "--prev", str(prev), "--now", "2026-10-14T12:03:00+08:00", "--force") == 0
    assert json.loads(capsys.readouterr().out) == {"ok": True, "reason": "ok"}
    assert run_cli("--check-only", "--prev", str(tmp_path / "missing.json"), "--now", "2026-10-14T12:03:00+08:00", "--cap", "100") == 0
    assert gh.read_text().split() == ["fetch=false", "fetch=true", "fetch=true"]
    monkeypatch.setenv("ARRIVALS_MONTHLY_CAP", "50")
    capsys.readouterr()
    run_cli("--check-only", "--prev", str(prev), "--now", "2026-10-14T12:30:00+08:00")
    assert json.loads(capsys.readouterr().out)["ok"] is False  # 100 calls this month >= cap 50 (env)


def test_cli_normal_run_counts_calls(root, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(A, "fetch", lambda s, t: ([row(sched="2026-10-14T18:05")], 2, A.ENDPOINT_TPE, "tdx"))
    monkeypatch.setattr(tdx, "get_token", lambda s=None: ("tok", "token ok"))
    out, prev = tmp_path / "o.json", tmp_path / "p.json"
    prev.write_text(json.dumps(prev_doc("2026-10-14T12:00:00+08:00", cm=100, cd=10)))
    assert run_cli("--prev", str(prev), "--out", str(out), "--now", "2026-10-14T18:40:12+08:00") == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["quota"] == {"month": "2026-10", "calls_month": 102, "cap_month": 4200, "day": "2026-10-14", "calls_day": 12}
    assert doc["endpoint"] == A.ENDPOINT_TPE and doc["source"] == "tdx" and len(doc["flights"]) == 1
    assert "tok" not in capsys.readouterr().out


def test_cli_guard_refusal_writes_nothing_and_exits_zero(root, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(A, "fetch", lambda s, t: pytest.fail("must not call TDX"))
    out, prev = tmp_path / "o.json", tmp_path / "p.json"
    prev.write_text(json.dumps(prev_doc("2026-10-14T18:35:00+08:00")))
    assert run_cli("--prev", str(prev), "--out", str(out), "--now", "2026-10-14T18:40:12+08:00") == 0
    assert not out.exists() and "not fetching" in capsys.readouterr().out


def test_cli_tdx_failure_exits_nonzero_and_keeps_old_file(root, tmp_path, monkeypatch):
    def boom(s, t):
        raise A.FetchError("down", 2)
    monkeypatch.setattr(A, "fetch", boom)
    out = tmp_path / "o.json"
    out.write_text("old")
    assert run_cli("--out", str(out), "--now", "2026-10-14T18:40:12+08:00") == 1
    assert out.read_text() == "old"


# ---------------------------------------------------------------- validate
def good_doc():
    return parse([row("1"), row("2", org="HKG", est="2026-10-14T19:00", remark="延遲DELAY", gate="D12"),
                  row("3", dst="TSA", org="ICN", gate="")])


def errors_of(doc):
    v = validate.V()
    validate.check_arrivals(v, doc)
    return v.errors


def test_validate_accepts_generated_document():
    assert errors_of(good_doc()) == []


def test_validate_absent_file_is_fine(root):
    (C.web_data() / "arrivals.json").unlink(missing_ok=True)
    assert not [e for e in validate.validate_dir(C.web_data()) if "arrivals" in e]


@pytest.mark.parametrize("mutate,needle", [
    (lambda d: d.pop("quota"), "quota"),
    (lambda d: d.update(source="x"), "source"),
    (lambda d: d["flights"][0].update(status="late"), "status"),
    (lambda d: d["flights"][0].update(checkpoint="E"), "checkpoint"),
    (lambda d: d["flights"][0].update(scheduled="2026-10-14T18:05"), "scheduled"),  # no offset
    (lambda d: d["flights"][0].update(lat="35"), "lat"),
    (lambda d: d["flights"][0].pop("lon"), "lon"),
    (lambda d: d["flights"][0].update(airport="KHH"), "KHH"),
    (lambda d: d["flights"].reverse(), "sorted"),
    (lambda d: d["flights"][0].update(country="TW"), "domestic"),
    (lambda d: d["airports"]["TPE"].update(flights=99), "flights=99"),
    (lambda d: d["quota"].update(calls_day=10 ** 6), "calls_day"),
    (lambda d: d["flights"][0].update(codeshares=["Z 1", "A 1"]), "sorted"),
    (lambda d: d["window"].update(to="soon"), "window.to"),
])
def test_validate_rejects_broken_documents(mutate, needle):
    doc = good_doc()
    assert errors_of(doc) == []
    mutate(doc)
    errs = errors_of(doc)
    assert errs and any(needle in e for e in errs), errs


def test_validate_null_coordinates_are_fine():
    doc = parse([row(org="XYZ")])
    assert doc["flights"][0]["lat"] is None and errors_of(doc) == []
