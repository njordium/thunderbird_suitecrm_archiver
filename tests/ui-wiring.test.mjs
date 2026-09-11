/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A button that looks pressable and does nothing is worse than no button, it was
// a real defect here once. These checks tie the markup and its script together:
// every button in the page must be wired up, and every element the script reaches
// for must exist in the page.
const read = (f) => readFileSync(new URL(`../src/ui/${f}`, import.meta.url), "utf8");

const PAIRS = [
  ["options.html", "options.js"],
  ["popup.html", "popup.js"],
];

// Ids the script creates at runtime rather than finding in the markup.
const DYNAMIC = new Set();

for (const [htmlFile, jsFile] of PAIRS) {
  const html = read(htmlFile);
  const js = read(jsFile);

  const buttonIds = [...html.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));

  test(`${htmlFile}: every button is referenced by ${jsFile}`, () => {
    assert.ok(buttonIds.length > 0, "no buttons found, the parser is wrong, not the page");
    const orphans = buttonIds.filter((id) => !referenced.has(id) && !js.includes(`"${id}"`));
    assert.deepEqual(orphans, [], `buttons with no code behind them: ${orphans.join(", ")}`);
  });

  test(`${jsFile}: every element it reaches for exists in ${htmlFile}`, () => {
    const missing = [...referenced].filter((id) => !htmlIds.has(id) && !DYNAMIC.has(id));
    assert.deepEqual(missing, [], `$() on ids not in the page: ${missing.join(", ")}`);
  });
}

// The add-on asks for exactly one host permission: the user's own CRM. Reaching
// out to a sender's website used to need one per domain, which cluttered the
// Permissions tab and prompted on every check. That is gone, and must stay gone.
test("the archiving window never asks for a host permission", () => {
  assert.doesNotMatch(read("popup.js"), /permissions\.request/,
    "a third-party site permission must not creep back into the create form");
});

test("every host permission request derives its origin from the CRM address", () => {
  const js = read("options.js");
  const calls = [...js.matchAll(/permissions\.request\(\{\s*origins:\s*\[([^\]]+)\]/g)]
    .map((m) => m[1].trim());
  assert.ok(calls.length > 0, "the parser found no requests, check the pattern, not the code");
  for (const arg of calls) {
    assert.match(arg, /^origin$|originPatternFor\(\$\("in-url"\)\.value\)/,
      `permission requested for something other than the CRM host: ${arg}`);
  }
});
