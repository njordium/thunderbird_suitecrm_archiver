#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Find code nothing reaches.

Seven sweeps, each answering one question that a linter does not: an export
nobody imports, a name nothing uses, a file nothing loads, an id in the markup
that no script or stylesheet mentions, a class no page carries, a locale string
nothing asks for, and a permission with no call behind it.

Matching is textual and deliberately generous, a name that appears anywhere
counts as used. That makes false negatives possible and false positives rare,
which is the right way round for something that suggests deletions.
"""

import re
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
src = sorted((root / "src").rglob("*.js"))
tests = sorted((root / "tests").glob("*.mjs"))
tools = sorted((root / "tools").glob("*.mjs"))
html = sorted((root / "src").rglob("*.html"))
css = sorted((root / "src").rglob("*.css"))

alljs = src + tests + tools
text = {f: f.read_text() for f in alljs + html + css}
blob_src = "\n".join(text[f] for f in src)
blob_all = "\n".join(text[f] for f in alljs)
blob_html = "\n".join(text[f] for f in html)
blob_css = "\n".join(text[f] for f in css)
mani_raw = (root / "manifest.json").read_text()
mani = json.loads(mani_raw)

total = 0


def report(title, hits):
    global total
    total += len(hits)
    print(f"== {title} ==")
    print("\n".join("  " + h for h in hits) or "  none")
    print()


# Types thrown across a module boundary stay exported even with no importer
# today: a caller catching one needs the constructor to test against. Helpers
# that never leave their file get no such licence.
KEPT_EXPORTS = {"AuthError": "thrown to callers; mirrors CrmError, which is imported"}

hits = []
for f in src:
    for m in re.finditer(r"^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)", text[f], re.M):
        n = m.group(1)
        if n in KEPT_EXPORTS:
            continue
        others = "\n".join(v for k, v in text.items() if k != f and k.suffix in (".js", ".mjs"))
        if not re.search(rf"\b{re.escape(n)}\b", others):
            hits.append(f"{f.relative_to(root)}::{n}")
report("exported symbols never imported anywhere", hits)

hits = []
for f in src:
    t = text[f]
    for m in re.finditer(r"^(?:const|let|function|async function)\s+(\w+)", t, re.M):
        n = m.group(1)
        if t[max(0, m.start() - 7):m.start()].strip().endswith("export"):
            continue
        elsewhere = "\n".join(v for k, v in text.items() if k != f)
        if len(re.findall(rf"\b{re.escape(n)}\b", t)) <= 1 and not re.search(rf"\b{re.escape(n)}\b", elsewhere):
            hits.append(f"{f.relative_to(root)}::{n}")
report("module-level names never used, in their file or any other", hits)

hits = []
entries = {v.lstrip("/") for v in mani_raw.split('"') if v.endswith((".js", ".html"))}
for f in src:
    rel = str(f.relative_to(root))
    if rel in entries:
        continue
    if not re.search(rf"[\"'][^\"']*{re.escape(f.name)}[\"']", blob_all + blob_html):
        hits.append(rel)
report("files never imported and not an entry point", hits)

hits = []
for h in html:
    near = [f for f in src if f.parent == h.parent] or src
    js = "\n".join(text[f] for f in near)
    # Ids are routinely built rather than written: $(`p-${key}`), $(`view-${name}`).
    # Collect those prefixes so a whole family of ids is not reported as dead
    # merely because no literal spells it out.
    built = [m.group(1) for m in re.finditer(r"[`\"']([\w-]+-)\$\{", js)]
    for m in re.finditer(r'\bid="([^"]+)"', text[h]):
        n = m.group(1)
        if re.search(rf"[\"'`]{re.escape(n)}[\"'`]", js):
            continue
        if re.search(rf"#{re.escape(n)}\b", js):     # inside a selector string
            continue
        if any(n.startswith(b) for b in built):
            continue
        if f"#{n}" in blob_css:
            continue
        hits.append(f"{h.relative_to(root)}  #{n}")
report("HTML ids referenced from neither JS nor CSS", hits)

# Scoped to the page the stylesheet belongs to, not to the whole add-on. A class
# alive in options.css and dead in popup.css is exactly the case a global search
# misses, and it is the case that actually arises, a control gets removed from
# one page while the same class name lives on elsewhere.
hits = []
for c in css:
    page = c.stem                      # options.css -> options.html, options.js
    scope = "\n".join(
        text[f] for f in html + src
        if f.stem == page or f.parent.name == page
    ) or blob_html + blob_src
    seen = set()
    for m in re.finditer(r"\.([a-zA-Z][\w-]+)", text[c]):
        n = m.group(1)
        if n in seen:
            continue
        seen.add(n)
        if not re.search(rf"\b{re.escape(n)}\b", scope):
            hits.append(f"{c.relative_to(root)}  .{n}   (unused on the {page} page)")

    # Compound selectors need both halves on one element, which a class-by-class
    # search cannot see: .status.is-warn can be alive while .field-note.is-warn
    # is dead, and the name "is-warn" is used either way.
    #
    # Only two forms are decidable by reading text. A class written into a
    # literal ("field-note is-ok") shows both names together. A class added
    # through classList could land on any element, so those are left alone
    # rather than guessed at, a false accusation here costs more than a miss.
    for m in re.finditer(r"^\s*\.([a-zA-Z][\w-]+)\.([a-zA-Z][\w-]+)\b", text[c], re.M):
        a, b = m.group(1), m.group(2)
        if re.search(rf"classList\.\w+\(\s*[\"'`]{re.escape(b)}\b", scope):
            continue                    # applied dynamically; undecidable here
        together = any(
            re.search(rf"\b{re.escape(a)}\b", lit) and re.search(rf"\b{re.escape(b)}\b", lit)
            for lit in re.findall(r"[\"'`]([^\"'`\n]*)[\"'`]", scope)
        )
        if not together:
            hits.append(f"{c.relative_to(root)}  .{a}.{b}   (never applied to the same element)")
report("CSS class selectors never used by their own page", hits)

hits = []
messages = root / "_locales/en/messages.json"
if messages.exists():
    for k in json.loads(messages.read_text()):
        # __MSG_name__ is the only way a message is read, so a plain word
        # boundary would miss it, the leading underscore is a word character.
        if f"__MSG_{k}__" not in mani_raw and not re.search(rf"getMessage\(\s*[\"'`]{re.escape(k)}\b", blob_all):
            hits.append(k)
report("locale messages never referenced", hits)

# A permission with no call behind it is both dead weight and a review finding:
# reviewers ask why it is there, and the honest answer would be "it is not".
API = {
    "storage": r"\bstorage\??\.",
    "messagesRead": r"messages\??\.(get|getFull|listAttachments|getAttachmentFile|query)",
    "accountsRead": r"accounts\??\.",
    "downloads": r"downloads\??\.",
    "messagesUpdate": r"messages\??\.update",
    "addressBooks": r"addressBooks\??\.",
    "messagesTags": r"messages\??\.(update|tags)",
    "messagesTagsList": r"messages\??\.tags",
    "compose": r"\bcompose\??\.",
    "scripting": r"scripting\??\.",
}
hits = []
for p in mani.get("permissions", []):
    pat = API.get(p)
    if pat and not re.search(pat, blob_src):
        hits.append(f"{p}  (nothing matches /{pat}/)")
report("manifest permissions with no matching API call", hits)

print(f"{total} candidate(s). Each needs a human decision, the matching is textual.")
