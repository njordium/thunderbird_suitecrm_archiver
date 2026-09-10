/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { accountAllowed } from "../src/lib/modules.js";

// null means "every account, including ones added later"; an array is the exact
// list, and an empty array means none. If "all" were also [], unticking every
// account in settings would silently re-enable them all.

test("null enables every account", () => {
  assert.deepEqual(accountAllowed(null, "account3"), { allowed: true });
  assert.deepEqual(accountAllowed(undefined, "account3"), { allowed: true });
  assert.deepEqual(accountAllowed(null, undefined), { allowed: true });
});

test("an empty list enables nothing, and says so", () => {
  const v = accountAllowed([], "account3");
  assert.equal(v.allowed, false);
  assert.ok(v.noneEnabled, "must be distinguishable from a non-matching account");
});

test("an explicit list allows only its members", () => {
  assert.equal(accountAllowed(["account3"], "account3").allowed, true);
  assert.equal(accountAllowed(["account3"], "account7").allowed, false);
  assert.equal(accountAllowed(["a", "b"], "b").allowed, true);
});

test("a non-matching account is not reported as 'none enabled'", () => {
  const v = accountAllowed(["account3"], "account7");
  assert.equal(v.allowed, false);
  assert.ok(!v.noneEnabled, "this is one account being off, not all of them");
});

// Blocking a message we cannot attribute would be a silent failure, so allow it.
test("an unknown account is allowed rather than silently blocked", () => {
  assert.equal(accountAllowed(["account3"], undefined).allowed, true);
  assert.equal(accountAllowed(["account3"], "").allowed, true);
});
