"""Outbreak route watch: direct-flight networks of an outbreak city, drawn on the map on demand.

    python -m pipeline watch            (also runs at the end of `python -m pipeline export`)

Input:  data/manual/watch/<id>.json (hub, titles, reason, source, country map, coordinate overrides)
        + the routes CSV it names (Country, City_Airport|City, IATA|Code, Monthly_Flights|Flights_Per_Month[, City_zh]);
        optional "notes" {IATA: {zh, en}} flag destinations (e.g. a reported exported case).
Output: web/data/watch.json (contract in docs/DATA_CONTRACT.md). Coordinates come from web/data/airports.json,
        then the set's own "coords" overrides; a route without coordinates is dropped and reported.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from . import common as C

WATCH_DIR = C.ROOT / "data" / "manual" / "watch"
# accepted spellings of the CSV columns (lists are pasted from different sources)
COLS = {"iata": ("IATA", "Code"), "city": ("City_Airport", "City"), "monthly": ("Monthly_Flights", "Flights_Per_Month"),
        "country": ("Country",), "city_zh": ("City_zh",)}
TEXT_KEYS = ("title_zh", "title_en", "reason_zh", "reason_en", "source_zh", "source_en", "hub_zh", "hub_en")


def _col(row: dict, key: str) -> str:
    return next((C.nfkc(row[c]).strip() for c in COLS[key] if row.get(c) not in (None, "")), "")


def _routes(path: Path, countries: dict, coords: dict, airports: dict, notes: dict) -> tuple[list[dict], list[str]]:
    out, missing = [], []
    countries = {C.nfkc(k): v for k, v in countries.items()}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            iata = _col(row, "iata").upper()
            if len(iata) != 3:
                continue
            ap = airports.get(iata) or {}
            lat, lon = (coords.get(iata) or [ap.get("lat"), ap.get("lon")])[:2]
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                missing.append(iata)
                continue
            city = _col(row, "city")
            r = {
                "iata": iata,
                "city_en": city or ap.get("city") or iata,
                "city_zh": _col(row, "city_zh") or city or iata,
                "country": countries.get(_col(row, "country")) or ap.get("country") or "",
                "lat": round(float(lat), 4), "lon": round(float(lon), 4),
                "monthly": int(float(_col(row, "monthly") or 0)),
            }
            note = notes.get(iata)
            if note:
                r["note_zh"], r["note_en"] = C.nfkc(note.get("zh", "")), C.nfkc(note.get("en", ""))
            out.append(r)
    out.sort(key=lambda r: (-r["monthly"], r["iata"]))
    return out, missing


def build_set(spec: dict, base: Path, airports: dict) -> dict:
    hub = spec["hub"].upper()
    ap = airports.get(hub) or {}
    coords = {k.upper(): v for k, v in (spec.get("coords") or {}).items()}
    hlat, hlon = (coords.get(hub) or [ap.get("lat"), ap.get("lon")])[:2]
    notes = {k.upper(): v for k, v in (spec.get("notes") or {}).items()}
    routes, missing = _routes(base / spec["routes"], spec.get("countries") or {}, coords, airports, notes)
    if missing:
        C.log.warning("watch %s: no coordinates for %s (dropped)", spec["id"], ", ".join(missing))
    doc = {"id": spec["id"], **{k: C.nfkc(spec.get(k, "")) for k in TEXT_KEYS}, "as_of": spec.get("as_of", ""),
           "hub": {"iata": hub, "country": spec.get("hub_country") or ap.get("country", ""),
                   "lat": round(float(hlat), 4), "lon": round(float(hlon), 4)},
           "routes": routes,
           "totals": {"destinations": len(routes), "monthly": sum(r["monthly"] for r in routes),
                      "countries": len({r["country"] for r in routes if r["country"]})}}
    return doc


def build(out_dir: Path | None = None, watch_dir: Path | None = None) -> dict:
    out_dir = Path(out_dir or C.web_data())
    watch_dir = Path(watch_dir or WATCH_DIR)
    airports = C.load_json(out_dir / "airports.json", {}) or {}
    sets = []
    for spec_path in sorted(watch_dir.glob("*.json")):
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        if spec.get("enabled", True):
            sets.append(build_set(spec, spec_path.parent, airports))
    doc = {"sets": sets}  # deterministic (no timestamp): unchanged inputs give an unchanged file
    (out_dir / "watch.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return doc


def main(argv=None) -> int:
    doc = build()
    for s in doc["sets"]:
        t = s["totals"]
        print(f"watch {s['id']}: hub {s['hub']['iata']}, {t['destinations']} destinations, {t['monthly']} flights/month, "
              f"{t['countries']} countries")
    return 0
