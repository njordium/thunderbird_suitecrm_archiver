#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Summarise addons-linter JSON on stdin.

Only the error count gates an upload. The warnings are, for a MailExtension,
almost entirely inherent: addons-linter validates against Firefox's schema, so
every Thunderbird-only permission and API is reported as unknown. Grouping them
by code makes that obvious at a glance, and makes a genuinely new warning stand
out instead of hiding in a wall of expected ones.
"""

import json
import sys
from collections import Counter

# Warnings no MailExtension can avoid, with the reason, so nobody spends time
# on them again.
INHERENT = {
    "MANIFEST_PERMISSIONS": "Thunderbird-only permissions, unknown to a Firefox linter",
    # The count tracks how much of Thunderbird the add-on uses, so it rises with
    # each feature. A jump is expected after new APIs, not a regression.
    "UNSUPPORTED_API": "Thunderbird-only APIs, unknown to a Firefox linter",
    "MISSING_DATA_COLLECTION_PERMISSIONS":
        "the data_collection_permissions key; needs Firefox 140+, so it can only "
        "be declared once strict_min_version is 140 or above",
    "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION":
        "data_collection_permissions needs Firefox for Android 142 but desktop "
        "140, and no gecko_android is declared. Silencing it would mean claiming "
        "Android compatibility for a mail extension that cannot run there",
}

data = json.load(sys.stdin)
summary = data["summary"]
errors = data.get("errors", [])
warnings = data.get("warnings", [])

print(f"  {summary['errors']} error(s), {summary['warnings']} warning(s), "
      f"{summary['notices']} notice(s)")

for e in errors:
    where = e.get("file") or ""
    path = e.get("dataPath") or ""
    print(f"  [error] {e['code']}: {e['message']} {where}{path}".rstrip())

for code, count in sorted(Counter(w["code"] for w in warnings).items()):
    why = INHERENT.get(code)
    note = f", {why}" if why else "  <-- NOT an inherent one; look at this"
    print(f"  [warn]  {code} x{count}{note}")

print("  nothing blocking an upload" if not errors else "  UPLOAD WILL BE REJECTED")
sys.exit(1 if errors else 0)
