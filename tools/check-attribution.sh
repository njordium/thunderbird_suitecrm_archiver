#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Fail if any tool-attribution marker appears in the tree, commit messages, or a
# built artefact.
#
#   ./tools/check-attribution.sh              # the whole repository
#   ./tools/check-attribution.sh --msg FILE   # one commit message, for the hook
#
# The vendor names are assembled from fragments rather than written out, so this
# file does not itself become the one place in the repository where they appear.
# It still excludes itself from the scan, because the assembled pattern exists in
# memory while it runs.
set -uo pipefail
cd "$(dirname "$0")/.."

PATTERN="$(printf 'cl%s|anthrop%s|co-authored-by|generated with|ai-generated|ai-assisted' 'aude' 'ic')"
SELF="check-attribution.sh"
found=0

# The commit-msg hook passes the message git is about to record. Nothing is in
# git log yet at that point, so the message has to be read directly, and it is
# the only thing worth reading, since a hook that scanned the whole repository
# would refuse a commit over something the commit does not touch. Comment lines
# are dropped first: git strips them, and `git commit -v` puts the entire diff
# in there behind them.
if [ "${1:-}" = "--msg" ]; then
  msg="${2:-}"
  [ -n "$msg" ] || { echo "--msg needs the path to a commit message"; exit 2; }
  if grep -v "^#" "$msg" | grep -niE "$PATTERN"; then
    echo "  ^ attribution markers in the commit message"
    echo "  This repository does not carry them. Remove the line and commit again."
    exit 1
  fi
  exit 0
fi

# .tools holds Thunderbird's review linter, cloned on demand: a third-party dev
# tool, gitignored and never packaged. Its own README is not text this governs.
if grep -rniE "$PATTERN" \
     --exclude-dir=.git --exclude-dir=reference --exclude-dir=node_modules \
     --exclude-dir=dist --exclude-dir=.tools --exclude="$SELF" . ; then
  echo "  ^ attribution markers in the working tree"; found=1
fi

if git rev-parse --git-dir >/dev/null 2>&1; then
  if git log --format="%H %B" 2>/dev/null | grep -niE "$PATTERN"; then
    echo "  ^ attribution markers in commit messages"; found=1
  fi
  if git log --format="%an|%ae|%cn|%ce" 2>/dev/null | grep -niE "$PATTERN"; then
    echo "  ^ attribution markers in commit authorship"; found=1
  fi
fi

for xpi in dist/*.xpi; do
  [ -e "$xpi" ] || continue
  if python3 -c "
import re, sys, zipfile
z = zipfile.ZipFile('$xpi')
bad = []
for n in z.namelist():
    try: t = z.read(n).decode('utf-8', 'ignore')
    except Exception: continue
    if re.search(r'''$PATTERN''', t, re.I): bad.append(n)
if bad: print('  ' + '$xpi' + ': ' + ', '.join(bad)); sys.exit(1)
"; then :; else
    echo "  ^ attribution markers inside the packaged add-on"; found=1
  fi
done

if [ "$found" -eq 0 ]; then echo "   clean"; fi
exit "$found"
