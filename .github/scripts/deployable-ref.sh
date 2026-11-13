#!/usr/bin/env bash
# Decides what a deploy outside deploy-pages.yml may publish, and checks it out.
#
# Site code reaches the public site through one door only: deploy-pages.yml, whose build job runs the checks
# (data-commit rule, data validation, poster manifest, d3 subset, malaria dose table, no symbolic links). The other
# deploys — the arrivals board every 10 minutes, the data refresh twice a day — exist to publish data. They used to
# publish whatever main held, so a commit that failed the checks went live with the next arrivals run anyway.
#
# The "checked version" is the newer of two commits:
#   - the one that is live now (version.json on the site, stamped by every deploy), and
#   - the one of the last successful Deploy Pages run (GitHub's own record).
# Two sources because either can lag for a moment right after a deploy; taking the newer one means a stale answer
# can never pull the site back to older code.
#
# Rule: compare main with the checked version.
#   - same commit, or main differs from it only under data/ and web/data/  ->  publish main
#   - anything else changed (code that deploy-pages.yml has not published yet, or refused)  ->  publish the checked
#     version; this run only adds its fresh data file. deploy-pages.yml brings the new code once it passes.
#   - no checked version can be determined  ->  publish nothing this time (ok=false); the next run tries again.
#
# Run from the repository root with main checked out. Step outputs: ok=true|false, mode=main|checked, commit=<sha>.
# Environment: GITHUB_REPOSITORY, GITHUB_API_URL (both set by Actions), GH_TOKEN (needs actions: read, contents: read).
#
#   deployable-ref.sh <site base URL>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out() { echo "$1" >> "${GITHUB_OUTPUT:-/dev/null}"; }
nothing() { echo "::warning title=Nothing published this time::$1"; out "ok=false"; exit 0; }

api() { # api <path under /repos/<owner>/<repo>/>  -> body, or nothing when the call fails
  local auth=()
  [ -z "${GH_TOKEN:-}" ] || auth=(-H "Authorization: Bearer ${GH_TOKEN}")
  curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' "${auth[@]}" \
    "${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY}/$1" 2>/dev/null || true
}
last_checked_run() { # commit of the newest successful Deploy Pages run on main, or nothing
  api 'actions/workflows/deploy-pages.yml/runs?branch=main&status=success&per_page=1' | python3 -c '
import json, re, sys
try:
    c = str(json.load(sys.stdin)["workflow_runs"][0]["head_sha"])
except Exception:
    c = ""
print(c if re.fullmatch(r"[0-9a-f]{40}", c) else "")' 2>/dev/null || true
}
relation() { # relation <a> <b>: how b stands to a — ahead | behind | identical | diverged, or nothing
  api "compare/$1...$2" | python3 -c '
import json, sys
try:
    s = str(json.load(sys.stdin).get("status", ""))
except Exception:
    s = ""
print(s if s in ("ahead", "behind", "identical", "diverged") else "")' 2>/dev/null || true
}

head=$(git rev-parse HEAD)
live=$("$here/live-commit.sh" "$1")
run=$(last_checked_run)

base=$live
if [ -n "$live" ] && [ -n "$run" ] && [ "$live" != "$run" ]; then
  case "$(relation "$live" "$run")" in
    ahead)    base=$run ;;     # Deploy Pages has published something newer than the version.json we were served
    behind|identical) ;;       # the live commit is the Deploy Pages one plus later data commits
    diverged) nothing "the live commit ${live:0:7} and the last Deploy Pages commit ${run:0:7} are on different histories" ;;
    *)        ;;               # the comparison is unavailable: go by the live commit
  esac
elif [ -z "$live" ]; then
  base=$run
fi
[ -n "$base" ] || nothing "could not read the published version (${1%/}/version.json) or the last Deploy Pages run"
echo "live ${live:0:7}  last Deploy Pages run ${run:0:7}  checked version ${base:0:7}  main ${head:0:7}"

if [ "$base" = "$head" ]; then
  echo "main ${head:0:7} is the checked version"
  out "ok=true"; out "mode=main"; out "commit=$head"
  exit 0
fi
if ! git cat-file -e "${base}^{commit}" 2>/dev/null && ! git fetch --quiet --depth=1 origin "$base" 2>/dev/null; then
  nothing "the checked commit ${base:0:7} is not in this repository"
fi
outside=$(git -c core.quotepath=off diff --name-only "$base" "$head" | grep -vE '^(data/|web/data/)' || true)
if [ -z "$outside" ]; then
  echo "main ${head:0:7} differs from the checked ${base:0:7} only in data files: publishing main"
  out "ok=true"; out "mode=main"; out "commit=$head"
  exit 0
fi
n=$(printf '%s\n' "$outside" | wc -l)
echo "::warning title=Publishing the last checked version::main ${head:0:7} has $n changed file(s) outside data/ and web/data/ that Deploy Pages has not published. Staying on ${base:0:7} until its checks pass."
printf '%s\n' "$outside" | head -n 20 | sed 's/^/  /'
git checkout --quiet --detach "$base"
out "ok=true"; out "mode=checked"; out "commit=$base"
