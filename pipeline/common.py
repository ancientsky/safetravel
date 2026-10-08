"""Shared paths, constants and small helpers."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(os.environ.get("SAFETRAVEL_ROOT") or Path(__file__).resolve().parents[1])

TAIPEI = timezone(timedelta(hours=8))  # Taiwan has no DST

ALERTS_URL = "https://www.cdc.gov.tw/CountryEpidLevel/ExportCSV?type=0&fileName=TCDCTravelAlertAll.csv"
EPID_URL = "https://www.cdc.gov.tw/TravelEpidemic/ExportCSV?type=1&fileName=TCDCIntlEpid.csv"
FLIGHT_PAGE_URL = "https://www.taoyuan-airport.com/flight_timetable?lang=en"

ALERT_COLUMNS = [
    "source", "effective", "senderName", "instruction", "web", "alert_title", "severity_level",
    "alert_disease", "areaDesc", "areaDesc_EN", "circle", "ISO3166", "areaDetail", "ISO3166_2",
]
EPID_COLUMNS = [
    "sent", "source", "effective", "expires", "senderName", "headline", "description", "instruction",
    "web", "alert_title", "severity_level", "alert_disease", "areaDesc", "areaDesc_EN", "circle",
    "ISO3166", "areaDetail", "ISO3166_2",
]

LEVEL_OF = {"第一級:注意(Watch)": 1, "第二級:警示(Alert)": 2, "第三級:警告(Warning)": 3, "解除": 0}
COVID_OLD = "嚴重特殊傳染性肺炎"
GLOBAL_MIN_COUNTRIES = 150
WINDOW_YEARS = 2
DEFAULT_MODEL = "gemini-3.5-flash"

log = logging.getLogger("safetravel")


def raw_dir() -> Path:
    return ROOT / "data" / "raw"


def manual_dir() -> Path:
    return ROOT / "data" / "manual"


def db_path() -> Path:
    return ROOT / "data" / "safetravel.db"


def web_data() -> Path:
    return ROOT / "web" / "data"


def model_name() -> str:
    return os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL


def now() -> datetime:
    """Current time in Asia/Taipei; SAFETRAVEL_NOW (ISO-8601) overrides for reproducible runs."""
    override = os.environ.get("SAFETRAVEL_NOW")
    if override:
        dt = datetime.fromisoformat(override)
        return dt.astimezone(TAIPEI) if dt.tzinfo else dt.replace(tzinfo=TAIPEI)
    return datetime.now(TAIPEI)


def iso_ts(dt: datetime | None = None) -> str:
    return (dt or now()).replace(microsecond=0).isoformat()


def today() -> date:
    return now().date()


def window_start(d: date | None = None) -> date:
    d = d or today()
    try:
        return d.replace(year=d.year - WINDOW_YEARS)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year - WINDOW_YEARS, day=28)


def nfkc(s: str | None) -> str:
    return unicodedata.normalize("NFKC", s or "").strip()


def sha1(*parts: str) -> str:
    h = hashlib.sha1()
    for p in parts:
        h.update(p.encode("utf-8"))
        h.update(b"\x1f")
    return h.hexdigest()


def load_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj, *, indent=None) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":")), encoding="utf-8")
    tmp.replace(path)


def split_diseases(s: str) -> list[str]:
    return [p.strip() for p in re.split(r"[,，、]", nfkc(s)) if p.strip()]


def clean_en_name(s: str) -> str:
    """'Congo,Democratic Republic of the' -> 'Democratic Republic of the Congo'."""
    s = (s or "").strip()
    m = re.fullmatch(r"([^,]+),\s*([^,]+)", s)
    if m:
        return f"{m.group(2).strip()} {m.group(1).strip()}"
    return s


def setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
