import sqlite3

from pipeline import common as C
from pipeline import db
from pipeline import mofa as M
from pipeline import validate as VAL

RAW = C.ROOT / "data" / "raw" / "boca"


def _fixture():
    rows = M.parse_list((RAW / "sp-trwa-list-1.html").read_text(encoding="utf-8"))
    rss = M.parse_rss((RAW / "sp-trwa-rss-1.xml").read_text(encoding="utf-8"))
    return rows, rss


def test_parse_fixture():
    rows, rss = _fixture()
    assert len(rows) >= 200 and len(rss) >= 200
    assert {r["level"] for r in rows} <= {0, 1, 2, 3, 4}
    assert set(M.REGIONS) >= {r["region"] for r in rows}
    linked = [r for r in rows if r["id"]]
    assert sum(r["id"] in rss for r in linked) / len(linked) > 0.95  # list rows join the RSS by content id
    assert M.parse_level("第三級：橙色避免前往") == 3 and M.parse_level("未發布旅遊警示分級") == 0
    assert M.split_zh_en("柬埔寨 Cambodia") == ("柬埔寨", "Cambodia")


def _resolver():
    conn = sqlite3.connect(f"file:{C.db_path()}?mode=ro", uri=True)  # CDC CSV names live in the committed DB
    return M.name_resolver(conn)


def test_build_countries_areas_and_mac():
    rows, rss = _fixture()
    b = M.build(rows, rss, _resolver(), M._mac(), C.load_json(C.web_data() / "countries.json", {}))
    c = b["countries"]
    assert c["KH"]["level"] == 3 and c["KH"]["max_level"] == 4 and c["KH"]["areas"][0]["level"] == 4
    assert c["PS"]["level"] is None and c["PS"]["max_level"] == 4 and len(c["PS"]["areas"]) == 2
    assert c["BQ"]["level"] is None and c["BQ"]["name_zh"] != "荷屬沙巴"  # two islands, no whole-country row
    for iso in ("CN", "HK", "MO"):
        assert c[iso]["source"] == "mac" and c[iso]["level"] == 3 and c[iso]["confirmed"]
    assert [u["title"] for u in b["unmapped"]] and all("Somaliland" in u["title"] for u in b["unmapped"])
    assert c["JP"]["summary_zh"] and len(c["JP"]["summary_zh"]) <= M.SUMMARY_MAX
    assert all(t for t in b["texts"].values())


def _conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(db.SCHEMA)
    return conn


def test_history_baseline_then_changes():
    conn = _conn()
    assert M.record(conn, {"KH|": 3, "KH|柏威夏省": 4}, "2026-10-01") == 0  # baseline
    assert M.record(conn, {"KH|": 4, "KH|柏威夏省": 4, "JP|": 1}, "2026-10-02") == 2  # raised + new
    assert M.record(conn, {"KH|": 4, "JP|": 1}, "2026-10-03") == 1  # area withdrawn
    ch = [(r["date"], r["iso"], r["area_zh"], r["from_level"], r["to_level"]) for r in conn.execute("SELECT * FROM mofa_changes ORDER BY id")]
    assert ch == [("2026-10-02", "KH", "", 3, 4), ("2026-10-02", "JP", "", None, 1), ("2026-10-03", "KH", "柏威夏省", 4, None)]


def test_summary_and_plain_text():
    text = M._plain("<p>一、第一段文字。<br />二、第二段。</p>")
    assert text.split("\n") == ["一、第一段文字。", "二、第二段。"]
    assert M.summary(text) == "第一段文字。"
    assert M.summary("一、" + "長" * 300).endswith("…")


def test_validate_warnings(tmp_path):
    rows, rss = _fixture()
    b = M.build(rows, rss, _resolver(), M._mac())
    doc = {"generated_at": C.iso_ts(), "sources": {"mofa": {"url": M.LIST_URL, "rss": M.RSS_URL, "fetched_at": "", "items": 1, "ok": True},
                                                  "mac": {"url": "https://www.mac.gov.tw/x", "confirmed": "2026-02-02", "manual": True}},
           "levels": M.LEVELS, "regions": {k: {"zh": v[0], "en": v[1]} for k, v in M.REGIONS.items()},
           "countries": b["countries"], "unmapped": b["unmapped"], "changes": {"mofa": [], "cdc": []}}
    v = VAL.V()
    VAL.check_warnings(v, doc)
    assert v.errors == []
    doc["countries"]["KH"]["level"] = 7
    VAL.check_warnings(v, doc)
    assert v.errors
