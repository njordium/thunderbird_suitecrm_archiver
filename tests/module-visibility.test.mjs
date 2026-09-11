/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { moduleAbsent } from "../src/lib/modules.js";

/**
 * Two different failures, two different answers in the settings. A module the
 * CRM refuses on an ACL still exists and somebody can grant access to it, so
 * it stays listed and inert with the reason on hover. A module SuiteCRM says
 * is not there is not something the reader can act on, so it is dropped.
 */
test("a module that does not exist is absent, so it is not listed", () => {
  for (const status of [400, 404]) {
    assert.equal(moduleAbsent({ disabled: true, status }), true, `HTTP ${status} should be hidden`);
  }
});

test("a module refused on access stays listed", () => {
  assert.equal(moduleAbsent({ disabled: true, status: 403 }), false);
});

test("a module still collecting strikes is not hidden", () => {
  assert.equal(moduleAbsent({ disabled: false, status: 400, strikes: 1 }), false);
  assert.equal(moduleAbsent({ disabled: false, status: 500, strikes: 2 }), false);
});

test("a module with no trouble recorded is never hidden", () => {
  for (const value of [undefined, null, {}, { status: 400 }]) {
    assert.equal(moduleAbsent(value), false, `${JSON.stringify(value)} should not be hidden`);
  }
});

test("the settings page actually applies the rule", () => {
  const source = readFileSync(new URL("../src/ui/options.js", import.meta.url), "utf8");
  assert.match(source, /\.filter\(\(name\) => !moduleAbsent\(/,
    "renderModules does not filter absent modules out of the list");
  assert.match(source, /tick\.disabled = true;/,
    "a refused module that stays listed must not be tickable");
});
