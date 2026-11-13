#!/usr/bin/env bash
# Prints the commit the published site was built from (<site>/version.json, key "commit"), or nothing when it cannot
# be read. Every deploy stamps that file (.github/scripts/stamp-version.sh), so this is "the version that is live".
#
#   live-commit.sh <site base URL>
set -euo pipefail
base=${1%/}
for attempt in 1 2 3; do
  if body=$(curl -fsS --max-time 20 "${base}/version.json?t=$(date +%s)${attempt}" 2>/dev/null); then
    sha=$(printf '%s' "$body" | python3 -c '
import json, re, sys
try:
    c = str(json.load(sys.stdin).get("commit", ""))
except Exception:
    c = ""
print(c if re.fullmatch(r"[0-9a-f]{40}", c) else "")' 2>/dev/null || true)
    if [ -n "$sha" ]; then echo "$sha"; exit 0; fi
  fi
  [ "$attempt" = 3 ] || sleep $((attempt * 3))
done
exit 0
