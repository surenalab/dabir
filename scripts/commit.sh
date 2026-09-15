#!/bin/sh
# Commit the index with exactly the message given, through the plumbing. Some agent harnesses rewrite
# `git commit` to append an attribution trailer (Co-authored-by: <tool>), which AGENTS.md and
# CONTRIBUTING.md forbid; `git commit-tree` is not rewritten. Stage first, then:
#
#   scripts/commit.sh "Subject line" ["Body paragraph…"]
#   printf 'Subject\n\nBody\n' | scripts/commit.sh -
#
# The message is the arguments joined by a blank line, or stdin when the only argument is "-".
set -eu
if [ "${1:-}" = "-" ]; then
  MSG="$(cat)"
else
  [ $# -ge 1 ] || { echo "usage: scripts/commit.sh \"subject\" [\"body\"] | printf … | scripts/commit.sh -"; exit 1; }
  MSG="$1"; shift
  for part in "$@"; do MSG="$MSG

$part"; done
fi
case "$MSG" in *[Cc]o-[Aa]uthored-[Bb]y:*|*Generated\ with*) echo "refusing: the message carries an attribution trailer"; exit 1;; esac
git diff --cached --quiet && { echo "nothing staged"; exit 1; }
TREE="$(git write-tree)"
if PARENT="$(git rev-parse -q --verify HEAD 2>/dev/null)"; then
  COMMIT="$(printf '%s\n' "$MSG" | git commit-tree "$TREE" -p "$PARENT")"
else
  COMMIT="$(printf '%s\n' "$MSG" | git commit-tree "$TREE")"
fi
git update-ref -m "commit: $(printf '%s' "$MSG" | head -1)" HEAD "$COMMIT"
git log -1 --oneline
