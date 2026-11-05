from pipeline import travelmed


def test_check_header_rows_and_encoding():
    good = "醫事機構代碼,合約醫院名稱,所在縣市\n0101090517,臺大醫院,臺北市\n".encode("utf-8-sig")
    assert travelmed.check(good, ["醫事機構代碼", "所在縣市"], 1) == (1, None)
    n, problem = travelmed.check(good, ["醫事機構代碼", "星期"], 1)
    assert "星期" in problem
    n, problem = travelmed.check(good, ["醫事機構代碼"], 5)
    assert n == 1 and "only 1 rows" in problem
    big5 = "疾病,疫苗\nA,B\n".encode("cp950")
    assert travelmed.check(big5, ["疾病", "疫苗"], 1) == (1, None)
    assert travelmed.check(b"", ["x"], 1)[1] == "empty file"


def test_fetch_skips_the_rest_when_the_host_is_unreachable(monkeypatch, tmp_path):
    import requests
    calls = []

    def boom(url, **kw):
        calls.append(url)
        raise requests.exceptions.ConnectTimeout("Connection to od.cdc.gov.tw timed out")

    monkeypatch.setattr(travelmed.http, "get", boom)
    monkeypatch.setattr(travelmed, "raw_dir", lambda: tmp_path)
    (tmp_path / "TMClinicsList.csv").write_text("kept")
    st = travelmed.fetch()
    assert len(calls) == 1 and not st["ok"] and "skipped" in st["reason"]
    assert (tmp_path / "TMClinicsList.csv").read_text() == "kept"


# ------------------------------------------------------------------- web pages and export
import json  # noqa: E402
import shutil  # noqa: E402

from pipeline import travelmed_pages as P  # noqa: E402
from pipeline import validate  # noqa: E402

from .conftest import FIX, REPO  # noqa: E402


def test_parse_page_sections_vaccines_groups_and_hotline():
    doc = P.parse((FIX / "travelmed_page_TH.html").read_text(encoding="utf-8"))
    assert doc["hotline"] == [{"where": "", "tel": "+66-81-666-4006"}]
    names = [v["name"] for v in doc["vaccines"]]
    assert names[0] == "例行性預防接種" and "瘧疾預防用藥" in names and "黃熱病疫苗" in names
    yf = next(v for v in doc["vaccines"] if v["name"] == "黃熱病疫苗")["lines"]
    assert yf[0]["k"] == "入境預防接種規定" and "g" not in yf[0]
    local = next(ln for ln in yf if ln.get("k") == "當地預防接種建議")
    assert "g" not in local  # the second general paragraph ends the immunocompromised block
    assert {ln.get("g") for ln in yf} >= {"infants", "pregnancy", "immuno"}
    assert len([ln for ln in yf if ln.get("g") == "infants"]) == 1  # repeated group notes are dropped
    dis = doc["sections"]["diseases"]
    assert {"t": "預防蚊蟲叮咬", "h": 1} in dis
    assert any(ln.get("k") == "重要流行疾病" and "霍亂" in ln["t"] for ln in dis)
    assert any(ln.get("d") == 2 and "DEET" in ln["t"] for ln in dis)
    assert {ln.get("g") for ln in doc["sections"]["before"]} >= set(P.GROUPS.values())
    assert set(doc["sections"]) == {"before", "vaccines", "diseases", "during", "after"}


def test_hotlines_per_mission():
    html = ("<section><h3>旅途中的健康照護</h3><div><strong>急難救助求救管道</strong>"
            "<ul><li>外館急難救助專線(河內)：+84-913-219-986</li><li>外館急難救助專線(胡志明市)：+84-903-927-019</li></ul>"
            "<div>如無法與駐外單位取得聯繫…0800-085-095</div></div></section>")
    assert P.parse(html)["hotline"] == [{"where": "河內", "tel": "+84-913-219-986"}, {"where": "胡志明市", "tel": "+84-903-927-019"}]


def test_split_name():
    assert P.split_name("Thailand 泰國") == ("泰國", "Thailand")
    assert P.split_name("Lao People's Dem Rep 寮國") == ("寮國", "Lao People's Dem Rep")


def _tm_root(root):
    raw = root / "data" / "raw" / "travelmed"
    shutil.copytree(REPO / "data" / "raw" / "travelmed", raw, ignore=shutil.ignore_patterns("pages"))
    pages = raw / "pages"
    pages.mkdir()
    shutil.copy(FIX / "travelmed_page_TH.html", pages / "498.html")
    (pages / "index.json").write_text(json.dumps({"498": {"zh": "泰國", "en": "Thailand", "area": "1"}}), encoding="utf-8")
    (pages / "state.json").write_text(json.dumps({"498": {"checked": "2026-10-01T10:00:00+08:00", "sha": "x"}}), encoding="utf-8")
    return root


def test_build_exports_countries_clinics_and_page_details(root):
    _tm_root(root)
    out = root / "web" / "data"
    doc = travelmed.build(out)
    assert doc and not doc["unmapped"]
    th = doc["countries"]["TH"]
    assert "日本腦炎疫苗" in th["vax"] and th["page"] == "2026-10-01"
    vector = [doc["terms"][i]["zh"] for i in th["dis"]["vector"]]
    assert "登革熱" in vector
    assert [s["zh"] for s in doc["countries"]["PT"]["subs"]] == ["葡屬亞速群島", "馬德拉群島"]
    assert "MY" in doc["countries"] and doc["countries"]["MY"]["zh"] == "馬來西亞"  # Madeira shares Malaysia's 458
    q = next(t for t in doc["terms"] if t["zh"].startswith("蜱媒腦炎(北海道"))
    assert q["base"] == "蜱媒腦炎" and q["en"].startswith("Tick-borne encephalitis (")
    assert len(doc["clinics"]) == 33 and all(c["hours"] for c in doc["clinics"])  # Penghu: matched by name
    ntuh = next(c for c in doc["clinics"] if c["id"] == "401180014")
    assert ntuh["mpox"] is True and ntuh["city"] == "臺北市" and len(ntuh["hours"]) == 7
    assert doc["clinics"][0]["city"] == "基隆市"  # north to south
    det = json.loads((out / "travelmed" / "TH.json").read_text(encoding="utf-8"))
    assert det["page"]["hotline"] == [{"where": "", "tel": "+66-81-666-4006"}] and det["cid"] == "498"
    v = validate.V()
    validate.check_travelmed(v, doc)
    validate.check_travelmed_details(v, out / "travelmed", doc)
    assert v.errors == []
    # same input → same "updated" date and identical output apart from generated_at
    again = travelmed.build(out)
    assert again["updated"] == doc["updated"] and again["sha"] == doc["sha"]


def test_build_without_raw_files_writes_nothing(root):
    assert travelmed.build(root / "web" / "data") is None
    assert not (root / "web" / "data" / "travelmed.json").exists()


class _Resp:
    def __init__(self, text="", js=None):
        self.text, self._js, self.content, self.status_code = text, js, text.encode(), 200

    def json(self):
        return self._js

    def raise_for_status(self):
        pass


def test_crawl_fetches_index_and_stale_pages(root, monkeypatch):
    form = '<select id="AreaList"><option value="-999">x</option><option value="1">亞太</option></select>'
    listing = [{"Text": f"Country{i} 國{i}", "Value": str(500 + i)} for i in range(160)]
    page = (FIX / "travelmed_page_TH.html").read_text(encoding="utf-8")
    printed = page.replace("<section><h3>", '<div class="card"><h3 class="card-title">').replace(
        "</h3>", '</h3><div class="card-body">').replace("</section>", "</div></div>")
    calls = []

    def get(url, **kw):
        calls.append(url)
        return _Resp(form if "Index" in url else printed)

    class S:
        def post(self, url, data=None, timeout=None):
            calls.append(url)
            return _Resp(js=listing)

    monkeypatch.setattr(P.http, "get", get)
    monkeypatch.setattr(P, "_sleep", lambda s: None)
    st = P.crawl(S(), max_pages=3)
    assert st["ok"] and st["index"] == 160 and st["checked"] == 3 and st["changed"] == 3
    d = P.pages_dir()
    assert len(list(d.glob("*.html"))) == 3
    assert "黃熱病疫苗" in (d / "500.html").read_text(encoding="utf-8")
    state = json.loads((d / "state.json").read_text(encoding="utf-8"))
    assert set(state) == {"_index_at", "500", "501", "502"}
    # next run: index is fresh, the three pages are not due; the next three are
    calls.clear()
    st = P.crawl(S(), max_pages=3)
    assert st["checked"] == 3 and not any("CounterList" in c for c in calls)
    assert "503.html" in {p.name for p in d.glob("*.html")}
