#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Emit dist/updates.json for self-hosted updates.

`update_info_url` is what populates the Add-ons Manager's Release Notes tab for an
add-on installed outside addons.thunderbird.net. Set UPDATE_BASE to the URL the
files will be served from; without it we write a template rather than a manifest
pointing at somewhere that does not exist.
"""
import hashlib, json, os, pathlib, sys

version, xpi = sys.argv[1], sys.argv[2]
base = os.environ.get("UPDATE_BASE", "").rstrip("/")

digest = hashlib.sha256(pathlib.Path(xpi).read_bytes()).hexdigest()
entry = {
    "version": version,
    "update_hash": f"sha256:{digest}",
    "applications": {"gecko": {"strict_min_version": "140.0"}},
}
if base:
    entry["update_link"] = f"{base}/{pathlib.Path(xpi).name}"
    entry["update_info_url"] = f"{base}/release-notes.html"

doc = {"addons": {"suitecrm-archiver@njordium.com": {"updates": [entry]}}}
pathlib.Path("dist/updates.json").write_text(json.dumps(doc, indent=2) + "\n")
print("   dist/updates.json" + ("" if base else "  (template, set UPDATE_BASE to activate)"))
