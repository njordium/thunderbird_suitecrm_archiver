/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Site access asked for during a website check is borrowed, not kept.
 *
 * Without releasing it, the Permissions tab collects one standing entry per
 * sender ever checked — a growing permission surface for a one-second fetch
 * each. The CRM host is the exception: that one is genuinely ongoing.
 */

// Mirrors strayHostPermissions() in the background page.
function strayOrigins(granted, crmOrigin) {
  return granted.filter((o) => {
    if (o === crmOrigin) return false;
    if (o.includes("://*/") || o === "<all_urls>") return false;
    return true;
  });
}

test("a site checked once is stray; the CRM host is not", () => {
  const stray = strayOrigins(
    ["http://192.0.2.10/*", "https://www.oldsite.example/*", "https://acme.example/*"],
    "http://192.0.2.10/*",
  );
  assert.deepEqual(stray, ["https://www.oldsite.example/*", "https://acme.example/*"]);
});

// A wildcard is something the user chose deliberately, most likely to get past
// a permission prompt. Withdrawing it would break them out of spite.
test("a wildcard the user granted deliberately is left alone", () => {
  const stray = strayOrigins(
    ["http://*/*", "https://*/*", "<all_urls>", "https://acme.example/*"],
    "http://192.0.2.10/*",
  );
  assert.deepEqual(stray, ["https://acme.example/*"]);
});

test("nothing is stray when only the CRM host is held", () => {
  assert.deepEqual(strayOrigins(["http://192.0.2.10/*"], "http://192.0.2.10/*"), []);
});

test("with no CRM configured, a wildcard is still not touched", () => {
  const stray = strayOrigins(["http://*/*", "https://acme.example/*"], null);
  assert.deepEqual(stray, ["https://acme.example/*"]);
});

test("an empty grant list yields nothing to release", () => {
  assert.deepEqual(strayOrigins([], "http://crm.example/*"), []);
});
