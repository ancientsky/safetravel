# SafeTravel TW — Operations runbook

Who reads this: the maintainer. Everything here is done from the GitHub web UI or `gh` CLI; no server exists.
Workflow file: `.github/workflows/update-data.yml` (refresh + commit + deploy) · `deploy-pages.yml` (deploy on `web/**` pushes).

Schedule: `cron 17 1,13 * * *` (UTC) = 09:17 and 21:17 Asia/Taipei. Manual runs are always available.

---

## 1. Trigger the workflow manually

Web UI: **Actions → update-data → Run workflow** → choose branch `main` → fill inputs → **Run workflow**.

CLI:

```bash
gh workflow run update-data.yml --ref main            # default inputs
gh workflow run update-data.yml --ref main -f max_calls=60   # cap Gemini calls this run
gh run watch "$(gh run list --workflow update-data.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Inputs:

| Input | Meaning |
|-------|---------|
| `max_calls` | Upper bound on Gemini API calls in this run (backfill throttle). Leave empty for the pipeline default. |

> Note: `docs/ARCHITECTURE.md` currently names this input `backfill_limit`. Whichever name `update-data.yml` actually declares is authoritative; keep the docs and the workflow in sync.

A manual run performs the same steps as the scheduled one (fetch → load → enrich → export → commit `data/` and `web/data/` if changed → deploy Pages).

## 2. Read the Actions logs

- **Find the run**: Actions tab → `update-data` → newest run. Red = failed, yellow/grey = skipped or cancelled.
- **Find the failing step**: expand the `update` job. Steps appear in order: checkout → setup-python → install → `python -m pipeline run` → commit → deploy.
- **Useful grep terms** in the step log: `fetch`, `flights`, `WARN`, `gemini`, `ai:false`, `unmapped`, `Traceback`.
- **Failed step only, from the CLI**:

  ```bash
  gh run list --workflow update-data.yml --limit 5
  gh run view <run-id> --log-failed
  ```

- **Raw artefacts**: the fetcher commits what it downloaded, so the same bytes are in git history:
  `data/raw/*.csv` (alerts and epidemics) and `data/raw/flights/` (flight pages / text). Compare against the log to see whether the upstream content changed or the parser broke.
- **Status snapshot**: `web/data/meta.json` records `generated_at`, per-source `fetched_at` and `rows`, the `flights.ok` flag, and `counts.ai_translated`. If `ai_translated` is 0 or lower than expected, Gemini did not run — check the secret (section 5).

## 3. Flight fetch failed

Symptoms: the log shows a flight warning or error; `web/data/meta.json` has `sources.flights.ok: false`; `web/data/flights.json` still has the previous day's `date`. This is expected to degrade gracefully — the site keeps yesterday's routes — but it should be fixed.

1. **Inspect the saved raw response** in the repo:

   ```bash
   ls -la data/raw/flights/latest/
   head -c 2000 data/raw/flights/latest/*
   ```

   If `latest/` is missing or empty, the download itself failed (network, HTTP status, or an unexpected redirect). Check the log lines around the request URL and status code.

2. **Decide which case you are in**:
   - *HTML changed* (page downloads but parsing finds no rows): the timetable layout changed. Fix the scraper in `pipeline/` against the saved file. You can reproduce offline:
     `python -m pipeline run --offline` uses the committed raw files, so parser fixes can be tested without network access.
   - *Upstream unreachable* (timeout, 403, TLS error): `taoyuan-airport.com` is not reachable from the dev sandbox. Re-run the workflow manually in a few hours; if it keeps failing, use the fallback below.
   - *Fallback feed*: the flight text file `a_flight_v4.txt` (20 comma-separated fields) is published on data.gov.tw (dataset 26194 or 177644). Its URL is discovered at runtime, or can be forced with the `FLIGHT_FILE_URL` environment variable (set it in the workflow `env:` block, not in the repo). Use this only as a temporary measure and document it in the commit message.

3. **Verify the fix**: run `python -m pipeline run --offline` locally, check `web/data/flights.json` has a fresh `date` and non-empty `routes`, then trigger the workflow manually.

4. **Do not hand-edit `web/data/flights.json`.** It is overwritten every run. If the feed is down for days, leaving the last good file in place is the intended behaviour.

## 4. Force a Gemini backfill

Gemini results are cached in SQLite (`data/safetravel.db`) keyed by content hash. A normal run calls Gemini only for items that have no cached result, so repeated runs make steady progress without re-spending quota.

- **Backfill in batches**: run with a cap, e.g. `gh workflow run update-data.yml --ref main -f max_calls=60`. Repeat until the log reports no pending items. Each run commits the newly cached translations.
- **Local backfill** (optional): export the key in the shell only, never write it to a file, and run the pipeline with the same cap. Check `python -m pipeline run --help` for the exact flag name before relying on it.

  ```bash
  export GEMINI_API_KEY='...'               # shell session only
  python -m pipeline run --help             # confirm the cap flag name
  python -m pipeline run                    # add that flag to cap calls
  unset GEMINI_API_KEY
  ```

- **Re-translate specific items** (e.g. after changing the prompt or model): remove their rows from the Gemini cache table in `data/safetravel.db` (see `pipeline/enrich.py` for the table and key), then run the backfill again. Changing `GEMINI_MODEL` does not automatically invalidate old translations — clear the cache if you want the new model everywhere.
- **Per-country overviews** regenerate only when a country's set of item ids changes, so they are cheap to leave alone.
- **Check the result**: `counts.ai_translated` in `web/data/meta.json` should rise; items with `"ai": false` are not yet translated.

## 5. Rotate the Gemini API key

1. In Google AI Studio, create a new API key for the project that owns the Gemini quota.
2. GitHub: **Settings → Secrets and variables → Actions → `GEMINI_API_KEY` → Update secret**. Paste the new key. Do not paste it into issues, PR comments, commit messages or the README.
3. Run the workflow manually (section 1) and confirm in the log that Gemini calls succeed and `counts.ai_translated` is not 0.
4. Revoke/delete the old key in AI Studio.
5. If a key was ever pasted in a log, issue or commit: revoke it immediately, then rotate as above and purge the leak from history if it reached git.

`GEMINI_MODEL` is an optional repository **variable** (not a secret): **Settings → Secrets and variables → Actions → Variables**. Changing it does not require rotating the key.

## 6. Re-run geodata (`pipeline/build_geo.py`)

Geodata is built once and only needs rebuilding when upstream packages or the manual name lists change.

```bash
npm install                               # provides node_modules/world-atlas and world-countries
python pipeline/build_geo.py              # writes web/data/world.json, countries.json, airports.json
git diff --stat web/data/                 # review the change
```

Inputs: `node_modules/world-atlas`, `node_modules/world-countries`, `data/raw/airports.dat` (OpenFlights), `data/manual/country_names.json`.

After a rebuild, commit the three JSON files, open `web/` locally (`python -m http.server -d web 8080`) and check that countries render and flight arcs still land on the right airports. If the `world-atlas` or `world-countries` versions change, update `package.json` deliberately and re-run `npm run vendor` only if the D3 or topojson bundles also changed.

## 7. Site looks stale or broken

- Check the latest `update-data` run is green and that `deploy-pages` (or the deploy job inside `update-data`) completed. Commits made with `GITHUB_TOKEN` do not trigger other workflows, which is why the deploy job also lives inside `update-data.yml`.
- Confirm **Settings → Pages → Source = GitHub Actions**.
- Hard-refresh the browser; GitHub Pages caches for a few minutes.
- Roll back a bad data export by reverting the data commit on `main` and re-running the workflow later — do not edit JSON by hand.

## 8. Dependencies, hash lock and workflow hardening

- `pipeline/requirements.txt` is the human-edited source (loose lower bounds). `pipeline/requirements.lock` is generated from it
  with hashes and is what Actions installs (`pip install --require-hashes -r pipeline/requirements.lock`). CI additionally installs
  `requirements-dev.txt` normally. Regenerate after editing `requirements.txt` (use Python 3.12 to match the workflows) and commit both:

  ```bash
  pip install pip-tools
  pip-compile --generate-hashes --output-file pipeline/requirements.lock pipeline/requirements.txt
  ```

  Dependabot (`.github/dependabot.yml`) opens weekly PRs for `github-actions` and for `pip` in `/pipeline`; for pip, regenerate the lock
  on the PR branch before merging.
- All actions are pinned to a commit SHA with the version in a trailing comment; Dependabot bumps both.
- Token scope: `update-data.yml` has `permissions: {}` at workflow level; the `update` job gets only `contents: write`, the `deploy` job
  `contents: read, pages: write, id-token: write`. The checkout uses `persist-credentials: false`; the token is wired into the git remote
  only inside the "Commit and push" step.
- The push step retries up to 3 times. After each `git pull --rebase -X theirs` it re-runs `python -m pipeline export` and
  `python -m pipeline validate` and commits any difference before pushing again (the SQLite file has two writers and cannot be merged).
- `deploy-pages.yml` runs `python -m pipeline validate` before uploading `web/`, so hand edits or routine pushes with invalid
  `web/data` are not deployed.
- Fetch safeguards: HTTP bodies are capped at 50 MB (`http.get(max_bytes=...)`); a CSV with a malformed/oversized field is rejected like any
  other bad download (previous file kept); URLs discovered in data.gov.tw responses must be https on `data.gov.tw`,
  `www.taoyuan-airport.com` or `odp.taoyuan-airport.com`; `FLIGHT_FILE_URL` must be https (or a `file:` path for tests). The Gemini key is sent in the
  `x-goog-api-key` header, never in the URL. Epidemic `url` values are exported only if https on `cdc.gov.tw` (or a subdomain), otherwise
  `""`; `validate` fails on any other non-empty URL.

## 9. Quick reference

| Task | Command / location |
|------|--------------------|
| Manual refresh | `gh workflow run update-data.yml --ref main` |
| Failed step log | `gh run view <id> --log-failed` |
| Flight raw data | `data/raw/flights/latest/` |
| Pipeline status | `web/data/meta.json` |
| Gemini key | repo secret `GEMINI_API_KEY` |
| Model override | repo variable `GEMINI_MODEL` |
| Geodata rebuild | `python pipeline/build_geo.py` (after `npm install`) |
| Offline test | `python -m pipeline run --offline` |
| Regenerate dependency lock | `pip-compile --generate-hashes --output-file pipeline/requirements.lock pipeline/requirements.txt` |
