#!/usr/bin/env bash
# Download the published arrivals.json (it carries the TDX usage counters) without any TDX call.
# Writes ok=true to $GITHUB_OUTPUT when the counters are trustworthy: HTTP 200 with valid JSON, or HTTP 404
# (nothing published yet: start from zero). Any other outcome (network error, 5xx, corrupt file) gives ok=false so
# the run is skipped instead of restarting the counters at zero and overspending the quota.
set -u
base="$1"; out="$2"
code=$(curl -sS -m 30 -o "$out" -w '%{http_code}' "${base%/}/data/arrivals.json?t=$(date +%s)" || echo 000)
ok=false
if [ "$code" = "200" ] && python3 -m json.tool "$out" >/dev/null 2>&1; then
  ok=true
elif [ "$code" = "404" ]; then
  rm -f "$out"; ok=true
else
  rm -f "$out"; echo "::warning::could not read the published arrivals.json (HTTP $code): skipping this run"
fi
echo "published arrivals.json: HTTP $code, counters usable: $ok"
echo "ok=$ok" >> "${GITHUB_OUTPUT:-/dev/null}"
