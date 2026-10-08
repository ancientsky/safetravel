"""SQLite storage (data/safetravel.db, committed). All writes are idempotent upserts."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from . import common as C

SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL UNIQUE,
  source TEXT, effective TEXT NOT NULL, senderName TEXT, instruction TEXT, web TEXT, alert_title TEXT,
  severity_level TEXT, alert_disease TEXT, areaDesc TEXT, areaDesc_EN TEXT, circle TEXT,
  ISO3166 TEXT, areaDetail TEXT, ISO3166_2 TEXT,
  first_seen TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_key ON alerts_raw(alert_disease, ISO3166, areaDesc, areaDetail);

CREATE TABLE IF NOT EXISTS epidemics (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,           -- sha1(NFKC headline, NFKC description): key into translations
  row_hash TEXT NOT NULL,
  sent TEXT, effective TEXT NOT NULL, expires TEXT,
  headline TEXT, description TEXT, disease TEXT, area_zh TEXT, area_en TEXT,
  isos TEXT,                            -- comma separated alpha-2 list
  is_global INTEGER NOT NULL DEFAULT 0,
  url TEXT, area_detail TEXT, iso_sub TEXT,
  first_seen TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_epid_date ON epidemics(effective);
CREATE INDEX IF NOT EXISTS idx_epid_hash ON epidemics(content_hash);

CREATE TABLE IF NOT EXISTS translations (
  content_hash TEXT PRIMARY KEY,
  headline_en TEXT, summary_zh TEXT, summary_en TEXT, description_en TEXT,
  model TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS overviews (
  iso TEXT PRIMARY KEY,
  items_hash TEXT NOT NULL, zh TEXT, en TEXT, items INTEGER, model TEXT, updated TEXT
);

CREATE TABLE IF NOT EXISTS flights_daily (
  date TEXT NOT NULL, iata TEXT NOT NULL,
  departures INTEGER NOT NULL DEFAULT 0, arrivals INTEGER NOT NULL DEFAULT 0,
  airlines_json TEXT NOT NULL DEFAULT '[]',
  city_en TEXT, city_zh TEXT, source TEXT, fetched_at TEXT,
  PRIMARY KEY (date, iata)
);

CREATE TABLE IF NOT EXISTS disease_names (
  zh TEXT PRIMARY KEY, en TEXT NOT NULL, source TEXT, updated TEXT
);

CREATE TABLE IF NOT EXISTS area_names (
  zh TEXT PRIMARY KEY, en TEXT NOT NULL, source TEXT, updated TEXT
);

CREATE TABLE IF NOT EXISTS airports_tdx (
  iata TEXT PRIMARY KEY, zh TEXT, en TEXT, country TEXT, updated TEXT
);

CREATE TABLE IF NOT EXISTS source_state (
  name TEXT PRIMARY KEY,                -- alerts | epidemics | flights
  url TEXT, fetched_at TEXT, rows INTEGER, date TEXT, ok INTEGER, reason TEXT
);

CREATE TABLE IF NOT EXISTS ai_failures (
  kind TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated TEXT,
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started TEXT, finished TEXT, command TEXT, status TEXT, details TEXT
);
"""


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    p = Path(path) if path else C.db_path()
    if str(p) != ":memory:":
        p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


# ---------------------------------------------------------------- source state
def set_source_state(conn, name: str, **fields) -> None:
    cur = conn.execute("SELECT * FROM source_state WHERE name=?", (name,)).fetchone()
    row = dict(cur) if cur else {"name": name, "url": None, "fetched_at": None, "rows": None, "date": None, "ok": 1, "reason": None}
    row.update({k: v for k, v in fields.items() if k in row})
    conn.execute(
        "INSERT INTO source_state(name,url,fetched_at,rows,date,ok,reason) VALUES(:name,:url,:fetched_at,:rows,:date,:ok,:reason)"
        " ON CONFLICT(name) DO UPDATE SET url=excluded.url, fetched_at=excluded.fetched_at, rows=excluded.rows,"
        " date=excluded.date, ok=excluded.ok, reason=excluded.reason", row)
    conn.commit()


def get_source_state(conn, name: str) -> dict:
    r = conn.execute("SELECT * FROM source_state WHERE name=?", (name,)).fetchone()
    return dict(r) if r else {}


# ----------------------------------------------------------------- run log
def log_run(conn, command: str, started: str, status: str, details: dict | None = None) -> None:
    conn.execute("INSERT INTO run_log(started,finished,command,status,details) VALUES(?,?,?,?,?)",
                 (started, C.iso_ts(), command, status, json.dumps(details or {}, ensure_ascii=False)))
    # keep the log small: it is committed with the database
    conn.execute("DELETE FROM run_log WHERE id NOT IN (SELECT id FROM run_log ORDER BY id DESC LIMIT 200)")
    conn.commit()


# ------------------------------------------------------------- translations
def get_translations(conn, hashes=None) -> dict[str, dict]:
    rows = conn.execute("SELECT * FROM translations").fetchall()
    out = {r["content_hash"]: dict(r) for r in rows}
    if hashes is not None:
        hs = set(hashes)
        out = {k: v for k, v in out.items() if k in hs}
    return out


def put_translation(conn, content_hash: str, *, headline_en, summary_zh, summary_en, description_en, model) -> None:
    conn.execute(
        "INSERT INTO translations(content_hash,headline_en,summary_zh,summary_en,description_en,model,created_at)"
        " VALUES(?,?,?,?,?,?,?) ON CONFLICT(content_hash) DO UPDATE SET headline_en=excluded.headline_en,"
        " summary_zh=excluded.summary_zh, summary_en=excluded.summary_en, description_en=excluded.description_en,"
        " model=excluded.model, created_at=excluded.created_at",
        (content_hash, headline_en, summary_zh, summary_en, description_en, model, C.iso_ts()))
    conn.commit()


def put_overview(conn, iso: str, items_hash: str, zh: str, en: str, n_items: int, model: str) -> None:
    conn.execute(
        "INSERT INTO overviews(iso,items_hash,zh,en,items,model,updated) VALUES(?,?,?,?,?,?,?)"
        " ON CONFLICT(iso) DO UPDATE SET items_hash=excluded.items_hash, zh=excluded.zh, en=excluded.en,"
        " items=excluded.items, model=excluded.model, updated=excluded.updated",
        (iso, items_hash, zh, en, n_items, model, C.today().isoformat()))
    conn.commit()


def put_name(conn, table: str, zh: str, en: str, source: str) -> None:
    assert table in ("disease_names", "area_names")
    conn.execute(
        f"INSERT INTO {table}(zh,en,source,updated) VALUES(?,?,?,?) ON CONFLICT(zh) DO UPDATE SET en=excluded.en,"
        f" source=excluded.source, updated=excluded.updated WHERE {table}.en != excluded.en",
        (zh, en, source, C.today().isoformat()))
    conn.commit()


def names(conn, table: str) -> dict[str, str]:
    return {r["zh"]: r["en"] for r in conn.execute(f"SELECT zh,en FROM {table}")}


# ------------------------------------------------------------- AI failures
def ai_failure_count(conn, kind: str, key: str) -> int:
    r = conn.execute("SELECT count FROM ai_failures WHERE kind=? AND key=?", (kind, key)).fetchone()
    return r["count"] if r else 0


def ai_failure_add(conn, kind: str, key: str, err: str) -> None:
    conn.execute(
        "INSERT INTO ai_failures(kind,key,count,last_error,updated) VALUES(?,?,1,?,?)"
        " ON CONFLICT(kind,key) DO UPDATE SET count=count+1, last_error=excluded.last_error, updated=excluded.updated",
        (kind, key, err[:300], C.iso_ts()))
    conn.commit()


def ai_failure_clear(conn, kind: str, key: str) -> None:
    conn.execute("DELETE FROM ai_failures WHERE kind=? AND key=?", (kind, key))
    conn.commit()


# ------------------------------------------------------------------ flights
def replace_flights_day(conn, day: str, routes: list[dict], source: str, fetched_at: str) -> bool:
    """Replace the day's rows unless the new snapshot is drastically smaller than what is stored."""
    old = conn.execute("SELECT COALESCE(SUM(departures+arrivals),0) FROM flights_daily WHERE date=?", (day,)).fetchone()[0]
    new = sum(r["departures"] + r["arrivals"] for r in routes)
    if old and new < 0.6 * old:
        C.log.warning("flights %s: new snapshot (%d flights) much smaller than stored (%d); keeping stored", day, new, old)
        return False
    with conn:
        conn.execute("DELETE FROM flights_daily WHERE date=?", (day,))
        conn.execute("DELETE FROM flights_daily WHERE date < date(?, '-30 days')", (day,))
        conn.executemany(
            "INSERT INTO flights_daily(date,iata,departures,arrivals,airlines_json,city_en,city_zh,source,fetched_at)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            [(day, r["iata"], r["departures"], r["arrivals"], json.dumps(r.get("airlines", [])),
              r.get("city_en"), r.get("city_zh"), source, fetched_at) for r in routes])
    return True


def put_airport_names(conn, names: dict) -> None:
    """names: {iata: (en, zh, country)}; replaces the cache when it is non-empty."""
    if not names:
        return
    with conn:
        conn.executemany(
            "INSERT INTO airports_tdx(iata,zh,en,country,updated) VALUES(?,?,?,?,?) ON CONFLICT(iata) DO UPDATE SET"
            " zh=excluded.zh, en=excluded.en, country=excluded.country, updated=excluded.updated"
            " WHERE airports_tdx.zh IS NOT excluded.zh OR airports_tdx.en IS NOT excluded.en OR airports_tdx.country IS NOT excluded.country",
            [(k, v[1], v[0], v[2], C.today().isoformat()) for k, v in names.items()])


def get_airport_names(conn) -> dict:
    return {r["iata"]: (r["en"] or "", r["zh"] or "") for r in conn.execute("SELECT * FROM airports_tdx")}


def latest_flights_day(conn):
    r = conn.execute("SELECT MAX(date) FROM flights_daily").fetchone()
    return r[0] if r else None
