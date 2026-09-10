/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { createBadgeUpdater } from "../src/lib/badge.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(count, delayMs = 5) {
  const painted = [];
  const b = createBadgeUpdater({
    count,
    delayMs,
    paint: async (tabId, text, colour, title) => { painted.push({ tabId, text, colour, title }); },
  });
  return { b, painted };
}

test("a sender with records gets a count badge", async () => {
  const { b, painted } = harness(async () => 3);
  b.schedule(1, { email: "jane@acme.se", name: "Jane" });
  await sleep(30);
  assert.equal(painted.at(-1).text, "3");
  assert.match(painted.at(-1).title, /3 CRM records for Jane/);
});

test("a sender with no records is marked, not left blank", async () => {
  const { b, painted } = harness(async () => 0);
  b.schedule(1, { email: "nobody@acme.se", name: "Nobody" });
  await sleep(30);
  assert.equal(painted.at(-1).text, "·");
  assert.match(painted.at(-1).title, /not in SuiteCRM/);
});

test("a lookup failure shows a warning rather than claiming zero", async () => {
  const { b, painted } = harness(async () => null);
  b.schedule(1, { email: "x@y.se", name: "X" });
  await sleep(30);
  assert.equal(painted.at(-1).text, "!");
  assert.match(painted.at(-1).title, /Could not reach/);
});

test("a thrown lookup is treated as a failure, not a crash", async () => {
  const { b, painted } = harness(async () => { throw new Error("boom"); });
  b.schedule(1, { email: "x@y.se", name: "X" });
  await sleep(30);
  assert.equal(painted.at(-1).text, "!");
});

// Arrowing down a folder must not fire one request per row.
test("rapid message changes collapse to a single lookup", async () => {
  let calls = 0;
  const { b, painted } = harness(async () => { calls++; return 1; });
  for (const who of ["a", "b", "c", "d"]) b.schedule(1, { email: `${who}@x.se`, name: who });
  await sleep(40);
  assert.equal(calls, 1, `expected one lookup, got ${calls}`);
  assert.match(painted.at(-1).title, /for d/, "the last message should win");
});

test("a message with no sender clears the badge immediately", async () => {
  const { b, painted } = harness(async () => 5);
  b.schedule(1, null);
  assert.equal(painted.at(-1).text, "", "should clear without waiting");
  assert.equal(b.pending, 0);
});

test("a count above 99 does not overflow the badge", async () => {
  const { b, painted } = harness(async () => 250);
  b.schedule(1, { email: "busy@x.se", name: "Busy" });
  await sleep(30);
  assert.equal(painted.at(-1).text, "99");
  assert.match(painted.at(-1).title, /250 CRM records/, "the real number stays in the tooltip");
});

test("closing a tab cancels its pending lookup", async () => {
  let calls = 0;
  const { b } = harness(async () => { calls++; return 1; });
  b.schedule(7, { email: "a@x.se", name: "A" });
  b.cancel(7);
  await sleep(30);
  assert.equal(calls, 0);
});
