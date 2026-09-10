/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { senderAddress, sameSender, toCrmDateTime, normaliseMessageId, buildEmailAttributes, shouldBeDocument } from "../src/lib/archive.js";

test("senderAddress extracts the bare address from a From header", () => {
  assert.equal(senderAddress("Jane Doe <Jane@Acme.SE>"), "jane@acme.se");
  assert.equal(senderAddress("jane@acme.se"), "jane@acme.se");
  assert.equal(senderAddress('"Doe, Jane" <jane@acme.se>'), "jane@acme.se");
  assert.equal(senderAddress("mailto:jane@acme.se"), "jane@acme.se");
  assert.equal(senderAddress(""), "");
});

test("normaliseMessageId strips the angle brackets SuiteCRM does not store", () => {
  assert.equal(normaliseMessageId("<abc@example.com>"), "abc@example.com");
  assert.equal(normaliseMessageId("  <abc@example.com>  "), "abc@example.com");
  assert.equal(normaliseMessageId("abc@example.com"), "abc@example.com");
});

test("toCrmDateTime emits the UTC format the Emails bean stores", () => {
  assert.equal(toCrmDateTime(new Date("2026-09-09T14:58:26.123Z")), "2026-09-09 14:58:26");
  assert.equal(toCrmDateTime("not a date"), null);
});

// A Message-ID is chosen by the sender and unauthenticated, so a match alone must
// not be enough to re-parent an existing record.
test("a same-Message-ID record from a different sender is not treated as the same email", () => {
  const msg = { header: { author: "Jane Doe <jane@acme.se>" } };
  assert.equal(sameSender({ from_addr: "Attacker <evil@elsewhere.tld>" }, msg), false);
});

test("a same-Message-ID record from the same sender still de-duplicates", () => {
  const msg = { header: { author: "Jane Doe <jane@acme.se>" } };
  assert.equal(sameSender({ from_addr: "jane@acme.se" }, msg), true);
  assert.equal(sameSender({ from_addr: "Jane <JANE@ACME.SE>" }, msg), true);
});

test("a record with no recorded sender does not block de-duplication", () => {
  const msg = { header: { author: "Jane Doe <jane@acme.se>" } };
  assert.equal(sameSender({ from_addr: "" }, msg), true);
  assert.equal(sameSender({}, msg), true);
});

// The V8 API accepts from_addr on write but never returns it; from_addr_name is
// the readable one. Reading the wrong field yields undefined, which made this
// check accept every record.
test("the readable from_addr_name is used for the sender check", () => {
  const msg = { header: { author: "Jane <jane@acme.se>", date: new Date("2026-01-01T10:00:00Z") } };
  assert.equal(sameSender({ from_addr_name: "Jane Doe <jane@acme.se>" }, msg), true);
  assert.equal(sameSender({ from_addr_name: "evil@elsewhere.tld" }, msg), false);
});

test("when no sender is readable, the send time decides", () => {
  const msg = { header: { author: "Jane <jane@acme.se>", date: new Date("2026-01-01T10:00:00Z") } };
  assert.equal(sameSender({ date_sent_received: "2026-01-01T10:00:00+00:00" }, msg), true);
  assert.equal(sameSender({ date_sent_received: "2026-01-01T10:00:30+00:00" }, msg), true, "30s slack");
  assert.equal(sameSender({ date_sent_received: "2026-03-04T18:22:00+00:00" }, msg), false);
});

test("with neither sender nor date readable, de-duplication still happens", () => {
  const msg = { header: { author: "Jane <jane@acme.se>", date: new Date("2026-01-01T10:00:00Z") } };
  assert.equal(sameSender({}, msg), true);
});

test("an empty from_addr_name does not silently pass the sender check", () => {
  const msg = { header: { author: "Jane <jane@acme.se>", date: new Date("2026-01-01T10:00:00Z") } };
  // Falls through to the date, which disagrees.
  assert.equal(sameSender({ from_addr_name: "", date_sent_received: "2020-01-01T00:00:00+00:00" }, msg), false);
});

// SuiteCRM orders activity timelines by date_entered, so an email archived today
// appears under today's date unless the record is explicitly back-dated.
test("back-dating sets date_entered to the message's own send time", () => {
  const msg = {
    header: {
      subject: "Njordium PA-MNDA & VIS info",
      author: "Zoja <zoja@example.test>",
      date: new Date("2026-06-30T20:28:00Z"),
      recipients: [], ccList: [], bccList: [],
    },
    rfcMessageId: "abc@example.test",
    bodyText: "hi", bodyHtml: "",
  };

  const on = buildEmailAttributes(msg, { parentType: "Contacts", parentId: "c1", backdate: true });
  assert.equal(on.date_entered, "2026-06-30 20:28:00");
  assert.equal(on.date_sent_received, "2026-06-30 20:28:00");

  const off = buildEmailAttributes(msg, { parentType: "Contacts", parentId: "c1", backdate: false });
  assert.equal(off.date_entered, undefined, "the CRM should set it when back-dating is off");
  assert.equal(off.date_sent_received, "2026-06-30 20:28:00", "send time is always recorded");
});

test("an unparseable date never produces a bad date_entered", () => {
  const msg = {
    header: { subject: "x", author: "a@b.test", date: "not a date", recipients: [], ccList: [], bccList: [] },
    rfcMessageId: "x@y.test", bodyText: "", bodyHtml: "",
  };
  const attrs = buildEmailAttributes(msg, { parentType: "Leads", parentId: "l1", backdate: true });
  assert.equal(attrs.date_entered, undefined);
  assert.equal(attrs.date_sent_received, undefined);
});

// A contract belongs in Documents, where it is searchable and versioned;
// a screenshot pasted into a reply does not.
test("the default routes real documents to Documents and the rest to Notes", () => {
  for (const f of ["contract.pdf", "Quote.DOCX", "figures.xlsx", "deck.pptx", "notes.odt", "data.csv"]) {
    assert.equal(shouldBeDocument(f, "smart"), true, `${f} should be a Document`);
  }
  for (const f of ["screenshot.png", "logo.svg", "archive.zip", "notes.txt", "clip.mp4", ""]) {
    assert.equal(shouldBeDocument(f, "smart"), false, `${f} should be a Note`);
  }
});

test("the setting overrides the guess in both directions", () => {
  assert.equal(shouldBeDocument("screenshot.png", "always"), true);
  assert.equal(shouldBeDocument("contract.pdf", "never"), false);
});

test("an unknown setting falls back to the sensible default", () => {
  assert.equal(shouldBeDocument("contract.pdf", undefined), true);
  assert.equal(shouldBeDocument("screenshot.png", undefined), false);
});
