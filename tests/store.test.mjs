/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Preferences are read many times per archive. They are memoised, so the tests
 * that matter are about the copy being dropped when it should be — a stale
 * preference is worse than a slow one.
 */
function mockBrowser() {
  const data = new Map();
  const state = { reads: 0, listeners: [] };
  globalThis.browser = {
    storage: {
      local: {
        async get(key) {
          state.reads++;
          const out = {};
          for (const k of (Array.isArray(key) ? key : [key])) if (data.has(k)) out[k] = data.get(k);
          return out;
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
        async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) data.delete(k); },
      },
      onChanged: { addListener: (fn) => state.listeners.push(fn) },
    },
  };
  return { data, state };
}

test("repeated reads hit storage once", async () => {
  const { state } = mockBrowser();
  const store = await import(`../src/lib/store.js?case=${Math.random()}`);
  for (let i = 0; i < 10; i++) await store.getPrefs();
  assert.equal(state.reads, 1, `expected 1 storage read, got ${state.reads}`);
});

test("writing a preference is visible immediately", async () => {
  mockBrowser();
  const store = await import(`../src/lib/store.js?case=${Math.random()}`);
  await store.getPrefs();
  await store.setPrefs({ archiveAttachments: false });
  const after = await store.getPrefs();
  assert.equal(after.archiveAttachments, false, "the write must not be masked by the cache");
});

test("defaults survive a partial write", async () => {
  mockBrowser();
  const store = await import(`../src/lib/store.js?case=${Math.random()}`);
  await store.setPrefs({ archiveAttachments: false });
  const prefs = await store.getPrefs();
  assert.equal(prefs.archiveAttachments, false);
  assert.equal(prefs.showSenderBadge, true, "unrelated defaults must remain");
});

// The settings page and the popup are separate contexts writing the same key.
test("a change from another context drops the cached copy", async () => {
  const { data, state } = mockBrowser();
  const store = await import(`../src/lib/store.js?case=${Math.random()}`);
  await store.getPrefs();
  const before = state.reads;

  data.set("prefs", { archiveAttachments: false });
  for (const fn of state.listeners) fn({ prefs: { newValue: {} } }, "local");

  const after = await store.getPrefs();
  assert.ok(state.reads > before, "should have re-read after the change event");
  assert.equal(after.archiveAttachments, false);
});

test("a change to an unrelated key does not throw the copy away", async () => {
  const { state } = mockBrowser();
  const store = await import(`../src/lib/store.js?case=${Math.random()}`);
  await store.getPrefs();
  const before = state.reads;
  for (const fn of state.listeners) fn({ tokens: { newValue: {} } }, "local");
  await store.getPrefs();
  assert.equal(state.reads, before, "an unrelated key should not invalidate preferences");
});
