import json

from pipeline import common as C
from pipeline import places, validate


def _seed(conn, out_dir):
    conn.executemany("INSERT INTO airports_tdx(iata, zh, en, country, updated) VALUES(?,?,?,?,?)", [
        ("NRT", "東京成田", "Tokyo-Narita", "JP", "x"),
        ("OVB", "俄羅斯", "Novosibirsk", "RU", "x"),   # TDX names this airport after its country
        ("HKG", "香港", "Hong Kong", "HK", "x"),       # a single-airport place really is called that
        ("XXX", "", "Nowhere", "JP", "x"),             # no Chinese name anywhere: left to airports.json
    ])
    (out_dir / "watch.json").write_text(json.dumps({"sets": [{"hub": {"iata": "IKT"}, "hub_zh": "伊爾庫次克",
        "routes": [{"iata": "OVB", "city_zh": "新西伯利亞"}]}]}, ensure_ascii=False), encoding="utf-8")
    (out_dir / "weather.json").write_text(json.dumps({"cities": [{"name_zh": "曼谷", "name_en": "Bangkok", "iso": "TH"},
        {"name_zh": "無國碼", "name_en": "No ISO", "iso": None}]}, ensure_ascii=False), encoding="utf-8")


def test_places_names_countries_and_cities(conn, root):
    out = C.web_data()
    _seed(conn, out)
    doc = places.build(conn, out)
    by = {p["code"] or p["zh"]: p for p in doc["places"]}
    assert by["NRT"] == {"code": "NRT", "iso": "JP", "zh": "東京成田", "en": "Tokyo-Narita"}
    assert by["OVB"]["zh"] == "新西伯利亞"          # the country-named TDX entry loses to the route-watch name
    assert by["HKG"]["zh"] == "香港"                # ... but stays when it is the only name
    assert by["IKT"]["zh"] == "伊爾庫次克" and by["IKT"]["iso"] == "RU"
    assert "XXX" not in by
    assert by["曼谷"] == {"code": "", "iso": "TH", "zh": "曼谷", "en": "Bangkok"} and "無國碼" not in by
    v = validate.V()
    validate.check_places(v, doc)
    assert v.errors == []


def test_places_is_idempotent_and_validated_in_dir(conn, root):
    out = C.web_data()
    _seed(conn, out)
    first = places.build(conn, out)
    again = places.build(conn, out)
    assert again["generated_at"] == first["generated_at"]   # unchanged list: same file, no churn in git
    bad = json.loads((out / "places.json").read_text(encoding="utf-8"))
    bad["places"][0]["iso"] = "Japan"
    bad["places"].append({"code": "nrt", "iso": "JP", "zh": "<b>x</b>", "en": ""})
    v = validate.V()
    validate.check_places(v, bad)
    msgs = " ".join(map(str, v.errors))
    assert "iso" in msgs and "IATA" in msgs and "HTML" in msgs
