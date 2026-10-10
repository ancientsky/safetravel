"""Gemini REST client + enrichment jobs (translation, per-country overviews, disease/area names).

Only `requests` is used; no Google SDK. Without GEMINI_API_KEY every job is skipped and the exporter
falls back to the Chinese text (`ai: false`).
"""
from __future__ import annotations

import json
import os
import random
import re
import time
from datetime import date

import requests

from . import common as C
from . import db
from . import export as X

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_TRIES = 6
MAX_FAILURES_PER_KEY = 3
BATCH_ITEMS = 15
BATCH_CHARS = 14000


class GeminiError(Exception):
    """Request failed (after retries); the caller may skip this batch."""


class GeminiFatal(GeminiError):
    """Credentials / model problem: continuing is pointless."""


class GeminiBadResponse(GeminiError):
    """Response arrived but was blocked, truncated or not the expected JSON."""


class BudgetExhausted(GeminiError):
    """--max-calls or --time-budget-min reached."""


def _sleep(seconds: float) -> None:  # indirection so tests can run without waiting
    time.sleep(seconds)


class Budget:
    def __init__(self, max_calls: int = 400, time_budget_min: float = 40.0):
        self.max_calls = max_calls
        self.deadline = time.monotonic() + time_budget_min * 60
        self.calls = 0

    def check(self) -> None:
        if self.calls >= self.max_calls:
            raise BudgetExhausted(f"call budget exhausted ({self.max_calls})")
        if time.monotonic() >= self.deadline:
            raise BudgetExhausted("time budget exhausted")

    def remaining_seconds(self) -> float:
        return max(0.0, self.deadline - time.monotonic())


class Client:
    def __init__(self, api_key: str, model: str | None = None, budget: Budget | None = None,
                 session: requests.Session | None = None, timeout: tuple[float, float] = (10, 180)):
        self.api_key = api_key
        self.model = model or C.model_name()
        self.budget = budget or Budget()
        self.session = session or requests.Session()
        self.timeout = timeout

    @property
    def url(self) -> str:
        return f"{API_ROOT}/{self.model}:generateContent"

    def _redact(self, text: str) -> str:
        return text.replace(self.api_key, "***") if self.api_key else text

    @staticmethod
    def _extract_text(data: dict) -> str:
        fb = data.get("promptFeedback") or {}
        if fb.get("blockReason"):
            raise GeminiBadResponse(f"prompt blocked: {fb['blockReason']}")
        cands = data.get("candidates") or []
        if not cands:
            raise GeminiBadResponse("no candidates in response")
        cand = cands[0]
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        reason = cand.get("finishReason")
        if reason not in (None, "STOP", "FINISH_REASON_UNSPECIFIED") and not text.strip():
            raise GeminiBadResponse(f"finishReason={reason}")
        if reason == "MAX_TOKENS":
            raise GeminiBadResponse("output truncated (MAX_TOKENS)")
        if not text.strip():
            raise GeminiBadResponse("empty response text")
        return text

    @staticmethod
    def _loads(text: str):
        t = text.strip()
        t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
        return json.loads(t)

    def generate_json(self, system: str, user: str, schema: dict, *, max_output_tokens: int = 32768):
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": 0.2, "responseMimeType": "application/json",
                "responseSchema": schema, "maxOutputTokens": max_output_tokens,
            },
        }
        last = "no attempt made"
        parse_failures = 0
        for attempt in range(1, MAX_TRIES + 1):
            self.budget.check()
            self.budget.calls += 1
            delay = min(60.0, 2.0 ** attempt) + random.uniform(0, 1)
            try:
                r = self.session.post(self.url, headers={"x-goog-api-key": self.api_key}, json=body, timeout=self.timeout)
            except (requests.Timeout, requests.ConnectionError) as e:
                last = self._redact(f"{type(e).__name__}: {e}")
            else:
                sc = r.status_code
                if sc == 200:
                    try:
                        return self._loads(self._extract_text(r.json()))
                    except GeminiBadResponse:
                        raise
                    except ValueError as e:  # JSONDecodeError (also r.json())
                        parse_failures += 1
                        last = f"invalid JSON in response: {e}"
                        if parse_failures >= 2:
                            raise GeminiBadResponse(last)
                        delay = 1.0
                elif sc in (408, 429) or sc >= 500:
                    last = f"HTTP {sc}: {self._redact(r.text[:200])}"
                    ra = r.headers.get("Retry-After")
                    if ra and ra.strip().isdigit():
                        delay = max(delay, min(float(ra), 90.0))
                else:
                    msg = self._redact(r.text[:300])
                    if sc in (401, 403, 404) or (sc == 400 and re.search(r"API key|API_KEY_INVALID|not found", msg, re.I)):
                        raise GeminiFatal(f"HTTP {sc}: {msg}")
                    raise GeminiError(f"HTTP {sc}: {msg}")
            if attempt == MAX_TRIES:
                break
            if delay >= self.budget.remaining_seconds():
                raise BudgetExhausted("time budget exhausted while backing off")
            C.log.warning("gemini attempt %d/%d failed (%s); retrying in %.1fs", attempt, MAX_TRIES, last, delay)
            _sleep(delay)
        raise GeminiError(f"gave up after {MAX_TRIES} tries: {last}")


def make_client(max_calls: int = 400, time_budget_min: float = 40.0) -> Client | None:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        C.log.warning("GEMINI_API_KEY is not set: skipping AI enrichment (exports fall back to the Chinese text, ai=false)")
        return None
    return Client(key, C.model_name(), Budget(max_calls, time_budget_min))


# ------------------------------------------------------------------ prompts
S = "STRING"
SCHEMA_TRANSLATE = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "id": {"type": S}, "headline_en": {"type": S}, "description_en": {"type": S},
    "summary_zh": {"type": S}, "summary_en": {"type": S}},
    "required": ["id", "headline_en", "description_en", "summary_zh", "summary_en"]}}
SCHEMA_OVERVIEW = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "iso": {"type": S}, "zh": {"type": S}, "en": {"type": S}}, "required": ["iso", "zh", "en"]}}
SCHEMA_NAMES = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
    "zh": {"type": S}, "en": {"type": S}}, "required": ["zh", "en"]}}

SYS_TRANSLATE = """You are a public-health translator and editor for a travel-health dashboard built on Taiwan CDC international epidemic notices.
The input is a JSON array of notices written in Traditional Chinese. Return a JSON array with exactly one object per input item, in the same order, with these fields:
- id: copied verbatim from the input.
- headline_en: natural English translation of the headline.
- description_en: faithful, complete English translation of the description. Keep every number, date, unit and place name; do not add, drop or interpret anything. Use the plain register of WHO / CDC / ECDC situation reports. If the description is empty, return an empty string.
- summary_zh: ONE sentence in Traditional Chinese (Taiwan usage), at most 40 characters, giving the key fact a traveller needs (where, what, how many).
- summary_en: ONE sentence in English, at most 30 words, same content as summary_zh.
Rules: keep place names consistent with their conventional English names (e.g. 美國 = United States, 中國大陸 = mainland China, 剛果民主共和國 = Democratic Republic of the Congo). Never invent facts that are not in the input. Output JSON only."""

SYS_OVERVIEW = """You write short country briefings for travellers on a Taiwan travel-health dashboard.
For each country you receive its epidemic notices from the past two years (date, disease, one-line summary). Return a JSON array with one object per country: iso (verbatim), zh, en.
- zh: Traditional Chinese (Taiwan usage), at most 3 sentences.
- en: English, at most 3 sentences, same content.
Describe the main diseases, whether activity looks recent, rising, declining or persistent, and the most notable recent events, using ONLY the listed notices. Do not give medical advice beyond what the notices say and never invent numbers, dates or diseases. Output JSON only."""

SYS_NAMES = """You translate Traditional Chinese names used by Taiwan CDC into standard English. Return a JSON array of {zh, en}, one object per input item, with zh copied verbatim.
For diseases use the standard WHO / ECDC English disease name (title case only for proper nouns, e.g. "Hepatitis A", "Listeriosis"). For administrative areas use the usual English name of the province/state/municipality (e.g. 北京市 = Beijing, 內布拉斯加州 = Nebraska). Output JSON only."""


def _trim_zh(s: str, n: int = 60) -> str:
    s = s.strip()
    return s if len(s) <= n else s[: n - 1].rstrip("，、 ") + "…"


def _trim_en(s: str, words: int = 45) -> str:
    w = s.strip().split()
    return " ".join(w) if len(w) <= words else " ".join(w[:words]).rstrip(",;") + "…"


def _str(v) -> str:
    return v.strip() if isinstance(v, str) else ""


# ------------------------------------------------------------- translation
def _pending_items(conn, start: date) -> list:
    done = set(db.get_translations(conn))
    rows = X.epidemic_rows(conn, start)  # newest first
    return [r for r in rows if r["content_hash"] not in done
            and db.ai_failure_count(conn, "translate", r["content_hash"]) < MAX_FAILURES_PER_KEY]


def _batches(rows: list, max_items: int, max_chars: int):
    cur, chars = [], 0
    for r in rows:
        n = len(r["description"] or "") + len(r["headline"] or "")
        if cur and (len(cur) >= max_items or chars + n > max_chars):
            yield cur
            cur, chars = [], 0
        cur.append(r)
        chars += n
    if cur:
        yield cur


def _translate_batch(conn, client, rows: list, stats: dict, depth: int = 0) -> None:
    payload = [{"id": r["id"], "disease": r["disease"], "area": r["area_zh"], "headline": r["headline"],
                "description": r["description"]} for r in rows]
    try:
        out = client.generate_json(SYS_TRANSLATE, json.dumps(payload, ensure_ascii=False), SCHEMA_TRANSLATE)
    except (GeminiFatal, BudgetExhausted):
        raise
    except GeminiError as e:
        stats["errors"] += 1
        stats["consecutive_errors"] += 1
        C.log.warning("translate batch of %d failed: %s", len(rows), e)
        if len(rows) > 1 and isinstance(e, GeminiBadResponse):
            mid = len(rows) // 2
            _translate_batch(conn, client, rows[:mid], stats, depth + 1)
            _translate_batch(conn, client, rows[mid:], stats, depth + 1)
        elif len(rows) == 1:
            db.ai_failure_add(conn, "translate", rows[0]["content_hash"], str(e))
        if stats["consecutive_errors"] >= 6:
            raise GeminiFatal("too many consecutive failures")
        return
    stats["consecutive_errors"] = 0
    got = {}
    ids = {r["id"] for r in rows}
    if isinstance(out, dict):  # tolerate {"items": [...]}
        out = next((v for v in out.values() if isinstance(v, list)), [])
    for o in out if isinstance(out, list) else []:
        if isinstance(o, dict) and _str(o.get("id")) in ids:
            got[_str(o["id"])] = o
    missing = []
    for r in rows:
        o = got.get(r["id"])
        if (not o or not _str(o.get("headline_en")) or not _str(o.get("summary_zh")) or not _str(o.get("summary_en"))
                or (r["description"] and not _str(o.get("description_en")))):
            missing.append(r)
            continue
        db.put_translation(conn, r["content_hash"], headline_en=_str(o["headline_en"]),
                           summary_zh=_trim_zh(_str(o["summary_zh"])), summary_en=_trim_en(_str(o["summary_en"])),
                           description_en=_str(o.get("description_en")), model=client.model)
        db.ai_failure_clear(conn, "translate", r["content_hash"])
        stats["translated"] += 1
    if not missing:
        return
    C.log.warning("translate: %d/%d items missing or incomplete in response", len(missing), len(rows))
    if len(missing) == 1 and (len(rows) == 1 or depth >= 2):
        db.ai_failure_add(conn, "translate", missing[0]["content_hash"], "incomplete response")
    elif len(missing) < len(rows) and depth < 2:
        _translate_batch(conn, client, missing, stats, depth + 1)
    else:
        mid = len(missing) // 2
        _translate_batch(conn, client, missing[:mid], stats, depth + 1)
        _translate_batch(conn, client, missing[mid:], stats, depth + 1)


def translate_pending(conn, client, stats: dict) -> None:
    pending = _pending_items(conn, C.window_start())
    stats["translate_pending"] = len(pending)
    C.log.info("translate: %d items pending", len(pending))
    for batch in _batches(pending, BATCH_ITEMS, BATCH_CHARS):
        _translate_batch(conn, client, batch, stats)


# ---------------------------------------------------------------- overviews
def _overview_inputs(conn, start: date) -> dict[str, dict]:
    rows = X.epidemic_rows(conn, start)
    trans = db.get_translations(conn)
    geo = C.load_json(C.web_data() / "countries.json", {}) or {}
    by_c: dict[str, list] = {}
    for r in rows:
        if r["is_global"]:
            continue
        for iso in dict.fromkeys(x for x in (r["isos"] or "").split(",") if x):
            by_c.setdefault(iso, []).append(r)
    out = {}
    for iso, rs in by_c.items():
        items = []
        for r in rs[:80]:
            t = trans.get(r["content_hash"])
            items.append({"date": X._day(r["effective"]), "disease": r["disease"],
                          "summary": (t and t["summary_zh"]) or X.first_sentence(r["description"], r["headline"], 80)})
        out[iso] = {"iso": iso, "name_zh": geo.get(iso, {}).get("zh", iso), "name_en": geo.get(iso, {}).get("en", iso),
                    "notice_count": len(rs), "notices": items, "_hash": X.overview_hash(r["id"] for r in rs),
                    "_latest": X._ts(rs[0]["effective"])}
    return out


def overviews_pending(conn, start: date) -> list[dict]:
    have = {r["iso"]: r["items_hash"] for r in conn.execute("SELECT iso, items_hash FROM overviews")}
    inp = _overview_inputs(conn, start)
    pend = [v for iso, v in inp.items() if have.get(iso) != v["_hash"]
            and db.ai_failure_count(conn, "overview", iso) < MAX_FAILURES_PER_KEY]
    pend.sort(key=lambda v: v["_latest"], reverse=True)
    return pend


def _overview_batches(pend: list[dict], max_countries: int = 6, max_chars: int = 18000):
    cur, chars = [], 0
    for v in pend:
        n = len(json.dumps(v["notices"], ensure_ascii=False))
        if cur and (len(cur) >= max_countries or chars + n > max_chars):
            yield cur
            cur, chars = [], 0
        cur.append(v)
        chars += n
    if cur:
        yield cur


def _overview_batch(conn, client, batch: list[dict], stats: dict) -> None:
    payload = [{k: v for k, v in b.items() if not k.startswith("_")} for b in batch]
    try:
        out = client.generate_json(SYS_OVERVIEW, json.dumps(payload, ensure_ascii=False), SCHEMA_OVERVIEW)
    except (GeminiFatal, BudgetExhausted):
        raise
    except GeminiError as e:
        stats["errors"] += 1
        stats["consecutive_errors"] += 1
        C.log.warning("overview batch (%s) failed: %s", ",".join(b["iso"] for b in batch), e)
        if len(batch) > 1 and isinstance(e, GeminiBadResponse):
            mid = len(batch) // 2
            _overview_batch(conn, client, batch[:mid], stats)
            _overview_batch(conn, client, batch[mid:], stats)
        elif len(batch) == 1:
            db.ai_failure_add(conn, "overview", batch[0]["iso"], str(e))
        if stats["consecutive_errors"] >= 6:
            raise GeminiFatal("too many consecutive failures")
        return
    stats["consecutive_errors"] = 0
    by_iso = {b["iso"]: b for b in batch}
    n_ok = 0
    for o in out if isinstance(out, list) else []:
        iso = _str(o.get("iso")).upper() if isinstance(o, dict) else ""
        b = by_iso.get(iso)
        if b and _str(o.get("zh")) and _str(o.get("en")):
            db.put_overview(conn, iso, b["_hash"], _str(o["zh"]), _str(o["en"]), b["notice_count"], client.model)
            db.ai_failure_clear(conn, "overview", iso)
            stats["overviews"] += 1
            n_ok += 1
            by_iso.pop(iso)
    for iso in by_iso:  # not returned: count a failure, retried next run
        db.ai_failure_add(conn, "overview", iso, "missing in response")


def refresh_overviews(conn, client, stats: dict) -> None:
    pend = overviews_pending(conn, C.window_start())
    stats["overviews_pending"] = len(pend)
    C.log.info("overviews: %d countries need (re)generation", len(pend))
    for batch in _overview_batches(pend):
        _overview_batch(conn, client, batch, stats)


# ------------------------------------------------------------------- names
def missing_diseases(conn, retry_limit: bool = True) -> list[str]:
    known = {C.nfkc(k) for k in X._manual("diseases.json")} | set(db.names(conn, "disease_names"))
    seen: set[str] = set()
    for r in conn.execute("SELECT DISTINCT alert_disease d FROM alerts_raw WHERE alert_disease != ?", (C.COVID_OLD,)):
        seen.update(C.split_diseases(r["d"]))
    for r in conn.execute("SELECT DISTINCT disease d FROM epidemics"):
        seen.update(C.split_diseases(r["d"]))
    return sorted(d for d in seen - known
                  if not retry_limit or db.ai_failure_count(conn, "disease", d) < MAX_FAILURES_PER_KEY)


def _missing_areas(conn) -> list[dict]:
    names = X.Names(conn)
    known = set(names.area) | set(names.area_ai)
    out = {}
    for r in conn.execute("SELECT DISTINCT areaDetail a, ISO3166_2 s, areaDesc_EN c FROM alerts_raw WHERE areaDetail != ''"):
        if r["a"] not in known and r["a"] not in out and db.ai_failure_count(conn, "area", r["a"]) < MAX_FAILURES_PER_KEY:
            out[r["a"]] = {"zh": r["a"], "iso_sub": r["s"], "country_en": r["c"]}
    return list(out.values())


def _names_job(conn, client, kind: str, table: str, items: list, stats: dict, key=lambda x: x) -> None:
    for i in range(0, len(items), 60):
        chunk = items[i:i + 60]
        keys = {key(x) for x in chunk}
        try:
            out = client.generate_json(SYS_NAMES, json.dumps(chunk, ensure_ascii=False), SCHEMA_NAMES)
        except (GeminiFatal, BudgetExhausted):
            raise
        except GeminiError as e:
            C.log.warning("%s names failed: %s", kind, e)
            stats["errors"] += 1
            for k in keys:
                db.ai_failure_add(conn, kind, k, str(e))
            continue
        for o in out if isinstance(out, list) else []:
            zh, en = (_str(o.get("zh")), _str(o.get("en"))) if isinstance(o, dict) else ("", "")
            if zh in keys and en:
                db.put_name(conn, table, zh, en, client.model)
                keys.discard(zh)
                stats["names"] += 1
        for k in keys:
            db.ai_failure_add(conn, kind, k, "missing in response")


def fill_names(conn, client, stats: dict) -> None:
    dis = missing_diseases(conn)
    C.log.info("names: %d diseases, ", len(dis))
    if dis:
        _names_job(conn, client, "disease", "disease_names", [{"zh": d} for d in dis], stats, key=lambda x: x["zh"])
    areas = _missing_areas(conn)
    C.log.info("names: %d sub-national areas", len(areas))
    if areas:
        _names_job(conn, client, "area", "area_names", areas, stats, key=lambda x: x["zh"])


# --------------------------------------------------------------------- main
def enrich(conn, client: Client | None) -> dict:
    stats = {"translated": 0, "overviews": 0, "names": 0, "errors": 0, "consecutive_errors": 0, "calls": 0,
             "skipped": False, "stopped": None}
    if client is None:
        stats["skipped"] = True
        return stats
    try:
        fill_names(conn, client, stats)
        translate_pending(conn, client, stats)
        refresh_overviews(conn, client, stats)
    except BudgetExhausted as e:
        stats["stopped"] = str(e)
        C.log.warning("gemini budget reached: %s (remaining work continues on the next run)", e)
    except GeminiFatal as e:
        stats["stopped"] = f"fatal: {e}"
        C.log.error("gemini aborted: %s", e)
    stats["calls"] = client.budget.calls
    stats.pop("consecutive_errors", None)
    C.log.info("enrich done: %s", stats)
    return stats
