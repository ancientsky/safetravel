import json
from pathlib import Path

import pytest

from pipeline import common as C
from pipeline import flights as F
from pipeline import tdx

FIX = Path(__file__).parent / "fixtures"
DAY = "2026-10-08"
AIRPORTS = json.loads((Path(__file__).resolve().parents[2] / "web" / "data" / "airports.json").read_text(encoding="utf-8"))


def totals(routes):
    return len(routes), sum(r["departures"] for r in routes), sum(r["arrivals"] for r in routes)


@pytest.mark.parametrize("name,lang,kind", [
    ("a_flight_v4_sample.txt", "en", "file"),
    ("timetable_tabs.html", "en", "html"),
    ("timetable_list_zh.html", "zh", "html"),
    ("timetable_nuxt.html", "en", "html-json"),
])
def test_all_parsers_agree(name, lang, kind):
    k, recs = F.parse_any((FIX / name).read_bytes(), lang, AIRPORTS)
    assert k == kind
    routes = F.aggregate(recs, DAY)
    assert totals(routes) == (8, 21, 23)  # other-day row and exact duplicate row are not counted
    r = {x["iata"]: x for x in routes}
    assert r["HKG"]["departures"] == 3 and r["HKG"]["arrivals"] == 4
    assert r["HKG"]["airlines"] and all(len(a) == 2 for a in r["HKG"]["airlines"])


def test_names_from_source():
    _, recs = F.parse_any((FIX / "a_flight_v4_sample.txt").read_bytes(), "en", AIRPORTS)
    r = {x["iata"]: x for x in F.aggregate(recs, DAY)}
    assert r["NRT"]["city_en"] == "Tokyo (Narita)" and r["NRT"]["city_zh"] == "東京(成田)"
    _, zh = F.parse_any((FIX / "timetable_list_zh.html").read_bytes(), "zh", AIRPORTS)
    _, en = F.parse_any((FIX / "timetable_tabs.html").read_bytes(), "en", AIRPORTS)
    merged = {x["iata"]: x for x in F.aggregate(en, DAY, name_sources=[zh])}
    assert merged["NRT"]["city_en"] == "Tokyo (Narita)" and merged["NRT"]["city_zh"] == "東京(成田)"


def test_flight_file_encodings():
    text = (FIX / "a_flight_v4_sample.txt").read_text(encoding="utf-8")
    for enc in ("utf-8", "utf-8-sig", "big5", "cp950"):
        recs = F.parse_flight_file(text.encode(enc))
        assert len(recs) == 46, enc
        assert recs[0].city_zh == "東京(成田)", enc


def test_garbage_and_cloudflare_pages_yield_nothing():
    cf = b"<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>"
    assert F.parse_any(cf, "en", AIRPORTS)[1] == []
    assert F.parse_any(b"", "en", AIRPORTS)[1] == []
    assert F.parse_any(b"hello,world\n1,2", "en", AIRPORTS)[1] == []
    assert F.parse_any(b"{not json", "en", AIRPORTS)[1] == []


def test_tdx_parse_rules():
    raw = json.loads((FIX / "tdx_fids_sample.json").read_text(encoding="utf-8"))
    recs = tdx.parse_fids(raw)
    routes = {r["iata"]: r for r in F.aggregate(recs, DAY)}
    assert {k: (v["departures"], v["arrivals"]) for k, v in routes.items()} == {
        "HKG": (34, 34), "NRT": (21, 21), "BKK": (16, 14), "SFO": (7, 7)}
    # codeshares collapse into the operating carrier
    assert set(routes["SFO"]["airlines"]) == {"BR", "UA", "CI", "JX"} and "AS" not in routes["SFO"]["airlines"]
    # other days are excluded by `day`
    assert sum(r["departures"] for r in F.aggregate(recs, "2026-10-07")) > 0
    # cancelled and cargo rows are dropped
    dep = raw[0]["FIDSDeparture"]
    victim = next(r for r in dep if r["FlightDate"] == DAY and r["ArrivalAirportID"] == "SFO" and r.get("AcType"))
    victim["DepartureRemark"] = "取消CANCELLED"
    cargo = dict(victim, DepartureRemark="準時ON TIME", IsCargo=True, ScheduleDepartureTime="2026-10-08T23:59")
    dep.append(cargo)
    again = {r["iata"]: r for r in F.aggregate(tdx.parse_fids(raw), DAY)}
    assert again["SFO"]["departures"] == routes["SFO"]["departures"] - 1


def test_tdx_fallback_to_all_airlines_without_actype():
    rows = [{"FlightDate": DAY, "FlightNumber": str(i), "AirlineID": "XX", "DepartureAirportID": "TPE", "ArrivalAirportID": "NRT",
             "ScheduleDepartureTime": f"{DAY}T0{i}:00", "IsCargo": False, "DepartureRemark": "ON TIME"} for i in range(1, 4)]
    r = F.aggregate(tdx.parse_fids([{"FIDSDeparture": rows, "FIDSArrival": []}]), DAY)
    assert r[0]["departures"] == 3 and r[0]["airlines"] == ["XX"]


def test_tdx_unknown_shapes_degrade_gracefully():
    assert tdx.parse_fids([]) == [] and tdx.parse_fids({"x": 1}) == [] and tdx.parse_fids([{"FIDSDeparture": [{"foo": 1}]}]) == []
    assert not tdx.looks_like_fids({"a": []})


def test_tdx_airport_names():
    names = tdx.parse_airports(json.loads((FIX / "tdx_airports_sample.json").read_text(encoding="utf-8")))
    assert names["AAN"] == ("Al Ain", "艾因", "AE") and names["ADJ"][1] == "安曼"
    _, recs = F.parse_any((FIX / "tdx_fids_sample.json").read_bytes(), "en", AIRPORTS)
    r = F.aggregate(recs, DAY, names={"NRT": ("Narita", "成田")})
    assert next(x for x in r if x["iata"] == "NRT")["city_zh"] == "成田"


def test_static_routes(root):
    from pipeline import static_routes as SR
    routes = SR.build_routes()
    if not routes:
        pytest.skip("routes.dat not present")
    assert len(routes) > 50 and all(r["departures"] == r["arrivals"] == len(r["airlines"]) or not r["airlines"] for r in routes)
    assert {"NRT", "HKG"} <= {r["iata"] for r in routes}
