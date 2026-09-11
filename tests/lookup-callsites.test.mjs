/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * resolveAddress() and searchRecords() default to the four built-in modules.
 * That default is right for the library and wrong for every caller: the user
 * chooses which modules are searched, and a caller that omits the option
 * silently searches modules they turned off. Archive-on-send did exactly that
 * and kept asking the CRM for a module it had already refused, which is how a
 * warning appeared on every filed message.
 *
 * So the rule is that callers outside the library always pass modules
 * explicitly. This reads the source rather than running it, because the bug
 * was an omission and there is no call that fails to prove it.
 */
const SOURCES = ["../src/background/index.js", "../src/ui/popup.js", "../src/ui/options.js"];

function callsIn(src, fn) {
  const text = readFileSync(new URL(src, import.meta.url), "utf8");
  const out = [];
  const needle = `${fn}(`;
  let at = text.indexOf(needle);
  while (at !== -1) {
    // Declarations and imports are not calls.
    const before = text.slice(Math.max(0, at - 30), at);
    if (!/(function\s+|import\s*\{[^}]*)$/.test(before)) {
      // The argument list, up to the matching close paren, one nesting deep.
      let depth = 0, end = at + needle.length - 1;
      for (; end < text.length; end += 1) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")") { depth -= 1; if (!depth) break; }
      }
      out.push({
        args: text.slice(at + needle.length, end),
        line: text.slice(0, at).split("\n").length,
        file: src.replace("../", ""),
      });
    }
    at = text.indexOf(needle, at + 1);
  }
  return out;
}

for (const fn of ["resolveAddress", "searchRecords"]) {
  test(`every ${fn}() call outside the library names its modules`, () => {
    const calls = SOURCES.flatMap((src) => callsIn(src, fn));
    const bare = calls.filter((c) => !/\bmodules\b/.test(c.args));
    assert.deepEqual(bare.map((c) => `${c.file}:${c.line}`), [],
      `these calls fall back to the built-in modules instead of the user's choice: ` +
      bare.map((c) => `${c.file}:${c.line}`).join(", "));
  });
}

test("the parser finds the calls it is meant to be checking", () => {
  const found = SOURCES.flatMap((src) => callsIn(src, "resolveAddress"));
  assert.ok(found.length >= 2,
    `expected several resolveAddress() calls, found ${found.length} - the pattern is wrong, not the code`);
});
