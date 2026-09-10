/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyAttempt, describeProbe, API_SUFFIXES } from "../src/lib/probe.js";

// The exact body a stock SuiteCRM 7.x returns for the probe's invalid client id.
// Captured from a live instance, HTTP 500 and all.
const SUITECRM_500 = JSON.stringify({
  error: "unknown_error",
  error_description: "OAuth2Clients module with id __probe__ is not found",
  message: "OAuth2Clients module with id __probe__ is not found",
});

const ok = (extra = {}) => ({
  base: "http://192.0.2.10:8484",
  origin: "http://192.0.2.10/*",
  hostname: "192.0.2.10",
  port: "8484",
  granted: true,
  insecure: true,
  mixedContentRisk: true,
  attempts: [{
    url: "http://192.0.2.10:8484/Api/access_token",
    reached: true, status: 500, body: SUITECRM_500,
  }],
  ...extra,
});

// --- classifyAttempt --------------------------------------------------------

test("SuiteCRM's HTTP 500 for an invalid client means the API is live", () => {
  const c = classifyAttempt({ reached: true, status: 500, body: SUITECRM_500 });
  assert.equal(c.live, true, "a JSON OAuth error is proof of a working endpoint");
  assert.match(c.headline, /expected/, "the status must be labelled expected, not left bare");
  assert.match(c.detail, /not a fault/i, "the user has to be told it is not a fault");
});

test("a 401 invalid_client is equally proof of a live endpoint", () => {
  const c = classifyAttempt({
    reached: true, status: 401,
    body: JSON.stringify({ error: "invalid_client", message: "Client authentication failed" }),
  });
  assert.equal(c.live, true);
});

test("an HTML error page means the API is not at this path", () => {
  const c = classifyAttempt({ reached: true, status: 404, body: "<!DOCTYPE html><h1>Not Found</h1>" });
  assert.equal(c.live, false);
  assert.match(c.headline, /not the V8 API/);
});

test("a 200 with no JSON at all is still not the API", () => {
  assert.equal(classifyAttempt({ reached: true, status: 200, body: "OK" }).live, false);
});

test("a connection failure carries its own error text", () => {
  const c = classifyAttempt({ reached: false, error: "NetworkError when attempting to fetch" });
  assert.equal(c.live, false);
  assert.match(c.detail, /NetworkError/);
});

test("a missing attempt does not throw", () => {
  assert.equal(classifyAttempt(undefined).live, false);
  assert.equal(classifyAttempt({ reached: true, status: 500, body: undefined }).live, false);
});

// --- describeProbe: the reached-and-granted case -----------------------------

test("reached and granted reads as success, with no remedial advice", () => {
  const r = describeProbe(ok());
  assert.equal(r.tone, "ok");
  assert.match(r.verdict, /answered at http:\/\/192\.0\.2\.10:8484\/Api/);
  assert.match(r.verdict, /Nothing is blocking/);
  assert.deepEqual(r.fixes, [], "a working connection must not be given things to fix");
});

test("success does not describe the server as a problem", () => {
  const { verdict } = describeProbe(ok());
  for (const word of ["not granted", "refused", "blocked", "failed", "error"]) {
    assert.doesNotMatch(verdict, new RegExp(word, "i"), `"${word}" has no place in a success verdict`);
  }
});

test("the api path is reported so the user knows which layout was found", () => {
  const rows = Object.fromEntries(describeProbe(ok()).rows.map(([k, v]) => [k, v]));
  assert.equal(rows["api path"], "/Api");
});

test("a /legacy/Api instance is reported as such", () => {
  const r = describeProbe(ok({
    attempts: [
      { url: "http://h:8484/Api/access_token", reached: true, status: 404, body: "<html>no</html>" },
      { url: "http://h:8484/legacy/Api/access_token", reached: true, status: 500, body: SUITECRM_500 },
    ],
    base: "http://h:8484",
  }));
  assert.equal(r.tone, "ok");
  const rows = Object.fromEntries(r.rows.map(([k, v]) => [k, v]));
  assert.equal(rows["api path"], "/legacy/Api");
});

// --- describeProbe: the reached-but-ungranted case ---------------------------

test("reached but ungranted leads with the server being fine", () => {
  const r = describeProbe(ok({ granted: false }));
  assert.equal(r.tone, "warn", "not a failure — nothing is broken");
  assert.match(r.verdict, /The server is fine/);
  assert.match(r.verdict, /one step left/);
});

test("after prompting, the advice is to accept the prompt — not to press Sign in", () => {
  const r = describeProbe(ok({ granted: false }), { askedNow: true });
  assert.match(r.fixes[0], /choose Allow/);
  assert.doesNotMatch(r.fixes[0], /Press Sign in/,
    "telling someone to trigger a prompt they just dismissed is no help");
});

test("without prompting, the advice points at Sign in", () => {
  const r = describeProbe(ok({ granted: false }), { askedNow: false });
  assert.match(r.fixes[0], /Press Sign in/);
});

// --- describeProbe: genuine failures ----------------------------------------

const unreachable = (extra = {}) => ok({
  attempts: [
    { url: "http://192.0.2.10:8484/Api/access_token", reached: false, error: "NetworkError" },
    { url: "http://192.0.2.10:8484/legacy/Api/access_token", reached: false, error: "NetworkError" },
  ],
  ...extra,
});

test("nothing reached and no access names the permission first", () => {
  const r = describeProbe(unreachable({ granted: false }));
  assert.equal(r.tone, "bad");
  assert.match(r.verdict, /has not been granted access/);
});

test("nothing reached with access granted blames the network, not the permission", () => {
  const r = describeProbe(unreachable({ granted: true }));
  assert.equal(r.tone, "bad");
  assert.doesNotMatch(r.verdict, /permission|granted access/i);
  assert.match(r.verdict, /did not answer/);
  assert.ok(r.fixes.some((f) => f.includes("8484")), "the port is the useful detail here");
});

test("an http failure explains the CSP rewrite and offers the port forward", () => {
  const r = describeProbe(unreachable({ granted: true, insecure: true }));
  assert.ok(r.fixes.some((f) => f.includes("upgrade-insecure-requests")));
  assert.ok(r.fixes.some((f) => f.includes("ssh -L 8484:localhost:8484")));
});

// --- rows -------------------------------------------------------------------

test("transport is one row, not a duplicated risk warning", () => {
  const labels = describeProbe(ok()).rows.map(([k]) => k);
  assert.equal(labels.filter((l) => /transport|plaintext/.test(l)).length, 1);
});

test("http to a remote host says the password crosses in the clear", () => {
  const rows = Object.fromEntries(describeProbe(ok()).rows.map(([k, v]) => [k, v]));
  assert.match(rows.transport, /in the clear/);
});

test("http to localhost is not treated as a risk", () => {
  const rows = Object.fromEntries(describeProbe(ok({
    base: "http://localhost:8484", hostname: "localhost", mixedContentRisk: false,
  })).rows.map(([k, v]) => [k, v]));
  assert.match(rows.transport, /localhost/);
  assert.doesNotMatch(rows.transport, /in the clear/);
});

test("https is reported as encrypted with no caveat", () => {
  const rows = Object.fromEntries(describeProbe(ok({
    insecure: false, mixedContentRisk: false,
  })).rows.map(([k, v]) => [k, v]));
  assert.equal(rows.transport, "https — encrypted");
});

test("the access row names the host, and its tone follows the state", () => {
  const [label, value, tone] = describeProbe(ok()).rows[0];
  assert.equal(label, "access to 192.0.2.10");
  assert.equal(value, "granted");
  assert.equal(tone, "ok");
  assert.equal(describeProbe(ok({ granted: false })).rows[0][2], "warn");
});

test("api suffixes are shared, in discovery order", () => {
  assert.deepEqual(API_SUFFIXES, ["/Api", "/legacy/Api"]);
});
