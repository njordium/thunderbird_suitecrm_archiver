/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { moduleTitle, failureIsPermanent, moduleVerdict, STRIKES_BEFORE_DISABLING,
         MODULE_TITLES, DIRECT_MODULES } from "../src/lib/modules.js";

/**
 * SuiteCRM calls the Targets module "Prospects" internally. The API takes that
 * name and a failure comes back under it, so the add-on has to use it, but
 * showing it produced a warning about a module the user does not have: the
 * settings said Targets while the error said Prospects.
 */
test("the built-in four all have a display name", () => {
  for (const name of DIRECT_MODULES) {
    assert.ok(MODULE_TITLES[name], `${name} would be shown by its internal name`);
  }
});

test("Prospects is shown as Targets", () => {
  assert.equal(moduleTitle("Prospects"), "Targets");
});

test("a custom module falls back to the CRM's own label", () => {
  assert.equal(moduleTitle("MyCustom_Widgets", { MyCustom_Widgets: "Widgets" }), "Widgets");
});

test("a module with no label anywhere is shown by name rather than blank", () => {
  assert.equal(moduleTitle("MyCustom_Widgets"), "MyCustom_Widgets");
  assert.equal(moduleTitle("MyCustom_Widgets", {}), "MyCustom_Widgets");
});

/**
 * Whether a failure justifies turning a module off. Getting this wrong in
 * either direction is bad: turn off on a blip and the module vanishes for no
 * reason, never turn off and the same warning arrives on every message.
 */
test("a revoked ACL, a removed module and an unknown module are permanent", () => {
  for (const status of [400, 403, 404]) {
    assert.equal(failureIsPermanent({ status }), true, `HTTP ${status} should be permanent`);
  }
});

test("a server error, a gateway timeout and a network failure are not", () => {
  for (const status of [500, 502, 503, 504, 429, 408]) {
    assert.equal(failureIsPermanent({ status }), false, `HTTP ${status} must not disable a module`);
  }
});

test("an error carrying no status is not treated as permanent", () => {
  assert.equal(failureIsPermanent({}), false);
  assert.equal(failureIsPermanent({ status: null }), false);
  assert.equal(failureIsPermanent(), false);
});

test("401 is not permanent, since it means sign in again rather than no access", () => {
  assert.equal(failureIsPermanent({ status: 401 }), false);
});

// --- What to do about a failure --------------------------------------------
//
// Checked against the live test CRM, where the module that prompted all this
// (Prospects, shown as Targets) answers a plain read perfectly well while
// being absent from /meta/modules. So "it failed once" cannot mean "turn it
// off", or a server having a moment would empty the user's module list.

test("a module that answers a plain read is left alone, and its strikes are forgotten", () => {
  assert.deepEqual(moduleVerdict({ readSucceeded: true, strikes: 2 }),
    { action: "keep", strikes: 0 });
});

test("a definitive refusal turns the module off at once", () => {
  for (const status of [400, 403, 404]) {
    assert.equal(moduleVerdict({ readSucceeded: false, status }).action, "disable",
      `HTTP ${status} should turn the module off immediately`);
  }
});

test("a server error earns a strike rather than a removal", () => {
  const first = moduleVerdict({ readSucceeded: false, status: 500, strikes: 0 });
  assert.deepEqual(first, { action: "strike", strikes: 1 });
  const second = moduleVerdict({ readSucceeded: false, status: 500, strikes: 1 });
  assert.deepEqual(second, { action: "strike", strikes: 2 });
});

test("enough strikes in a row does turn it off", () => {
  const verdict = moduleVerdict({ readSucceeded: false, status: 500, strikes: STRIKES_BEFORE_DISABLING - 1 });
  assert.equal(verdict.action, "disable");
  assert.equal(verdict.strikes, STRIKES_BEFORE_DISABLING);
});

test("a dead connection, with no status at all, is treated as transient", () => {
  assert.equal(moduleVerdict({ readSucceeded: false, status: null }).action, "strike");
  assert.equal(moduleVerdict({ readSucceeded: false }).action, "strike");
});

test("called with nothing, it does not claim a module should be removed", () => {
  assert.notEqual(moduleVerdict().action, "disable");
});
