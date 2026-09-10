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

// --- the array form ---------------------------------------------------------

// These two helpers exist separately because confusing them is not
// hypothetical: using the single-header one where an array was meant made
// `.length` undefined, `[0]` undefined and destructuring throw, which silently
// disabled a context menu, two of its entries, a keyboard shortcut and the
// in-message banner without one error surfacing.
test("unwrapMessageListAll always returns an array", async () => {
  const { unwrapMessageListAll } = await import("../src/lib/tbcompat.js");
  for (const input of [null, undefined, "", 0, false, {}, { messages: [] }, []]) {
    const out = unwrapMessageListAll(input);
    assert.ok(Array.isArray(out), `${JSON.stringify(input)} did not give an array`);
    assert.equal(out.length, 0);
  }
});

test("unwrapMessageListAll keeps every message, not just the first", async () => {
  const { unwrapMessageListAll } = await import("../src/lib/tbcompat.js");
  const three = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(unwrapMessageListAll({ id: "list", messages: three }), three);
  assert.deepEqual(unwrapMessageListAll(three), three);
});

test("unwrapMessageListAll wraps a lone header", async () => {
  const { unwrapMessageListAll } = await import("../src/lib/tbcompat.js");
  assert.deepEqual(unwrapMessageListAll({ id: 7, subject: "x" }), [{ id: 7, subject: "x" }]);
});

test("the two helpers agree on which message comes first", async () => {
  const { unwrapMessageList, unwrapMessageListAll } = await import("../src/lib/tbcompat.js");
  for (const input of [{ id: "l", messages: [{ id: 5 }, { id: 6 }] }, [{ id: 5 }], { id: 5 }]) {
    assert.deepEqual(unwrapMessageListAll(input)[0], unwrapMessageList(input));
  }
});

// The exact shapes each caller relies on, so the misuse cannot come back.
test("an array result supports the operations the callers perform", async () => {
  const { unwrapMessageListAll } = await import("../src/lib/tbcompat.js");
  const out = unwrapMessageListAll({ id: "l", messages: [{ id: 1 }] });
  assert.equal(out.length, 1, "the menu tests .length");
  assert.equal(out[0].id, 1, "the banner indexes [0]");
  const [first] = out;
  assert.equal(first.id, 1, "the shortcut destructures");
  assert.deepEqual(out.map((h) => h.id), [1], "the menu maps over it");
});
