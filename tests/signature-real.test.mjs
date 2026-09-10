/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseContact, extractSignatureBlock } from "../src/lib/signature.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY = fs.readFileSync(path.join(HERE, "fixtures/threaded-reply.txt"), "utf8");
const AUTHOR = "Amrit Kaur <amrit.kaur@stonefields.example>";

// Shaped after a real threaded business reply that the parser got badly wrong:
// no "-- " delimiter, a greeting containing "KB", inline-image placeholders whose
// ids look like phone numbers, a certification line whose standard number looks
// like a postcode, and links wrapped in a tracking redirect.

test("the signature starts after the sign-off, not N lines from the end", () => {
  const { block, signOff, delimited } = extractSignatureBlock(BODY);
  assert.equal(delimited, false);
  assert.ok(signOff, "should have located the sign-off");
  assert.ok(!block.includes("Hi KB"), "greeting must not be in the signature");
  assert.ok(!block.includes("Vancouver"), "message body must not be in the signature");
  assert.ok(block.includes("Senior Manager"), "the real signature should be present");
});

test("the quoted reply below is never harvested", () => {
  const { block } = extractSignatureBlock(BODY);
  assert.ok(!block.includes("Kaare"), "quoted sender leaked into the signature");
  assert.ok(!block.includes("example-partner"), "quoted domain leaked in");
});

test("name and title are taken correctly", () => {
  const r = parseContact({ author: AUTHOR, bodyText: BODY });
  assert.equal(r.fields.first_name, "Amrit");
  assert.equal(r.fields.last_name, "Kaur");
  assert.equal(r.fields.title, "Senior Manager, Sales Operations");
});

// "KB" is a Swedish kommanditbolag and also somebody's initials. Matching a legal
// form anywhere in a line made the greeting "Hi KB," the company name.
test("a greeting containing a legal-form abbreviation is not a company", () => {
  const r = parseContact({ author: AUTHOR, bodyText: BODY });
  assert.notEqual(r.fields.account_name, "Hi KB,");
  assert.ok(!/^Hi\b/i.test(r.fields.account_name || ""), `got ${r.fields.account_name}`);
});

// [signature_4149225487] is an inline image placeholder, not a phone number.
test("inline image placeholders are never read as phone numbers", () => {
  const r = parseContact({ author: AUTHOR, bodyText: BODY });
  for (const f of ["phone_work", "phone_mobile", "phone_fax"]) {
    assert.equal(r.fields[f], undefined, `${f} was invented: ${r.fields[f]}`);
  }
});

// "ISO/IEC 27001 Lead Auditor" is a certification, not "27001, Lead Auditor".
test("a certification line is not read as a postal address", () => {
  const r = parseContact({ author: AUTHOR, bodyText: BODY });
  assert.equal(r.fields.primary_address_postalcode, undefined);
  assert.equal(r.fields.primary_address_city, undefined);
  assert.equal(r.fields.primary_address_street, undefined);
});

test("a tracking-wrapped link resolves to the real website", () => {
  const r = parseContact({ author: AUTHOR, bodyText: BODY });
  assert.match(r.fields.website, /stonefields\.example/);
  assert.ok(!r.fields.website.includes("google.com"), `wrapper kept: ${r.fields.website}`);
  assert.ok(!r.fields.website.includes("g2.com"), "picked the review link");
});

test("a company guessed from the domain is marked low confidence", () => {
  const r = parseContact({ author: AUTHOR, bodyText: BODY });
  assert.equal(r.fields.account_name, "Stonefields");
  assert.equal(r.confidence.account_name, "low");
  assert.ok(r.needsReview.includes("account_name"));
});

test("nothing uncertain is presented as certain", () => {
  const r = parseContact({ author: AUTHOR, bodyText: BODY });
  const high = Object.entries(r.confidence).filter(([, c]) => c === "high").map(([k]) => k);
  assert.deepEqual(high.sort(), ["email1", "first_name", "last_name"],
    "only header-derived facts should be high confidence");
});
