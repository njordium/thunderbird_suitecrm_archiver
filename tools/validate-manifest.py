#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Check that every path the manifest and HTML reference actually exists."""
import json, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
errors, checked = [], 0

manifest = json.loads((root / "manifest.json").read_text())

def check(path, origin):
    global checked
    checked += 1
    if not (root / path).is_file():
        errors.append(f"{origin} references missing file: {path}")

for size, path in manifest.get("icons", {}).items():
    check(path, f"icons.{size}")
for key in ("message_display_action", "action", "compose_action"):
    block = manifest.get(key, {})
    for field in ("default_popup", "default_icon"):
        if field not in block:
            continue
        value = block[field]
        # default_icon may be a single path or a {size: path} map.
        if isinstance(value, dict):
            for size, path in value.items():
                check(path, f"{key}.{field}[{size}]")
        else:
            check(value, f"{key}.{field}")
for script in manifest.get("background", {}).get("scripts", []):
    check(script, "background.scripts")
if "page" in manifest.get("options_ui", {}):
    check(manifest["options_ui"]["page"], "options_ui.page")

# Follow src/href out of every HTML page.
for html in root.glob("src/**/*.html"):
    text = html.read_text()
    for ref in re.findall(r'(?:src|href)="([^"]+)"', text):
        if ref.startswith(("http", "data:", "#")):
            continue
        check((html.parent / ref).resolve().relative_to(root), html.name)

# Every relative ES import must resolve.
for js in list(root.glob("src/**/*.js")) + list(root.glob("tests/*.mjs")):
    for ref in re.findall(r'from\s+"(\.[^"]+)"', js.read_text()):
        check((js.parent / ref).resolve().relative_to(root), js.name)

# Manifest V3 defaults to "script-src 'self'; upgrade-insecure-requests;", which
# rewrites http:// requests to https:// and makes a plain-http CRM unreachable.
# We must therefore declare our own policy, and it must not reintroduce it.
if manifest.get("manifest_version") == 3:
    csp = manifest.get("content_security_policy")
    if not isinstance(csp, dict) or "extension_pages" not in csp:
        errors.append(
            "MV3 manifest has no content_security_policy.extension_pages, so the default "
            "upgrade-insecure-requests applies and http:// CRM hosts become unreachable"
        )
    elif "upgrade-insecure-requests" in csp["extension_pages"]:
        errors.append(
            "content_security_policy.extension_pages contains upgrade-insecure-requests, "
            "which breaks CRM instances served over plain http"
        )

# `developer.name` sets the Author line and `developer.url` sets the Homepage line
# (XPIInstall.sys.mjs assigns developer.url to homepageURL, not to the author).
# The Author line can only become a hyperlink for an add-on installed from
# addons.thunderbird.net, where the URL is the ATN profile and comes from listing
# data rather than the manifest — so a self-hosted build always shows it as text.
dev = manifest.get("developer")
if not isinstance(dev, dict) or not dev.get("name"):
    errors.append("developer.name is missing, so the Author line falls back to `author`")
elif dev.get("url") and not dev["url"].startswith("https://"):
    errors.append(f"developer.url should be https, got {dev['url']}")

# Scripts registered at runtime are not reachable from the manifest or any HTML,
# so name them here or a rename would only fail once a message is displayed.
for path in ["src/messageview/banner.js", "src/compose/composeStatus.js"]:
    check(path, "runtime-registered script")

# Every permission must be one Thunderbird actually recognises. An invented name
# is not ignored: it can stop the add-on loading, which takes the whole thing
# down rather than one feature. `messagesModify` was real in older Thunderbird
# and removed since, which is exactly how a plausible-looking wrong name gets in.
THUNDERBIRD_PERMISSIONS = {
    "accountsFolders", "accountsIdentities", "accountsRead", "addressBooks", "compose",
    "menus", "messagesDelete", "messagesImport", "messagesModifyPermanent", "messagesMove",
    "messagesRead", "messagesTags", "messagesTagsList", "messagesUpdate", "messengerSettings",
}
GECKO_PERMISSIONS = {
    "storage", "unlimitedStorage", "downloads", "tabs", "scripting", "notifications",
    "alarms", "idle", "clipboardRead", "clipboardWrite", "cookies", "management",
    "identity", "browserSettings", "privacy", "proxy", "dns", "sessions", "theme",
    "webNavigation", "webRequest", "webRequestBlocking", "contextualIdentities",
    "declarativeNetRequest", "browsingData", "nativeMessaging", "pkcs11", "activityLog",
}
KNOWN_PERMISSIONS = THUNDERBIRD_PERMISSIONS | GECKO_PERMISSIONS

for perm in manifest.get("permissions", []):
    if perm.startswith(("http://", "https://", "*://", "file://")) or perm == "<all_urls>":
        continue   # a host permission, checked elsewhere
    if perm not in KNOWN_PERMISSIONS:
        errors.append(
            f"'{perm}' is not a permission Thunderbird recognises — "
            f"an unknown permission can stop the add-on loading entirely"
        )

# Keys Thunderbird carried over from Manifest V2 and now ignores. Harmless at
# runtime, which is the problem: the add-on works, so nothing tells you they are
# there — and the store's validator rejects the upload over them. "maintoolbar"
# is a legal value for browser_action.default_area in MV2 and has no meaning at
# all under MV3's action, where allowed_spaces replaced it.
DEPRECATED_KEYS = {
    ("action", "default_area"):
        "unsupported under Manifest V3 — allowed_spaces replaced it, and the "
        "store's validator rejects the upload",
    ("browser_action", "default_area"):
        "browser_action is Manifest V2; use action with allowed_spaces",
    ("message_display_action", "default_area"):
        "unsupported under Manifest V3 — allowed_spaces replaced it",
    ("compose_action", "default_area"):
        "unsupported under Manifest V3 — allowed_spaces replaced it",
}
SPACES = {"mail", "addressbook", "calendar", "tasks", "chat", "settings", "default"}

for (key, sub), why in DEPRECATED_KEYS.items():
    if isinstance(manifest.get(key), dict) and sub in manifest[key]:
        errors.append(f"{key}.{sub} is deprecated: {why}")

# allowed_spaces is what actually places the button, so a typo there silently
# hides it rather than failing loudly.
for key in ("action", "message_display_action", "compose_action"):
    spaces = (manifest.get(key) or {}).get("allowed_spaces")
    if spaces is None:
        continue
    if not isinstance(spaces, list):
        errors.append(f"{key}.allowed_spaces must be a list")
        continue
    for space in spaces:
        if space not in SPACES:
            errors.append(
                f"{key}.allowed_spaces has '{space}', which is not a Thunderbird "
                f"space — expected one of {', '.join(sorted(SPACES))}"
            )

# Cross-check declared locale.
loc = manifest.get("default_locale")
if loc and not (root / "_locales" / loc / "messages.json").is_file():
    errors.append(f"default_locale '{loc}' has no _locales/{loc}/messages.json")

if errors:
    print("Manifest validation FAILED:", file=sys.stderr)
    for e in errors:
        print("  •", e, file=sys.stderr)
    sys.exit(1)
print(f"   {checked} references, all resolved")
