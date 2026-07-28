#!/usr/bin/env bash
# Stage the given paths, commit if anything actually changed, and push.
#
# Usage: scripts/commit-and-push.sh "<commit message>" <path> [path...]
#
# Both of hydro.yml's commit points share this, and the hydrology and dashboard
# steps push to main within the same run, so a push can lose a race against the
# other job. Rebase and retry rather than failing: the data is already correct
# locally, and a rejected push is a scheduling collision, not a data problem.
#
# Exits 0 with no commit when nothing changed — the scripts are idempotent and
# most runs legitimately produce identical output.
set -euo pipefail

message="$1"
shift

git config user.name "hydro-bot"
git config user.email "actions@users.noreply.github.com"

git add "$@"
if git diff --staged --quiet; then
  echo "No change — $* already current."
  exit 0
fi

git commit -m "$message"

for attempt in 1 2 3; do
  if git push; then
    echo "Pushed on attempt $attempt."
    exit 0
  fi
  echo "Push rejected, rebasing (attempt $attempt)..."
  git pull --rebase --autostash origin main || true
  sleep 5
done

echo "Could not push after 3 attempts." >&2
exit 1
