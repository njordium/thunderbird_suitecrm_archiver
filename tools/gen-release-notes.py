#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Render CHANGELOG.md into the add-on's release notes.

One source of truth, two outputs, neither of them inside src/ as HTML: the
settings page reads src/ui/release-notes.json, and dist/release-notes.html is
the standalone page `update_info_url` points at, which fills the Add-ons
Manager's Release Notes tab for a self-hosted add-on. An HTML fragment left in
src/ would ship in the .xpi unreferenced, which ATN's reviewers reject.
"""
import html, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
md = (root / "CHANGELOG.md").read_text()

def inline(text):
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
    return text

out, in_list = [], False
def close_list():
    global in_list
    if in_list:
        out.append("</ul>")
        in_list = False

for raw in md.splitlines():
    line = raw.rstrip()
    if line.startswith("# "):
        continue
    if line.startswith("## "):
        close_list()
        out.append(f"<h2>{inline(line[3:])}</h2>")
    elif line.startswith("### "):
        close_list()
        out.append(f"<h3>{inline(line[4:])}</h3>")
    elif line.startswith("- "):
        if not in_list:
            out.append("<ul>")
            in_list = True
        out.append(f"<li>{inline(line[2:])}</li>")
    elif line.strip() == "":
        close_list()
    else:
        if in_list:                      # continuation of the previous bullet
            out[-1] = out[-1][:-5] + " " + inline(line.strip()) + "</li>"
        else:
            out.append(f"<p>{inline(line.strip())}</p>")
close_list()

body = "\n".join(out)

# Also emit the same content as structured data. The settings page builds its
# "What's new" panel from this rather than assigning HTML to innerHTML, which
# Thunderbird's review linter flags, and which would be a real hazard the day
# this file stops being purely ours.
import json
blocks = []
for raw in md.splitlines():
    line = raw.rstrip()
    if line.startswith("# "):
        continue
    if line.startswith("## "):
        blocks.append({"t": "h2", "v": line[3:]})
    elif line.startswith("### "):
        blocks.append({"t": "h3", "v": line[4:]})
    elif line.startswith("- "):
        if blocks and blocks[-1]["t"] == "ul":
            blocks[-1]["v"].append(line[2:])
        else:
            blocks.append({"t": "ul", "v": [line[2:]]})
    elif line.strip() == "":
        continue
    else:
        if blocks and blocks[-1]["t"] == "ul":
            blocks[-1]["v"][-1] += " " + line.strip()
        else:
            blocks.append({"t": "p", "v": line.strip()})

# Markdown emphasis is dropped rather than carried: the panel is plain text.
def plain(t):
    return (t.replace("**", "").replace("`", "")
             .replace("*", ""))

for b in blocks:
    b["v"] = [plain(x) for x in b["v"]] if isinstance(b["v"], list) else plain(b["v"])

(root / "src/ui/release-notes.json").write_text(json.dumps(blocks, indent=1) + "\n")
print(f"   release notes: {len(blocks)} blocks (json)")

# Standalone page for update_info_url, which Thunderbird loads in its own frame.
standalone = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SuiteCRM Email Archiver, Release Notes</title>
<style>
 body {{ font: 13px/1.5 system-ui, sans-serif; margin: 16px; color: #1b1d21; }}
 h2 {{ font-size: 15px; }} h3 {{ font-size: 12.5px; margin: 14px 0 4px; }}
 ul {{ padding-left: 18px; }} li {{ margin-bottom: 3px; }}
 code {{ font: 11.5px ui-monospace, Menlo, monospace; background: #f0f1f3; padding: 1px 4px; border-radius: 3px; }}
 @media (prefers-color-scheme: dark) {{
   body {{ background: #1e2126; color: #e6e8eb; }} code {{ background: #2a2f36; }}
 }}
</style></head><body>
{body}
</body></html>
"""
pathlib.Path(root / "dist").mkdir(exist_ok=True)
(root / "dist/release-notes.html").write_text(standalone)
print(f"   release notes: {len(out)} blocks")
