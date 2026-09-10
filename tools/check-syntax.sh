#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Syntax-check the extension's ES modules.
# `node --check` treats .js as CommonJS, so we stage copies as .mjs.
set -u
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ok=0; bad=0
for f in "$@"; do
  cp "$f" "$tmp/$(basename "${f%.js}").mjs"
  if node --check "$tmp/$(basename "${f%.js}").mjs" 2>"$tmp/err"; then
    ok=$((ok+1))
  else
    bad=$((bad+1)); echo "FAIL $f"; head -6 "$tmp/err"
  fi
done
echo "syntax: $ok ok, $bad failed"
[ "$bad" -eq 0 ]
