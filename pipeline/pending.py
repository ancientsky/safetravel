"""Export the AI work that is still pending, for an external translator (e.g. a scheduled Claude session).

    python -m pipeline pending --out DIR [--chunk 25]

Writes:
  DIR/translations/in/chunk_NNN.json   untranslated epidemic digests (hash, id, date, headline, description, ...)
  DIR/overviews/in/countries_NN.json   countries whose 2-year item set changed since their stored overview
  DIR/README.txt                       the expected output format (what import_translations.py consumes)

Exits 0 and prints JSON counts. The translator writes DIR/translations/out/*.json and DIR/overviews/out/*.json,
then runs `python pipeline/import_translations.py translations DIR/translations/out` and
`python pipeline/import_translations.py overviews DIR/overviews/out/all.json`, followed by `python -m pipeline export`.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import common as C
from . import db
from . import export as X

README = """Output format (one file per input chunk, same name, under ../out/):

translations/out/chunk_NNN.json : JSON list, one object per input item in the same order:
  {"hash": <copied>, "headline_en": str, "description_en": str, "summary_zh": str (<=40 chars, Traditional Chinese),
   "summary_en": str (<=30 words)}

overviews/out/all.json : JSON object {ISO2: {"zh": str (2-3 sentences, <=120 chars), "en": str (2-3 sentences, <=70 words)}}
  covering every country listed in overviews/in/*.json.
"""


def pending_translations(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT e.content_hash, e.id, e.effective, e.headline, e.description, e.disease, e.area_zh, e.area_en"
        " FROM epidemics e LEFT JOIN translations t ON t.content_hash = e.content_hash"
        " WHERE t.content_hash IS NULL ORDER BY e.effective DESC"
    ).fetchall()
    seen, out = set(), []
    for r in rows:
        if r["content_hash"] in seen:
            continue
        seen.add(r["content_hash"])
        out.append({"hash": r["content_hash"], "id": r["id"], "date": X._day(r["effective"]), "headline": r["headline"],
                    "description": r["description"], "disease": r["disease"], "area_zh": r["area_zh"], "area_en": r["area_en"]})
    return out


def pending_overviews(conn) -> list[dict]:
    """Same inputs the Gemini job would use (pipeline.gemini._overview_inputs), limited to changed countries."""
    from . import gemini
    return gemini.overviews_pending(conn, C.window_start())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipeline pending")
    ap.add_argument("--out", required=True)
    ap.add_argument("--chunk", type=int, default=25)
    ap.add_argument("--overview-batch", type=int, default=30, help="countries per overview input file")
    a = ap.parse_args(argv)
    out = Path(a.out)
    conn = db.connect()

    items = pending_translations(conn)
    tdir = out / "translations" / "in"
    tdir.mkdir(parents=True, exist_ok=True)
    (out / "translations" / "out").mkdir(parents=True, exist_ok=True)
    for k in range(0, len(items), a.chunk):
        (tdir / f"chunk_{k // a.chunk:03d}.json").write_text(
            json.dumps(items[k:k + a.chunk], ensure_ascii=False, indent=0), encoding="utf-8")

    ovs = pending_overviews(conn)
    odir = out / "overviews" / "in"
    odir.mkdir(parents=True, exist_ok=True)
    (out / "overviews" / "out").mkdir(parents=True, exist_ok=True)
    public = [{k: v for k, v in o.items() if not k.startswith("_")} for o in ovs]
    for k in range(0, len(public), a.overview_batch):
        (odir / f"countries_{k // a.overview_batch:02d}.json").write_text(
            json.dumps(public[k:k + a.overview_batch], ensure_ascii=False, indent=0), encoding="utf-8")

    (out / "README.txt").write_text(README, encoding="utf-8")
    counts = {"translations": len(items), "translation_chunks": -(-len(items) // a.chunk) if items else 0,
              "overviews": len(ovs), "overview_files": -(-len(ovs) // a.overview_batch) if ovs else 0}
    print(json.dumps(counts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
