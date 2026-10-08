"""HTTP helper: browser-like headers, retries with backoff, TLS chain verification without X509 strict mode."""
from __future__ import annotations

import ssl
import time

import requests
from requests.adapters import HTTPAdapter

from . import common as C

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/csv,application/json,text/plain;q=0.8,*/*;q=0.7",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}


class HttpError(Exception):
    def __init__(self, msg: str, status: int | None = None):
        super().__init__(msg)
        self.status = status


class _LenientTLSAdapter(HTTPAdapter):
    """Still verifies the certificate chain and host name, but drops VERIFY_X509_STRICT: Python 3.13+ rejects
    several Taiwanese government certificates that lack a Subject Key Identifier."""

    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        if hasattr(ssl, "VERIFY_X509_STRICT"):
            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


def new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.mount("https://", _LenientTLSAdapter())
    return s


def _sleep(seconds: float) -> None:  # patched in tests
    time.sleep(seconds)


def get(url: str, *, session: requests.Session | None = None, tries: int = 3, timeout=(10, 60),
        headers: dict | None = None) -> requests.Response:
    """GET with retries on network errors / 408 / 429 / 5xx. Raises HttpError otherwise (also for other non-200s)."""
    s = session or new_session()
    last = None
    for attempt in range(1, tries + 1):
        try:
            r = s.get(url, timeout=timeout, headers=headers)
            if r.status_code == 200:
                return r
            last = HttpError(f"HTTP {r.status_code} for {url}", r.status_code)
            if not (r.status_code in (408, 429) or r.status_code >= 500):
                raise last
        except (requests.Timeout, requests.ConnectionError) as e:
            last = HttpError(f"{type(e).__name__}: {e}")
        if attempt < tries:
            C.log.warning("GET %s failed (%s); retry %d/%d", url, last, attempt, tries - 1)
            _sleep(2 ** attempt)
    raise last  # type: ignore[misc]
