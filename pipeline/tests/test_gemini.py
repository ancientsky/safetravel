import json

import pytest
import requests
import responses

from pipeline import common as C
from pipeline import db, export, gemini
from pipeline.gemini import Budget, Client, GeminiBadResponse, GeminiError, GeminiFatal

URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"


def wrap(obj, finish="STOP"):
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": finish}]}


def client(max_calls=50, key="SECRETKEY"):
    return Client(key, "gemini-3.5-flash", Budget(max_calls, 40))


@responses.activate
def test_request_shape_and_json_parsing():
    responses.add(responses.POST, URL, json=wrap([{"id": "a", "x": "中文"}]))
    out = client().generate_json("sys", "user", gemini.SCHEMA_NAMES)
    assert out == [{"id": "a", "x": "中文"}]
    req = responses.calls[0].request
    assert "key=SECRETKEY" in req.url
    body = json.loads(req.body)
    gc = body["generationConfig"]
    assert gc["responseMimeType"] == "application/json" and gc["temperature"] == 0.2 and "responseSchema" in gc
    assert body["systemInstruction"]["parts"][0]["text"] == "sys"


@responses.activate
def test_markdown_fenced_json_is_accepted():
    responses.add(responses.POST, URL, json=wrap('```json\n[{"a": 1}]\n```'))
    assert client().generate_json("s", "u", {}) == [{"a": 1}]


@responses.activate
def test_retries_429_and_5xx_then_succeeds(monkeypatch):
    sleeps = []
    monkeypatch.setattr(gemini, "_sleep", sleeps.append)
    responses.add(responses.POST, URL, status=429, headers={"Retry-After": "7"})
    responses.add(responses.POST, URL, status=503)
    responses.add(responses.POST, URL, json=wrap([1]))
    c = client()
    assert c.generate_json("s", "u", {}) == [1]
    assert len(responses.calls) == 3 and c.budget.calls == 3
    assert len(sleeps) == 2 and sleeps[0] >= 7 and sleeps[1] >= 4  # Retry-After honoured, exponential otherwise


@responses.activate
def test_gives_up_after_six_tries():
    responses.add(responses.POST, URL, status=500, body="boom")
    with pytest.raises(GeminiError, match="6 tries"):
        client().generate_json("s", "u", {})
    assert len(responses.calls) == 6


@responses.activate
def test_network_errors_are_retried_and_key_is_redacted():
    responses.add(responses.POST, URL, body=requests.ConnectionError("failed https://x/?key=SECRETKEY"))
    responses.add(responses.POST, URL, json=wrap({"ok": True}))
    assert client().generate_json("s", "u", {}) == {"ok": True}
    responses.reset()
    responses.add(responses.POST, URL, body=requests.ConnectionError("failed https://x/?key=SECRETKEY"))
    with pytest.raises(GeminiError) as ei:
        client().generate_json("s", "u", {})
    assert "SECRETKEY" not in str(ei.value)


@responses.activate
def test_bad_key_is_fatal_and_other_4xx_is_not_retried():
    responses.add(responses.POST, URL, status=400, json={"error": {"message": "API key not valid. Please pass a valid API key."}})
    with pytest.raises(GeminiFatal):
        client().generate_json("s", "u", {})
    responses.reset()
    responses.add(responses.POST, URL, status=400, json={"error": {"message": "bad schema"}})
    with pytest.raises(GeminiError) as ei:
        client().generate_json("s", "u", {})
    assert not isinstance(ei.value, GeminiFatal) and len(responses.calls) == 1


@responses.activate
def test_truncated_blocked_and_invalid_json():
    responses.add(responses.POST, URL, json=wrap('[{"a"', finish="MAX_TOKENS"))
    with pytest.raises(GeminiBadResponse):
        client().generate_json("s", "u", {})
    responses.reset()
    responses.add(responses.POST, URL, json={"promptFeedback": {"blockReason": "SAFETY"}})
    with pytest.raises(GeminiBadResponse, match="blocked"):
        client().generate_json("s", "u", {})
    responses.reset()
    responses.add(responses.POST, URL, json=wrap("not json at all"))
    responses.add(responses.POST, URL, json=wrap("still not json"))
    with pytest.raises(GeminiBadResponse):
        client().generate_json("s", "u", {})
    assert len(responses.calls) == 2


@responses.activate
def test_call_budget():
    responses.add(responses.POST, URL, json=wrap([1]))
    c = client(max_calls=2)
    c.generate_json("s", "u", {})
    c.generate_json("s", "u", {})
    with pytest.raises(gemini.BudgetExhausted):
        c.generate_json("s", "u", {})
    assert len(responses.calls) == 2


def test_time_budget_exhausted():
    c = Client("k", "m", Budget(10, time_budget_min=0))
    with pytest.raises(gemini.BudgetExhausted):
        c.generate_json("s", "u", {})


def test_no_api_key_skips(monkeypatch, loaded):
    assert gemini.make_client() is None
    stats = gemini.enrich(loaded, None)
    assert stats["skipped"] is True
    assert loaded.execute("SELECT COUNT(*) FROM translations").fetchone()[0] == 0


# ---------------------------------------------------------------- enrichment
class FakeClient:
    """Answers the three prompt kinds deterministically; records calls."""
    model = "fake-model"

    def __init__(self, drop_ids=(), fail_big_batches=False):
        self.calls = []
        self.budget = Budget(1000, 40)
        self.drop = set(drop_ids)
        self.fail_big = fail_big_batches

    def generate_json(self, system, user, schema):
        payload = json.loads(user)
        self.budget.calls += 1
        if schema is gemini.SCHEMA_TRANSLATE:
            self.calls.append(("t", [p["id"] for p in payload]))
            if self.fail_big and len(payload) > 3:
                raise GeminiBadResponse("truncated")
            return [{"id": p["id"], "headline_en": "EN " + p["headline"], "description_en": "EN " + p["description"],
                     "summary_zh": "摘要" + p["id"][:4], "summary_en": "Summary " + p["id"][:4]}
                    for p in payload if p["id"] not in self.drop]
        if schema is gemini.SCHEMA_OVERVIEW:
            self.calls.append(("o", [p["iso"] for p in payload]))
            return [{"iso": p["iso"], "zh": f"{p['name_zh']}概況", "en": f"{p['name_en']} overview"} for p in payload]
        self.calls.append(("n", [p["zh"] for p in payload]))
        return [{"zh": p["zh"], "en": "EN-" + p["zh"]} for p in payload]


@pytest.fixture
def small(loaded):
    """Shrink the DB to the 40 newest in-window epidemic items so enrichment tests are quick."""
    keep = [r["id"] for r in export.epidemic_rows(loaded, C.window_start())[:40]]
    loaded.execute(f"DELETE FROM epidemics WHERE id NOT IN ({','.join('?' * len(keep))})", keep)
    loaded.commit()
    return loaded


def test_enrich_translates_batches_and_is_incremental(small):
    fc = FakeClient()
    stats = gemini.enrich(small, fc)
    assert stats["translated"] == 40 and stats["errors"] == 0
    t_calls = [c for c in fc.calls if c[0] == "t"]
    assert len(t_calls) == 3 and all(len(c[1]) <= 15 for c in t_calls)
    out = export.build_epidemics(small, "x", export.Names(small))
    assert all(i["ai"] for i in out["items"]) and out["items"][0]["headline_en"].startswith("EN ")
    assert set(out["overviews"]) and all(o["ai"] for o in out["overviews"].values())
    # a disease name that was missing from data/manual got filled from the "names" job
    names = db.names(small, "disease_names")
    assert all(v.startswith("EN-") for v in names.values())
    # second run: nothing left to do, no calls at all
    fc2 = FakeClient()
    stats2 = gemini.enrich(small, fc2)
    assert fc2.calls == [] and stats2["translated"] == 0


def test_overview_regenerates_only_when_item_set_changes(small):
    gemini.enrich(small, FakeClient())
    before = {r["iso"]: r["items_hash"] for r in small.execute("SELECT iso, items_hash FROM overviews")}
    # new item for one country -> only that country is regenerated
    iso = next(iter(before))
    row = dict(small.execute("SELECT * FROM epidemics WHERE isos LIKE ? LIMIT 1", (f"%{iso}%",)).fetchone())
    row.update(id="NEWID", content_hash="newhash", row_hash="r", effective="2026-10-08T09:00:00+08:00")
    cols = list(row)
    small.execute(f"INSERT INTO epidemics({','.join(cols)}) VALUES({','.join('?' * len(cols))})", list(row.values()))
    small.commit()
    fc = FakeClient()
    gemini.enrich(small, fc)
    regenerated = [i for kind, ids in fc.calls if kind == "o" for i in ids]
    expected = set(row["isos"].split(","))
    assert set(regenerated) == expected & set(before)
    assert [c for c in fc.calls if c[0] == "t"] == [("t", ["NEWID"])]


def test_missing_ids_are_retried_and_persistent_failures_recorded(small):
    bad = export.epidemic_rows(small, C.window_start())[0]["id"]
    fc = FakeClient(drop_ids={bad})
    stats = gemini.enrich(small, fc)
    assert stats["translated"] == 39
    h = small.execute("SELECT content_hash FROM epidemics WHERE id=?", (bad,)).fetchone()[0]
    assert db.ai_failure_count(small, "translate", h) >= 1
    out = export.build_epidemics(small, "x", export.Names(small))
    assert next(i for i in out["items"] if i["id"] == bad)["ai"] is False  # falls back to the Chinese text


def test_bad_response_splits_the_batch(small):
    fc = FakeClient(fail_big_batches=True)
    stats = gemini.enrich(small, fc)
    assert stats["translated"] == 40
    assert max(len(ids) for k, ids in fc.calls if k == "t") <= 15
    assert any(len(ids) <= 3 for k, ids in fc.calls if k == "t")


def test_enrich_stops_on_budget(small):
    fc = FakeClient()
    fc.budget = Budget(max_calls=2, time_budget_min=40)
    real = fc.generate_json

    def limited(system, user, schema):
        fc.budget.check()
        return real(system, user, schema)
    fc.generate_json = limited
    stats = gemini.enrich(small, fc)
    assert stats["stopped"] and "budget" in stats["stopped"]


@responses.activate
def test_enrich_end_to_end_over_http(small, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")

    def cb(request):
        body = json.loads(request.body)
        props = body["generationConfig"]["responseSchema"]["items"]["properties"]
        schema = (gemini.SCHEMA_TRANSLATE if "headline_en" in props
                  else gemini.SCHEMA_OVERVIEW if "iso" in props else gemini.SCHEMA_NAMES)
        out = FakeClient().generate_json("", body["contents"][0]["parts"][0]["text"], schema)
        return 200, {}, json.dumps(wrap(out))
    responses.add_callback(responses.POST, URL, callback=cb)
    client_ = gemini.make_client(max_calls=100)
    stats = gemini.enrich(small, client_)
    assert stats["translated"] == 40 and stats["calls"] == len(responses.calls) > 0
