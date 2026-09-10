/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { timeAgo } from "../src/lib/humanTime.js";

const NOW = new Date("2026-09-09T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

test("recent times read as minutes and hours", () => {
  assert.equal(timeAgo(ago(30_000), NOW), "just now");
  assert.equal(timeAgo(ago(60_000), NOW), "1 minute ago");
  assert.equal(timeAgo(ago(5 * 60_000), NOW), "5 minutes ago");
  assert.equal(timeAgo(ago(3 * 3600_000), NOW), "3 hours ago");
});

test("days read naturally, with yesterday named", () => {
  assert.equal(timeAgo(ago(24 * 3600_000), NOW), "yesterday");
  assert.equal(timeAgo(ago(3 * 24 * 3600_000), NOW), "3 days ago");
  assert.equal(timeAgo(ago(20 * 24 * 3600_000), NOW), "20 days ago");
});

test("longer gaps collapse to months, then to a real date", () => {
  assert.equal(timeAgo(ago(60 * 24 * 3600_000), NOW), "2 months ago");
  assert.match(timeAgo(ago(500 * 24 * 3600_000), NOW), /\d/);
  assert.ok(!timeAgo(ago(500 * 24 * 3600_000), NOW).includes("ago"),
            "beyond a year the date itself is more useful");
});

test("the SuiteCRM date format is understood", () => {
  assert.equal(timeAgo("2026-09-06T12:00:00+00:00", NOW), "3 days ago");
});

test("nothing unparseable ever reaches the card", () => {
  assert.equal(timeAgo(null, NOW), "");
  assert.equal(timeAgo("", NOW), "");
  assert.equal(timeAgo("not a date", NOW), "");
});

test("a future date falls back to showing it rather than a negative age", () => {
  const future = new Date(NOW.getTime() + 86400_000).toISOString();
  const out = timeAgo(future, NOW);
  assert.ok(out && !out.includes("ago"), out);
});
