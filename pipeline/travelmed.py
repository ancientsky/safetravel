"""Taiwan CDC travel medicine open data (od.cdc.gov.tw, monthly): travel clinics, their opening hours and the
per-country "travel prescription" (vaccines, preventive advice, prevalent diseases).

    fetch()   download the three CSVs into data/raw/travelmed/ (keeps the previous file when a download looks wrong)

Run in GitHub Actions only (no network to cdc.gov.tw from the dev sandbox). Never blocks the data update.
od.cdc.gov.tw (like data.gov.tw) does not answer GitHub-hosted runners (connect timeout, 2026-11): files placed in
data/raw/travelmed/ by hand are kept and used; a connect failure skips the remaining files so a run loses ~8 s, not 90.
"""
from __future__ import annotations

import csv
import io
from pathlib import Path

from . import common as C
from . import http

SOURCES = {
    # name: (url, file, columns that must be in the header, minimum data rows)
    "clinics": ("https://od.cdc.gov.tw/quarantine/TMClinicsList.csv", "TMClinicsList.csv",
                ["醫事機構代碼", "合約醫院名稱", "所在縣市"], 10),
    "hours": ("https://od.cdc.gov.tw/quarantine/ClinicsTime.csv", "ClinicsTime.csv",
              ["醫事機構代碼", "星期", "時段"], 50),
    "prescription": ("https://od.cdc.gov.tw/quarantine/TMPrescription.csv", "TMPrescription.csv",
                     ["疾病", "疫苗"], 200),
}


def raw_dir() -> Path:
    return C.ROOT / "data" / "raw" / "travelmed"


def _norm(s: str) -> str:
    return C.nfkc(s or "").replace(" ", "").strip()


def check(body: bytes, columns: list[str], min_rows: int) -> tuple[int, str | None]:
    """(data rows, problem or None): UTF-8 (BOM allowed), a header holding every expected column, enough rows."""
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = body.decode("cp950")
        except UnicodeDecodeError:
            return 0, "not UTF-8 / Big5 text"
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return 0, "empty file"
    head = [_norm(h) for h in rows[0]]
    missing = [c for c in columns if not any(_norm(c) in h for h in head)]
    if missing:
        return 0, f"header lacks {', '.join(missing)}"
    n = sum(1 for r in rows[1:] if any(x.strip() for x in r))
    if n < min_rows:
        return n, f"only {n} rows (expected at least {min_rows})"
    return n, None


def fetch(session=None) -> dict:
    """Download the three files; each is replaced only when the new copy passes check()."""
    st = {"url": SOURCES["prescription"][0], "ok": False, "fetched_at": C.iso_ts(), "reason": None, "files": {}}
    d = raw_dir()
    d.mkdir(parents=True, exist_ok=True)
    problems = []
    unreachable = False
    for name, (url, fname, cols, min_rows) in SOURCES.items():
        if unreachable:  # one host for all three: do not spend another connect timeout per file
            problems.append(f"{name}: skipped (host unreachable)")
            continue
        try:
            body = http.get(url, session=session, tries=1, timeout=(8, 60)).content
            n, problem = check(body, cols, min_rows)
            if problem:
                raise ValueError(problem)
            (d / fname).write_bytes(body)
            st["files"][name] = n
        except Exception as e:  # network / format trouble: keep the previous file, report, carry on
            unreachable = unreachable or "Connect" in type(e).__name__ or "Connect" in str(e)
            problems.append(f"{name}: {type(e).__name__}: {e}")
            C.log.warning("travel medicine %s not refreshed: %s", name, e)
    st["ok"] = not problems
    st["reason"] = "; ".join(problems) or None
    C.log.info("travel medicine: %s", st["files"])
    return st
