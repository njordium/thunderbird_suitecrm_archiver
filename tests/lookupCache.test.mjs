/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { LookupCache } from "../src/lib/lookupCache.js";

test("a stored value comes back, case- and space-insensitively", () => {
  const c = new LookupCache();
  c.set("Jane@Acme.SE", { total: 2 });
  assert.deepEqual(c.get("  jane@acme.se "), { total: 2 });
});

test("a miss is undefined, not null, so a cached zero is still a hit", () => {
  const c = new LookupCache();
  assert.equal(c.get("nobody@acme.se"), undefined);
  c.set("nobody@acme.se", { total: 0 });
  assert.deepEqual(c.get("nobody@acme.se"), { total: 0 }, "a genuine zero must not look like a miss");
});

test("entries expire, so a record created elsewhere is picked up", () => {
  let clock = 1000;
  const c = new LookupCache({ ttlMs: 100, now: () => clock });
  c.set("a@b.se", { total: 0 });
  clock += 50;
  assert.deepEqual(c.get("a@b.se"), { total: 0 });
  clock += 100;
  assert.equal(c.get("a@b.se"), undefined, "stale entry should be dropped");
});

test("the cache is capped, evicting the least recently used", () => {
  const c = new LookupCache({ max: 2 });
  c.set("a@x.se", 1); c.set("b@x.se", 2);
  c.get("a@x.se");            // a is now the most recent
  c.set("c@x.se", 3);         // evicts b
  assert.equal(c.get("a@x.se"), 1);
  assert.equal(c.get("b@x.se"), undefined);
  assert.equal(c.get("c@x.se"), 3);
});

test("invalidate drops one address or all of them", () => {
  const c = new LookupCache();
  c.set("a@x.se", 1); c.set("b@x.se", 2);
  c.invalidate("a@x.se");
  assert.equal(c.get("a@x.se"), undefined);
  assert.equal(c.get("b@x.se"), 2);
  c.invalidate();
  assert.equal(c.size, 0);
});

test("an empty address is never stored", () => {
  const c = new LookupCache();
  c.set("", { total: 1 });
  c.set(null, { total: 1 });
  assert.equal(c.size, 0);
});

// The badge, the in-message strip and the popup all ask the same question about
// the same address within a second of each other. They must share one answer.
test("a shared cache collapses repeated questions to one lookup", async () => {
  let fanouts = 0;
  const cache = new LookupCache();
  const resolve = async (email) => {
    const hit = cache.get(email);
    if (hit !== undefined) return hit;
    fanouts++;
    return cache.set(email, { total: 2, found: true });
  };

  await resolve("a@b.example");   // badge
  await resolve("a@b.example");   // in-message strip
  await resolve("a@b.example");   // popup
  assert.equal(fanouts, 1, `expected one lookup, made ${fanouts}`);

  await resolve("other@b.example");
  assert.equal(fanouts, 2, "a different address must still be looked up");
});

test("a failed lookup is cached as null and not mistaken for zero records", () => {
  const c = new LookupCache();
  c.set("x@y.example", null);
  assert.equal(c.get("x@y.example"), null, "null means 'could not ask'");
  assert.notEqual(c.get("x@y.example"), undefined, "and must not read as a cache miss");
});
