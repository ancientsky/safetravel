from pipeline import export, validate


def _index():
    items = [
        {"id": "a", "date": "2026-11-03", "countries": ["VN"]},
        {"id": "b", "date": "2026-09-05", "countries": ["JP"]},   # exactly 59 days before
        {"id": "c", "date": "2026-09-04", "countries": []},       # 60 days: still in
        {"id": "d", "date": "2026-09-03", "countries": ["TH"]},   # 61 days: out
    ]
    return {"generated_at": "2026-11-03T08:00:00+08:00", "window_start": "2024-11-03", "details_dir": "epidemics/",
            "items": items, "overviews": {}}


def test_recent_slice_newest_first_and_validated():
    idx = _index()
    rec = export.recent_epidemics(idx)
    assert rec["since"] == "2026-09-04" and rec["days"] == 60
    assert [it["id"] for it in rec["items"]] == ["a", "b", "c"]
    assert rec["items"][0] is idx["items"][0]                    # same item objects / shape as epidemics.json
    v = validate.V()
    validate.check_epidemics_recent(v, rec, idx)
    assert v.errors == []


def test_recent_validator_flags_strays():
    idx = _index()
    rec = export.recent_epidemics(idx)
    rec["items"].append({"id": "zzz", "date": "2026-10-01", "countries": []})
    rec["items"].append(dict(idx["items"][3]))                   # older than `since`
    v = validate.V()
    validate.check_epidemics_recent(v, rec, idx)
    msgs = " ".join(map(str, v.errors))
    assert "zzz" in msgs and "before since" in msgs
