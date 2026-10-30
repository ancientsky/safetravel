import json
import re

import responses

from pipeline import common as C
from pipeline import validate as VAL
from pipeline import weather as W

RAW = json.loads((C.ROOT / "data" / "raw" / "cwa" / "F-C0032-007.json").read_text(encoding="utf-8-sig"))


def test_build_from_fixture():
    doc = W.build(RAW)
    assert len(doc["cities"]) == 80 and not doc["unmapped"]
    assert [r["id"] for r in doc["regions"]] == ["asia", "americas", "china", "europe"]
    assert len(doc["days"]) == 7
    tokyo = next(c for c in doc["cities"] if c["id"] == "47662")
    assert (tokyo["name_zh"], tokyo["name_en"], tokyo["iso"], tokyo["region"]) == ("東京", "Tokyo", "JP", "asia")
    assert len(tokyo["days"]) == 7
    for c in doc["cities"]:
        for d in c["days"]:
            assert d["icon"] in VAL.WEATHER_ICONS and d["wx_en"] and not re.search(r"[一-鿿]", d["wx_en"])
            assert d["max"] is None or d["min"] is None or d["max"] >= d["min"]


def test_icon_rules():
    cases = {"晴天": "sun", "晴時多雲": "partly", "多雲": "cloud", "陰天": "overcast", "陰時多雲": "overcast",
             "雨天": "rain", "陣雨": "showers", "雷陣雨": "thunder", "下雪": "snow", "雨夾雪": "sleet", "有霧": "fog"}
    assert {k: W.icon_for(k) for k in cases} == cases


def test_unknown_station_is_listed_not_dropped():
    raw = json.loads(json.dumps(RAW))
    raw["cwaopendata"]["Dataset"]["Locations"]["Location"][0]["StationID"] = "99999"
    doc = W.build(raw)
    assert len(doc["cities"]) == 80
    assert doc["unmapped"] == [{"id": "99999", "name_zh": "東京", "region": "亞洲、大洋洲"}]
    c = doc["cities"][0]
    assert c["iso"] is None and c["name_en"] == ""


def test_fetch_without_key_keeps_raw(monkeypatch):
    monkeypatch.delenv("CWA_API_KEY", raising=False)
    st = W.fetch()
    assert not st["ok"] and st["reason"] == "CWA_API_KEY not set"


@responses.activate
def test_fetch_error_never_leaks_the_key(monkeypatch, tmp_path):
    monkeypatch.setenv("CWA_API_KEY", "CWA-SECRET-1234")
    monkeypatch.setattr(W, "raw_path", lambda: tmp_path / "F-C0032-007.json")
    responses.add(responses.GET, re.compile(r"https://opendata\.cwa\.gov\.tw/.*"), status=401, body="unauthorized")
    st = W.fetch()
    assert not st["ok"] and "CWA-SECRET-1234" not in st["reason"] and "***" in st["reason"]
    assert not (tmp_path / "F-C0032-007.json").exists()


@responses.activate
def test_fetch_success_writes_raw(monkeypatch, tmp_path):
    monkeypatch.setenv("CWA_API_KEY", "k")
    monkeypatch.setattr(W, "raw_path", lambda: tmp_path / "F-C0032-007.json")
    responses.add(responses.GET, re.compile(r"https://opendata\.cwa\.gov\.tw/.*"), status=200, json=RAW)
    st = W.fetch()
    assert st["ok"] and st["items"] == 80 and (tmp_path / "F-C0032-007.json").exists()


def test_validator_accepts_export_and_rejects_bad_rows(tmp_path):
    doc = W.export(None, tmp_path)
    v = VAL.V()
    VAL.check_weather(v, json.loads((tmp_path / "weather.json").read_text(encoding="utf-8")))
    assert not v.errors
    bad = json.loads(json.dumps(doc))
    bad["cities"][0]["days"][0].update(icon="tornado", max=1, min=5)
    bad["cities"][1]["region"] = "mars"
    v = VAL.V()
    VAL.check_weather(v, bad)
    msgs = " ".join(str(e) for e in v.errors)
    assert "unknown icon" in msgs and "max below min" in msgs and "unknown region" in msgs
