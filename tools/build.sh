#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Package the add-on as an installable .xpi, after checking it hangs together.
#
#   ./tools/build.sh
#   UPDATE_BASE=https://example.com/tb-suitecrm ./tools/build.sh   # self-hosted updates
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/suitecrm-email-archiver-${VERSION}.xpi"

echo "→ Generating release notes from CHANGELOG.md"
python3 tools/gen-release-notes.py

echo "→ Validating manifest references"
python3 tools/validate-manifest.py

echo "→ Linting"
if [ -x node_modules/.bin/eslint ]; then
  node_modules/.bin/eslint src tests tools --max-warnings 20 || { echo "   lint FAILED"; exit 1; }
  echo "   clean"
else
  echo "   skipped (run: npm install)"
fi

echo "→ Checking syntax"
./tools/check-syntax.sh src/lib/*.js src/background/*.js src/ui/*.js >/dev/null

echo "→ Running tests"
node --test tests/*.test.mjs >/dev/null 2>&1 || { echo "   tests FAILED"; exit 1; }

echo "→ Checking for prohibited attribution"
./tools/check-attribution.sh

mkdir -p dist
rm -f "$OUT"

# A .xpi is a plain zip with the manifest at the root.
python3 - "$OUT" <<'PYEOF'
import sys, zipfile, pathlib
out = sys.argv[1]
# LICENSE travels with the package: MPL 2.0 obliges us to inform recipients of
# the terms, and a licence left behind in the repository does not reach someone
# who only ever sees the .xpi.
include = ["manifest.json", "LICENSE"]
for d in ("src", "_locales"):
    include += [str(p) for p in pathlib.Path(d).rglob("*") if p.is_file()]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(include):
        z.write(f)
print(f"   {len(include)} files")
PYEOF

python3 tools/gen-update-manifest.py "$VERSION" "$OUT"

echo "→ Built $OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "Install: Thunderbird → Add-ons → gear icon → Install Add-on From File…"
echo "Develop: Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on → manifest.json"
