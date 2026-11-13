#!/usr/bin/env bash
# Tests for the scripts that decide what gets published (.github/scripts/): deployable-ref.sh, live-commit.sh and
# check-data-commit.sh. Builds a throw-away git repository and a throw-away "published site" (a local web server that
# serves version.json), then plays the situations the workflows meet.
#
#   bash tests/deploy-scripts.test.sh        needs bash, git, curl, python3; no network
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d)
SERVER=""
cleanup() { [ -z "$SERVER" ] || kill "$SERVER" 2>/dev/null || true; rm -rf "$W"; }
trap cleanup EXIT
export NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
no() { echo "FAIL  $1 — $2"; fail=$((fail + 1)); }
expect() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "got '$2', wanted '$3'"; fi; }

# ---- a repository like ours: site code, data, the scripts
O=$W/origin
git init -q -b main "$O"
git -C "$O" config user.name t; git -C "$O" config user.email t@example.invalid
git -C "$O" config uploadpack.allowAnySHA1InWant true      # GitHub serves any reachable commit by id; so does this one
mkdir -p "$O/web/data" "$O/data" "$O/.github/scripts" "$O/docs"
cp "$ROOT"/.github/scripts/{deployable-ref,live-commit,check-data-commit}.sh "$O/.github/scripts/"
echo 'console.log(1)' > "$O/web/app.js"; echo '{"n":1}' > "$O/web/data/meta.json"; echo db1 > "$O/data/safetravel.db"; echo doc > "$O/docs/a.md"
commit() { git -C "$O" add -A; git -C "$O" commit -q -m "$1"; git -C "$O" rev-parse HEAD; }
C0=$(commit "site: first version")

# ---- the published site
mkdir -p "$W/site"
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server --bind 127.0.0.1 --directory "$W/site" "$PORT" >/dev/null 2>&1 &
SERVER=$!
SITE=http://127.0.0.1:$PORT
for _ in $(seq 1 50); do curl -s -o /dev/null "$SITE/" && break; sleep 0.1; done
publish() { printf '{"code": "x", "commit": "%s"}\n' "$1" > "$W/site/version.json"; }
# ...and a stand-in for the two GitHub API answers the script asks for (same local server, canned files)
export GITHUB_REPOSITORY=o/r GITHUB_API_URL=$SITE/api
API=$W/site/api/repos/o/r
mkdir -p "$API/actions/workflows/deploy-pages.yml" "$API/compare"
ran() { if [ -n "${1:-}" ]; then printf '{"workflow_runs": [{"head_sha": "%s"}]}\n' "$1" > "$API/actions/workflows/deploy-pages.yml/runs"; else rm -f "$API/actions/workflows/deploy-pages.yml/runs"; fi; }
# what GitHub's compare answers for two commits of the test repository (b seen from a)
relate() {
  local a=$1 b=$2 s
  if [ "$a" = "$b" ]; then s=identical
  elif git -C "$O" merge-base --is-ancestor "$a" "$b" 2>/dev/null; then s=ahead
  elif git -C "$O" merge-base --is-ancestor "$b" "$a" 2>/dev/null; then s=behind
  else s=diverged; fi
  printf '{"status": "%s"}\n' "$s" > "$API/compare/$a...$b"
}

# run deployable-ref.sh the way a workflow does: a fresh shallow checkout of main
decide() { # -> "ok mode commit head-after file-content"
  rm -rf "$W/work" "$W/out" "$API/compare"; mkdir -p "$API/compare"
  local l r
  l=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("commit", ""))' "$W/site/version.json" 2>/dev/null || true)
  r=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["workflow_runs"][0]["head_sha"])' "$API/actions/workflows/deploy-pages.yml/runs" 2>/dev/null || true)
  if [[ "$l" =~ ^[0-9a-f]{40}$ ]] && [[ "$r" =~ ^[0-9a-f]{40}$ ]] && git -C "$O" cat-file -e "$l" 2>/dev/null; then relate "$l" "$r"; fi
  git clone -q --depth 1 "file://$O" "$W/work"
  ( cd "$W/work" && GITHUB_OUTPUT=$W/out .github/scripts/deployable-ref.sh "$SITE" >"$W/log" 2>&1 )
  local k v okv="" mode="" commit=""
  while IFS='=' read -r k v; do case "$k" in ok) okv=$v ;; mode) mode=$v ;; commit) commit=$v ;; esac; done < "$W/out"
  echo "$okv $mode $commit $(git -C "$W/work" rev-parse HEAD) $(cat "$W/work/web/app.js")"
}

echo "== deployable-ref.sh"
publish "$C0"; ran "$C0"
expect "main is what is live: publish main" "$(decide)" "true main $C0 $C0 console.log(1)"

echo '{"n":2}' > "$O/web/data/meta.json"; echo db2 > "$O/data/safetravel.db"
D1=$(commit "data: refresh")
expect "only data changed since the live version: publish main" "$(decide)" "true main $D1 $D1 console.log(1)"

publish "$D1"
echo 'console.log(2)' > "$O/web/app.js"
C2=$(commit "site: new code, not yet through Deploy Pages")
expect "code changed since the live version: publish the live commit again" "$(decide)" "true checked $D1 $D1 console.log(1)"
if grep -q '::warning title=Publishing the last checked version' "$W/log" && grep -q '  web/app.js' "$W/log"; then ok "…and the run says why, naming the file"; else no "warning text" "$(cat "$W/log")"; fi

echo '{"n":3}' > "$O/web/data/meta.json"
D3=$(commit "data: refresh")
expect "unpublished code plus newer data: still the live commit" "$(decide)" "true checked $D1 $D1 console.log(1)"

echo doc2 > "$O/docs/a.md"
C4=$(commit "docs only")
expect "a docs-only change also waits for Deploy Pages" "$(decide | cut -d' ' -f1-3)" "true checked $D1"

publish "$C4"; ran "$C4"
expect "Deploy Pages published it: publish main again" "$(decide)" "true main $C4 $C4 console.log(2)"

# the two sources can each lag for a moment after a deploy; a stale one must not pull the site back
publish "$D1"; ran "$C4"
expect "version.json still shows the older commit, the run record is newer: publish main (no step back)" "$(decide)" "true main $C4 $C4 console.log(2)"
publish "$C4"; ran "$C0"
expect "the run record lags, version.json is newer: publish main" "$(decide)" "true main $C4 $C4 console.log(2)"
publish "$D1"; ran ""
expect "no run record at all: go by version.json" "$(decide | cut -d' ' -f1-3)" "true checked $D1"
rm -f "$W/site/version.json"; ran "$C4"
expect "version.json unreadable, run record there: go by the run record" "$(decide | cut -d' ' -f1-3)" "true main $C4"

rm -f "$W/site/version.json"; ran ""
expect "neither source readable: publish nothing" "$(decide | cut -d' ' -f1)" "false"
printf '{"code": "dev"}\n' > "$W/site/version.json"
expect "version.json without a commit, no run record: publish nothing" "$(decide | cut -d' ' -f1)" "false"
publish "0123456789abcdef0123456789abcdef01234567"
expect "published commit unknown to the repository: publish nothing" "$(decide | cut -d' ' -f1)" "false"
printf '{"commit": "main; rm -rf /"}\n' > "$W/site/version.json"
expect "version.json with something that is not a commit id: publish nothing" "$(decide | cut -d' ' -f1)" "false"
# a rewritten history: the live commit and the run's commit are no longer on one line
git -C "$O" checkout -q -b side "$C0"; echo side > "$O/docs/a.md"; SIDE=$(commit "side branch"); git -C "$O" checkout -q main
publish "$SIDE"; ran "$C4"
expect "live commit and run commit on different histories: publish nothing" "$(decide | cut -d' ' -f1)" "false"
publish "$C4"; ran "$C4"

echo "== check-data-commit.sh"
check() { ( cd "$O" && .github/scripts/check-data-commit.sh "$1" "$2" >"$W/log" 2>&1 && echo pass || echo refused ); }
expect "data commit that only touches data" "$(check "$C0" "$D1")" "pass"
expect "ordinary commit that touches code" "$(check "$D1" "$C2")" "pass"

echo 'console.log("injected")' > "$O/web/app.js"; echo '{"n":4}' > "$O/web/data/meta.json"
B5=$(commit "data: refresh")
expect "data commit that also changes site code" "$(check "$C4" "$B5")" "refused"
if grep -q '  web/app.js' "$W/log" && ! grep -q 'web/data/meta.json' "$W/log"; then ok "…naming the file outside data/ only"; else no "error text" "$(cat "$W/log")"; fi

echo doc3 > "$O/docs/a.md"
C6=$(commit "docs: unrelated later push")
expect "a later unrelated push, checked from the live version: still refused" "$(check "$C4" "$C6")" "refused"
expect "(checked from the previous push only, it would have slipped through)" "$(check "$B5" "$C6")" "pass"

echo 'console.log(2)' > "$O/web/app.js"
C7=$(commit "revert the code change of the data commit")
expect "the change was reverted: passes" "$(check "$C4" "$C7")" "pass"
if grep -q '::notice::data commit' "$W/log"; then ok "…with a notice"; else no "notice text" "$(cat "$W/log")"; fi

echo "x" > "$O/.github/scripts/extra.sh"; echo '{"n":5}' > "$O/web/data/meta.json"
B8=$(commit "data: adds a script")
git -C "$O" rm -q .github/scripts/extra.sh
C9=$(commit "remove the added script")
expect "a file a data commit added, removed again: passes" "$(check "$C7" "$C9")" "pass"
expect "…and is refused while it is there" "$(check "$C7" "$B8")" "refused"

echo
echo "deploy scripts: $((pass + fail)) checks, $pass passed, $fail failed"
[ "$fail" = 0 ]
