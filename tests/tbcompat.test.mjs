/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { unwrapMessageList } from "../src/lib/tbcompat.js";

// Thunderbird 128+ exposes only getDisplayedMessages() (plural), which returns a
// MessageList. The singular getDisplayedMessage() does not exist, and calling it
// throws "is not a function" — the shapes below are what each variant returns.

test("a MessageList yields its first message", () => {
  const list = { id: "list1", messages: [{ id: 7, subject: "a" }, { id: 8, subject: "b" }] };
  assert.equal(unwrapMessageList(list).id, 7);
});

test("a plain array yields its first message", () => {
  assert.equal(unwrapMessageList([{ id: 3 }, { id: 4 }]).id, 3);
});

test("a lone MessageHeader is returned as-is", () => {
  assert.equal(unwrapMessageList({ id: 42, subject: "solo" }).id, 42);
});

test("nothing displayed yields null rather than throwing", () => {
  assert.equal(unwrapMessageList(null), null);
  assert.equal(unwrapMessageList(undefined), null);
  assert.equal(unwrapMessageList([]), null);
  assert.equal(unwrapMessageList({ id: "list1", messages: [] }), null);
});

test("an object with neither messages nor an id yields null", () => {
  assert.equal(unwrapMessageList({ totalMessages: 0 }), null);
});

test("message id 0 is not mistaken for absent", () => {
  assert.equal(unwrapMessageList({ id: 0, subject: "zero" }).subject, "zero");
});
