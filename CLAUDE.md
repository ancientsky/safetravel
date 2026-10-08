# SafeTravel TW

Static GitHub Pages dashboard of Taiwan CDC travel-health advisories with an animated TPE flight map.
Read `docs/ARCHITECTURE.md` and `docs/DATA_CONTRACT.md` before changing anything.

## Ground rules

- Default branch is `main`; commit and push directly to `main`. No feature branches, no PRs.
- No network from the dev sandbox to `cdc.gov.tw`, `taoyuan-airport.com`, `data.gov.tw`. Develop against fixtures in `data/raw/` and run real fetches only in GitHub Actions.
- `web/` must stay a build-free static site (ES modules, vendored libs in `web/vendor/`). It is served from a sub-path (`/safetravel/`), so use relative URLs only.
- Everything user-facing is bilingual (`zh-Hant` default, `en`) and themed (`dark` default: black/green; `light`).
- Never read CSVs with pandas defaults: `keep_default_na=False` (Namibia = `NA`). Normalize text with NFKC.
- Pipeline must be idempotent and work with **no** `GEMINI_API_KEY` (degraded, `ai:false`).
- Do not put model identifiers or AI attribution in code comments or commit messages beyond the standard trailer.

## Commands

```bash
python -m pip install -r pipeline/requirements.txt    # Actions install the hash-locked pipeline/requirements.lock
python -m pipeline run --offline          # fixtures only, no network, no Gemini
python -m pipeline run                    # full run (Actions)
python -m pipeline export                 # re-export JSON from sqlite
python pipeline/build_geo.py              # rebuild web/data/world.json, airports.json, countries.json
python -m http.server -d web 8080         # preview site
```
