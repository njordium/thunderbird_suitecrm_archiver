/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { stripSecrets, maskEmails, maskId, maskHost } from "../src/lib/diagnostics.js";

test("stripSecrets removes bearer tokens", () => {
  const out = stripSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.sIgNaTuRe");
  assert.ok(!out.includes("sIgNaTuRe"), out);
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"), out);
});

test("stripSecrets removes JSON credential fields", () => {
  const body = JSON.stringify({
    grant_type: "password",
    client_id: "00000000-1111-2222",
    client_secret: "0123456789abcdef0123456789abcdef",
    username: "kim@example.se",
    password: "hunter2!",
  });
  const out = stripSecrets(body);
  assert.ok(!out.includes("hunter2!"), out);
  assert.ok(!out.includes("0123456789abcdef0123456789abcdef"), out);
  assert.ok(out.includes("grant_type"), "non-secret fields survive");
});

test("stripSecrets removes access and refresh tokens by name", () => {
  const out = stripSecrets('{"access_token":"abc123XYZ","refresh_token":"def456UVW"}');
  assert.ok(!out.includes("abc123XYZ"), out);
  assert.ok(!out.includes("def456UVW"), out);
});

test("stripSecrets removes long opaque hex blobs", () => {
  const secret = "a".repeat(48);
  assert.ok(!stripSecrets(`secret is ${secret} ok`).includes(secret));
});

test("stripSecrets leaves ordinary text and short ids alone", () => {
  const text = "GET /Api/V8/module/Contacts HTTP 200 in 42ms";
  assert.equal(stripSecrets(text), text);
});

test("maskEmails keeps the domain but hides the person", () => {
  assert.equal(maskEmails("jane.doe@acme.se"), "j***@acme.se");
  assert.equal(maskEmails("From: Jane <jane.doe@acme.se> to bob@other.com"),
               "From: Jane <j***@acme.se> to b***@other.com");
});

test("maskEmails is a no-op on text without addresses", () => {
  assert.equal(maskEmails("no addresses here"), "no addresses here");
});

test("maskId keeps a comparable prefix only", () => {
  assert.equal(maskId("00000000-1111-2222-3333-444444444444"), "00000000…(36 chars)");
  assert.equal(maskId("short", 8), "short");
  assert.equal(maskId(""), "");
});

test("maskHost keeps scheme, port and path but not the host", () => {
  assert.equal(maskHost("http://192.0.2.10:8484/Api"), "http://<host>:8484/Api");
  assert.equal(maskHost("https://crm.example.se/legacy/Api"), "https://<host>/legacy/Api");
  assert.equal(maskHost("not a url"), "<url>");
});

test("a realistic failing request survives redaction with nothing sensitive left", () => {
  const line = 'POST http://192.0.2.10:8484/Api/access_token {"grant_type":"password",' +
               '"username":"user@crm.example","password":"hunter2-not-a-real-password","client_secret":"deadbeef1234"}';
  const out = maskEmails(stripSecrets(line));
  assert.ok(!out.includes("hunter2-not-a-real-password"), out);
  assert.ok(!out.includes("deadbeef1234"), out);
  assert.ok(!out.includes("user@crm.example"), out);
  assert.ok(out.includes("access_token"), "the endpoint stays visible for debugging");
});

// ---------------------------------------------------------------------------
// Whole-report redaction
//
// The helpers above were tested in isolation, which is exactly why a bypass
// survived: recorded URLs are percent-encoded, so `@` arrives as `%40` and the
// masking pattern never matched. The report told the user addresses were
// masked while printing them verbatim. These test the artifact itself.
// ---------------------------------------------------------------------------

import { buildReport, recordRequest, record, setEnabled, clear, decodePercent } from "../src/lib/diagnostics.js";

globalThis.browser = {
  storage: { local: { async set() {}, async get() { return {}; }, async remove() {} } },
};

const CTX = {
  addon: { name: "test", version: "0.0.0", id: "t@example" },
  prefs: { username: "kim@company.example", logLevel: "debug" },
  connection: null,
};

async function reportWith(fn, opts = {}) {
  await clear();
  setEnabled(true);
  fn();
  return buildReport(CTX, opts);
}

test("decodePercent reverses the encoding that hid addresses", () => {
  assert.equal(decodePercent("ceo%40target.example"), "ceo@target.example");
  assert.equal(decodePercent("ceo%2540target.example"), "ceo@target.example", "double-encoded too");
  assert.equal(decodePercent("plain text"), "plain text");
  assert.equal(decodePercent("%E0%A4%A"), "%E0%A4%A", "malformed input must not throw");
});

test("an address inside a recorded URL is masked", async () => {
  const out = await reportWith(() => recordRequest({
    method: "GET", status: 200, ms: 12,
    url: "http://crm.example/Api/V8/module/Contacts?filter%5Bemail1%5D%5Beq%5D=ceo%40target.example",
  }));
  assert.ok(!out.includes("ceo@target.example"), "the address appeared in the report");
  assert.ok(!out.includes("ceo%40target.example"), "the encoded address appeared in the report");
  assert.ok(out.includes("c***@target.example"), `expected a masked address:\n${out}`);
});

test("a double-encoded address is masked too", async () => {
  const out = await reportWith(() => recordRequest({
    method: "GET", url: "http://crm.example/x?q=ceo%2540target.example", status: 200,
  }));
  assert.ok(!/ceo@target|ceo%40target|ceo%2540target/.test(out), out);
});

test("a domain-wide filter does not disclose the domain's addresses", async () => {
  const out = await reportWith(() => recordRequest({
    method: "GET", status: 200,
    url: "http://crm.example/Api/V8/module/Accounts?filter%5Bemail1%5D%5Blike%5D=%25%40customer.example",
  }));
  // The domain itself is useful for debugging and is not an address; what must
  // not appear is a complete address.
  assert.ok(!/[A-Za-z0-9._-]+@customer\.example/.test(out.replace(/%@customer\.example/g, "")),
            `an address leaked:\n${out}`);
});

test("settings go through the same redaction as everything else", async () => {
  const out = await reportWith(() => record("info", ["ready"]));
  assert.ok(!out.includes("kim@company.example"), "a preference disclosed an address");
  assert.ok(out.includes("k***@company.example"), `expected the masked form:\n${out}`);
});

test("opting in really does include addresses, so the control is not decorative", async () => {
  const out = await reportWith(() => recordRequest({
    method: "GET", status: 200, url: "http://crm.example/x?q=ceo%40target.example",
  }), { includeEmails: true });
  assert.ok(out.includes("ceo@target.example"), "opting in should include the real address");
});

test("no secret survives into the report, however it was encoded", async () => {
  const out = await reportWith(() => {
    record("debug", ['{"client_secret":"0123456789abcdef0123456789abcdef0123456789abcdef"}']);
    record("debug", ["Authorization: Bearer eyJhbGciOiJI.UzI1NiIsInR5cCI6.IkpXVCJ9"]);
    recordRequest({ method: "POST", url: "http://crm.example/Api/access_token", status: 200 });
  });
  assert.ok(!out.includes("0123456789abcdef0123456789abcdef"), "a client secret leaked");
  assert.ok(!out.includes("eyJhbGciOiJI.UzI1NiIsInR5cCI6.IkpXVCJ9"), "a bearer token leaked");
});

// Decoding happens in two places: when a request is recorded, and again when
// the report is built. That redundancy is deliberate, but it also means a test
// that only exercises recordRequest passes even when the report-time decode is
// removed. This one reaches scrub() with the encoding intact, so it fails if
// either layer goes.
test("an encoded address in a plain log line is masked at report time", async () => {
  const out = await reportWith(() =>
    record("debug", ["GET /module/Contacts?filter[email1][eq]=ceo%40target.example"]));
  assert.ok(!out.includes("ceo@target.example"), `decoded address leaked:\n${out}`);
  assert.ok(!out.includes("ceo%40target.example"), `encoded address leaked:\n${out}`);
  assert.ok(out.includes("c***@target.example"), `expected the masked form:\n${out}`);
});

// --- the CRM host must not survive its own masking -------------------------

// Found by security review. The granted permission pattern is built without a
// port on purpose (see originPatternFor), while URL.host carries one, so on a
// CRM at a non-default port neither the base URL nor the host matched the
// pattern, and the "hosts" line printed the real hostname under a header
// promising it was masked. The common case, a CRM on 80 or 443, was masked
// correctly, which is why it went unnoticed.
test("the CRM hostname is masked even on a non-default port", async () => {
  const { originPatternFor } = await import("../src/lib/url.js");

  for (const base of ["https://crm.corp.internal:8443", "http://192.0.2.10:8484"]) {
    setEnabled(true);
    clear();
    const out = await buildReport({
      permissions: { permissions: ["storage"], origins: [originPatternFor(base)] },
      connection: { baseUrl: base, apiBase: base + "/Api" },
    }, { includeHost: false, includeEmails: false });

    const { hostname } = new URL(base);
    assert.ok(!out.includes(hostname), `${hostname} survived masking:\n${out}`);
  }
});

test("asking for the host still gets the host", async () => {
  setEnabled(true);
  clear();
  const out = await buildReport({
    connection: { baseUrl: "https://crm.corp.internal:8443" },
  }, { includeHost: true, includeEmails: false });
  assert.ok(out.includes("crm.corp.internal"), "masking must be opt-out, not unconditional");
});

test("a hostname typed in another case is still masked", async () => {
  setEnabled(true);
  clear();
  record("debug", ["contacting CRM.Corp.Internal:8443 now"]);
  const out = await buildReport({
    connection: { baseUrl: "https://crm.corp.internal:8443" },
  }, { includeHost: false, includeEmails: false });
  assert.ok(!/crm\.corp\.internal/i.test(out), `case-varied hostname survived:\n${out}`);
});

test("percent-encoding is decoded however deeply it was applied", async () => {
  const { decodePercent } = await import("../src/lib/diagnostics.js");
  assert.equal(decodePercent("a%40b"), "a@b");
  assert.equal(decodePercent("a%2540b"), "a@b");
  assert.equal(decodePercent("a%25252540b"), "a@b");
});

// --- turning logging off must leave nothing behind ------------------------

// Found while documenting what the add-on stores. setEnabled(false) stopped
// recording but left up to MAX_EVENTS entries in the profile until someone
// pressed Clear, so the switch implied more than it did. Nothing secret was in
// there (secrets are never recorded), but email addresses and CRM URLs were.
test("disabling detailed logging clears what was already recorded", async () => {
  setEnabled(true);
  clear();
  record("debug", ["contacting crm.example for user@crm.example"]);
  record("debug", ["a second entry"]);

  const { size } = await import("../src/lib/diagnostics.js");
  assert.ok(size() > 0, "precondition: something was recorded");

  await setEnabled(false);
  assert.equal(size(), 0, "the buffer must be empty after disabling");

  const after = await buildReport({}, { includeHost: true, includeEmails: true });
  assert.ok(!after.includes("user@crm.example"),
    `a disabled log still carried its entries:\n${after}`);
});

test("disabling also removes the persisted copy, not just the buffer", async () => {
  const removed = [];
  const real = globalThis.browser;
  globalThis.browser = {
    storage: { local: {
      get: async () => ({}),
      set: async () => {},
      remove: async (k) => { removed.push(k); },
    } },
  };
  try {
    setEnabled(true);
    record("debug", ["something"]);
    await setEnabled(false);
    assert.ok(removed.includes("debugLog"),
      `storage.local.remove was not called with debugLog (got ${JSON.stringify(removed)})`);
  } finally {
    globalThis.browser = real;
  }
});

test("enabling still records that it was enabled", async () => {
  await setEnabled(false);
  await setEnabled(true);
  const { size } = await import("../src/lib/diagnostics.js");
  assert.ok(size() > 0, "enabling should leave its own marker so the log is never empty-looking");
});
