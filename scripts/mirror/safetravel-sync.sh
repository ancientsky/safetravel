#!/usr/bin/env bash
# SafeTravel TW — intranet mirror sync (docs/MIRROR.md).
#
# Copies the already-built site from GitHub — web/ of the main branch, plus the live data/arrivals.json that only
# exists on GitHub Pages — into a new release directory, checks it, and switches the directory nginx serves with
# an atomic rename. It never contacts the original data sources (Taiwan CDC, MOFA/BOCA, MAC, TDX, CWA): GitHub
# Actions stays the only fetcher, and no API key lives on this machine.
#
#   safetravel-sync.sh             one sync; nothing is rebuilt when GitHub has nothing new
#                                  (run every 5 minutes by safetravel-sync.timer)
#   safetravel-sync.sh --check     monitoring (Nagios/Zabbix style): exit 0 OK, 1 WARNING, 2 CRITICAL
#   safetravel-sync.sh --rollback  serve the previous release again (until GitHub publishes something new)
#
# Settings: /etc/safetravel/mirror.env (see mirror.env.example), or the file named by $SAFETRAVEL_CONF.
# Needs: bash, git >= 2.27, curl, rsync, python3 (any 3.x; JSON checks only), flock, GNU coreutils.
set -Eeuo pipefail
umask 022

CONF=${SAFETRAVEL_CONF:-/etc/safetravel/mirror.env}
# shellcheck source=/dev/null
if [ -r "$CONF" ]; then set -a; . "$CONF"; set +a; fi   # exported, so HTTPS_PROXY etc. reach git and curl

REPO_URL=${REPO_URL:-https://github.com/ancientsky/safetravel.git}
BRANCH=${BRANCH:-main}
SITE_URL=${SITE_URL:-https://ancientsky.github.io/safetravel}
BASE=${BASE:-/srv/safetravel}
KEEP_RELEASES=${KEEP_RELEASES:-12}
HTTP_TIMEOUT=${HTTP_TIMEOUT:-60}
WARN_AFTER_MIN=${WARN_AFTER_MIN:-30}      # --check: last successful sync older than this -> WARNING
CRIT_AFTER_MIN=${CRIT_AFTER_MIN:-120}     #                                                 -> CRITICAL
DATA_WARN_HOURS=${DATA_WARN_HOURS:-26}    # --check: data/meta.json older than this -> WARNING (upstream stalled)

REPO=$BASE/repo            # sparse, shallow git checkout (web/ only)
RELEASES=$BASE/releases    # one directory per published version, unchanged files hard-linked
WWW=$BASE/www              # nginx root; WWW/safetravel -> ../releases/<name>
LIVE=$WWW/safetravel
STATE=$BASE/state          # status.json, last arrivals.json, deployed fingerprint, lock
TMP=$BASE/tmp              # same filesystem as releases (atomic renames)

log()  { echo "safetravel-sync: $*"; }
warn() { echo "safetravel-sync: WARNING: $*" >&2; }

COMMIT=""
RELEASE_NAME=""

# status.json (also served read-only by nginx at /safetravel/_mirror/status.json) — written atomically.
write_status() { # write_status <ok|error> <message>
  python3 - "$STATE/status.json" "$1" "$2" "$COMMIT" "$LIVE" "$REPO_URL" "$SITE_URL" <<'PY' || true
import json, os, sys, time
path, result, msg, commit, live, repo, site = sys.argv[1:8]
now = time.strftime('%Y-%m-%dT%H:%M:%S%z')
try:
    with open(path, encoding='utf-8') as f:
        st = json.load(f)
except Exception:
    st = {}
def generated_at(rel):
    try:
        with open(os.path.join(live, rel), encoding='utf-8') as f:
            return json.load(f).get('generated_at')
    except Exception:
        return None
st.update(last_attempt=now, result=result, message=msg, source={'repo': repo, 'site': site})
if result == 'ok':
    st['last_success'] = now
if commit:
    st['commit'] = commit
st['release'] = os.path.basename(os.path.realpath(live)) if os.path.exists(live) else None
st['data_generated_at'] = generated_at('data/meta.json')
st['arrivals_generated_at'] = generated_at('data/arrivals.json')
tmp = path + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(st, f, ensure_ascii=False, indent=2)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

fail() {
  trap - ERR
  echo "safetravel-sync: ERROR: $*" >&2
  write_status error "$*"
  exit 1
}
trap 'fail "unexpected failure at line $LINENO (see the journal)"' ERR

json_ok() { # json_ok <file> [required-top-level-key]
  python3 - "$1" "${2:-}" <<'PY' 2>/dev/null
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    d = json.load(f)
if sys.argv[2] and not (isinstance(d, dict) and sys.argv[2] in d):
    sys.exit(1)
PY
}

need_tools() {
  local t
  for t in git curl rsync python3 flock sha256sum; do
    command -v "$t" >/dev/null 2>&1 || fail "missing command: $t"
  done
}

# ------------------------------------------------------------------ git: web/ of main, shallow + sparse + blob-less
clone_repo() {
  rm -rf "$REPO"
  git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$BRANCH" "$REPO_URL" "$REPO"
  git -C "$REPO" sparse-checkout set web
}
update_repo() {
  git -C "$REPO" remote set-url origin "$REPO_URL"
  git -C "$REPO" fetch --quiet --depth 1 origin "$BRANCH"
  git -C "$REPO" reset --quiet --hard FETCH_HEAD
  git -C "$REPO" gc --auto --quiet || true
}
sync_repo() {
  if [ -d "$REPO/.git" ]; then
    update_repo || { warn "git update failed; cloning again"; clone_repo; }
  else
    clone_repo
  fi
  COMMIT=$(git -C "$REPO" rev-parse HEAD)
  [ -s "$REPO/web/index.html" ] || fail "checkout has no web/index.html"
}

# ------------------------------------------------------------------ arrivals.json: only on GitHub Pages (not in git)
fetch_arrivals() {
  local out=$TMP/arrivals.json
  if curl -fsS --max-time "$HTTP_TIMEOUT" --retry 2 --retry-delay 5 -H 'Cache-Control: no-cache' \
       -o "$out" "$SITE_URL/data/arrivals.json?t=$(date +%s)" && json_ok "$out" flights; then
    mv -f "$out" "$STATE/arrivals.json"
  else
    rm -f "$out"
    if [ -f "$STATE/arrivals.json" ]; then warn "arrivals.json not refreshed; keeping the previous copy"
    else warn "arrivals.json unavailable; the arrivals board stays empty until it can be downloaded"; fi
  fi
}

fingerprint() {
  {
    echo "$COMMIT"
    if [ -f "$STATE/arrivals.json" ]; then sha256sum < "$STATE/arrivals.json"; fi
  } | sha256sum | cut -c1-64
}

# ------------------------------------------------------------------ release: build, check, switch, prune
check_release() { # check_release <dir>
  local d=$1 f
  for f in index.html trip.html slide.html arrivals.html m.html app.js styles.css data/meta.json data/epidemics.json data/alerts.json \
           data/world.json slides/slides.json; do
    [ -s "$d/$f" ] || { warn "release is missing $f"; return 1; }
  done
  python3 - "$d" <<'PY'
import json, os, sys
bad = []
for root, _, files in os.walk(sys.argv[1]):
    for n in files:
        if n.endswith('.json'):
            p = os.path.join(root, n)
            try:
                with open(p, encoding='utf-8') as f:
                    json.load(f)
            except Exception as e:
                bad.append('%s: %s' % (p, e))
if bad:
    sys.stderr.write('invalid JSON:\n  ' + '\n  '.join(bad[:10]) + '\n')
    sys.exit(1)
PY
}

# version.json: open pages (web/js/autoreload.js) reload when "code" changes. Same hash as the GitHub deploys
# compute (.github/scripts/stamp-version.sh): the site's code files only, data left out — keep the two in step.
# Written as a new file + rename: release files may be hard links shared with older releases.
stamp_version() { # stamp_version <release dir>
  local code
  code=$(git -C "$REPO" ls-tree -r HEAD -- web | grep -vE $'\tweb/(data|slides)/|\tweb/version\\.json$' | sha256sum | cut -c1-16)
  printf '{"code": "%s", "commit": "%s"}\n' "$code" "$COMMIT" > "$1/version.json.new"
  mv -f "$1/version.json.new" "$1/version.json"
}

switch_to() { # switch_to <release name>: rename(2) over the symlink, so a request sees the old or the new tree
  ln -sfn "../releases/$1" "$WWW/.safetravel.new"
  mv -Tf "$WWW/.safetravel.new" "$LIVE"
}

build_release() {
  local prev="" new
  if [ -e "$LIVE" ]; then prev=$(readlink -f "$LIVE"); fi
  RELEASE_NAME=$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:7}
  new=$RELEASES/$RELEASE_NAME
  rm -rf "$TMP/release"
  # unchanged files become hard links to the previous release: a new release costs almost no disk or time
  rsync -a --exclude='.git*' ${prev:+--link-dest="$prev"} "$REPO/web/" "$TMP/release/"
  if [ -f "$STATE/arrivals.json" ]; then
    rm -f "$TMP/release/data/arrivals.json"   # never write through a hard link into an older release
    install -m 644 "$STATE/arrivals.json" "$TMP/release/data/arrivals.json"
  fi
  stamp_version "$TMP/release"
  check_release "$TMP/release" || { rm -rf "$TMP/release"; fail "new release failed its checks; still serving $(basename "${prev:-none}")"; }
  mv "$TMP/release" "$new"
  switch_to "$RELEASE_NAME"
  fingerprint > "$STATE/deployed.fp"
}

prune_releases() {
  local live d
  live=$(readlink -f "$LIVE" 2>/dev/null || true)
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | head -n -"$KEEP_RELEASES" |
    while read -r d; do
      if [ -n "$d" ] && [ "$RELEASES/$d" != "$live" ]; then rm -rf -- "${RELEASES:?}/$d"; fi
    done
}

# ------------------------------------------------------------------ modes
do_sync() {
  need_tools
  mkdir -p "$REPO" "$RELEASES" "$WWW" "$STATE" "$TMP"
  exec 9>"$STATE/sync.lock"
  flock -n 9 || { log "another sync is still running; skipping this one"; exit 0; }

  sync_repo
  fetch_arrivals
  if [ -e "$LIVE" ] && [ "$(fingerprint)" = "$(cat "$STATE/deployed.fp" 2>/dev/null)" ]; then
    write_status ok "up to date (${COMMIT:0:7})"
    touch "$STATE/last_success"
    log "up to date (${COMMIT:0:7})"
    return
  fi
  build_release
  prune_releases
  write_status ok "published $RELEASE_NAME"
  touch "$STATE/last_success"
  log "published $RELEASE_NAME"
}

do_rollback() {
  exec 9>"$STATE/sync.lock"
  flock -w 120 9 || fail "a sync is running; try again"
  local cur prev
  cur=$(basename "$(readlink -f "$LIVE")")
  prev=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | awk -v c="$cur" '$0 < c' | tail -n 1)
  [ -n "$prev" ] || fail "no release older than $cur"
  switch_to "$prev"
  write_status ok "rolled back from $cur to $prev"
  log "now serving $prev (was $cur). The next change on GitHub is published as usual;"
  log "to hold this version, stop the timer: systemctl stop safetravel-sync.timer"
}

do_check() {
  trap - ERR
  local now age code=0 msg=() gen gen_s hours
  now=$(date +%s)
  if [ ! -f "$STATE/last_success" ]; then
    echo "CRITICAL - SafeTravel mirror has never synced successfully"; exit 2
  fi
  age=$(( (now - $(stat -c %Y "$STATE/last_success")) / 60 ))
  if   [ "$age" -ge "$CRIT_AFTER_MIN" ]; then code=2; msg+=("last successful sync ${age} min ago")
  elif [ "$age" -ge "$WARN_AFTER_MIN" ]; then code=1; msg+=("last successful sync ${age} min ago")
  else msg+=("synced ${age} min ago"); fi
  gen=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("generated_at",""))' "$LIVE/data/meta.json" 2>/dev/null || true)
  if gen_s=$(date -d "$gen" +%s 2>/dev/null); then
    hours=$(( (now - gen_s) / 3600 ))
    msg+=("data ${hours} h old")
    if [ "$hours" -ge "$DATA_WARN_HOURS" ] && [ "$code" -lt 1 ]; then code=1; msg+=("(upstream update stalled?)"); fi
  else
    [ "$code" -lt 1 ] && code=1; msg+=("data/meta.json unreadable")
  fi
  msg+=("release $(basename "$(readlink -f "$LIVE" 2>/dev/null)")")
  local label=OK; [ "$code" = 1 ] && label=WARNING; [ "$code" = 2 ] && label=CRITICAL
  echo "$label - SafeTravel mirror: ${msg[*]}"
  exit "$code"
}

case "${1:-}" in
  "")          do_sync ;;
  --check)     do_check ;;
  --rollback)  do_rollback ;;
  -h|--help)   sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)           echo "usage: $0 [--check | --rollback | --help]" >&2; exit 64 ;;
esac
