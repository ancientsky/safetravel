#!/usr/bin/env bash
# Writes web/version.json for a deploy: {"code": <hash of the site's code files>, "commit": <sha>}.
# Open pages poll it (web/js/autoreload.js, web/js/refresh.js) and reload themselves when "code" changes, so kiosks
# pick up new page code without anyone touching them. Data (web/data/, web/slides/) is left out of the hash: data
# refreshes are detected separately (data/meta.json) and must not reload the poster carousel twice a day.
# The committed web/version.json says "dev" (local preview never reloads).
# Run from the repository root after checkout. The intranet mirror computes the same hash
# (scripts/mirror/safetravel-sync.sh, stamp_version) — keep the two in step.
set -euo pipefail
code=$(git ls-tree -r HEAD -- web | grep -vE $'\tweb/(data|slides)/|\tweb/version\\.json$' | sha256sum | cut -c1-16)
printf '{"code": "%s", "commit": "%s"}\n' "$code" "$(git rev-parse HEAD)" > web/version.json
cat web/version.json
