import json

from pipeline import common as C
from pipeline import db, export, load, validate


def _export(conn):
    export.export_all(conn)
    return {n: json.loads((C.web_data() / f"{n}.json").read_text(encoding="utf-8")) for n in ("alerts", "epidemics", "meta")}


def test_load_is_idempotent(conn):
    a = load.load_all(conn)
    b = load.load_all(conn)
    assert a["alerts"]["new"] == 2504 and b["alerts"]["new"] == 0
    assert b["epidemics"]["new"] == 0 and b["epidemics"]["changed"] == 0
    assert conn.execute("SELECT COUNT(*) FROM alerts_raw").fetchone()[0] == 2504


def test_namibia_is_not_null(loaded):
    assert loaded.execute("SELECT COUNT(*) FROM alerts_raw WHERE ISO3166='NA'").fetchone()[0] > 0
    assert "NA" in _export(loaded)["alerts"]["countries"]


def test_business_rules(loaded):
    out = _export(loaded)
    al = out["alerts"]["countries"]
    cd = al["CD"]
    assert cd["max_level"] == 3
    assert any(a["disease"] == "伊波拉病毒感染" and a["level"] == 3 for a in cd["alerts"])
    cn = al["CN"]
    assert cn["max_level"] == 2 and any(a["iso_sub"].startswith("CN-") for a in cn["alerts"])
    assert [k for k, v in al.items() if v["max_level"] == 3] == ["CD"]
    # COVID: the old name never appears; the new one is a global advisory applied to every mapped country
    everything = json.dumps(out["alerts"], ensure_ascii=False)
    assert "嚴重特殊傳染性肺炎" not in everything
    assert [g["disease"] for g in out["alerts"]["global"]] == ["新冠併發重症"]
    assert out["alerts"]["global"][0]["applied_to_all"] is True
    assert all(any(a["disease"] == "新冠併發重症" and a.get("global") for a in c["alerts"]) for c in al.values())
    assert "TW" not in al and "AQ" not in al
    assert al["JP"]["max_level"] >= 1
    # sub-national English names come from the built-in dictionary
    assert next(a for a in cn["alerts"] if a["iso_sub"] == "CN-11")["area_en"] == "Beijing"
    # ties on the same timestamp resolve to the higher level (DE mpox 2025-03-05 L2/L1)
    assert al["DE"]["max_level"] == 2


def test_sorting_and_diseases(loaded):
    out = _export(loaded)
    for c in out["alerts"]["countries"].values():
        lv = [a["level"] for a in c["alerts"]]
        assert lv == sorted(lv, reverse=True)
    assert out["alerts"]["diseases"]["伊波拉病毒感染"]["en"] == "Ebola virus disease"
    dates = [i["date"] for i in out["epidemics"]["items"]]
    assert dates == sorted(dates, reverse=True)
    assert out["epidemics"]["window_start"] == "2024-10-08" and min(dates) >= "2024-10-08"


def test_fallback_without_ai(loaded):
    out = _export(loaded)
    it = out["epidemics"]["items"][0]
    assert it["ai"] is False and it["headline_en"] == it["headline_zh"] and it["description_en"] == it["description_zh"]
    assert it["summary_zh"] and it["summary_zh"] in it["description_zh"]
    assert out["meta"]["counts"]["ai_translated"] == 0
    assert all(not o["ai"] for o in out["epidemics"]["overviews"].values())
    g = [i for i in out["epidemics"]["items"] if i.get("global")]
    assert g and all(i["countries"] == [] for i in g)


def test_nfkc_applied(loaded):
    r = loaded.execute("SELECT headline, description FROM epidemics").fetchall()
    assert not any("⾏" in x["headline"] + x["description"] for x in r)


def test_validate_passes_and_catches_violations(loaded):
    _export(loaded)
    # flights.json comes from the static fallback / kept file; create it via the real code path
    from pipeline.__main__ import apply_static_fallback
    apply_static_fallback(loaded)
    export.export_all(loaded)
    assert validate.validate_dir(C.web_data()) == []
    p = C.web_data() / "alerts.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    d["countries"]["cd"] = d["countries"]["CD"]
    d["countries"]["CD"]["alerts"].reverse()
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    errs = validate.validate_dir(C.web_data())
    assert any("upper-case" in e for e in errs) and any("sorted" in e for e in errs)


def test_overview_and_translation_used_when_present(loaded):
    row = loaded.execute("SELECT * FROM epidemics ORDER BY effective DESC LIMIT 1").fetchone()
    db.put_translation(loaded, row["content_hash"], headline_en="H", summary_zh="摘要", summary_en="Sum", description_en="Desc", model="m")
    iso = row["isos"].split(",")[0]
    db.put_overview(loaded, iso, "x", "概況", "Overview", 1, "m")
    out = _export(loaded)
    it = next(i for i in out["epidemics"]["items"] if i["id"] == row["id"])
    assert it["ai"] and it["headline_en"] == "H" and it["summary_en"] == "Sum"
    assert out["epidemics"]["overviews"][iso]["en"] == "Overview" and out["epidemics"]["overviews"][iso]["ai"]
    assert out["meta"]["counts"]["ai_translated"] == 1


def test_epidemic_urls_are_cdc_https_only(loaded):
    assert C.safe_cdc_url("https://www.cdc.gov.tw/TravelEpidemic/Detail?epidemicId=abc") != ""
    assert C.safe_cdc_url("https://cdc.gov.tw/x") != ""
    for bad in ("http://www.cdc.gov.tw/x", "javascript:alert(1)", "https://cdc.gov.tw.evil.com/x", "https://evil.com/?https://cdc.gov.tw/",
                "https://evilcdc.gov.tw/x", "https://user@evil.com\\@www.cdc.gov.tw/x", ""):
        assert C.safe_cdc_url(bad) == "", bad
    loaded.execute("UPDATE epidemics SET url='javascript:alert(1)'")
    items = _export(loaded)["epidemics"]["items"]
    assert items and all(it["url"] == "" for it in items)
    from pipeline.__main__ import apply_static_fallback
    apply_static_fallback(loaded)
    export.export_all(loaded)
    p = C.web_data() / "epidemics.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    d["items"][0]["url"] = "https://evil.example.com/x"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    assert any("cdc.gov.tw" in e for e in validate.validate_dir(C.web_data()))
