"""Fallback when no live flight data is available: static TPE route list from OpenFlights routes.dat
(airline,airlineID,src,srcID,dst,dstID,codeshare,stops,equipment)."""
from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

from . import common as C
from . import flights as F

SOURCE = "openflights-static"
REASON = "fallback: OpenFlights static routes"


def build_routes(path: Path | None = None) -> list[dict]:
    path = path or C.raw_dir() / "routes.dat"
    if not Path(path).exists():
        return []
    zh = C.load_json(F.HERE / "airport_zh.json", {}) or {}
    airlines: dict[str, set] = defaultdict(set)
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 6:
                continue
            al, src, dst = row[0].strip(), row[2].strip().upper(), row[4].strip().upper()
            if src == "TPE" and dst != "TPE":
                other = dst
            elif dst == "TPE" and src != "TPE":
                other = src
            else:
                continue
            if len(other) == 3 and other.isalpha():
                airlines[other].add(al if al and al != "\\N" else "?")
    routes = []
    for iata, als in sorted(airlines.items()):
        als.discard("?")
        n = max(len(als), 1)
        routes.append({"iata": iata, "departures": n, "arrivals": n, "airlines": sorted(als)[:12],
                       "city_en": "", "city_zh": zh.get(iata, "")})
    routes.sort(key=lambda r: (-r["departures"], r["iata"]))
    return routes
