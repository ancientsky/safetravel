import json
import shutil
from pathlib import Path

from pipeline import common as C
from pipeline import places, validate

REPO = Path(__file__).resolve().parents[2]


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
    assert {k: by["NRT"][k] for k in ("code", "iso", "zh", "en")} == {"code": "NRT", "iso": "JP", "zh": "東京成田", "en": "Tokyo-Narita"}
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


def test_places_aliases(conn, root):
    """Other names an airport answers to: losing source names + pipeline/airport_alias.json, no repeats, no country."""
    out = C.web_data()
    _seed(conn, out)
    (root / "pipeline").mkdir(exist_ok=True)
    shutil.copy(REPO / "pipeline" / "airport_alias.json", root / "pipeline" / "airport_alias.json")
    conn.execute("INSERT INTO airports_tdx(iata, zh, en, country, updated) VALUES('NGO','中部','Chubu Centrair Intl','JP','x')")
    by = {p["code"] or p["zh"]: p for p in places.build(conn, out)["places"]}
    ngo = by["NGO"]["alias"]
    assert by["NGO"]["zh"] == "中部" and "名古屋" in ngo and "Nagoya" in ngo and "セントレア" in ngo
    assert "中部" not in ngo and len(ngo) == len(set(ngo))
    assert "俄羅斯" not in by["OVB"].get("alias", [])     # a country's name is not an airport alias
    assert by["FKS"]["zh"] == "福島"                       # curated Chinese name when no source has one
    v = validate.V()
    validate.check_places(v, {"version": 1, "generated_at": "x", "places": [
        {"code": "NGO", "iso": "JP", "zh": "中部", "en": "", "alias": ["<img>"]},
        {"code": "KIX", "iso": "JP", "zh": "關西", "en": "", "alias": "大阪"}]})
    msgs = " ".join(map(str, v.errors))
    assert "alias looks like HTML" in msgs and "alias must be a list" in msgs


def test_airport_alias_file_is_clean():
    doc = json.loads((REPO / "pipeline" / "airport_alias.json").read_text(encoding="utf-8"))
    for code, names in doc.items():
        if code.startswith("_"):
            continue
        assert places.IATA.match(code), code
        assert isinstance(names, list) and names and all(isinstance(n, str) and n.strip() == n and n for n in names), code
        assert len(names) == len(set(names)), code
