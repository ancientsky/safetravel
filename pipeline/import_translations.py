"""Import pre-made translations/overviews into the SQLite cache (one-off backfill).

Usage:
  python pipeline/import_translations.py translations <dir-or-file.json> [--model NAME]
  python pipeline/import_translations.py overviews <file.json> [--model NAME]
  python pipeline/import_translations.py diseases <file.json> [--model NAME]

translations: JSON list (or a directory of JSON lists) of
  {"hash": <epidemics.content_hash>, "headline_en", "description_en", "summary_zh", "summary_en"}
overviews: JSON object {ISO2: {"zh": ..., "en": ...}}; items_hash is computed from the current 2-year window
  exactly like the exporter does, so the pipeline will not regenerate them until the country's items change.
diseases: JSON object {zh: en} stored in the disease_names table (data/manual/diseases.json still takes precedence).
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline import common as C  # noqa: E402
from pipeline import db  # noqa: E402
from pipeline import export as X  # noqa: E402

TPE = timezone(timedelta(hours=8))
CJK = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff]")
REQUIRED = ("headline_en", "description_en", "summary_zh", "summary_en")


def load_items(path: Path) -> list[dict]:
    files = sorted(path.glob("*.json")) if path.is_dir() else [path]
    out: list[dict] = []
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data = [dict(v, hash=k) for k, v in data.items()]
        out.extend(data)
    return out


def import_translations(conn: sqlite3.Connection, items: list[dict], model: str) -> tuple[int, int]:
    known = {r[0] for r in conn.execute("SELECT content_hash FROM epidemics")}
    now = datetime.now(TPE).isoformat(timespec="seconds")
    ok = skipped = 0
    for it in items:
        h = it.get("hash")
        if h not in known or any(not str(it.get(k, "")).strip() for k in REQUIRED):
            skipped += 1
            continue
        conn.execute(
            "INSERT INTO translations(content_hash,headline_en,summary_zh,summary_en,description_en,model,created_at)"
            " VALUES(?,?,?,?,?,?,?) ON CONFLICT(content_hash) DO UPDATE SET headline_en=excluded.headline_en,"
            " summary_zh=excluded.summary_zh,summary_en=excluded.summary_en,description_en=excluded.description_en,"
            " model=excluded.model,created_at=excluded.created_at",
            (h, C.nfkc(it["headline_en"]), C.nfkc(it["summary_zh"]), C.nfkc(it["summary_en"]),
             C.nfkc(it["description_en"]), model, now),
        )
        ok += 1
    conn.commit()
    return ok, skipped


def import_overviews(conn: sqlite3.Connection, data: dict, model: str) -> tuple[int, int]:
    # Mirror pipeline.gemini._overview_inputs so the stored items_hash matches what the pipeline computes.
    conn.row_factory = sqlite3.Row
    ids_by_iso: dict[str, list[str]] = {}
    for r in X.epidemic_rows(conn, C.window_start()):
        if r["is_global"]:
            continue
        for iso in dict.fromkeys(x for x in (r["isos"] or "").split(",") if x):
            ids_by_iso.setdefault(iso, []).append(r["id"])
    now = datetime.now(TPE).date().isoformat()
    ok = skipped = 0
    for iso, ov in data.items():
        ids = ids_by_iso.get(iso)
        if not ids or not str(ov.get("zh", "")).strip() or not str(ov.get("en", "")).strip():
            skipped += 1
            continue
        conn.execute(
            "INSERT INTO overviews(iso,items_hash,zh,en,items,model,updated) VALUES(?,?,?,?,?,?,?)"
            " ON CONFLICT(iso) DO UPDATE SET items_hash=excluded.items_hash,zh=excluded.zh,en=excluded.en,"
            " items=excluded.items,model=excluded.model,updated=excluded.updated",
            (iso, X.overview_hash(ids), C.nfkc(ov["zh"]), C.nfkc(ov["en"]), len(ids), model, now),
        )
        ok += 1
    conn.commit()
    return ok, skipped


def import_diseases(conn: sqlite3.Connection, data: dict, model: str) -> tuple[int, int]:
    ok = skipped = 0
    for zh, en in data.items():
        zh, en = C.nfkc(str(zh)).strip(), C.nfkc(str(en or "")).strip()
        if not zh or not en or CJK.search(en):
            skipped += 1
            continue
        db.put_name(conn, "disease_names", zh, en, model)
        ok += 1
    return ok, skipped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["translations", "overviews", "diseases"])
    ap.add_argument("path")
    ap.add_argument("--model", default="batch-import")
    ap.add_argument("--db", default=str(ROOT / "data" / "safetravel.db"))
    a = ap.parse_args()
    conn = sqlite3.connect(a.db)
    if a.kind == "translations":
        ok, skipped = import_translations(conn, load_items(Path(a.path)), a.model)
    elif a.kind == "diseases":
        ok, skipped = import_diseases(conn, json.loads(Path(a.path).read_text(encoding="utf-8")), a.model)
    else:
        ok, skipped = import_overviews(conn, json.loads(Path(a.path).read_text(encoding="utf-8")), a.model)
    print(f"{a.kind}: imported {ok}, skipped {skipped}")


if __name__ == "__main__":
    main()
