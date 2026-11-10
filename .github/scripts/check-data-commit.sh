#!/usr/bin/env bash
# Automated data commits may only change data files.
#
# Commits whose subject starts with "data:" are made by machines: update-data.yml and the daily translation routine
# (docs/TRANSLATION_GUIDE.md), which reads text from outside sources. Such a commit must touch nothing but data/ and
# web/data/. If one also changes site code, a workflow or a script, the deploy stops here and a person looks at it.
#
#   check-data-commit.sh [<before sha>] [<head sha>]     (defaults: only HEAD)
set -euo pipefail
before=${1:-}
head=${2:-HEAD}

if [[ "$before" =~ ^[0-9a-f]{40}$ ]] && ! [[ "$before" =~ ^0+$ ]] && git cat-file -e "${before}^{commit}" 2>/dev/null; then
  commits=$(git rev-list "${before}..${head}")
else
  commits=$(git rev-parse "$head")   # manual run, first push, or the earlier commit is outside the shallow clone
fi

bad=0
for c in $commits; do
  subject=$(git log -1 --format=%s "$c")
  case "$subject" in data:*) ;; *) continue ;; esac
  if ! git rev-parse -q --verify "${c}^" >/dev/null; then
    echo "::warning::cannot compare ${c:0:7} with its parent (shallow clone); not checked"
    continue
  fi
  outside=$(git diff-tree --no-commit-id --name-only -r "$c" | grep -vE '^(data/|web/data/)' || true)
  if [ -n "$outside" ]; then
    echo "::error::data commit ${c:0:7} (\"$subject\") changes files outside data/ and web/data/:"
    echo "$outside" | sed 's/^/  /'
    bad=1
  fi
done
[ "$bad" = 0 ] && echo "data commits checked: nothing outside data/ and web/data/"
exit "$bad"
