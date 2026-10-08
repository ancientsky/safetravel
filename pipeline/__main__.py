"""python -m pipeline <command>"""
from __future__ import annotations

import argparse
import sys

from . import common as C
from . import db


def apply_static_fallback(conn) -> bool:
    """Static OpenFlights route list, used only while the database holds no real flight data at all."""
    from . import static_routes as SR
    if conn.execute("SELECT 1 FROM flights_daily WHERE source != ? LIMIT 1", (SR.SOURCE,)).fetchone():
        return False
    routes = SR.build_routes()
    if not routes:
        C.log.warning("static route fallback unavailable (data/raw/routes.dat missing)")
        return False
    names = db.get_airport_names(conn)
    for r in routes:
        en, zh = names.get(r["iata"], ("", ""))
        r["city_en"], r["city_zh"] = en or r["city_en"], zh or r["city_zh"]
    day, now = C.today().isoformat(), C.iso_ts()
    db.replace_flights_day(conn, day, routes, SR.SOURCE, now)
    db.set_source_state(conn, "flights", url=SR.SOURCE, fetched_at=now, date=day, ok=0, reason=SR.REASON)
    C.log.warning("flights: using static fallback (%d routes)", len(routes))
    return True


def _store_flights(conn, res: dict) -> None:
    if res.get("ok"):
        db.put_airport_names(conn, res.get("airport_names") or {})
        stored = db.replace_flights_day(conn, res["day"], res["routes"], res["source"], res["fetched_at"])
        if stored:
            db.set_source_state(conn, "flights", url=res["source"], fetched_at=res["fetched_at"], date=res["day"],
                                ok=0 if res.get("warn") else 1, reason=res.get("warn"))
            return
        res["reason"] = "new snapshot much smaller than the stored one for the same day"
    st = db.get_source_state(conn, "flights")
    db.set_source_state(conn, "flights", ok=0, reason=res.get("reason") or "unknown",
                        fetched_at=st.get("fetched_at") or res.get("fetched_at"), url=st.get("url") or C.FLIGHT_PAGE_URL)
    apply_static_fallback(conn)


def do_fetch(conn, only: str | None = None) -> dict:
    from . import fetch
    out = {}
    if only in (None, "cdc"):
        out["cdc"] = fetch.fetch_cdc()
        for name, st in out["cdc"].items():
            if st["ok"]:
                db.set_source_state(conn, name, url=st["url"], fetched_at=st["fetched_at"], ok=1, reason=None)
            else:
                db.set_source_state(conn, name, url=st["url"], ok=0, reason=st["reason"])
    if only in (None, "flights"):
        try:
            res = fetch.fetch_flights(cached_names=db.get_airport_names(conn))
        except Exception as e:  # network/parser bug must never break the data update
            C.log.exception("flight fetch crashed")
            res = {"ok": False, "reason": f"crash: {type(e).__name__}: {e}", "fetched_at": C.iso_ts()}
        _store_flights(conn, res)
        out["flights"] = {k: v for k, v in res.items() if k not in ("routes", "airport_names")} | {"routes": len(res.get("routes", []))}
    return out


def do_enrich(conn, args) -> dict:
    from . import gemini
    client = gemini.make_client(args.max_calls, args.time_budget_min)
    return gemini.enrich(conn, client)


def cmd_run(args) -> int:
    from . import export, load
    started = C.iso_ts()
    conn = db.connect()
    details: dict = {"offline": args.offline}
    if not args.offline:
        details["fetch"] = do_fetch(conn)
    details["load"] = load.load_all(conn)
    if args.offline and not db.latest_flights_day(conn):
        apply_static_fallback(conn)
    if args.offline or args.skip_gemini:
        C.log.info("AI enrichment skipped (%s)", "offline" if args.offline else "--skip-gemini")
        details["enrich"] = {"skipped": True}
    else:
        details["enrich"] = do_enrich(conn, args)
    meta = export.export_all(conn)
    details["counts"] = meta["counts"]
    db.log_run(conn, "run", started, "ok", details)
    print(f"run ok: {meta['counts']}")
    return 0


def cmd_fetch(args) -> int:
    conn = db.connect()
    do_fetch(conn, args.only)
    return 0


def cmd_load(args) -> int:
    from . import load
    load.load_all(db.connect())
    return 0


def cmd_enrich(args) -> int:
    conn = db.connect()
    stats = do_enrich(conn, args)
    print(stats)
    return 0


def cmd_export(args) -> int:
    from . import export
    export.export_all(db.connect())
    return 0


def cmd_validate(args) -> int:
    from . import validate
    errs = validate.validate_dir(C.web_data())
    for e in errs:
        print("VIOLATION:", e)
    print("validate:", "FAILED" if errs else "ok", f"({len(errs)} violations)")
    return 1 if errs else 0


def cmd_flights(args) -> int:
    from pathlib import Path
    from . import flights as F
    path = Path(args.from_file)
    kind, recs = F.parse_saved_file(path, args.lang)
    day = args.date or C.today().isoformat()
    day = F.choose_day(recs, day) if not args.date else day
    names = {}
    if C.db_path().exists():
        names = db.get_airport_names(db.connect())
    routes = F.aggregate(recs, day, names=names)
    dep = sum(r["departures"] for r in routes)
    arr = sum(r["arrivals"] for r in routes)
    print(f"{path}: kind={kind} records={len(recs)} day={day} destinations={len(routes)} departures={dep} arrivals={arr}")
    for r in routes[:15]:
        print("  ", r)
    if args.save and routes:
        conn = db.connect()
        from . import tdx
        src = tdx.FIDS_URL.split("?")[0] if kind == "tdx" else f"file:{path.name}"
        ok = db.replace_flights_day(conn, day, routes, src, C.iso_ts())
        db.set_source_state(conn, "flights", url=src, fetched_at=C.iso_ts(), date=day, ok=1 if ok else 0,
                            reason=None if ok else "snapshot smaller than stored")
        print("saved to database" if ok else "not saved (smaller than stored snapshot)")
    return 0 if routes else 2


def cmd_pending(args) -> int:
    from . import pending
    return pending.main(["--out", args.out, "--chunk", str(args.chunk), "--overview-batch", str(args.overview_batch)])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipeline")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def ai_args(p):
        p.add_argument("--max-calls", type=int, default=400)
        p.add_argument("--time-budget-min", type=float, default=40.0)

    p = sub.add_parser("run", help="fetch -> load -> enrich -> export")
    p.add_argument("--offline", action="store_true", help="no network, no Gemini: use data/raw as is")
    p.add_argument("--skip-gemini", action="store_true")
    ai_args(p)
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("fetch")
    p.add_argument("--only", choices=["cdc", "flights"])
    p.set_defaults(fn=cmd_fetch)
    sub.add_parser("load").set_defaults(fn=cmd_load)
    p = sub.add_parser("enrich")
    ai_args(p)
    p.set_defaults(fn=cmd_enrich)
    sub.add_parser("export").set_defaults(fn=cmd_export)
    sub.add_parser("validate").set_defaults(fn=cmd_validate)
    p = sub.add_parser("flights", help="parse a saved raw flight file offline")
    p.add_argument("--from-file", required=True)
    p.add_argument("--lang", choices=["en", "zh"])
    p.add_argument("--date", help="YYYY-MM-DD to count (default: today, Asia/Taipei)")
    p.add_argument("--save", action="store_true", help="store the parsed day in the database")
    p.set_defaults(fn=cmd_flights)
    p = sub.add_parser("pending", help="export untranslated digests / stale overviews for an external translator")
    p.add_argument("--out", required=True)
    p.add_argument("--chunk", type=int, default=25)
    p.add_argument("--overview-batch", type=int, default=30)
    p.set_defaults(fn=cmd_pending)

    args = ap.parse_args(argv)
    C.setup_logging(args.verbose)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
