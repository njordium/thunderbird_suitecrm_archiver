/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { recordToVCard, escapeValue, usableForAddressBook } from "../src/lib/vcard.js";

test("delimiters in a value are escaped, not left to split the field", () => {
  // Written with explicit char codes: the previous version asserted "a\;b",
  // which in a JS literal is just "a;b" — the same mistake the implementation
  // made, so the test passed while the escape did nothing.
  const BS = String.fromCharCode(92);

  assert.equal(escapeValue("Lots Ekonomi, AB"), `Lots Ekonomi${BS}, AB`);
  assert.equal(escapeValue("a;b"), `a${BS};b`);
  assert.equal(escapeValue("line1\nline2"), `line1${BS}nline2`);
  assert.equal(escapeValue("back" + BS + "slash"), `back${BS}${BS}slash`);

  // A bare carriage return must fold into the same escape, not survive raw.
  assert.equal(escapeValue("a\r\nb"), `a${BS}nb`);
  assert.equal(escapeValue("a\rb"), `a${BS}nb`);
  assert.ok(!escapeValue("a\rb").includes("\r"), "a raw CR must not reach the vCard");
});

// N and ORG are semicolon-delimited, so an unescaped semicolon in a name
// shifts every following component.
test("a semicolon in a name does not shift the N and ORG components", () => {
  const v = recordToVCard({
    first_name: "Jane", last_name: "Doe;X;Dr;PhD",
    email1: "j@x.example", account_name: "Acme;Evil Unit",
  });
  const n = v.split("\r\n").find((l) => l.startsWith("N:"));
  const org = v.split("\r\n").find((l) => l.startsWith("ORG:"));

  // Exactly four delimiters in N — family;given;additional;prefixes;suffixes.
  const unescapedSemis = (line) => line.replace(/\\;/g, "").split(";").length - 1;
  assert.equal(unescapedSemis(n), 4, `N has the wrong component count: ${n}`);
  assert.equal(unescapedSemis(org), 0, `ORG gained a component: ${org}`);
});

test("a contact becomes a complete vCard", () => {
  const v = recordToVCard({
    module: "Contacts", id: "c1",
    first_name: "Anna", last_name: "Lindqvist",
    email1: "anna@nordwind.example", account_name: "Nordwind Solutions AB",
    title: "CTO", phone_work: "+46 8 555 010 20", phone_mobile: "+46 70 123 45 67",
  });
  assert.match(v, /^BEGIN:VCARD\r\nVERSION:4\.0/);
  assert.match(v, /\r\nN:Lindqvist;Anna;;;/);
  assert.match(v, /\r\nFN:Anna Lindqvist/);
  assert.match(v, /\r\nEMAIL:anna@nordwind\.example/);
  assert.match(v, /\r\nORG:Nordwind Solutions AB/);
  assert.match(v, /\r\nTEL;TYPE=cell:\+46 70 123 45 67/);
  assert.match(v, /\r\nUID:suitecrm-Contacts-c1/);
  assert.match(v, /\r\nEND:VCARD$/);
});

test("a company name containing a comma does not corrupt the card", () => {
  const v = recordToVCard({ last_name: "Doe", email1: "d@x.example", account_name: "Acme, Inc" });
  assert.match(v, /ORG:Acme\\, Inc/);
});

test("missing fields are omitted rather than emitted empty", () => {
  const v = recordToVCard({ last_name: "Solo", email1: "solo@x.example" });
  assert.ok(!v.includes("ORG:"), "an absent company should not appear");
  assert.ok(!v.includes("TITLE:"), "an absent title should not appear");
  assert.match(v, /FN:Solo/);
});

test("a record with only a company name still gets a display name", () => {
  const v = recordToVCard({ name: "Nordwind Solutions AB", email1: "info@x.example" });
  assert.match(v, /FN:Nordwind Solutions AB/);
});

test("only records with an address are worth offering for autocomplete", () => {
  assert.ok(usableForAddressBook({ email1: "a@b.example" }));
  assert.ok(!usableForAddressBook({ email1: "" }));
  assert.ok(!usableForAddressBook({ email1: "not-an-address" }));
  assert.ok(!usableForAddressBook(null));
});
