/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseContact, extractSignatureBlock, stripQuotedReply, splitPersonName,
  parseVCard, htmlToText,
} from "../src/lib/signature.js";

test("splitPersonName keeps nobiliary particles with the surname", () => {
  assert.deepEqual(splitPersonName("Jane Doe"), { first_name: "Jane", last_name: "Doe" });
  assert.deepEqual(splitPersonName("Jan van der Berg"), { first_name: "Jan", last_name: "van der Berg" });
  assert.deepEqual(splitPersonName("Anna Karin Nilsson"), { first_name: "Anna Karin", last_name: "Nilsson" });
  assert.deepEqual(splitPersonName("Cher"), { last_name: "Cher" });
});

test("stripQuotedReply cuts at the quote marker", () => {
  const body = ["Hi,", "See below.", "", "On Mon, Jane wrote:", "> old text"].join("\n");
  assert.equal(stripQuotedReply(body), "Hi,\nSee below.");
});

test("stripQuotedReply cuts at a Swedish reply header", () => {
  const body = ["Tack!", "", "Den 3 mars skrev Jane Doe:", "> gammalt"].join("\n");
  assert.equal(stripQuotedReply(body), "Tack!");
});

test("extractSignatureBlock prefers the RFC 3676 delimiter", () => {
  const body = ["Body text here.", "", "-- ", "Jane Doe", "Acme AB"].join("\n");
  const { block, delimited } = extractSignatureBlock(body);
  assert.ok(delimited);
  assert.equal(block, "Jane Doe\nAcme AB");
});

test("a delimited signature yields a full, high-confidence contact", () => {
  const body = [
    "Hi there,", "", "Could you send the quote?", "", "Best regards,", "",
    "-- ",
    "Jane Doe",
    "Chief Technology Officer",
    "Acme Solutions AB",
    "Storgatan 12",
    "114 55 Stockholm",
    "M: +46 70 123 45 67",
    "T: +46 8 555 010 20",
    "jane.doe@acmesolutions.se",
    "https://www.acmesolutions.se",
  ].join("\n");

  const r = parseContact({ author: "Jane Doe <jane.doe@acmesolutions.se>", bodyText: body });

  assert.equal(r.source, "signature-delimited");
  assert.equal(r.fields.first_name, "Jane");
  assert.equal(r.fields.last_name, "Doe");
  assert.equal(r.fields.email1, "jane.doe@acmesolutions.se");
  assert.equal(r.fields.title, "Chief Technology Officer");
  assert.equal(r.fields.account_name, "Acme Solutions AB");
  assert.equal(r.fields.phone_mobile, "+46 70 123 45 67");
  assert.equal(r.fields.phone_work, "+46 8 555 010 20");
  assert.equal(r.fields.website, "https://www.acmesolutions.se");
  assert.equal(r.fields.primary_address_street, "Storgatan 12");
  assert.equal(r.fields.primary_address_postalcode, "114 55");
  assert.equal(r.fields.primary_address_city, "Stockholm");
  assert.equal(r.confidence.email1, "high");
});

test("the header display name outranks anything in the body", () => {
  const body = ["-- ", "Someone Else", "Acme AB"].join("\n");
  const r = parseContact({ author: '"Doe, Jane" <jane@acme.se>', bodyText: body });
  assert.equal(r.fields.first_name, "Jane");
  assert.equal(r.fields.last_name, "Doe");
  assert.equal(r.confidence.first_name, "high");
});

test("Last, First display names are unswapped; credentials are dropped", () => {
  assert.deepEqual(splitPersonName("Doe, Jane"), { first_name: "Jane", last_name: "Doe" });
  assert.deepEqual(splitPersonName("van der Berg, Jan"), { first_name: "Jan", last_name: "van der Berg" });
  assert.deepEqual(splitPersonName("Jane Doe, PhD"), { first_name: "Jane", last_name: "Doe" });
  assert.deepEqual(splitPersonName("Jane Doe, Jr."), { first_name: "Jane", last_name: "Doe" });
  assert.deepEqual(splitPersonName("Doe, Jane Karin"), { first_name: "Jane Karin", last_name: "Doe" });
});

test("an undelimited signature is parsed but flagged for review", () => {
  const body = [
    "Thanks!", "",
    "Bob Smith",
    "Sales Manager",
    "Nordwind GmbH",
    "Tel: +49 30 1234567",
  ].join("\n");

  const r = parseContact({ author: "bob@nordwind.de", bodyText: body });
  // "Thanks!" is a sign-off, so the block below it is the signature.
  assert.equal(r.source, "signature-after-signoff");
  assert.equal(r.fields.first_name, "Bob");
  assert.equal(r.fields.last_name, "Smith");
  assert.equal(r.fields.account_name, "Nordwind GmbH");
  assert.notEqual(r.confidence.first_name, "high");
  assert.ok(r.needsReview.includes("first_name"));
});

test("phone labels drive the right slot", () => {
  const body = ["-- ", "Jane Doe", "Mobile: +46 70 111 22 33", "Fax: +46 8 999 88 77", "Direct: +46 8 111 00 11"].join("\n");
  const r = parseContact({ author: "Jane Doe <jane@acme.se>", bodyText: body });
  assert.equal(r.fields.phone_mobile, "+46 70 111 22 33");
  assert.equal(r.fields.phone_fax, "+46 8 999 88 77");
  assert.equal(r.fields.phone_work, "+46 8 111 00 11");
});

test("a LinkedIn URL is not mistaken for the company website", () => {
  const body = ["-- ", "Jane Doe", "https://www.linkedin.com/in/janedoe"].join("\n");
  const r = parseContact({ author: "Jane Doe <jane@acme.se>", bodyText: body });
  assert.ok(!/linkedin/i.test(r.fields.website || ""), `LinkedIn became the website: ${r.fields.website}`);
  assert.match(r.fields.linkedin_c, /linkedin\.com\/in\/janedoe/);
  // With no website in the signature, the email domain is the next best guess,
  // offered at low confidence so the form highlights it for checking. www is
  // added because that is where a company of this shape serves its site.
  assert.equal(r.fields.website, "https://www.acme.se");
  assert.equal(r.confidence.website, "low");
});

test("a website in the signature beats the domain guess", () => {
  const body = ["-- ", "Jane Doe", "https://products.acme.se/team"].join("\n");
  const r = parseContact({ author: "Jane Doe <jane@acme.se>", bodyText: body });
  assert.equal(r.fields.website, "https://products.acme.se/team");
  assert.notEqual(r.confidence.website, "low");
});

test("a consumer domain never becomes a company website", () => {
  const r = parseContact({ author: "Jane <jane@gmail.com>", bodyText: "Hi" });
  assert.equal(r.fields.website, undefined);
});

test("a consumer domain never becomes a company name", () => {
  const r = parseContact({ author: "Jane Doe <jane.doe@gmail.com>", bodyText: "Hi" });
  assert.equal(r.fields.account_name, undefined);
  // No sign-off and no delimiter means no signature was found at all, the
  // parser no longer guesses by taking the last few lines of the message.
  assert.equal(r.source, "headers-only");
});

test("a company is derived from the domain only as a last resort", () => {
  const r = parseContact({ author: "Jane Doe <jane@nordwind-solutions.se>", bodyText: "Hi" });
  assert.equal(r.fields.account_name, "Nordwind Solutions");
  assert.equal(r.confidence.account_name, "low");
});

test("a name is recovered from the local part when nothing else exists", () => {
  const r = parseContact({ author: "jane.doe@acme.se", bodyText: "Hi" });
  assert.equal(r.fields.first_name, "Jane");
  assert.equal(r.fields.last_name, "Doe");
  assert.equal(r.confidence.first_name, "low");
});

test("a vCard beats every heuristic", () => {
  const vcard = [
    "BEGIN:VCARD", "VERSION:3.0",
    "N:Doe;Jane;;;", "FN:Jane Doe",
    "ORG:Acme Solutions AB;IT",
    "TITLE:CTO",
    "EMAIL;TYPE=WORK:jane.doe@acme.se",
    "TEL;TYPE=CELL:+46701234567",
    "TEL;TYPE=WORK:+4685550101",
    "ADR;TYPE=WORK:;;Storgatan 12;Stockholm;;114 55;Sweden",
    "URL:https://acme.se",
    "END:VCARD",
  ].join("\r\n");

  const r = parseContact({ author: "J <j@elsewhere.com>", bodyText: "-- \nWrong Name\nWrong Co Ltd", vcard });
  assert.equal(r.source, "vcard");
  assert.equal(r.fields.first_name, "Jane");
  assert.equal(r.fields.last_name, "Doe");
  assert.equal(r.fields.title, "CTO");
  assert.equal(r.fields.account_name, "Acme Solutions AB");
  assert.equal(r.fields.phone_mobile, "+46701234567");
  assert.equal(r.fields.primary_address_city, "Stockholm");
  assert.equal(r.confidence.title, "high");
});

test("parseVCard unfolds continuation lines", () => {
  const raw = "BEGIN:VCARD\r\nORG:Very Long Company\r\n  Name AB\r\nEND:VCARD";
  assert.equal(parseVCard(raw).account_name, "Very Long Company Name AB");
});

test("parseVCard ignores non-vCard input", () => {
  assert.equal(parseVCard("just some text"), null);
});

test("htmlToText produces line breaks, not a run-on string", () => {
  assert.equal(htmlToText("<p>Jane Doe</p><p>Acme&nbsp;AB</p>"), "Jane Doe\nAcme AB");
  assert.equal(htmlToText("<div>A<br>B</div>"), "A\nB");
});

test("a date in the signature is not read as a phone number", () => {
  const body = ["-- ", "Jane Doe", "Offer valid until 2026-12-31", "M: +46 70 123 45 67"].join("\n");
  const r = parseContact({ author: "Jane Doe <jane@acme.se>", bodyText: body });
  assert.equal(r.fields.phone_mobile, "+46 70 123 45 67");
});

test("the quoted reply's signature is not harvested", () => {
  const body = [
    "Thanks, will do.", "",
    "On Mon, Jane wrote:",
    "> -- ",
    "> Jane Doe",
    "> Wrong Company AB",
  ].join("\n");
  const r = parseContact({ author: "Bob Smith <bob@nordwind.de>", bodyText: body });
  assert.notEqual(r.fields.account_name, "Wrong Company AB");
});

// --- a CC'd colleague must not inherit the sender's personal details ---------

const SENDER_BODY = [
  "Hi,", "", "Adding Bob who handles procurement.", "", "-- ",
  "Jane Doe",
  "Chief Technology Officer",
  "Acme Solutions AB",
  "Storgatan 12",
  "114 55 Stockholm",
  "M: +46 70 123 45 67",
  "https://www.acmesolutions.se",
].join("\n");

test("a colleague does not inherit the sender's title, phone or address", () => {
  const r = parseContact({
    author: "Bob Smith <bob@acmesolutions.se>",
    bodyText: SENDER_BODY,
    isAuthor: false,
  });

  assert.equal(r.source, "colleague-of-sender");
  assert.equal(r.fields.first_name, "Bob");
  assert.equal(r.fields.last_name, "Smith");
  assert.equal(r.fields.email1, "bob@acmesolutions.se");

  // The signature belongs to Jane, not Bob.
  assert.equal(r.fields.title, undefined, "must not copy Jane's job title to Bob");
  assert.equal(r.fields.phone_mobile, undefined, "must not copy Jane's mobile to Bob");
  assert.equal(r.fields.primary_address_street, undefined, "must not copy Jane's address to Bob");
  assert.equal(r.fields.linkedin_c, undefined, "must not copy Jane's LinkedIn to Bob");

  // Company-level details are shared across the domain, so they do carry over.
  assert.equal(r.fields.account_name, "Acme Solutions AB");
  assert.equal(r.fields.website, "https://www.acmesolutions.se");
});

test("the sender themselves still gets the full signature", () => {
  const r = parseContact({
    author: "Jane Doe <jane@acmesolutions.se>",
    bodyText: SENDER_BODY,
    isAuthor: true,
  });
  assert.equal(r.fields.title, "Chief Technology Officer");
  assert.equal(r.fields.phone_mobile, "+46 70 123 45 67");
  assert.equal(r.fields.primary_address_city, "Stockholm");
});

test("a colleague's company details are held at lower confidence", () => {
  const r = parseContact({
    author: "Bob Smith <bob@acmesolutions.se>",
    bodyText: SENDER_BODY,
    isAuthor: false,
  });
  assert.notEqual(r.confidence.account_name, "high");
  assert.ok(r.needsReview.includes("account_name"));
});

test("a colleague does not inherit the sender's vCard identity", () => {
  const vcard = [
    "BEGIN:VCARD", "VERSION:3.0", "N:Doe;Jane;;;",
    "TITLE:CTO", "ORG:Acme Solutions AB",
    "TEL;TYPE=CELL:+46701234567", "END:VCARD",
  ].join("\r\n");

  const r = parseContact({
    author: "Bob Smith <bob@acmesolutions.se>",
    bodyText: "Hi", vcard, isAuthor: false,
  });

  assert.equal(r.fields.first_name, "Bob", "vCard name is Jane's, not Bob's");
  assert.equal(r.fields.last_name, "Smith");
  assert.equal(r.fields.title, undefined);
  assert.equal(r.fields.phone_mobile, undefined);
  assert.equal(r.fields.account_name, "Acme Solutions AB");
});

// A vCard arrives as an attachment, so its URL property is untrusted. Only a
// web address belongs in a website field: anything else would be written to the
// CRM, where it may later be rendered as a link for someone else to click.
test("a vCard URL that is not a web address is discarded", () => {
  const card = (url) => ["BEGIN:VCARD", "VERSION:3.0", "N:Doe;Jane;;;",
                         `URL:${url}`, "END:VCARD"].join("\r\n");
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "not a url at all",
  ]) {
    const r = parseContact({
      author: "Jane <jane@acme.se>", bodyText: "Hi", vcard: card(bad),
    });
    assert.notEqual(r.fields.website, bad, `accepted a ${bad.split(":")[0]} URL`);
    assert.ok(!/^(javascript|data|file|vbscript):/i.test(r.fields.website || ""),
              `a dangerous scheme reached the form: ${r.fields.website}`);
  }
});

test("a normal vCard URL is still taken", () => {
  const vcard = ["BEGIN:VCARD", "VERSION:3.0", "N:Doe;Jane;;;",
                 "URL:https://acme.se/team", "END:VCARD"].join("\r\n");
  const r = parseContact({ author: "Jane <jane@acme.se>", bodyText: "Hi", vcard });
  assert.equal(r.fields.website, "https://acme.se/team");
});

// --- guessing a homepage from an email domain -----------------------------

// www is the better guess for a bare domain: it is where companies serve their
// site and what a person would type. It is the wrong guess for a host that
// already has a subdomain, where it would invent a name nobody serves.
test("www is added to a bare registrable domain", async () => {
  const { homepageFromDomain } = await import("../src/lib/signature.js");
  assert.equal(homepageFromDomain("g2.com"), "https://www.g2.com");
  assert.equal(homepageFromDomain("njordium.com"), "https://www.njordium.com");
  assert.equal(homepageFromDomain("leedflow.se"), "https://www.leedflow.se");
});

test("www is not added to a host that already has a subdomain", async () => {
  const { homepageFromDomain } = await import("../src/lib/signature.js");
  assert.equal(homepageFromDomain("oe.arizent.com"), "https://oe.arizent.com");
  assert.equal(homepageFromDomain("post.leedflow.se"), "https://post.leedflow.se");
  assert.equal(homepageFromDomain("a.b.example.com"), "https://a.b.example.com");
});

test("a two-part suffix counts as one label, not a subdomain", async () => {
  const { homepageFromDomain } = await import("../src/lib/signature.js");
  assert.equal(homepageFromDomain("example.co.uk"), "https://www.example.co.uk");
  assert.equal(homepageFromDomain("example.com.au"), "https://www.example.com.au");
  // ...but a real subdomain under one is still a subdomain.
  assert.equal(homepageFromDomain("mail.example.co.uk"), "https://mail.example.co.uk");
});

test("an existing www is kept, not doubled", async () => {
  const { homepageFromDomain } = await import("../src/lib/signature.js");
  assert.equal(homepageFromDomain("www.g2.com"), "https://www.g2.com");
});

test("nothing that is not a domain yields a homepage", async () => {
  const { homepageFromDomain } = await import("../src/lib/signature.js");
  for (const bad of ["", null, undefined, "localhost", "   ", "."]) {
    assert.equal(homepageFromDomain(bad), null, `${JSON.stringify(bad)} is not a domain`);
  }
  assert.equal(homepageFromDomain("G2.COM"), "https://www.g2.com", "case is normalised");
  assert.equal(homepageFromDomain("g2.com."), "https://www.g2.com", "a trailing dot is dropped");
});
