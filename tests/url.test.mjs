/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { normaliseBaseUrl, originPatternFor, UrlError } from "../src/lib/url.js";

test("normaliseBaseUrl adds a scheme and trims noise", () => {
  assert.equal(normaliseBaseUrl("crm.example.se"), "https://crm.example.se");
  assert.equal(normaliseBaseUrl("https://crm.example.se/"), "https://crm.example.se");
  assert.equal(normaliseBaseUrl("  http://10.0.0.1:8484/  "), "http://10.0.0.1:8484");
});

test("normaliseBaseUrl tolerates a pasted /index.php or API path", () => {
  assert.equal(normaliseBaseUrl("https://crm.example.se/index.php"), "https://crm.example.se");
  assert.equal(normaliseBaseUrl("https://crm.example.se/Api"), "https://crm.example.se");
  assert.equal(normaliseBaseUrl("https://crm.example.se/Api/V8"), "https://crm.example.se");
  assert.equal(normaliseBaseUrl("https://crm.example.se/legacy/Api"), "https://crm.example.se/legacy");
});

test("normaliseBaseUrl rejects an empty value", () => {
  assert.throws(() => normaliseBaseUrl(""), UrlError);
  assert.throws(() => normaliseBaseUrl("   "), UrlError);
});

// Firefox and Thunderbird reject a match pattern containing a port
// (https://bugzil.la/1362809). An invalid pattern makes permissions.request and
// permissions.contains THROW rather than return false, which previously left the
// add-on believing it had permission and failing later with a bare NetworkError.
test("the host permission pattern never contains a port", () => {
  assert.equal(originPatternFor("http://192.0.2.10:8484"), "http://192.0.2.10/*");
  assert.equal(originPatternFor("https://crm.example.se:8443/"), "https://crm.example.se/*");
  assert.equal(originPatternFor("https://crm.example.se"), "https://crm.example.se/*");
});

test("the pattern keeps the scheme, since http and https are separate grants", () => {
  assert.equal(originPatternFor("http://crm.example.se"), "http://crm.example.se/*");
  assert.equal(originPatternFor("https://crm.example.se"), "https://crm.example.se/*");
});

test("the pattern carries no path, even when the base URL has one", () => {
  assert.equal(originPatternFor("https://crm.example.se/legacy"), "https://crm.example.se/*");
});

test("a pattern is a shape Thunderbird accepts", () => {
  // scheme://host/* with no port, no userinfo, no query.
  for (const input of ["http://192.0.2.10:8484", "https://crm.example.se:9000/legacy"]) {
    const p = originPatternFor(input);
    assert.match(p, /^https?:\/\/[^/:?#]+\/\*$/, `bad pattern: ${p}`);
  }
});

// Add-on pages are secure contexts, so a plain http:// fetch from one is blocked
// as mixed content unless the host is potentially trustworthy. Only localhost
// and loopback qualify — a LAN address does not.
import { isTrustworthyPlaintext, isMixedContentRisk } from "../src/lib/url.js";

test("only localhost and loopback are trustworthy over plain http", () => {
  for (const h of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "::1"]) {
    assert.ok(isTrustworthyPlaintext(h), `${h} should be trustworthy`);
  }
  for (const h of ["192.0.2.10", "192.168.1.10", "crm.example.se", "example.com"]) {
    assert.ok(!isTrustworthyPlaintext(h), `${h} should not be trustworthy`);
  }
});

test("http to a LAN address is flagged as a mixed-content risk", () => {
  assert.equal(isMixedContentRisk("http://192.0.2.10:8484"), true);
  assert.equal(isMixedContentRisk("http://crm.example.se"), true);
});

test("https and localhost are not flagged", () => {
  assert.equal(isMixedContentRisk("https://192.0.2.10:8484"), false);
  assert.equal(isMixedContentRisk("https://crm.example.se"), false);
  assert.equal(isMixedContentRisk("http://localhost:8484"), false);
  assert.equal(isMixedContentRisk("http://127.0.0.1:8484"), false);
});
