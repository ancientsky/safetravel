#!/usr/bin/env bash
# SafeTravel TW — intranet mirror sync (docs/MIRROR.md).
#
# Copies the already-built site from GitHub — web/ of the commit the public site is serving, plus the live
# data/arrivals.json that only exists on GitHub Pages — into a new release directory, checks it, and switches the
# directory nginx serves with an atomic rename. It never contacts the original data sources (Taiwan CDC, MOFA/BOCA,
# MAC, TDX, CWA): GitHub Actions stays the only fetcher, and no API key lives on this machine.
#
# Which commit: the one named in <SITE_URL>/version.json, i.e. what GitHub Pages publishes after its checks
# (FOLLOW=published, the default). So the mirror never runs ahead of the public site with code that has not passed
# the checks there. FOLLOW=branch takes the tip of $BRANCH instead, as older versions of this script did.
#
#   safetravel-sync.sh             one sync; nothing is rebuilt when GitHub has nothing new
#                                  (run every 5 minutes by safetravel-sync.timer)
#   safetravel-sync.sh --check     monitoring (Nagios/Zabbix style): exit 0 OK, 1 WARNING, 2 CRITICAL
#   safetravel-sync.sh --rollback  serve the previous release again (until GitHub publishes something new)
#   safetravel-sync.sh --selftest  check this host: tools, the atomic switch, pruning, and that GitHub is reachable
#                                  (works in a temporary directory; the live site is not touched)
#
# Settings: /etc/safetravel/mirror.env (see mirror.env.example), or the file named by $SAFETRAVEL_CONF.
# Needs: bash, git >= 2.27, curl, rsync, python3 (3.7+), flock, find (GNU findutils) and basic coreutils.
# The steps that must behave identically everywhere — the atomic switch, date arithmetic — are done in python3,
# so GNU coreutils and the Rust coreutils of Ubuntu 25.10+ / 26.04 both work.
set -Eeuo pipefail
umask 022

CONF=${SAFETRAVEL_CONF:-/etc/safetravel/mirror.env}
# shellcheck source=/dev/null
if [ -r "$CONF" ]; then set -a; . "$CONF"; set +a; fi   # exported, so HTTPS_PROXY etc. reach git and curl
# Every path below is absolute. Started with "sudo -u safetravel" from an admin's home directory, the working
# directory is one this user cannot enter, and find then complains that it cannot return to it: work from /.
cd / 2>/dev/null || true

REPO_URL=${REPO_URL:-https://github.com/ancientsky/safetravel.git}
BRANCH=${BRANCH:-main}
SITE_URL=${SITE_URL:-https://ancientsky.github.io/safetravel}
FOLLOW=${FOLLOW:-published}   # published: the commit in SITE_URL/version.json; branch: the tip of BRANCH
BASE=${BASE:-/srv/safetravel}
SELFTEST_DIR=""
if [ "${1:-}" = "--selftest" ]; then   # everything below then points into a throw-away directory
  SELFTEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/safetravel-selftest.XXXXXX")
  BASE=$SELFTEST_DIR
fi
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

# ------------------------------------------------------------------ which commit: the one the public site serves
published_commit() { # prints the commit id in SITE_URL/version.json, or nothing
  local out=$TMP/version.json
  if curl -fsS --max-time "$HTTP_TIMEOUT" --retry 2 --retry-delay 5 -H 'Cache-Control: no-cache' \
       -o "$out" "$SITE_URL/version.json?t=$(date +%s)" 2>/dev/null; then
    python3 - "$out" <<'PY' 2>/dev/null || true
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    c = str(json.load(f).get('commit', ''))
print(c if re.fullmatch(r'[0-9a-f]{40}', c) else '')
PY
  fi
  rm -f "$out"
}

# ------------------------------------------------------------------ git: web/ of that commit, shallow + sparse + blob-less
clone_repo() {
  rm -rf "$REPO"
  git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$BRANCH" "$REPO_URL" "$REPO"
  git -C "$REPO" sparse-checkout set web
}
update_repo() { # update_repo <branch name or commit id>
  git -C "$REPO" remote set-url origin "$REPO_URL"
  git -C "$REPO" fetch --quiet --depth 1 origin "$1"
  git -C "$REPO" reset --quiet --hard FETCH_HEAD
  git -C "$REPO" gc --auto --quiet || true
}
sync_repo() {
  local want=$BRANCH
  if [ "$FOLLOW" = published ]; then
    want=$(published_commit)
    [ -n "$want" ] || fail "cannot read the published version ($SITE_URL/version.json); still serving the current release"
  fi
  if [ -d "$REPO/.git" ]; then
    update_repo "$want" || { warn "git update failed; cloning again"; clone_repo; update_repo "$want"; }
  else
    clone_repo
    update_repo "$want"
  fi
  COMMIT=$(git -C "$REPO" rev-parse HEAD)
  if [ "$FOLLOW" = published ] && [ "$COMMIT" != "$want" ]; then fail "checked out ${COMMIT:0:7}, wanted the published ${want:0:7}"; fi
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
# Only plain files and directories are ever published. A symbolic link committed under web/ could point at a file
# of this host (nginx follows links), so a checkout that contains one — or a submodule — is refused outright.
only_plain_files() { # only_plain_files <dir>: true when the tree holds nothing but regular files and directories
  local odd
  odd=$(find "$1" \( -type l -o ! \( -type f -o -type d \) \) -print 2>/dev/null | head -n 5)
  if [ -n "$odd" ]; then
    warn "not a regular file (symbolic link or special file); refusing to publish: $(echo "$odd" | tr '\n' ' ')"
    return 1
  fi
}

check_release() { # check_release <dir>
  local d=$1 f
  only_plain_files "$d" || return 1
  for f in index.html trip.html slide.html arrivals.html m.html help.html app.js styles.css data/meta.json data/epidemics.json data/alerts.json \
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
  # python3 rather than "ln -sfn" + "mv -T": os.replace is exactly one rename(2) on every system, whatever
  # coreutils the host has (GNU, or the Rust ones Ubuntu 26.04 installs by default)
  python3 - "$WWW" "$1" <<'PY'
import os, sys
www, name = sys.argv[1:3]
tmp = os.path.join(www, '.safetravel.new')
try:
    os.unlink(tmp)
except FileNotFoundError:
    pass
os.symlink('../releases/' + name, tmp)
os.replace(tmp, os.path.join(www, 'safetravel'))
PY
}

build_release() {
  local prev="" new
  if [ -e "$LIVE" ]; then prev=$(readlink -f "$LIVE"); fi
  RELEASE_NAME=$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:7}
  new=$RELEASES/$RELEASE_NAME
  rm -rf "$TMP/release"
  # the checkout itself must be plain files (git mode 120000 = symbolic link, 160000 = submodule)
  if git -C "$REPO" ls-tree -r HEAD -- web | grep -qvE '^100(644|755) '; then
    fail "web/ contains a symbolic link or submodule in ${COMMIT:0:7}; still serving $(basename "${prev:-none}")"
  fi
  only_plain_files "$REPO/web" || fail "web/ checkout is not plain files; still serving $(basename "${prev:-none}")"
  # unchanged files become hard links to the previous release: a new release costs almost no disk or time.
  # --no-links / --no-devices / --no-specials: even if a link got this far it would not be copied
  rsync -a --no-links --no-devices --no-specials --exclude='.git*' ${prev:+--link-dest="$prev"} "$REPO/web/" "$TMP/release/"
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
  # everything but the newest $KEEP_RELEASES (awk, not "head -n -N": the same on every coreutils)
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort |
    awk -v keep="$KEEP_RELEASES" '{ a[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print a[i] }' |
    while read -r d; do
      if [ -n "$d" ] && [ "$RELEASES/$d" != "$live" ]; then rm -rf -- "${RELEASES:?}/$d"; fi
    done
}

# ------------------------------------------------------------------ modes
do_sync() {
  mkdir -p "$REPO" "$RELEASES" "$WWW" "$STATE" "$TMP"   # first: a failure below is recorded in state/status.json
  need_tools
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
  local now age code=0 msg=() gen_s hours
  now=$(date +%s)
  if [ ! -f "$STATE/last_success" ]; then
    echo "CRITICAL - SafeTravel mirror has never synced successfully"; exit 2
  fi
  age=$(( (now - $(python3 -c 'import os, sys; print(int(os.path.getmtime(sys.argv[1])))' "$STATE/last_success")) / 60 ))
  if   [ "$age" -ge "$CRIT_AFTER_MIN" ]; then code=2; msg+=("last successful sync ${age} min ago")
  elif [ "$age" -ge "$WARN_AFTER_MIN" ]; then code=1; msg+=("last successful sync ${age} min ago")
  else msg+=("synced ${age} min ago"); fi
  # generated_at is ISO 8601 with an offset ("2026-11-03T11:54:19+08:00"): parsed in python3, not with "date -d"
  gen_s=$(python3 -c 'import datetime, json, sys
print(int(datetime.datetime.fromisoformat(json.load(open(sys.argv[1], encoding="utf-8"))["generated_at"]).timestamp()))' "$LIVE/data/meta.json" 2>/dev/null || true)
  if [ -n "$gen_s" ]; then
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

# ------------------------------------------------------------------ --selftest: is this host fit to run the mirror?
do_selftest() {
  trap - ERR
  set +e
  local bad=0 t v n
  ok()  { echo "PASS  $*"; }
  no()  { echo "FAIL  $*"; bad=1; }
  echo "SafeTravel mirror self-test in $SELFTEST_DIR (the live site is not touched)"
  for t in bash git curl rsync python3 flock find sha256sum awk; do
    if command -v "$t" >/dev/null 2>&1; then
      v=$("$t" --version 2>&1 | head -n 1)
      ok "tool $t — ${v:0:70}"
    else no "tool $t is missing"; fi
  done
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' && ok "python3 is 3.7 or newer" || no "python3 older than 3.7"
  mkdir -p "$RELEASES/a" "$RELEASES/b" "$WWW" "$STATE" "$TMP"
  echo one > "$RELEASES/a/f.txt"; echo two > "$RELEASES/b/f.txt"
  # the switch: a link to a directory replaced by another link, in place
  switch_to a && [ "$(cat "$LIVE/f.txt" 2>/dev/null)" = one ] && switch_to b && [ "$(cat "$LIVE/f.txt" 2>/dev/null)" = two ] \
    && [ -L "$LIVE" ] && [ "$(basename "$(readlink -f "$LIVE")")" = b ] && [ ! -e "$WWW/.safetravel.new" ] \
    && ok "atomic switch of the served directory" || no "atomic switch of the served directory"
  # unchanged files of a new release are hard links to the previous one; links in the source are not copied
  mkdir -p "$TMP/src"; echo same > "$TMP/src/keep.txt"; ln -s /etc/hostname "$TMP/src/link"
  # rsync mentions the link it leaves out ("skipping non-regular file"): expected here, so not shown
  rsync -a --no-links "$TMP/src/" "$RELEASES/r1/" >/dev/null 2>&1 && rsync -a --no-links --link-dest="$RELEASES/r1" "$TMP/src/" "$RELEASES/r2/" >/dev/null 2>&1
  n=$(python3 -c 'import os, sys; print(os.stat(sys.argv[1]).st_nlink)' "$RELEASES/r2/keep.txt" 2>/dev/null)
  [ "$n" = 2 ] && [ ! -e "$RELEASES/r2/link" ] && ok "rsync: hard links to the previous release, symbolic links left out" || no "rsync --link-dest / --no-links (nlink=$n)"
  only_plain_files "$TMP/src" 2>/dev/null && no "a symbolic link was not noticed" || ok "a symbolic link in the checkout is refused"
  # pruning keeps the newest $KEEP_RELEASES and never the live one
  rm -rf "$RELEASES"; mkdir -p "$RELEASES"
  for n in 01 02 03 04 05; do mkdir -p "$RELEASES/2026010${n:1}T000000Z-x"; done
  switch_to 20260101T000000Z-x
  KEEP_RELEASES=2 prune_releases
  n=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f ' | tr -s ' ')
  [ "$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 3 ] && [ -d "$RELEASES/20260101T000000Z-x" ] && [ -d "$RELEASES/20260105T000000Z-x" ] \
    && ok "pruning keeps the newest releases and the live one" || no "pruning left: $n"
  # status file and the monitoring probe (dates are parsed in python3)
  mkdir -p "$LIVE/data"; printf '{"generated_at": "%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" > "$LIVE/data/meta.json"
  write_status ok selftest; touch "$STATE/last_success"
  json_ok "$STATE/status.json" last_success && ok "status.json written and readable" || no "status.json"
  v=$( ( do_check ) 2>&1 ); case "$v" in OK\ -*|WARNING\ -*data*h\ old*) ok "--check answers: ${v:0:80}" ;; *) no "--check answered: $v" ;; esac
  # the two places this host must reach (TCP 443): a firewall or proxy problem shows here
  if git ls-remote --heads "$REPO_URL" "$BRANCH" 2>"$TMP/git.err" | grep -q "refs/heads/$BRANCH"; then ok "network: $REPO_URL (git)"
  else no "network: cannot read $REPO_URL — $(head -n 1 "$TMP/git.err")"; fi
  if curl -fsS --max-time "$HTTP_TIMEOUT" -o "$TMP/a.json" "$SITE_URL/data/arrivals.json" 2>"$TMP/curl.err" && json_ok "$TMP/a.json" flights; then ok "network: $SITE_URL (arrivals.json)"
  else no "network: cannot download $SITE_URL/data/arrivals.json — $(head -n 1 "$TMP/curl.err")"; fi
  if [ "$FOLLOW" = published ]; then
    # the commit the public site serves, and that git hands out exactly that commit
    v=$(published_commit)
    if [ -z "$v" ]; then no "published version: $SITE_URL/version.json has no commit id"
    elif git init --quiet "$TMP/probe" && git -C "$TMP/probe" fetch --quiet --depth 1 --filter=blob:none "$REPO_URL" "$v" 2>"$TMP/git.err"; then ok "published version ${v:0:7}: git serves that commit"
    else no "published version ${v:0:7}: git cannot fetch that commit — $(head -n 1 "$TMP/git.err")"; fi
  fi
  rm -rf "$SELFTEST_DIR"
  if [ "$bad" = 0 ]; then echo "self-test passed"; else echo "self-test FAILED (see the FAIL lines)"; fi
  exit "$bad"
}

case "${1:-}" in
  "")          do_sync ;;
  --check)     do_check ;;
  --rollback)  do_rollback ;;
  --selftest)  do_selftest ;;
  -h|--help)   sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)           echo "usage: $0 [--check | --rollback | --selftest | --help]" >&2; exit 64 ;;
esac
