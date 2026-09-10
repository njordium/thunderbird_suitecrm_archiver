/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * The settings page offers to clear what the profile remembers about who you
 * have filed mail from. Two things have to hold for that button to be honest:
 * the count it shows must be the real one, and clearing must take both keys
 * and nothing else — losing the connection or the tokens would sign the user
 * out of their CRM for pressing a housekeeping button.
 *
 * The background is loaded with a storage that actually stores, so the
 * handlers run against real data rather than a stub that answers {}.
 */
function makeBrowser(seed = {}) {
  const data = structuredClone(seed);
  let listener = null;

  const local = {
    async get(key) {
      if (key === null || key === undefined) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(
        keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])
      );
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(key) { for (const k of [].concat(key)) delete data[k]; },
  };

  const inert = () => ({ addListener: () => {}, removeListener: () => {} });
  const nsProxy = () => new Proxy({}, {
    get(_t, key) {
      const k = String(key);
      if (k.startsWith("on")) return inert();
      if (["tags", "provider", "messageDisplay", "compose"].includes(k)) {
        return new Proxy({}, {
          get: (_a, k2) => (String(k2).startsWith("on") ? inert() : async () => ({})),
        });
      }
      return async () => ({});
    },
  });

  const browser = new Proxy({}, {
    get(_t, ns) {
      const name = String(ns);
      if (name === "storage") return { local, onChanged: inert() };
      if (name === "runtime") {
        return {
          onMessage: { addListener: (fn) => { listener = fn; } },
          getManifest: () => ({ version: "0", name: "test" }),
          sendMessage: async () => ({}),
          getURL: (p) => p,
          openOptionsPage: async () => {},
        };
      }
      return nsProxy(name);
    },
  });

  return {
    browser,
    data,
    async send(type, payload = {}) {
      assert.ok(listener, "the background never registered a message listener");
      const res = await listener({ type, payload }, {});
      assert.ok(res?.ok, `${type} failed: ${res?.error?.message}`);
      return res.result;
    },
  };
}

async function load(mock) {
  globalThis.browser = mock.browser;
  // A fresh query string defeats the module cache between cases.
  await import(`../src/background/index.js?history=${Math.random()}`);
  return mock;
}

const SEED = {
  connection: { baseUrl: "https://crm.example", clientId: "cid", clientSecret: "shh" },
  tokens: { refreshToken: "r", accessToken: "a" },
  prefs: { archiveAttachments: true },
  lastTargets: {
    "someone@example.com": { type: "Contacts", id: "1", label: "Someone", at: 1 },
    "other@example.com": { type: "Leads", id: "2", label: "Other", at: 2 },
  },
  recentArchives: [
    { subject: "Quote for the roof", module: "Accounts", id: "9", label: "Acme", at: 3 },
  ],
};

test("historySize reports what is actually stored", async () => {
  const mock = await load(makeBrowser(SEED));
  assert.deepEqual(await mock.send("historySize"), { targets: 2, recents: 1 });
});

test("historySize reports nothing on a profile that has filed nothing", async () => {
  const mock = await load(makeBrowser({ prefs: {} }));
  assert.deepEqual(await mock.send("historySize"), { targets: 0, recents: 0 });
});

test("clearHistory removes both keys", async () => {
  const mock = await load(makeBrowser(SEED));
  await mock.send("clearHistory");
  assert.ok(!("lastTargets" in mock.data), "the remembered records survived");
  assert.ok(!("recentArchives" in mock.data), "the Recent list survived");
  assert.deepEqual(await mock.send("historySize"), { targets: 0, recents: 0 });
});

test("clearHistory does not sign the user out or lose their settings", async () => {
  const mock = await load(makeBrowser(SEED));
  await mock.send("clearHistory");
  assert.deepEqual(mock.data.connection, SEED.connection, "the CRM connection was cleared too");
  assert.deepEqual(mock.data.tokens, SEED.tokens, "the tokens were cleared too");
  assert.deepEqual(mock.data.prefs, SEED.prefs, "the preferences were cleared too");
});

test("clearHistory on an empty profile is not an error", async () => {
  const mock = await load(makeBrowser({}));
  assert.deepEqual(await mock.send("clearHistory"), { targets: 0, recents: 0 });
});
