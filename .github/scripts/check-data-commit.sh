#!/usr/bin/env bash
# Automated data commits may only change data files.
#
# Commits whose subject starts with "data:" are made by machines: update-data.yml and the daily translation routine
# (docs/TRANSLATION_GUIDE.md), which reads text from outside sources. Such a commit must touch nothing but data/ and
# web/data/. If one also changes site code, a workflow or a script, the deploy stops here and a person looks at it.
#
#   check-data-commit.sh [<base sha>] [<head sha>]     (defaults: only HEAD)
#
# Every commit after <base> up to <head> is checked. deploy-pages.yml passes the commit that is live as <base>, so a
# data commit that was refused once is still refused when a later, unrelated push comes along — it does not slip
# through because only the newest push was looked at.
#
# A change that is no longer there is forgiven: when every file the data commit touched outside data/ is, at <head>,
# identical to what it was before that commit (someone reverted it), the commit passes with a notice. A change a
# person has read and wants to keep is released by running Deploy Pages by hand with "reviewed" ticked.
set -euo pipefail
before=${1:-}
head=${2:-HEAD}

if [[ "$before" =~ ^[0-9a-f]{40}$ ]] && ! [[ "$before" =~ ^0+$ ]] && git cat-file -e "${before}^{commit}" 2>/dev/null; then
  commits=$(git rev-list "${before}..${head}")
else
  commits=$(git rev-parse "$head")   # manual run, first push, or the earlier commit is outside the shallow clone
fi

blob() { git rev-parse -q --verify "$1:$2" 2>/dev/null || echo absent; }   # object id of a path in a commit

bad=0
for c in $commits; do
  subject=$(git log -1 --format=%s "$c")
  case "$subject" in data:*) ;; *) continue ;; esac
  if ! git rev-parse -q --verify "${c}^" >/dev/null; then
    echo "::warning::cannot compare ${c:0:7} with its parent (shallow clone); not checked"
    continue
  fi
  outside=$(git -c core.quotepath=off diff-tree --no-commit-id --name-only -r "$c" | grep -vE '^(data/|web/data/)' || true)
  [ -n "$outside" ] || continue
  still=""
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ "$(blob "${c}^" "$p")" != "$(blob "$head" "$p")" ]; then still+="$p"$'\n'; fi
  done <<< "$outside"
  if [ -z "$still" ]; then
    echo "::notice::data commit ${c:0:7} changed files outside data/ and web/data/, but they are back to what they were"
    continue
  fi
  echo "::error::data commit ${c:0:7} (\"$subject\") changes files outside data/ and web/data/:"
  printf '%s' "$still" | sed 's/^/  /'
  bad=1
done
[ "$bad" = 0 ] && echo "data commits checked: nothing outside data/ and web/data/"
exit "$bad"
