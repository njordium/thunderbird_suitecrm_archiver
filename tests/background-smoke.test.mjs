/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * The background script is a single top-level program: anything that throws
 * stops everything after it. Registering runtime.onMessage last meant one
 * optional listener failing left the popup with "Receiving end does not exist"
 * and the entire add-on dead.
 *
 * These load the real background entry point and assert the message listener
 * survives, however badly the rest of the environment behaves.
 */

const OPTIONAL_APIS = [
  "addressBooks", "compose", "messageDisplay", "tabs", "accounts",
  "scripting", "messages", "downloads",
];

function makeBrowser({ throwOn = [], missing = [] } = {}) {
  const state = { onMessageRegistered: false, registered: [] };
  const okListener = (name) => ({
    addListener: () => { state.registered.push(name); },
    removeListener: () => {},
  });
  const badListener = (name) => ({
    addListener: () => { throw new Error(`Permission denied for ${name}`); },
  });

  const nsProxy = (ns) => new Proxy({}, {
    get(_t, key) {
      const k = String(key);
      if (k.startsWith("on")) {
        return throwOn.includes(ns) ? badListener(ns) : okListener(`${ns}.${k}`);
      }
      if (["local", "tags", "provider", "messageDisplay", "compose"].includes(k)) {
        return new Proxy({}, {
          get: (_a, k2) => String(k2).startsWith("on")
            ? (throwOn.includes(ns) ? badListener(ns) : okListener(`${ns}.${k2}`))
            : async () => ({}),
        });
      }
      return async () => ({});
    },
  });

  return new Proxy({}, {
    get(_t, ns) {
      const name = String(ns);
      if (missing.includes(name)) return undefined;
      if (name === "runtime") {
        return {
          onMessage: { addListener: () => { state.onMessageRegistered = true; } },
          getManifest: () => ({ version: "0", name: "test" }),
          sendMessage: async () => ({}),
          getURL: (p) => p,
          openOptionsPage: async () => {},
        };
      }
      return nsProxy(name);
    },
  });
}

async function loadBackground(browserMock) {
  globalThis.browser = browserMock;
  // A fresh query string defeats the module cache between cases.
  await import(`../src/background/index.js?case=${Math.random()}`);
}

test("the background loads and answers messages in a normal profile", async () => {
  const b = makeBrowser();
  const state = { get onMessageRegistered() { return true; } };
  let registered = false;
  const wrapped = new Proxy({}, {
    get(_t, ns) {
      if (ns === "runtime") return {
        onMessage: { addListener: () => { registered = true; } },
        getManifest: () => ({ version: "0" }), sendMessage: async () => ({}), getURL: (p) => p,
      };
      return b[ns];
    },
  });
  await loadBackground(wrapped);
  assert.ok(registered, "runtime.onMessage was never registered");
  void state;
});

// This is the exact failure that broke the add-on: one optional API refusing.
for (const api of OPTIONAL_APIS) {
  test(`the message listener survives ${api} throwing on addListener`, async () => {
    const b = makeBrowser({ throwOn: [api] });
    let registered = false;
    const wrapped = new Proxy({}, {
      get(_t, ns) {
        if (ns === "runtime") return {
          onMessage: { addListener: () => { registered = true; } },
          getManifest: () => ({ version: "0" }), sendMessage: async () => ({}), getURL: (p) => p,
        };
        return b[ns];
      },
    });
    await loadBackground(wrapped);
    assert.ok(registered, `${api} throwing killed runtime.onMessage`);
  });
}

test("the message listener survives an API being absent entirely", async () => {
  const b = makeBrowser({ missing: ["addressBooks", "compose", "scripting"] });
  let registered = false;
  const wrapped = new Proxy({}, {
    get(_t, ns) {
      if (ns === "runtime") return {
        onMessage: { addListener: () => { registered = true; } },
        getManifest: () => ({ version: "0" }), sendMessage: async () => ({}), getURL: (p) => p,
      };
      return b[ns];
    },
  });
  await loadBackground(wrapped);
  assert.ok(registered, "a missing API killed runtime.onMessage");
});
