/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { withTag, withoutTag, TAG_KEY } from "../src/lib/tagging.js";

test("the tag is added without disturbing existing tags", () => {
  assert.deepEqual(withTag(["$label1", "important"]), ["$label1", "important", TAG_KEY]);
});

test("tagging twice does not duplicate", () => {
  assert.deepEqual(withTag([TAG_KEY]), [TAG_KEY]);
  assert.deepEqual(withTag(["a", TAG_KEY, "b"]), ["a", TAG_KEY, "b"]);
});

test("an untagged message starts a fresh list", () => {
  assert.deepEqual(withTag([]), [TAG_KEY]);
  assert.deepEqual(withTag(undefined), [TAG_KEY]);
  assert.deepEqual(withTag(null), [TAG_KEY]);
});

test("removing the tag leaves the others alone", () => {
  assert.deepEqual(withoutTag(["$label1", TAG_KEY, "important"]), ["$label1", "important"]);
  assert.deepEqual(withoutTag(["$label1"]), ["$label1"]);
  assert.deepEqual(withoutTag(undefined), []);
});
