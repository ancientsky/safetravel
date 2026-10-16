import json

from pipeline import watch as W
from pipeline import validate as VAL


def test_build_irkutsk(tmp_path):
    (tmp_path / "airports.json").write_text((W.C.web_data() / "airports.json").read_text(encoding="utf-8"), encoding="utf-8")
    doc = W.build(tmp_path)
    s = next(x for x in doc["sets"] if x["id"] == "irkutsk")
    assert s["hub"]["iata"] == "IKT" and s["hub"]["country"] == "RU"
    assert s["totals"] == {"destinations": 51, "monthly": 1568, "countries": 7}
    by = {r["iata"]: r for r in s["routes"]}
    assert by["UBN"]["lat"] == 47.6469 and by["UBN"]["country"] == "MN"  # coordinate override (not in airports.json)
    assert by["OVB"]["city_zh"] == "新西伯利亞" and s["routes"][0]["iata"] == "OVB"  # busiest first
    assert [r["monthly"] for r in s["routes"]] == sorted((r["monthly"] for r in s["routes"]), reverse=True)
    v = VAL.V()
    VAL.check_watch(v, json.loads((tmp_path / "watch.json").read_text(encoding="utf-8")))
    assert v.errors == []


def test_route_without_coordinates_is_dropped(tmp_path):
    wdir = tmp_path / "watch"
    wdir.mkdir()
    (wdir / "x.csv").write_text("Country,City_Airport,IATA,Monthly_Flights\nRussia,Nowhere,ZZZ,3\nRussia,Irkutsk,IKT,5\n", encoding="utf-8")
    (wdir / "x.json").write_text(json.dumps({"id": "x", "hub": "IKT", "routes": "x.csv", "coords": {"IKT": [52.27, 104.39]},
                                             "countries": {"Russia": "RU"}}), encoding="utf-8")
    doc = W.build(tmp_path, wdir)
    assert [r["iata"] for r in doc["sets"][0]["routes"]] == ["IKT"]


def test_build_kinshasa_aliases_notes_and_idle_routes(tmp_path):
    (tmp_path / "airports.json").write_text((W.C.web_data() / "airports.json").read_text(encoding="utf-8"), encoding="utf-8")
    s = next(x for x in W.build(tmp_path)["sets"] if x["id"] == "kinshasa")
    by = {r["iata"]: r for r in s["routes"]}
    assert s["hub"]["iata"] == "FIH" and s["hub"]["country"] == "CD"
    assert s["totals"] == {"destinations": 17, "monthly": 345, "countries": 16}  # City/Code/Flights_Per_Month columns
    assert by["NBO"]["note_zh"] and by["NBO"]["note_en"] and "note_zh" not in by["ADD"]
    assert by["ABJ"]["country"] == "CI"  # "Côte d’Ivoire" with a typographic apostrophe
    assert by["NBJ"]["lat"] == -9.05  # coordinate override: not in airports.json
    assert by["CMN"]["monthly"] == 0 and s["routes"][-1]["monthly"] == 0  # idle routes kept, listed last
