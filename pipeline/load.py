"""Load the CDC CSVs from data/raw into SQLite (idempotent upserts)."""
from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timezone
from pathlib import Path

from . import common as C
from . import db

_ISO2 = re.compile(r"^[A-Za-z]{2}$")
_EPID_ID = re.compile(r"[?&]epidemicId=([\w-]+)")


def read_csv(path: Path) -> list[dict]:
    """Read a CDC CSV as plain strings (never NA-coerce: Namibia is 'NA')."""
    text = Path(path).read_bytes().decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text, newline="")))


def _file_time(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=C.TAIPEI).replace(microsecond=0).isoformat()


def load_alerts(conn, path: Path | None = None) -> dict:
    path = path or C.raw_dir() / "TCDCTravelAlertAll.csv"
    rows = read_csv(path)
    now = C.iso_ts()
    cols = C.ALERT_COLUMNS
    new = 0
    with conn:
        for r in rows:
            v = [C.nfkc(r.get(c)) for c in cols]
            if not v[1]:
                continue
            cur = conn.execute(
                f"INSERT OR IGNORE INTO alerts_raw(content_hash,{','.join(cols)},first_seen) VALUES(?,{','.join('?' * len(cols))},?)",
                (C.sha1(*v), *v, now))
            new += cur.rowcount
    total = conn.execute("SELECT COUNT(*) FROM alerts_raw").fetchone()[0]
    st = db.get_source_state(conn, "alerts")
    db.set_source_state(conn, "alerts", url=st.get("url") or C.ALERTS_URL, rows=len(rows),
                        fetched_at=st.get("fetched_at") or _file_time(path))
    C.log.info("alerts: %d csv rows, %d new, %d total in db", len(rows), new, total)
    return {"csv_rows": len(rows), "new": new, "total": total}


def epidemic_id(web: str, headline: str, effective: str) -> str:
    m = _EPID_ID.search(web or "")
    return m.group(1) if m else "h" + C.sha1(headline, effective)[:16]


def load_epidemics(conn, path: Path | None = None) -> dict:
    path = path or C.raw_dir() / "TCDCIntlEpid.csv"
    rows = read_csv(path)
    today = C.today().isoformat()
    parsed: dict[str, dict] = {}
    for r in rows:
        head = C.nfkc(r.get("headline"))
        desc = C.nfkc(r.get("description"))
        eff = C.nfkc(r.get("effective"))
        if not eff:
            continue
        web = (r.get("web") or "").strip()
        iid = epidemic_id(web, head, eff)
        isos = [x.strip().upper() for x in (r.get("ISO3166") or "").split(",") if _ISO2.match(x.strip())]
        area_zh = C.nfkc(r.get("areaDesc"))
        rec = {
            "id": iid, "content_hash": C.sha1(head, desc), "sent": C.nfkc(r.get("sent")), "effective": eff,
            "expires": C.nfkc(r.get("expires")), "headline": head, "description": desc,
            "disease": C.nfkc(r.get("alert_disease")), "area_zh": area_zh,
            "area_en": C.clean_en_name(C.nfkc(r.get("areaDesc_EN"))), "isos": ",".join(isos),
            "is_global": 1 if area_zh.startswith("全球") else 0, "url": web,
            "area_detail": C.nfkc(r.get("areaDetail")), "iso_sub": C.nfkc(r.get("ISO3166_2")),
        }
        prev = parsed.get(iid)
        if prev is None or rec["sent"] >= prev["sent"]:  # duplicate ids: latest 'sent' wins
            parsed[iid] = rec
    new = changed = 0
    with conn:
        for rec in parsed.values():
            rec["row_hash"] = C.sha1(*[str(rec[k]) for k in sorted(rec) if k != "id"])
            old = conn.execute("SELECT row_hash FROM epidemics WHERE id=?", (rec["id"],)).fetchone()
            if old is None:
                new += 1
            elif old[0] != rec["row_hash"]:
                changed += 1
            else:
                continue
            conn.execute(
                "INSERT INTO epidemics(id,content_hash,row_hash,sent,effective,expires,headline,description,disease,area_zh,"
                "area_en,isos,is_global,url,area_detail,iso_sub,first_seen,updated_at) VALUES"
                "(:id,:content_hash,:row_hash,:sent,:effective,:expires,:headline,:description,:disease,:area_zh,"
                ":area_en,:isos,:is_global,:url,:area_detail,:iso_sub,:today,:today)"
                " ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,row_hash=excluded.row_hash,sent=excluded.sent,"
                "effective=excluded.effective,expires=excluded.expires,headline=excluded.headline,description=excluded.description,"
                "disease=excluded.disease,area_zh=excluded.area_zh,area_en=excluded.area_en,isos=excluded.isos,"
                "is_global=excluded.is_global,url=excluded.url,area_detail=excluded.area_detail,iso_sub=excluded.iso_sub,"
                "updated_at=excluded.updated_at", {**rec, "today": today})
    total = conn.execute("SELECT COUNT(*) FROM epidemics").fetchone()[0]
    st = db.get_source_state(conn, "epidemics")
    db.set_source_state(conn, "epidemics", url=st.get("url") or C.EPID_URL, rows=len(rows),
                        fetched_at=st.get("fetched_at") or _file_time(path))
    C.log.info("epidemics: %d csv rows, %d new, %d changed, %d total in db", len(rows), new, changed, total)
    return {"csv_rows": len(rows), "new": new, "changed": changed, "total": total}


def load_all(conn) -> dict:
    out = {}
    a = C.raw_dir() / "TCDCTravelAlertAll.csv"
    e = C.raw_dir() / "TCDCIntlEpid.csv"
    if a.exists():
        out["alerts"] = load_alerts(conn, a)
    else:
        C.log.warning("missing %s", a)
    if e.exists():
        out["epidemics"] = load_epidemics(conn, e)
    else:
        C.log.warning("missing %s", e)
    return out
