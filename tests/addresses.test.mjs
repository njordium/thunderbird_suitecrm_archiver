/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMailbox, splitAddressList, buildCandidates, domainOf, isConsumerDomain, isNoReply,
} from "../src/lib/addresses.js";

test("parseMailbox handles plain, angled and quoted forms", () => {
  assert.deepEqual(parseMailbox("jane@acme.se"), { name: "", email: "jane@acme.se" });
  assert.deepEqual(parseMailbox("Jane Doe <Jane@Acme.SE>"), { name: "Jane Doe", email: "jane@acme.se" });
  assert.deepEqual(parseMailbox('"Doe, Jane" <jane@acme.se>'), { name: "Doe, Jane", email: "jane@acme.se" });
  assert.deepEqual(parseMailbox('"Jane \\"JD\\" Doe" <jane@acme.se>'), { name: 'Jane "JD" Doe', email: "jane@acme.se" });
});

test("parseMailbox rejects malformed input", () => {
  assert.equal(parseMailbox(""), null);
  assert.equal(parseMailbox("not an address"), null);
  assert.equal(parseMailbox("<>"), null);
});

test("parseMailbox drops a display name that merely repeats the address", () => {
  assert.deepEqual(parseMailbox("jane@acme.se <jane@acme.se>"), { name: "", email: "jane@acme.se" });
});

test("splitAddressList ignores commas inside quotes and angle brackets", () => {
  assert.deepEqual(
    splitAddressList('"Doe, Jane" <jane@acme.se>, Bob <bob@acme.se>'),
    ['"Doe, Jane" <jane@acme.se>', "Bob <bob@acme.se>"]
  );
});

test("domain helpers", () => {
  assert.equal(domainOf("Jane@Acme.SE"), "acme.se");
  assert.ok(isConsumerDomain("gmail.com"));
  assert.ok(!isConsumerDomain("acme.se"));
  assert.ok(isNoReply("no-reply@acme.se"));
  assert.ok(isNoReply("donotreply@acme.se"));
  assert.ok(!isNoReply("jane@acme.se"));
});

test("buildCandidates groups colleagues by the target's domain", () => {
  const c = buildCandidates({
    author: "Jane Doe <jane@acme.se>",
    recipients: ["Me <me@mine.se>"],
    ccList: ["Bob <bob@acme.se>", "Zoe <zoe@other.com>"],
  }, { ownAddresses: ["me@mine.se"] });

  assert.equal(c.primary.email, "jane@acme.se");
  assert.equal(c.sentByMe, false);
  assert.deepEqual(c.sameDomain.map((x) => x.email), ["bob@acme.se"]);
  assert.deepEqual(c.otherDomain.map((x) => x.email), ["zoe@other.com"]);
  assert.deepEqual(c.excludedSelf.map((x) => x.email), ["me@mine.se"]);
  assert.ok(c.groupable);
});

// To: is who the message was addressed to, so it outranks Cc: in the picker.
test("To: recipients are listed before Cc: recipients", () => {
  const c = buildCandidates({
    author: "Jane <jane@acme.se>",
    recipients: ["Carl <carl@acme.se>", "Dora <dora@acme.se>"],
    ccList: ["Bob <bob@acme.se>"],
  }, { ownAddresses: [] });

  assert.deepEqual(c.sameDomain.map((x) => x.email),
                   ["carl@acme.se", "dora@acme.se", "bob@acme.se"]);
  assert.deepEqual(c.sameDomain.map((x) => x.role), ["to", "to", "cc"]);
});

test("To: recipients are offered even when Cc: is switched off", () => {
  const c = buildCandidates({
    author: "Jane <jane@acme.se>",
    recipients: ["Carl <carl@acme.se>"],
    ccList: ["Bob <bob@acme.se>"],
  }, { ownAddresses: [], includeCc: false });

  assert.deepEqual(c.sameDomain.map((x) => x.email), ["carl@acme.se"]);
  assert.ok(!c.sameDomain.some((x) => x.email === "bob@acme.se"), "Cc should be excluded");
});

// On a message you sent, the sender is you and worth nothing to the CRM; the
// recipient is the contact.
test("on your own sent mail the first To: recipient becomes the target", () => {
  const c = buildCandidates({
    author: "Me <me@mine.se>",
    recipients: ["Carl <carl@acme.se>", "Dora <dora@acme.se>"],
    ccList: ["Bob <bob@acme.se>"],
  }, { ownAddresses: ["me@mine.se"] });

  assert.ok(c.sentByMe);
  assert.equal(c.primary.email, "carl@acme.se");
  assert.equal(c.senderDomain, "acme.se", "grouping follows the target, not the sender");
  assert.deepEqual(c.sameDomain.map((x) => x.email), ["dora@acme.se", "bob@acme.se"]);
  assert.ok(!c.sameDomain.some((x) => x.email === "me@mine.se"), "never offer myself");
});

test("sent mail with only my own addresses yields no usable target", () => {
  const c = buildCandidates({
    author: "Me <me@mine.se>",
    recipients: ["Me <me@mine.se>"],
  }, { ownAddresses: ["me@mine.se"] });
  assert.ok(c.sentByMe);
  assert.equal(c.primary.email, "me@mine.se", "falls back to the sender rather than nothing");
  assert.equal(c.sameDomain.length, 0);
});

test("buildCandidates refuses to treat a consumer domain as a company", () => {
  const c = buildCandidates({
    author: "Jane <jane@gmail.com>",
    ccList: ["Stranger <bob@gmail.com>"],
  }, { ownAddresses: [] });

  assert.ok(!c.groupable);
  assert.equal(c.sameDomain.length, 0, "gmail users must not be grouped as colleagues");
  assert.deepEqual(c.otherDomain.map((x) => x.email), ["bob@gmail.com"]);
});

test("buildCandidates never lists the target twice or repeats an address", () => {
  const c = buildCandidates({
    author: "Jane <jane@acme.se>",
    recipients: ["Jane <jane@acme.se>", "Bob <bob@acme.se>"],
    ccList: ["Bob <bob@acme.se>"],
  }, { ownAddresses: [] });

  const emails = [...c.sameDomain, ...c.otherDomain].map((x) => x.email);
  assert.deepEqual(emails, ["bob@acme.se"]);
});
