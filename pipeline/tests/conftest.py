import shutil
from pathlib import Path

import pytest

from pipeline import common as C
from pipeline import db, gemini, http

REPO = Path(__file__).resolve().parents[2]
FIX = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(http, "_sleep", lambda s: None)
    monkeypatch.setattr(gemini, "_sleep", lambda s: None)
    monkeypatch.setenv("SAFETRAVEL_NOW", "2026-10-08T12:00:00+08:00")
    for k in ("GEMINI_API_KEY", "TDX_CLIENT_ID", "TDX_CLIENT_SECRET", "FLIGHT_FILE_URL"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A throw-away project tree with the real fixtures (CSV, manual dictionaries, geodata)."""
    (tmp_path / "data" / "raw").mkdir(parents=True)
    (tmp_path / "web" / "data").mkdir(parents=True)
    shutil.copytree(REPO / "data" / "manual", tmp_path / "data" / "manual")
    for f in ("TCDCTravelAlertAll.csv", "TCDCIntlEpid.csv", "routes.dat"):
        if (REPO / "data" / "raw" / f).exists():
            shutil.copy(REPO / "data" / "raw" / f, tmp_path / "data" / "raw" / f)
    for f in ("airports.json", "countries.json"):
        shutil.copy(REPO / "web" / "data" / f, tmp_path / "web" / "data" / f)
    monkeypatch.setattr(C, "ROOT", tmp_path)
    return tmp_path


@pytest.fixture
def conn(root):
    c = db.connect()
    yield c
    c.close()


@pytest.fixture
def loaded(conn):
    from pipeline import load
    load.load_all(conn)
    return conn
