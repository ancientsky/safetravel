# SafeTravel TW — Architecture

Static, AI-assisted dashboard of Taiwan CDC international travel-health advisories,
deployed on GitHub Pages, refreshed twice a day by GitHub Actions.

```
 ┌──────────────── GitHub Actions (cron 2×/day + manual) ────────────────┐
 │  pipeline/fetch.py   → data/raw/*.csv, data/raw/flights/*             │
 │  pipeline/load.py    → data/safetravel.db  (SQLite, committed)         │
 │  pipeline/enrich.py  → Gemini (gemini-3.5-flash): translate + summarize│
 │                        incremental, cached by content hash in SQLite  │
 │  pipeline/export.py  → web/data/*.json  (contract: DATA_CONTRACT.md)  │
 │  git commit + push (GITHUB_TOKEN)  →  deploy job → GitHub Pages       │
 └────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
          web/  (vanilla JS + D3 v7 + topojson-client, no build step)
          index.html · app.js · styles.css · i18n · themes · data/*.json
```

## Repository layout

| Path | Owner | Purpose |
|------|-------|---------|
| `pipeline/` | Python 3.11+ | ETL: fetch → sqlite → Gemini enrich → export JSON |
| `data/raw/` | pipeline | Latest downloaded sources (CSV / flight text / html). Committed so dev works offline. |
| `data/manual/` | humans | Hand-maintained dictionaries: disease names zh→en, territory→ISO, level labels |
| `data/safetravel.db` | pipeline | SQLite. Source of truth for history + Gemini cache. Committed. |
| `web/` | frontend | The static site served by GitHub Pages (root = `web/`) |
| `web/data/` | pipeline export | JSON consumed by the browser. Overwritten every run. `epidemics.json` is a slim index; full texts are lazy-loaded from `web/data/epidemics/<ISO2>.json` (+ `_global.json`). `world.json` (50m) and `world-110m.json` (narrow screens) are built by `build_geo.py`. |
| `web/vendor/` | npm (vendored) | `d3.min.js`, `topojson-client.min.js` — no CDN at runtime |
| `.github/workflows/` | ops | `update-data.yml` (cron) · `deploy-pages.yml` (on push to main, web/**) · `arrivals.yml` (arrivals board, external trigger) |
| `docs/` | — | This file + `DATA_CONTRACT.md` + `ARRIVALS.md` (arrivals board spec) + `ARRIVALS_SETUP.md` (owner setup, zh-Hant) |

## Data sources

1. **Travel alert levels** (國際旅遊疫情建議等級, all history)
   `https://www.cdc.gov.tw/CountryEpidLevel/ExportCSV?type=0&fileName=TCDCTravelAlertAll.csv`
   Columns: `source,effective,senderName,instruction,web,alert_title,severity_level,alert_disease,areaDesc,areaDesc_EN,circle,ISO3166,areaDetail,ISO3166_2`
   - `severity_level` ∈ {`第一級:注意(Watch)`, `第二級:警示(Alert)`, `第三級:警告(Warning)`, `解除`}
   - One row = one announcement. **Current state = latest row per key (alert_disease, ISO3166, areaDetail)**; if that latest row is `解除` the advisory is lifted → drop it.
   - `嚴重特殊傳染性肺炎` (COVID-19, 248 rows of level 3 from 2020-03-21, never individually lifted) was superseded when CDC renamed it `新冠併發重症` and reset everything to level 1 on 2023-11-01 (some 2020 rows, e.g. 巴勒斯坦地區, have no 2023 counterpart). **Drop every `嚴重特殊傳染性肺炎` row entirely**; only `新冠併發重症` rows count.
   - Key for "latest row wins" = (disease, resolved ISO alpha-2 — or `areaDesc` when there is none —, `areaDetail`).
   - Diseases that apply to ≥ 150 countries at the same level (currently only `新冠併發重症` L1) are **global** advisories: applied to every country on the map (except TW and AQ), flagged `global: true` in each country's list, and they do count toward map colouring / `max_level`.
   - `ISO3166` can be `NA` (Namibia) → **never let a CSV reader turn it into null** (`keep_default_na=False`). Empty `ISO3166` = territory without code → map via `data/manual/territories.json`, else list under `unmapped`. `SMLL` = Somaliland → unmapped.
   - `areaDetail`/`ISO3166_2` give sub-national scope (e.g. 中國大陸 / 北京市 / CN-11). A country's level = max over its rows, including sub-national ones.

2. **International epidemic digest** (國際重要疫情資訊, ~2 years)
   `https://www.cdc.gov.tw/TravelEpidemic/ExportCSV?type=1&fileName=TCDCIntlEpid.csv`
   Columns: `sent,source,effective,expires,senderName,headline,description,instruction,web,alert_title,severity_level,alert_disease,areaDesc,areaDesc_EN,circle,ISO3166,areaDetail,ISO3166_2`
   - ~2,600 rows, 2024-01 → today. `description` is a Chinese paragraph (median 140 chars, max 3.5k).
   - `ISO3166` is comma-separated (`ET,NE,SN`), may be empty (global / regional).
   - Text contains Kangxi-radical look-alikes (`流⾏性` U+2F8F) → **apply `unicodedata.normalize('NFKC', …)`** to headline/description before storing or hashing.
   - Stable id = `epidemicId` query param of `web` URL.

3. **Taoyuan Airport (TPE) daily flights**
   Primary: **TDX** (Ministry of Transportation open data) `GET https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport/TPE?$format=JSON`
   → `[{AirportID, FIDSDeparture[], FIDSArrival[], UpdateTime}]`, covering yesterday/today/tomorrow (~700 rows each way per day, codeshares included).
   Row keys: FlightDate, FlightNumber, AirlineID, DepartureAirportID, ArrivalAirportID, ScheduleDepartureTime/ScheduleArrivalTime,
   DepartureRemark/ArrivalRemark (`準時ON TIME`, `出發DEPARTED`, `已到ARRIVED`, `時間更改SCHEDULE CHANGE`, `取消CANCELLED`, `延遲DELAY`), Terminal, Gate, IsCargo, AcType (only on the operating carrier's row).
   Works from GitHub runners **without credentials** (small daily anonymous quota); optional `TDX_CLIENT_ID`/`TDX_CLIENT_SECRET` secrets enable OAuth2 client-credentials for a higher quota.
   Rules: today's rows only (Asia/Taipei), drop cargo and cancelled, de-duplicate codeshares by (schedule time, other airport) → physical flights; airlines = operating carriers.
   City names: `GET .../v2/Air/Airport?$format=JSON` gives `AirportName.Zh_tw / En`; fallback `web/data/airports.json` (OpenFlights).
   Fallback when TDX fails: static route list from OpenFlights `data/raw/routes.dat` (103 TPE destinations), flagged `source: openflights-static`, `meta.sources.flights.ok=false`.
   Not usable from Actions: `www.taoyuan-airport.com` (Cloudflare JS challenge) and `odp.taoyuan-airport.com` (TCP timeout, geo-blocked) — verified by `data/raw/flights/probe*/NOTES.txt`.
   Raw responses are saved to `data/raw/flights/<date>/` and `latest/` for offline debugging.

4. **Gemini** — `GEMINI_API_KEY` secret, model `GEMINI_MODEL` (default `gemini-3.5-flash`), REST
   `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `response_mime_type: application/json` and a JSON schema.
   Jobs: (a) translate epidemic headline+description → English, plus a one-sentence zh and en summary; batched ~15 items/call;
   (b) per-country 2-year overview (zh + en, ≤ 3 sentences) regenerated only when that country's set of item ids changes;
   (c) disease names not in `data/manual/diseases.json`.
   Everything is cached in SQLite keyed by content hash; without an API key the pipeline still runs and exports with `*_en` falling back to zh and `ai: false`.

## Scheduling

- `update-data.yml`: `workflow_dispatch` only (inputs: `max_calls`, `skip_gemini`), triggered at 11:17 / 21:17 Asia/Taipei by the external scheduler below.
  Steps: checkout → setup-python → `pip install --require-hashes -r pipeline/requirements.lock` → `python -m pipeline run` → commit `data/` + `web/data/` if changed → deploy Pages (second job, needs `pages: write`, `id-token: write`).
- `deploy-pages.yml`: on push to `main` touching `web/**` → upload `web/` → deploy. Uses `actions/configure-pages@v5` with `enablement: true`.
- Commits made with `GITHUB_TOKEN` do not trigger other workflows, hence the deploy job lives inside `update-data.yml` too.
- `arrivals.yml` ("Arrivals board"): publishes `web/data/arrivals.json` (inbound international flights, `docs/ARRIVALS.md`) to Pages every ~10 min without committing anything. A lock-free `guard` job (download the live `arrivals.json` with the quota counters → `python -m pipeline arrivals --check-only`, no TDX call), then a `publish` job holding the `pages` concurrency lock: checkout `main` → re-read counters and re-check → `python -m pipeline arrivals` (one TDX call) → `validate` → upload `web/` → deploy. Needs secrets `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET`. Optional variable `ARRIVALS_MONTHLY_CAP` (default 4200 of the 4,500 free calls/month).
- Every other Pages deploy (`deploy-pages.yml`, the deploy job of `update-data.yml`) holds the same `pages` lock at job level and first copies the live `arrivals.json` into `web/data/` (no TDX call), so code/data deploys never drop the board.
- **External trigger (primary clock for the two workflows above).** GitHub cron on this repository was measured to start runs **4.5–8.5 h late** (`17 3,13 * * *` ran at 17:52–18:54 and 01:52–05:45 Taipei), while `workflow_dispatch` starts within seconds. cron-job.org therefore POSTs `.../actions/workflows/arrivals.yml/dispatches` every 10 min and `.../update-data.yml/dispatches` at 11:17 / 21:17 Asia/Taipei, authenticated by a fine-grained PAT (this repository only, *Actions: read and write*). Neither workflow has an in-repo `schedule:` any more; the arrivals guard makes duplicate triggers harmless. Setup: `docs/ARRIVALS_SETUP.md`.

## Frontend principles

- No build step; ES modules; D3 v7 + topojson-client vendored.
- All copy through `i18n` (`zh-Hant` default, `en`), persisted in `localStorage`.
- Theme: `dark` default (black `#050a07` → deep green, neon green `#19ff8a` accent, cyan secondary), `light` alternative. Level colours per `DATA_CONTRACT.md`.
- Everything the map needs is loaded from `web/data/*.json` with `fetch()` relative to `index.html` (works under `/safetravel/` sub-path).
