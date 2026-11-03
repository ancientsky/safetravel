import json
import shutil

import pytest

from pipeline import common as C
from pipeline import slides_auto as A
from pipeline import validate as VAL

PNG = C.ROOT / "web" / "slides" / "assets" / "cdc-logo.png"


def make_web(tmp_path, *names):
    """A minimal web/ copy: the real slides.json + airports.json + assets, and the given files in slides/auto/."""
    web = tmp_path / "web"
    shutil.copytree(C.ROOT / "web" / "slides" / "assets", web / "slides" / "assets")
    shutil.copy(C.ROOT / "web" / "slides" / "slides.json", web / "slides" / "slides.json")
    shutil.copy(C.ROOT / "web" / "slides" / "airports.json", web / "slides" / "airports.json")
    (web / "slides" / "auto").mkdir()
    for n in names:
        shutil.copy(PNG, web / "slides" / "auto" / n)
    return web


def test_parse_tokens():
    p = A.parse("01_猴痘宣導_上架2026-11-10_下架2026-12-31_10秒_橫式_英文_加頁尾.png")
    assert p == {"title": "猴痘宣導", "order": 1, "from": "2026-11-10", "until": "2026-12-31", "duration": 10,
                 "orient": "landscape", "lang": "en", "brand": True}
    # English tokens, spaces, full-width digits (NFKC), single-digit month/day
    p = A.parse("Mpox poster until2026-1-5 ８s portrait.JPG")
    assert (p["title"], p["until"], p["duration"], p["orient"]) == ("Mpox poster", "2026-01-05", 8, "portrait")
    assert A.parse("海報.webp") == {"title": "海報", "order": None}


@pytest.mark.parametrize("name, msg", [
    ("x_下架2026-02-30.png", "no such date"),
    ("x_上架2026-12-01_下架2026-11-01.png", "after"),
    ("x_99秒.png", "3..60"),
    ("x_直式_橫式.png", "conflicting"),
])
def test_parse_rejects(name, msg):
    with pytest.raises(A.NameError_, match=msg):
        A.parse(name)


def test_scan_pairs_orientations_orders_and_skips(tmp_path):
    web = make_web(tmp_path, "02_登革熱 防蚊.png", "01_猴痘_直式_下架2026-12-31.png", "01_猴痘_橫式.png",
                   "_草稿.png", "notes.txt")
    doc, errors, warnings = A.scan(web)
    assert not errors and not warnings
    s = doc["slides"]
    assert [x["alt"] for x in s] == ["猴痘", "登革熱 防蚊"]
    assert s[0]["src"] == "slides/auto/01_%E7%8C%B4%E7%97%98_%E7%9B%B4%E5%BC%8F_%E4%B8%8B%E6%9E%B62026-12-31.png"
    assert s[0]["src_landscape"].startswith("slides/auto/01_") and s[0]["until"] == "2026-12-31"
    assert "src_landscape" not in s[1] and s[1]["id"].startswith("auto-")
    assert A.write(web, doc) is True and A.write(web, doc) is False  # idempotent
    assert VAL.validate_slides(web) == []


def test_bad_name_strict_fails_lenient_skips(tmp_path, capsys):
    web = make_web(tmp_path, "ok.png", "壞_下架2026-13-01.png")
    assert A.main([str(web)]) == 1
    assert "壞_下架2026-13-01.png" in capsys.readouterr().out
    assert A.main([str(web), "--lenient"]) == 0
    doc = json.loads((web / "slides" / "auto" / "index.json").read_text(encoding="utf-8"))
    assert [x["alt"] for x in doc["slides"]] == ["ok"]


def test_validator_rejects_tampered_index(tmp_path):
    web = make_web(tmp_path, "a.png")
    doc, _, _ = A.scan(web)
    doc["slides"][0]["src"] = "slides/auto/missing.png"
    doc["slides"].append({**doc["slides"][0], "src": "https://evil.example/x.png"})
    A.write(web, doc)
    msgs = " ".join(VAL.validate_slides(web))
    assert "does not exist" in msgs and "url-encoded" in msgs and "duplicate id" in msgs


def test_committed_index_matches_the_folder():
    doc, errors, _ = A.scan(C.ROOT / "web")
    assert not errors
    committed = (C.ROOT / "web" / "slides" / "auto" / "index.json").read_text(encoding="utf-8")
    assert json.loads(committed) == doc, "run: python -m pipeline.slides_auto web"


def test_alert_routes_need_known_airports(tmp_path):
    web = make_web(tmp_path)
    p = web / "slides" / "slides.json"
    m = json.loads(p.read_text(encoding="utf-8"))
    alert = next(s for s in m["slides"] if s.get("routes"))
    alert["routes"] = [["FIH", "XXX", "TPE"], ["FIH"]]
    p.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    msgs = " ".join(VAL.validate_slides(web))
    assert "'XXX' is not in web/slides/airports.json" in msgs and "2-4 airport codes" in msgs
