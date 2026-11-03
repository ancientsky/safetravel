"""Auto-publish folder for slide.html: every image in web/slides/auto/ becomes a full-screen poster. docs/SLIDES.md

    python -m pipeline.slides_auto [web-dir] [--lenient]

Scans web/slides/auto/ and writes web/slides/auto/index.json, which slide.html appends to the slides.json playlist.
No JSON editing: settings ride in the file name, as words separated by "_" or spaces (NFKC, so full-width digits work):

    01_猴痘宣導_下架2026-12-31_10秒.png
    01_猴痘宣導_橫式.png            -> same poster, shown on landscape screens

    leading number      play order (01, 02, ...); not part of the title
    上架YYYY-MM-DD      first day shown (Asia/Taipei)   also: from2026-11-10
    下架YYYY-MM-DD      last day shown                  also: until2026-12-31
    N秒                 seconds on screen (3..60)        also: 10s
    直式 / 橫式         portrait / landscape version     also: portrait / landscape
    中文 / 英文 / 雙語  poster language for screens that filter by language   also: zh / en / bi
    加頁尾              add the Taiwan CDC bar           also: brand

Files whose name starts with "_" or "." are skipped (paused without deleting). Stdlib only: the deploy and export
workflows run it before validating. Exit status 1 on a bad file name (a date that does not exist, two settings that
conflict, ...); --lenient skips such files with a warning instead (deploys must not be blocked by one bad upload).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import quote

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}
BIG_BYTES = 5 * 1024 * 1024
SEP = re.compile(r"[_\s]+")
DATE_TOK = r"[-:]?(\d{4})-(\d{1,2})-(\d{1,2})"
FROM = re.compile(rf"^(?:上架|from){DATE_TOK}$", re.I)
UNTIL = re.compile(rf"^(?:下架|until){DATE_TOK}$", re.I)
SECONDS = re.compile(r"^(\d{1,3})(?:秒|s|sec)$", re.I)
ORIENT = {"直式": "portrait", "portrait": "portrait", "橫式": "landscape", "横式": "landscape", "landscape": "landscape"}
LANG = {"中文": "zh", "zh": "zh", "英文": "en", "en": "en", "雙語": "bi", "中英": "bi", "bi": "bi"}
BRAND = {"加頁尾", "brand"}
ORDER = re.compile(r"^\d{1,4}$")


class NameError_(ValueError):
    pass


def _date(m: re.Match) -> str:
    y, mo, d = (int(x) for x in m.groups())
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        raise NameError_(f"{m.group(0)}: no such date") from None


def parse(name: str) -> dict:
    """Settings and title from one file name (without its folder)."""
    stem = unicodedata.normalize("NFKC", Path(name).stem).strip()
    out: dict = {"title": [], "order": None}
    toks = [t for t in SEP.split(stem) if t]

    def put(k, v):
        if k in out and out[k] != v:
            raise NameError_(f"conflicting {k}: {out[k]} / {v}")
        out[k] = v

    for i, tok in enumerate(toks):
        low = tok.lower()
        if i == 0 and ORDER.match(tok):
            out["order"] = int(tok)
        elif m := FROM.match(tok):
            put("from", _date(m))
        elif m := UNTIL.match(tok):
            put("until", _date(m))
        elif m := SECONDS.match(tok):
            n = int(m.group(1))
            if not 3 <= n <= 60:
                raise NameError_(f"{tok}: seconds must be 3..60")
            put("duration", n)
        elif low in ORIENT or tok in ORIENT:
            put("orient", ORIENT.get(tok) or ORIENT[low])
        elif low in LANG or tok in LANG:
            put("lang", LANG.get(tok) or LANG[low])
        elif tok in BRAND or low in BRAND:
            out["brand"] = True
        else:
            out["title"].append(tok)
    if out.get("from") and out.get("until") and out["from"] > out["until"]:
        raise NameError_(f"上架 {out['from']} is after 下架 {out['until']}")
    out["title"] = re.sub(r"[<>]", "", " ".join(out["title"])).strip() or stem
    return out


def scan(web: Path) -> tuple[dict, list[str], list[str]]:
    """(index document, errors, warnings) for web/slides/auto/."""
    folder = web / "slides" / "auto"
    errors, warnings = [], []
    groups: dict[tuple, dict] = {}
    files = sorted(p for p in folder.iterdir() if p.is_file()) if folder.is_dir() else []
    for p in files:
        if p.name.startswith((".", "_")) or p.suffix.lower() not in IMAGE_EXT:
            continue
        try:
            info = parse(p.name)
        except NameError_ as e:
            errors.append(f"{p.name}: {e}")
            continue
        if p.stat().st_size > BIG_BYTES:
            warnings.append(f"{p.name}: {p.stat().st_size // 1024 // 1024} MB; airport screens load it every few minutes, "
                            "a JPG/WebP under 2 MB is enough")
        key = (info["order"], info["title"])
        g = groups.setdefault(key, {"files": {}, "settings": {}})
        orient = info.get("orient", "any")
        if orient in g["files"]:
            errors.append(f"{p.name}: same poster as {g['files'][orient].name} (rename one, or tag 直式 / 橫式)")
            continue
        g["files"][orient] = p
        for k in ("from", "until", "duration", "lang", "brand"):
            if k in info:
                if k in g["settings"] and g["settings"][k] != info[k]:
                    errors.append(f"{p.name}: {k} differs from the other version of this poster")
                g["settings"][k] = info[k]
    slides = []
    for (order, title), g in sorted(groups.items(), key=lambda kv: (kv[0][0] is None, kv[0][0] or 0, kv[0][1])):
        f = g["files"]
        portrait = f.get("portrait") or f.get("any") or f.get("landscape")
        landscape = f.get("landscape") if (f.get("landscape") and f.get("landscape") is not portrait) else None
        if f.get("any") and f.get("portrait"):
            errors.append(f"{f['any'].name}: also has a 直式 version ({f['portrait'].name}); tag this one 橫式 or remove it")
            continue
        key = f"{'' if order is None else order}\x00{title}"
        s = {"id": "auto-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10], "template": "image", "auto": True,
             "src": "slides/auto/" + quote(portrait.name, safe=""), "alt": title, "active": True,
             "file": portrait.name}
        if landscape:
            s["src_landscape"] = "slides/auto/" + quote(landscape.name, safe="")
            s["file_landscape"] = landscape.name
        s.update(g["settings"])
        slides.append(s)
    return {"version": 1, "folder": "web/slides/auto/", "slides": slides}, errors, warnings


def write(web: Path, doc: dict) -> bool:
    """Write index.json only when it changed (idempotent: no timestamp)."""
    p = web / "slides" / "auto" / "index.json"
    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    if p.exists() and p.read_text(encoding="utf-8") == text:
        return False
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return True


def main(argv: list[str]) -> int:
    lenient = "--lenient" in argv
    args = [a for a in argv if not a.startswith("--")]
    web = Path(args[0] if args else Path(__file__).resolve().parent.parent / "web")
    doc, errors, warnings = scan(web)
    for w in warnings:
        print(f"::warning title=slides/auto::{w}")
    for e in errors:
        print(f"::{'warning' if lenient else 'error'} title=slides/auto::{e} — this file is not published")
    changed = write(web, doc)
    print(f"slides/auto: {len(doc['slides'])} posters{' (index.json updated)' if changed else ''}")
    return 1 if errors and not lenient else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
