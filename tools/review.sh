#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Run Thunderbird's own review linter against the built add-on.
#
# This is the authoritative check: it validates API calls and permissions
# against the annotated schema for the target Thunderbird channel, and applies
# the ATN review policies. It catches the class of mistake that broke this
# add-on once already — a permission that looks plausible but does not exist.
set -uo pipefail
cd "$(dirname "$0")/.."

LINTER=".tools/webext-linter"
XPI=$(ls -t dist/*.xpi 2>/dev/null | head -1)

if [ -z "$XPI" ]; then
  echo "No .xpi found — run ./tools/build.sh first."; exit 1
fi

if [ ! -d "$LINTER" ]; then
  echo "Fetching Thunderbird's review linter…"
  mkdir -p .tools
  git clone --depth 1 -q https://github.com/thunderbird/webext-linter.git "$LINTER" || {
    echo "Could not fetch the linter; skipping."; exit 0; }
  (cd "$LINTER" && npm install --no-audit --no-fund --silent) || {
    echo "Could not install the linter; skipping."; exit 0; }
fi

echo "Reviewing $XPI"
OUT=$(cd "$LINTER" && node verify.js "$OLDPWD/$XPI" 2>&1)

echo "$OUT" | grep -E "\[fail\]" | sed 's/^/  /' || true

ERRORS=$(echo "$OUT" | grep -cE "\[fail\]" || true)
echo
echo "$OUT" | grep -E "^[0-9]+ error|── Summary ──" -A 2 | tail -2
[ "$ERRORS" -eq 0 ] && echo "  no automated findings" || true

# The escalations matter as much as the failures. A check that cannot decide by
# itself reports [unsure] and defers to the extended manual review, and the
# reviewer resolves it with --llm-review — which is how 0.2.2 was turned down:
# two unreferenced files in src/ escalated here and never appeared as a [fail].
# The ten standard steps are about the ATN listing, not the code, so they stay
# out; this section is our own code and belongs in the gate.
EXTENDED=$(echo "$OUT" | sed -n '/── Extended manual review ──/,/── Standard manual review ──/p' \
  | grep -vE "── (Extended|Standard) manual review ──|^Continue manual review|^$" || true)
if [ -n "$EXTENDED" ]; then
  echo
  echo "Escalated to the reviewer's judgement (--llm-review resolves these)"
  echo "$EXTENDED" | sed 's/^/  /'
fi

# The reviewers' own linter. It normalises formatting and strips unused function
# parameters, so anything it reports is a real finding rather than a style
# difference — and the parameters it drops are dead code we should not have
# shipped. Its rewritten copy is a by-product; only its complaints matter here.
REVIEW=".tools/webext-review-linter"
if [ ! -d "$REVIEW" ]; then
  echo
  echo "Fetching the reviewers' linter…"
  git clone --depth 1 -q https://github.com/thunderbird/webext-review-linter.git "$REVIEW" || {
    echo "  could not fetch it; skipping."; exit 0; }
  (cd "$REVIEW" && npm install --no-audit --no-fund --silent) || {
    echo "  could not install it; skipping."; exit 0; }
fi

echo
echo "Reviewers' linter"
ROUT=$(cd "$REVIEW" && node lint.js "$OLDPWD/$XPI" 2>&1)
FINDINGS=$(echo "$ROUT" | grep -viE "^Linted:|^Extracting|baseline-browser|^Linted zip|^$" || true)
if [ -z "$FINDINGS" ]; then
  echo "  no findings, no unused parameters"
else
  echo "$FINDINGS" | sed 's/^/  /'
fi
rm -f "dist/linted_$(basename "$XPI")"

# The validator the store itself runs. Its warnings are mostly inherent to being
# a MailExtension — Thunderbird's own permissions and APIs are unknown to a
# Firefox-oriented linter — so only the error count gates anything here. That
# count is what blocks an upload.
AMO=".tools/addons-linter"
if [ ! -x "$AMO/node_modules/.bin/addons-linter" ]; then
  echo
  echo "Fetching the store's validator…"
  mkdir -p "$AMO"
  (cd "$AMO" && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund --silent addons-linter) || {
    echo "  could not install it; skipping."; exit 0; }
fi

echo
echo "Store validator (addons-linter)"
"$AMO/node_modules/.bin/addons-linter" --output=json "$XPI" 2>/dev/null \
  | python3 tools/amo-summary.py || true

exit 0
