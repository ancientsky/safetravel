"""Build static geodata for the web app (run once; re-run when upstream packages change).

Outputs (see docs/DATA_CONTRACT.md):
  web/data/world.json     TopoJSON countries-50m, geometry id = ISO alpha-2
  web/data/countries.json {A2: {zh, en, lat, lon}}
  web/data/airports.json  {IATA: {name, city, country, lat, lon}}

Inputs: node_modules/world-atlas, node_modules/world-countries (npm install),
        data/raw/airports.dat (OpenFlights), data/manual/country_names.json
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NM = ROOT / "node_modules"
OUT = ROOT / "web" / "data"

# Numeric codes in world-atlas that are not in world-countries / need forcing
EXTRA_NUMERIC_TO_A2 = {
    "-99": None,
    "010": "AQ",   # Antarctica
    "260": "TF",   # French Southern Territories
    "336": "VA",
    "248": "AX",
}
# Country-name fixes for OpenFlights country strings → alpha-2
OPENFLIGHTS_COUNTRY_FIX = {
    "Taiwan": "TW", "South Korea": "KR", "North Korea": "KP", "Russia": "RU",
    "Vietnam": "VN", "Laos": "LA", "Iran": "IR", "Syria": "SY", "Burma": "MM",
    "Myanmar": "MM", "Macau": "MO", "Hong Kong": "HK", "Czech Republic": "CZ",
    "Czechia": "CZ", "Brunei": "BN", "Congo (Kinshasa)": "CD", "Congo (Brazzaville)": "CG",
    "Cote d'Ivoire": "CI", "Ivory Coast": "CI", "Cape Verde": "CV", "Swaziland": "SZ",
    "Eswatini": "SZ", "Macedonia": "MK", "North Macedonia": "MK", "Moldova": "MD",
    "Bolivia": "BO", "Venezuela": "VE", "Tanzania": "TZ", "United States": "US",
    "United Kingdom": "GB", "Netherlands Antilles": "CW", "East Timor": "TL",
    "Timor-Leste": "TL", "Palestine": "PS", "Reunion": "RE", "Virgin Islands": "VI",
    "British Virgin Islands": "VG", "Saint Vincent and the Grenadines": "VC",
    "Saint Kitts and Nevis": "KN", "Saint Lucia": "LC", "Micronesia": "FM",
    "Sao Tome and Principe": "ST", "Falkland Islands": "FK", "Faroe Islands": "FO",
    "Western Sahara": "EH", "Kosovo": "XK", "Guinea-Bissau": "GW", "Saint Helena": "SH",
    "Wallis and Futuna": "WF", "Svalbard": "SJ", "Johnston Atoll": "UM", "Midway Islands": "UM",
    "Wake Island": "UM", "Cocos (Keeling) Islands": "CC", "Christmas Island": "CX",
    "Norfolk Island": "NF", "Netherlands": "NL", "Vatican City": "VA", "Gambia": "GM",
    "Bahamas": "BS", "Antigua and Barbuda": "AG", "Trinidad and Tobago": "TT",
    "Turks and Caicos Islands": "TC", "Cayman Islands": "KY", "Saint Pierre and Miquelon": "PM",
    "Bosnia and Herzegovina": "BA", "Dominican Republic": "DO", "Central African Republic": "CF",
    "Equatorial Guinea": "GQ", "Papua New Guinea": "PG", "Solomon Islands": "SB",
    "Marshall Islands": "MH", "Northern Mariana Islands": "MP", "American Samoa": "AS",
    "French Polynesia": "PF", "New Caledonia": "NC", "Cook Islands": "CK", "Niue": "NU",
    "Isle of Man": "IM", "Guernsey": "GG", "Jersey": "JE", "Greenland": "GL",
    "Puerto Rico": "PR", "Guam": "GU", "Bermuda": "BM", "Aruba": "AW", "Anguilla": "AI",
    "Montserrat": "MS", "Gibraltar": "GI", "Mayotte": "YT", "Martinique": "MQ",
    "Guadeloupe": "GP", "French Guiana": "GF", "South Sudan": "SS", "Sint Maarten": "SX",
    "Curacao": "CW", "Bonaire": "BQ", "Saint Barthelemy": "BL", "Saint Martin": "MF",
    "Åland": "AX", "Aland Islands": "AX", "Cabo Verde": "CV", "Tokelau": "TK",
    "United Arab Emirates": "AE", "Saudi Arabia": "SA", "South Africa": "ZA",
    "New Zealand": "NZ", "Sri Lanka": "LK", "El Salvador": "SV", "Costa Rica": "CR",
    "Burkina Faso": "BF", "Sierra Leone": "SL", "Hong Kong SAR": "HK", "Turkey": "TR",
}
# world-atlas geometries without a numeric ISO code → stable synthetic ids by name
NAME_TO_ID = {
    "Somaliland": "x-somaliland", "Kosovo": "XK", "N. Cyprus": "x-ncyprus",
    "Indian Ocean Ter.": "IO", "Siachen Glacier": "x-siachen",
}


def load_world_countries():
    data = json.loads((NM / "world-countries" / "countries.json").read_text(encoding="utf-8"))
    by_ccn3 = {}
    by_name = {}
    by_a2 = {}
    for c in data:
        a2 = c["cca2"]
        by_a2[a2] = c
        if c.get("ccn3"):
            by_ccn3[c["ccn3"]] = a2
        for n in {c["name"]["common"], c["name"]["official"], *c.get("altSpellings", [])}:
            by_name[n.lower()] = a2
    return data, by_ccn3, by_name, by_a2


def build_world(by_ccn3):
    topo = json.loads((NM / "world-atlas" / "countries-50m.json").read_text(encoding="utf-8"))
    geoms = topo["objects"]["countries"]["geometries"]
    missing = []
    for g in geoms:
        nid = str(g.get("id", ""))
        a2 = EXTRA_NUMERIC_TO_A2.get(nid, by_ccn3.get(nid))
        name = g.get("properties", {}).get("name")
        if a2:
            g["id"] = a2
        elif name in NAME_TO_ID:
            g["id"] = NAME_TO_ID[name]
        else:
            g["id"] = f"n{nid or name}"
            missing.append((nid, name))
    # keep only the countries object; drop land to save bytes
    topo["objects"] = {"countries": topo["objects"]["countries"]}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "world.json").write_text(json.dumps(topo, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"world.json: {len(geoms)} geometries, unmapped: {missing}")


def build_countries(data):
    # world-countries ships Simplified Chinese; convert to Taiwan Traditional with OpenCC (s2twp)
    try:
        from opencc import OpenCC  # opencc-python-reimplemented
        s2tw = OpenCC("s2twp").convert
    except Exception:  # pragma: no cover
        s2tw = lambda x: x  # noqa: E731
    overrides = json.loads((ROOT / "data/manual/country_names.json").read_text(encoding="utf-8"))
    out = {}
    for c in data:
        a2 = c["cca2"]
        zh = s2tw((c.get("translations", {}).get("zho") or {}).get("common") or c["name"]["common"])
        en = c["name"]["common"]
        lat, lon = (c.get("latlng") or [0, 0])[:2]
        o = overrides.get(a2, {})
        out[a2] = {"zh": o.get("zh", zh), "en": o.get("en", en), "lat": lat, "lon": lon}
    (OUT / "countries.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"countries.json: {len(out)} entries")


def build_airports(by_name):
    out = {}
    unknown_countries = set()
    with (ROOT / "data/raw/airports.dat").open(encoding="utf-8") as fh:
        for row in csv.reader(fh):
            if len(row) < 8:
                continue
            _, name, city, country, iata, _icao, lat, lon = row[:8]
            if not iata or iata == r"\N" or len(iata) != 3:
                continue
            a2 = OPENFLIGHTS_COUNTRY_FIX.get(country) or by_name.get(country.lower())
            if not a2:
                unknown_countries.add(country)
                a2 = ""
            try:
                lat_f, lon_f = round(float(lat), 4), round(float(lon), 4)
            except ValueError:
                continue
            out[iata] = {"name": name, "city": city, "country": a2, "lat": lat_f, "lon": lon_f}
    (OUT / "airports.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"airports.json: {len(out)} airports; unknown countries: {sorted(unknown_countries)}")


if __name__ == "__main__":
    data, by_ccn3, by_name, _ = load_world_countries()
    build_world(by_ccn3)
    build_countries(data)
    build_airports(by_name)
