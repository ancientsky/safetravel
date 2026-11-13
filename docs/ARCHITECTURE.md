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
| `web/vendor/` | npm (vendored, `npm run vendor`) | `d3.min.js` (only the d3 functions listed in `scripts/d3-entry.mjs`, bundled by esbuild; the Pages deploy runs `scripts/check-d3.mjs` and fails if `web/` calls a d3 function outside that list), `topojson-client.min.js` — no CDN at runtime; `zhuyin.json` (Zhuyin dictionary of the on-screen keyboard `js/osk.js` + `osk.css`, opt-in with `?osk=1`; built by `scripts/build-zhuyin.py` from McBopomofo data, MIT, `zhuyin.LICENSE.txt`, plus the Chinese names in `web/data/countries.json` / `places.json`) `qrcode.js` (qrcode-generator 1.4.4, MIT, copied unchanged from npm with `qrcode.LICENSE.txt`; fetched on first use by `web/js/qr.js`). |
| `web/slides/` | humans + Actions | Health-poster carousel (`slide.html`): `slides.json` playlist, `assets/` artwork, `auto/` auto-publish folder (images dropped there + generated `index.json`), `export/` PNG written by `slides.yml`. Spec: `SLIDES.md` |
| `scripts/slide-sources/` | humans | Original Taiwan CDC posters + seal; `scripts/crop-slide-assets.py` cuts the artwork into `web/slides/assets/` |
| `scripts/mirror/` | humans | Intranet mirror kit (sync script, systemd units, nginx site, installer): copies `web/` of the commit the public site serves + the live `arrivals.json` to an internal nginx host; never contacts the data sources. Spec: `MIRROR.md` |
| `.github/workflows/` | ops | `update-data.yml` (cron) · `deploy-pages.yml` (on push to main, web/**) · `arrivals.yml` (arrivals board, external trigger) · `slides.yml` (poster PNG/PDF export → commit → dispatch deploy) |
| `docs/` | — | This file + `DATA_CONTRACT.md` + `SLIDES.md` (poster carousel) + `ARRIVALS.md` (arrivals board spec) + `ARRIVALS_SETUP.md` (owner setup, zh-Hant) |

## Self-reload of open pages (kiosks)

Every deploy (deploy-pages, update-data, arrivals publish) runs `.github/scripts/stamp-version.sh`, which writes
`web/version.json` `{"code": <hash of git ls-tree of web/ minus data/, slides/ and itself>, "commit"}` into the Pages
artifact; the intranet mirror computes the same hash. The committed file says `"dev"` (local preview never reloads).
`web/js/autoreload.js` polls it (and, for `trip.html`, `data/meta.json`) every 5 minutes and marks a reload pending;
the page reloads at a harmless moment: `index.html` via `refresh.js` (spotlight boundary or 60 s; activity defers it by at most 2 min),
`slide.html` at the next poster change (paused: 60 s idle), `trip.html` after 5 minutes without input, `arrivals.html`
after 60 s without input. Hidden tabs do
not poll; `?refreshEvery=<s>` shortens the poll for tests.

**Half-updated browser cache.** Pages are build-free ES modules with fixed URLs and GitHub Pages lets browsers keep each
file 10 minutes, so right after a deploy a browser can combine a new module with an old cached one; a missing export then
stops the whole module graph (blank page). Two guards: `js/boot-guard.js` (classic script in every page's `<head>`) waits
for `load` + 1.5 s and, if the entry module never set `<html data-booted>` (its first statement after the imports),
re-fetches every same-site script / stylesheet the page used with `cache: 'reload'` and reloads — at most twice per tab
session (`sessionStorage safetravel.recover`). And every code-update reload (`refresh.js`, `autoreload.js`) goes through
the same re-fetch first (`freshReload`), so kiosks never mix versions. New pages: include the guard and set the mark.

**Framed by another website.** GitHub Pages cannot send `X-Frame-Options` or `frame-ancestors`, and a `<meta>` CSP
cannot carry `frame-ancestors` (the intranet mirror's nginx sends both headers). The same `js/boot-guard.js` therefore
checks first whether the page sits in a frame whose top page is another origin; if so it replaces itself with
`framed.html` (static, no script: a bilingual notice and a link that opens the site in a new tab) before any page
code draws. Same-origin frames are allowed, like `frame-ancestors 'self'`; the host name `localhost` is exempt for
development preview panes. The pages' own CSP has no `frame-src`, so the site never frames anything itself.

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

5. **Travel medicine** (疾管署國際旅遊處方箋、旅遊醫學門診) — three monthly CSVs on `od.cdc.gov.tw` (uploaded by
   hand to `data/raw/travelmed/`: the host does not answer GitHub runners) plus the per-country prescription pages on
   `www.cdc.gov.tw` (crawled a few per run). `pipeline/travelmed.py`, `pipeline/travelmed_pages.py` →
   `web/data/travelmed.json`, `web/data/travelmed/<ISO>.json`. Details: `docs/TRAVELMED.md`.

## Scheduling

- `update-data.yml`: `workflow_dispatch` only (inputs: `max_calls`, `skip_gemini`), triggered at 11:17 / 21:17 Asia/Taipei by the external scheduler below.
  Steps: checkout → setup-python → `pip install --require-hashes -r pipeline/requirements.lock` → `python -m pipeline run` → commit `data/` + `web/data/` if changed → deploy Pages (second job, needs `pages: write`, `id-token: write`).
- `deploy-pages.yml`: on every push to `main` → job `build` (read-only token: data-commit check, validate, poster index, d3 check, version stamp, artifact) → job `deploy` (Pages rights, no repository code: artifact + live `arrivals.json` → deploy). Uses `actions/configure-pages` with `enablement: true`.
- Commits made with `GITHUB_TOKEN` do not trigger other workflows, hence the deploy job lives inside `update-data.yml` too.
- `arrivals.yml` ("Arrivals board"): publishes `web/data/arrivals.json` (inbound international flights, `docs/ARRIVALS.md`) to Pages every ~10 min without committing anything. A lock-free `guard` job (download the live `arrivals.json` with the quota counters → `python -m pipeline arrivals --check-only`, no TDX call), then a `publish` job holding the `pages` concurrency lock: checkout `main`, or the live commit while `main` has unpublished code (see below) → re-read counters and re-check → `python -m pipeline arrivals` (one TDX call) → `validate` → upload `web/` → deploy. Needs secrets `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET`. Optional variable `ARRIVALS_MONTHLY_CAP` (default 4200 of the 4,500 free calls/month).
- **Site code goes live through `deploy-pages.yml` only.** `arrivals.yml` and the deploy job of `update-data.yml` exist to publish data. Before publishing they run `.github/scripts/deployable-ref.sh`: it takes the *checked version* — the newer of the commit that is live (`version.json` on the site, written by every deploy) and the commit of the last successful `deploy-pages.yml` run (Actions API; two sources because either can lag for a moment after a deploy, and the newer one can never pull the site back) — and compares it with `main`. Same commit, or a difference under `data/` and `web/data/` only → `main` is published. Anything else changed (code `deploy-pages.yml` has not published yet, or refused) → `arrivals.yml` checks out the checked version and publishes it with the fresh `arrivals.json`; `update-data.yml` publishes nothing and the data goes out once the code has passed. Neither source readable → nothing is published that round. `deploy-pages.yml` runs one at a time (workflow-level `concurrency`), so an older commit is never published after a newer one. That is why `deploy-pages.yml` runs on every push, whatever it touched: until it has published a commit, the other paths stay on the version before it. Its data-commit check starts at the live commit, not at the previous push, so a refused `data:` commit stays refused when a later push arrives; it passes once a commit puts the offending files back to what they were. There is no manual override (a run started by hand, or by the scheduler's token, checks exactly like a push); to keep a change a data commit made, revert it, let that deploy, and make the change again in an ordinary commit. The intranet mirror follows the same `version.json`. Tests: `tests/deploy-scripts.test.sh` (CI). This keeps broken or out-of-bounds commits off the site; it is not a barrier against someone who can push arbitrary code to `main`, since the workflows themselves live there.
- Every other Pages deploy (`deploy-pages.yml`, the deploy job of `update-data.yml`) holds the same `pages` lock at job level and first copies the live `arrivals.json` into `web/data/` (no TDX call), so code/data deploys never drop the board.
- **External trigger (primary clock for the two workflows above).** GitHub cron on this repository was measured to start runs **4.5–8.5 h late** (`17 3,13 * * *` ran at 17:52–18:54 and 01:52–05:45 Taipei), while `workflow_dispatch` starts within seconds. cron-job.org therefore POSTs `.../actions/workflows/arrivals.yml/dispatches` every 10 min and `.../update-data.yml/dispatches` at 11:17 / 21:17 Asia/Taipei, authenticated by a fine-grained PAT (this repository only, *Actions: read and write*). Neither workflow has an in-repo `schedule:` any more; the arrivals guard makes duplicate triggers harmless. Setup: `docs/ARRIVALS_SETUP.md`.

## Frontend principles

- No build step; ES modules; D3 v7 + topojson-client vendored.
- All copy through `i18n` (`zh-Hant` default, `en`), persisted in `localStorage`.
- Theme: `dark` default (black `#050a07` → deep green, neon green `#19ff8a` accent, cyan secondary), `light` alternative. Level colours per `DATA_CONTRACT.md`.
- Everything the map needs is loaded from `web/data/*.json` with `fetch()` relative to `index.html` (works under `/safetravel/` sub-path).
- Text size: `js/textsize-boot.js` (classic script in `<head>` of `index.html` and `trip.html`, so no CSP hash) sets
  `data-ts` (s / m / l / xl = 100 / 112 / 125 / 140 %; `?text=` > localStorage `safetravel.textSize` > `xl`, or `s` on
  ≤ 760 px) before first paint; every font size in `styles.css` / `trip.css` is `calc(Npx * var(--ts))`, and the
  panel, legend, spotlight, search and arrivals board widen with it. The header stops at 112 % (100 % below 1500 px);
  the toolbar / panel / zoom / weather bar follow its measured bottom edge (`--hud-top-b`, `--hud-b` from a
  ResizeObserver in `app.js`). `slide.html` posters are fixed canvases and do not scale.
- Search: countries plus airports and cities (`js/places.js`: `data/places.json` + `data/airports.json`, loaded on the
  first use of a search box); a place opens its country.

## Weather (CWA world-city forecast)

`pipeline/weather.py` → `web/data/weather.json` (contract in DATA_CONTRACT.md). Front end:
- `web/js/wx-shared.js`: pure helpers shared by both pages (data normalisation, temperature classes, °C/°F, marker priority and
  keyboard order, the greedy screen-space declutter).
- `trip.html`: `trip-weather.js` (city cards, card block; unit in `localStorage` `safetravel.trip.unit`) and `trip-wxmap.js`
  (third map tab).
- Main site: `web/js/weather.js`, loaded with a dynamic `import()` only when the overlay is switched on — while it is off
  nothing weather-related is fetched or built. State in `localStorage` `safetravel.weather` (`on`/`off`, default off),
  overridden by `?wx=1` / `?wx=0`. Markers are HTML buttons in their own layer (above the map, flights canvas and route watch,
  below the HUD), placed in screen pixels on every zoom/pan frame and kept clear of the HUD cards.

## Travel medicine on `trip.html`

`trip-med.js` (card section "出國前健康準備": vaccines, local diseases and prevention, emergency numbers, traveller-group
notes) and `trip-clinics.js` (section "旅遊醫學門診": city / open-now / M痘 filters, nearest-first, week grid, locator
map). Data and refresh: `docs/TRAVELMED.md`.

## Traveller aids on the map page

- **Brief + QR code** (`js/panel.js` `renderBrief`, `js/qr.js`): the country panel opens with three plain lines built from the
  data already loaded (CDC level, diseases and instruction; MOFA / MAC level incl. a higher regional level; a fixed pre-trip
  line linking to `trip.html#ISO`). The lines type themselves once per country and language (`typeBrief`; hidden full text
  keeps the layout still; a re-render resumes instead of restarting; static with reduced motion). The QR code encodes the absolute address of that trip check on the public site, taken
  from `<meta name="safetravel-public-url">` in `index.html` (so an intranet mirror still hands out a public link; forks
  change the meta). The code is off by default and only rendered with `?qr=1`; never at 760 px and below. Without it
  the generator is not fetched.
- **Kiosk destination buttons** (`js/ask.js`): "要去哪裡？" plus `places.js` `POPULAR_ISO` beside the search
  box, only with `?ask=1` (off by default, also on kiosks). `fit()` measures what is to the right of the
  search box (zoom buttons, panel, board, spotlight) and under it (layer switches, weather day bar) and keeps one or two
  rows of whole buttons.
- **Level patterns** (`js/map.js` `renderPatterns`): a `g.patterns` layer above the countries repeats the paths of the two
  highest levels of the active layer with SVG pattern fills (dots, hatching); `patternTransform` is rescaled on zoom so the
  pattern keeps its size on screen. `state.patterns`, `localStorage` `safetravel.patterns` (`off` to disable), `?pat=0|1`,
  class `pat-on` on `<html>` for the legend swatches.
- **Board filter button** (`js/arrivals.js`): the count of listed flights from level 2+ areas is a compact toggle beside the
  checkpoint control (also on a collapsed board); `.arr-stale-bar` appears when the feed is older than twice the refresh interval plus 5 minutes.

## `trip.html` on phones

Screen widths up to 760 px only (wider screens and print keep everything):
- `trip-more.js`: one helper that shows the first N items of a long list behind a "顯示全部（N）" button — clinics 6, weather
  cities 6, destination table 8. Filters, search and sorting always run over the whole list; hidden items carry `.is-more`.
- `trip-nav.js`: the header sticks with only the section-chip row visible (`--jump-top`, `--jump-h`), the chip of the section
  in view gets `aria-current`, and a back-to-top button appears after the first screen.
- `trip.js`: opening a destination card pushes one history entry, so Back closes the card instead of leaving the page;
  switching destinations replaces that entry.
- `trip-search.js` shares the main site's aliases and ranking (`places.js` `COUNTRY_ALIASES`, `popRank`, `placeRank`).

## Quick check (`m.html`, personal / phone version)

Search-first page without the map, for staff's and travellers' own devices: `m.html` (CSP without inline scripts) +
`js/m-boot.js` (theme follows the device unless chosen here: `safetravel.m.theme`; language) + `js/m.js` + `m.css`
(self-contained tokens, light + dark). Role in `localStorage` `safetravel.role` (`?role=officer|public`): officers get the
arrivals tab, flight-number search and flights from the country on its card (arrivals.json, polled every minute while
visible); travellers get popular destinations and the MOFA warning summary. Hash routes: `#/c/<ISO>` (card),
`#/flights`, `#/news`. Loads alerts.json + countries.json at start; warnings.json, `epidemics-recent.json` (last 60 days,
docs/DATA_CONTRACT.md), arrivals.json and the place index only when a view needs them. Reuses `state.js`, `i18n.js`
(strings `m_*`), `places.js`, `textsize.js`, `autoreload.js` and `bestTime` / `flightKey` from `arrivals.js`. The map page
offers it once on phones (`safetravel.mpromo`).

## Help page (`help.html`)

Static user guide for staff and travellers: `help.html` holds the whole text twice (`<main data-lang="zh">` and
`<main data-lang="en">`), styled by `m.css` + `help.css`; `js/help.js` only switches language (`safetravel.lang`) and theme
(`safetravel.m.theme`, shared with m.html) and maps `#sources`-style anchors to the English ids (`#en-sources`). Linked from
the map page's footer and phone menu, m.html and trip.html. The map page's footer lists sources as one short line of
names (link titles say what each provides) and points to `help.html#sources` for the details.
**Keep it current**: every user-visible change (page, feature, URL parameter, level wording, source) also updates
help.html in both languages (CLAUDE.md ground rule).

## Standalone arrivals board (`arrivals.html`)

The inbound board without the map, for counter tablets and screens: `arrivals.html` (CSP without inline scripts) +
`js/board-boot.js` (theme / language before first paint, same keys as the map page) + `js/board.js` (loads
alerts.json + countries.json, then `createArrivals({ standalone: true })` from `js/arrivals.js`; rows open
`trip.html#<ISO>`; `autoreload.js` for new site code). Styles live in `styles.css` (`.board-page`). Details in
`docs/ARRIVALS.md` (UI).

## Health-poster carousel (slide.html)

Kiosk page for airport quarantine-station screens; maintenance guide in `docs/SLIDES.md` (zh-Hant, English summary).
- `web/slide.html` (same CSP as `trip.html`) + `js/slide-boot.js` (theme / language / orientation before first paint) +
  `js/slide.js` (playlist, timer, settings panel, wake lock, 5-minute manifest refresh) + `js/slide-templates.js`
  (one renderer per template: `alert`, `symptoms`, `report`, `germs`, `image`; DOM built with `createElement` /
  `textContent`, highlights as `{t, hl}` segments, only `https://…cdc.gov.tw` links) + `slide.css` (fixed 1080×1920 /
  1920×1080 canvas scaled with `transform`, layouts per orientation, `@media print` with named `@page`s).
- Entrance animations only animate *from* a start state, so print, `?still=1` (export) and `prefers-reduced-motion`
  show the final state by switching animations off.
- The `alert` map uses the vendored d3 (`geoNaturalEarth1`, `geoPath`) + topojson with `web/data/world-110m.json`.
- `pipeline/validate.py` checks `web/slides/slides.json` and `web/slides/auto/index.json` with
  `python -m pipeline.validate web` (stdlib only), run by `deploy-pages.yml` and `slides.yml` — not by the data /
  arrivals deploys, so a poster typo never blocks them.
- `pipeline/slides_auto.py` (stdlib) indexes `web/slides/auto/`: each image becomes an `image` poster, settings parsed
  from the file name (dates, seconds, 直式/橫式 pair, language); `slide.js` appends `auto/index.json` to the playlist.
  `slides.yml` runs it strictly (a bad file name fails the run), `deploy-pages.yml` with `--lenient` (skips the file).
- `.github/workflows/slides.yml`: on poster changes, `scripts/export-slides.mjs` renders PNGs with Playwright,
  commits `web/slides/export/` and `web/slides/auto/index.json` with the bot identity and dispatches `deploy-pages.yml` (GITHUB_TOKEN commits do not
  trigger workflows).
