# Inbound flights for quarantine stations (入境航班 · 檢疫站)

Floating board on the map listing passenger flights that **arrive within ±60 minutes of now** at a chosen Taiwan
airport and quarantine checkpoint, with the origin country's CDC advisory level, so airport quarantine officers can
prepare for passengers from that place. Off by default; opened with a header toggle or a station deep link.

## Source: TDX FIDS arrivals

Verified from the TDX Air swagger (`eb87998f-…`, probe run 2026-10-14):

| operationId | Path | Anonymous |
|---|---|---|
| `AirApi_Arrival_2013` | `GET /v2/Air/FIDS/Airport/Arrival` — all airports | **401 "Valid API Key Required"** |
| `AirApi_Arrival_2013_1` | `GET /v2/Air/FIDS/Airport/Arrival/{IATA}` — one airport | works (small daily quota per IP) |

Query options on both: `IsCargo`, `$select`, `$filter`, `$orderby`, `$top`, `$skip`, `$format`.
Response: flat JSON list of `FIDSArrival` rows covering yesterday/today/tomorrow (TPE ≈ 700 rows/day incl. codeshares):

`FlightDate, FlightNumber (digits only), AirlineID, DepartureAirportID, ArrivalAirportID, ScheduleArrivalTime,
EstimatedArrivalTime, ActualArrivalTime (local Asia/Taipei, "YYYY-MM-DDTHH:MM", no offset), ArrivalRemark
("已到ARRIVED", "準時ON TIME", "延遲DELAY", "時間更改SCHEDULE CHANGE", "取消CANCELLED", …), ArrivalRemarkEn,
Terminal ("1"/"2"), Gate (" A8", "B1R", "D12"; leading spaces; missing on remote stands), Apron, CodeShare,
IsCargo, AcType (only on the operating carrier's row), BaggageClaim, UpdateTime`.
`AirRouteType` exists in the schema but is not populated by CAA/TPE FIDS.

Taoyuan gates → quarantine checkpoints: **T1 = A, B; T2 = C, D** (first letter of the gate).

## Call budget

Free TDX plan: **4,500 calls / month** (≈ 145 / day ≈ 6 / hour). The OAuth token endpoint has its own limit
(20 / min / IP) and does not count against the API quota.

| Consumer | Calls |
|---|---|
| `update-data.yml` (2 runs/day × FIDS TPE + Airport list) | ≤ 4 / day ≈ 124 / month |
| `arrivals.yml` day 05:00–23:59 Taipei, every 10 min | 19 h × 6 = 114 / day |
| `arrivals.yml` night 00:00–04:59 Taipei, every 30 min | 5 h × 2 = 10 / day |
| **Total** (31-day month) | ≈ 3,968 — leaves ≈ 530 (12 %) for manual runs / retries |

Each arrivals run makes **one** call: `/FIDS/Airport/Arrival?IsCargo=false` (all airports) with the API key;
only if that fails, one fallback call to `/FIDS/Airport/Arrival/TPE`. Without a key (secrets not set) scheduled runs
do nothing; a manual run may call `/Arrival/TPE` anonymously for testing.

### Guard (decides whether a run may call TDX — costs no quota)

The previous `arrivals.json` is read from the live site (`<pages_url>/data/arrivals.json`), which carries the
usage counters. A run calls TDX only if **all** hold:

1. age of the published data ≥ 7 min (05:00–23:59 Taipei) or ≥ 25 min (00:00–04:59) — with a trigger every 10 min
   this gives one call per trigger by day and one per three triggers at night, even when a run queued for the Pages lock;
2. `calls_month < cap` (`vars.ARRIVALS_MONTHLY_CAP`, default **4200**);
3. `calls_day < min(130, floor((cap − calls_month_before_today) / days_left_in_month_incl_today))` — self-balancing
   when a month runs hot.

Otherwise the run ends without deploying. Extra triggers (backup cron, double dispatches, manual clicks) are
therefore harmless to the quota.

## Triggering: external scheduler (GitHub cron is not usable here)

Measured on this repo (Oct 2026): scheduled runs start **4.5–8.5 h late** (`17 3,13 * * *` ran at 17:52–18:54 and
01:52–05:45 Taipei), while `workflow_dispatch` runs start within seconds. So:

- **Primary:** an external cron (e.g. cron-job.org, free) sends `POST /repos/ancientsky/safetravel/actions/workflows/arrivals.yml/dispatches`
  `{"ref":"main"}` every 10 min, authenticated with a fine-grained PAT limited to this repository with
  **Actions: Read and write** only. The same service can dispatch `update-data.yml` at 11:17 / 21:17 Taipei to fix
  the late daily refresh. Setup steps: `docs/ARRIVALS_SETUP.md`.
- **Backup:** `schedule: '7,37 * * * *'` in `arrivals.yml` (fires late, but the guard keeps it harmless).

## Publishing

`web/data/arrivals.json` is **not committed** (`.gitignore`); it is published straight to GitHub Pages:

- `arrivals.yml` has two jobs. `guard` (no Pages lock, no TDX call) reads the live counters and stops most triggers.
  `publish` (`concurrency: pages`, no cancel) re-reads the counters **under the lock** and re-runs the guard — two
  queued runs can never both spend a call — then fetches, validates, uploads `web/` from a fresh checkout of `main`
  and deploys. The live file is read by `.github/scripts/prev-arrivals.sh`: HTTP 200 + valid JSON or 404 (first run)
  continue; any other outcome skips the run rather than restarting the counters at zero.
- Every other Pages deploy (`deploy-pages.yml`, the deploy job of `update-data.yml`) first copies the live
  `data/arrivals.json` into `web/data/` (no TDX call), so a code or data deploy never drops the board.
- `refresh.js` (page auto-reload) watches `meta.json` only, so the 10-minute arrivals deploys never reload the page.
  The board polls `arrivals.json` itself (every 60 s while open, cache-busting query string).

## `arrivals.json` (contract)

```json
{
  "generated_at": "2026-10-14T18:40:12+08:00",
  "source": "tdx",
  "endpoint": "https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport/Arrival",
  "tdx_updated": "2026-10-14T18:39:58+08:00",
  "window": { "from": "2026-10-14T16:40:00+08:00", "to": "2026-10-14T22:40:00+08:00" },
  "refresh_minutes": { "day": 10, "night": 30 },
  "quota": { "month": "2026-10", "calls_month": 1234, "cap_month": 4200, "day": "2026-10-14", "calls_day": 57 },
  "airports": {
    "TPE": { "name_zh": "桃園", "name_en": "Taoyuan", "lat": 25.0777, "lon": 121.233, "flights": 41,
             "checkpoints": [ {"id": "A", "terminal": "1"}, {"id": "B", "terminal": "1"},
                              {"id": "C", "terminal": "2"}, {"id": "D", "terminal": "2"} ] },
    "TSA": { "name_zh": "松山", "name_en": "Songshan", "lat": 25.0694, "lon": 121.5525, "flights": 6, "checkpoints": [] }
  },
  "flights": [
    {
      "id": "TPE|NRT|2026-10-14T18:05",
      "airport": "TPE",
      "flight": "CI 101", "airline": "CI", "codeshares": ["BR 2101"],
      "from": "NRT", "from_zh": "東京成田", "from_en": "Tokyo Narita", "country": "JP", "lat": 35.7647, "lon": 140.386,
      "terminal": "1", "gate": "A5", "checkpoint": "A", "apron": "",
      "scheduled": "2026-10-14T18:05+08:00", "estimated": "2026-10-14T18:21+08:00", "actual": null,
      "status": "delayed", "status_zh": "延遲", "status_en": "DELAY",
      "aircraft": "A350-900"
    }
  ]
}
```

Rules:
- `generated_at` = run time; `window` = `generated_at − 2 h … + 4 h` (the browser shows now ± 60 min, so a board
  that missed a few refreshes still has data). A flight is in the window when its best time
  (`actual` ‖ `estimated` ‖ `scheduled`; cancelled flights: `scheduled`) is inside it.
- Only passenger flights from **outside Taiwan** (origin country ≠ `TW`; HK/MO/CN count as outside). Origin country
  from `web/data/airports.json`, else the TDX airport list in SQLite (`airports_tdx`), else `""` (kept).
- `lat` / `lon`: origin airport coordinates from `airports.json` (4 decimals), `null` when unknown — the map draws
  arcs from them without downloading the 621 KB airports file.
- Codeshares collapse into one physical flight per (airport, origin, scheduled time): the operating carrier is the row
  with `AcType`, else the lowest flight number; the others go to `codeshares` (sorted). `flight` = `"<AirlineID> <FlightNumber>"`.
- `gate`: trimmed. `checkpoint`: for TPE, the gate's first letter when it is A–D, else `null` (remote stand / not yet
  assigned — the UI shows it under every checkpoint of its terminal). Other airports: `null` and `checkpoints: []`.
- Times: TDX local times + `+08:00`; missing → `null`. `scheduled` is always present.
- `status` ∈ `arrived | on_time | early | delayed | changed | cancelled | other`, from `ArrivalRemarkEn` /
  `ArrivalRemark` (`ARRIV` → arrived, `CANCEL` → cancelled, `DELAY` → delayed, `CHANGE` → changed, `EARLY` → early,
  `ON TIME` → on_time). `status_zh` / `status_en` keep the source wording split at the first Latin letter.
- `airports`: every Taiwan airport with ≥ 1 international arrival anywhere in the fetched payload (so the selector is
  stable), plus TPE always. Short names from the table in `pipeline/arrivals.py`; coordinates from `airports.json`.
  `flights` = count inside `window`.
- `flights` sorted by best time ascending. `quota` carries the guard counters forward (reset on a new month / day).
- File size target < 150 KB.

## UI

- **Toggle:** header button `arrivals-toggle` (plane-landing icon, 「入境航班 / Arrivals」), `aria-pressed`,
  persisted in `localStorage['safetravel.arrivals']`; **default off**.
- **Station deep link** (bookmark per checkpoint / wall screen): `?arr=TPE-C` opens the board for TPE checkpoint C,
  `?arr=KHH` for Kaohsiung; `&big=1` large-type mode for wall displays. URL settings override stored ones.
- **Board content:** airport selector; checkpoint segmented control for TPE (全部 · A·T1 · B·T1 · C·T2 · D·T2);
  freshness line (updated HH:MM, n min ago; amber when older than 2× the refresh interval);
  two sections — **即將抵達 / Arriving** (next 60 min, soonest first) and **已抵達 / Arrived** (past 60 min, latest first).
  Row: big time (actual ‖ estimated, with scheduled struck through when different) + relative minutes; origin city ·
  IATA · country with its **advisory level badge** and its top advisory diseases; flight + codeshare count + aircraft;
  **gate** (large) / terminal / checkpoint; status chip. Clicking a row opens that country's panel; hovering highlights
  its route on the map.
- **Map layer** (while the board is open): arcs from each origin airport to the selected airport, coloured by the
  origin country's level; planes for arriving flights positioned by remaining time; the regular TPE route
  animation is dimmed.
- **Placement** (floating; drag the header to move, position remembered per orientation; "dock" button resets):
  - *Landscape* (default dock **left**): below the search toolbar, full height to the footer; legend and route HUD
    shift right of it. The country panel opens on the right, so board and details are side by side; the left side
    covers Europe/Africa, the regions with the fewest TPE arrivals.
  - *Portrait* (airport wall screens, default dock **top**): full width under the toolbar, ≈ 42 % of the height —
    the map in portrait only fills the middle third, so the board takes the empty band and the map refits below it.
  - *Phone* (≤ 760 px): bottom sheet.
  - Map zooms (spotlight tour, country panel) keep the target country clear of a docked board; in portrait the board
    narrows beside the open country panel so the gate column stays visible.
- **Auto-scroll** (switch on the board, default on, remembered): the list glides down at ≈ 28 px/s, rests 5 s at the
  top and 6 s at the bottom, then returns to the top; it pauses while a mouse is over the list and for 20 s after a
  touch / wheel / click. Reduced-motion users get page-by-page steps instead.
