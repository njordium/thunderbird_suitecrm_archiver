/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { parseContact, splitPersonName } from "../src/lib/signature.js";

// Cases drawn from real business mail, with names and domains changed. Each one
// is a shape the parser previously got wrong.

// --- somebody else's signature quoted back at you ---------------------------

const REPLY_WITH_MY_OWN_SIGNATURE = [
  "Hei,", "",
  "Takk for oppdateringen.", "",
  "Med vennlig hilsen",
  "Ingrid Dahl", "",
  "Fra: Kari Nordmann <kari@mycompany.example>",
  "Sendt: mandag 18. august 2026 12:45",
  "Til: Ingrid Dahl <ingrid.dahl@kredittsjekk.example>",
  "Emne: SV: Kundeforespørsel", "",
  "Hi Ingrid,", "",
  "Please see attached.", "",
  "Kari Nordmann", "",
  "Co-Founder & CISO | My Company Group AB", "",
  "mobile: +46 760 046 232 | web: mycompany.example", "",
  "social: linkedin.com/in/karinordmann",
].join("\n");

test("a reply never harvests the recipient's own quoted signature", () => {
  const r = parseContact({
    author: "Ingrid Dahl <ingrid.dahl@kredittsjekk.example>",
    bodyText: REPLY_WITH_MY_OWN_SIGNATURE,
  });
  assert.equal(r.fields.phone_mobile, undefined, "took the other party's mobile");
  assert.equal(r.fields.linkedin_c, undefined, "took the other party's LinkedIn");
  assert.ok(!/My Company/i.test(r.fields.account_name || ""),
            `took the other party's company: ${r.fields.account_name}`);
  assert.equal(r.fields.first_name, "Ingrid");
});

test("a block naming only other domains is rejected outright", () => {
  const body = ["Regards,", "", "Someone Else", "Acme Ltd", "someone@acme.example"].join("\n");
  const r = parseContact({ author: "Real Sender <real@different.example>", bodyText: body });
  assert.equal(r.source, "headers-only", "block from another domain should be discarded");
  assert.equal(r.fields.title, undefined);
});

// --- Nordic signatures ------------------------------------------------------

const SWEDISH = [
  "Hej Kim,", "",
  "Tack för informationen.", "",
  "Med vänliga hälsningar", "",
  "[cid:cd58dc1a-8845-43f5-aa9e-675dfd8ef487]<https://www.lotsekonomi.example/>", "",
  "Britta Hagberg",
  "Kontorschef",
  "Auktoriserad Redovisningskonsult", "",
  "Lots Ekonomi AB",
  "Mätarvägen 3B, 196 37 Kungsängen",
  "Direkt: 08-501 296 46",
  "Växel: 08-581 761 35", "",
  "När du skickar e-post till Lots Ekonomi så innebär det att vi behandlar dina personuppgifter.",
].join("\n");

test("a Swedish compound job title is recognised", () => {
  const r = parseContact({ author: "Britta Hagberg <britta@lotsekonomi.example>", bodyText: SWEDISH });
  assert.equal(r.fields.title, "Kontorschef");
});

test("a company ending in AB is taken over a domain guess", () => {
  const r = parseContact({ author: "Britta Hagberg <britta@lotsekonomi.example>", bodyText: SWEDISH });
  assert.equal(r.fields.account_name, "Lots Ekonomi AB");
});

test("a one-line Swedish address is split into its parts", () => {
  const r = parseContact({ author: "Britta Hagberg <britta@lotsekonomi.example>", bodyText: SWEDISH });
  assert.equal(r.fields.primary_address_street, "Mätarvägen 3B");
  assert.equal(r.fields.primary_address_postalcode, "196 37");
  assert.equal(r.fields.primary_address_city, "Kungsängen");
});

// A switchboard belongs to the company, not to this person's direct line.
test("Direkt and Växel land in different phone fields", () => {
  const r = parseContact({ author: "Britta Hagberg <britta@lotsekonomi.example>", bodyText: SWEDISH });
  assert.equal(r.fields.phone_work, "08-501 296 46");
  assert.equal(r.fields.phone_other, "08-581 761 35");
});

test("a privacy notice below the signature is not parsed", () => {
  const r = parseContact({ author: "Britta Hagberg <britta@lotsekonomi.example>", bodyText: SWEDISH });
  assert.ok(!/personuppgifter/i.test(JSON.stringify(r.fields)), "privacy notice leaked into a field");
});

// --- bold runs glue a name to a title ---------------------------------------

test("a name and title joined by bold markers are separated", () => {
  const body = [
    "Hej,", "", "Det fungerar bra.", "",
    "Best regards,", "",
    "*Pavel Horvat*Co-founder",
    "www.leadflow.example",
    "+46 73 989 35 98",
    "pavel@leadflow.example",
  ].join("\n");
  const r = parseContact({ author: "Pavel Horvat <pavel@leadflow.example>", bodyText: body });
  assert.equal(r.fields.title, "Co-founder");
  assert.equal(r.fields.phone_mobile, "+46 73 989 35 98");
  assert.match(r.fields.website, /leadflow\.example/);
});

// --- names -----------------------------------------------------------------

test("Mc, Mac and O' stay with the surname", () => {
  assert.deepEqual(splitPersonName("Fiona Mc Grath"), { first_name: "Fiona", last_name: "Mc Grath" });
  assert.deepEqual(splitPersonName("Sean Mac Donald"), { first_name: "Sean", last_name: "Mac Donald" });
  assert.deepEqual(splitPersonName("Anna Van Dijk"), { first_name: "Anna", last_name: "Van Dijk" });
});

// --- quoted-reply markers ---------------------------------------------------

test("Nordic quoted headers end the searchable body", () => {
  for (const marker of ["Fra: Kari <k@x.example>", "Från: Kari <k@x.example>",
                        "Skickat: den 31 augusti 2026 13:24", "Emne: SV: Test",
                        "Ämne: Re: Test", "Til: Ingrid <i@y.example>"]) {
    const body = ["Regards,", "", "Real Sender", "Real Corp AB", "", marker,
                  "", "Fake Person", "Fake Corp AB", "Tel: +46 8 000 000"].join("\n");
    const r = parseContact({ author: "Real Sender <real@realcorp.example>", bodyText: body });
    assert.ok(!/Fake/i.test(r.fields.account_name || ""), `leaked past "${marker}"`);
    assert.equal(r.fields.phone_work, undefined, `leaked a phone past "${marker}"`);
  }
});
