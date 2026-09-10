/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildRecord, defaultsFor, dateInDays, dateTimeInDays, CREATABLE } from "../src/lib/createFromEmail.js";

const MSG = {
  header: { subject: "Credit check for Rubix", author: "Anna <anna@nordwind.example>" },
  bodyText: "Could you run a check on this company?",
};

test("date helpers produce the formats SuiteCRM stores", () => {
  const from = new Date("2026-09-09T12:00:00Z");
  assert.equal(dateInDays(30, from), "2026-10-09");
  assert.match(dateTimeInDays(3, 9, from), /^\d{4}-\d{2}-\d{2} 09:00:00$/);
});

test("a Case carries the subject, the body and the sender", () => {
  const r = buildRecord("Cases", MSG, { accountId: "acc1", parent: { type: "Contacts", id: "c1" } });
  assert.equal(r.module, "Cases");
  assert.equal(r.attributes.name, "Credit check for Rubix");
  assert.match(r.attributes.description, /From: Anna <anna@nordwind\.example>/);
  assert.match(r.attributes.description, /run a check/);
  assert.equal(r.attributes.account_id, "acc1");
  assert.deepEqual(r.relate, [{ module: "Contacts", id: "c1" }]);
});

// Opportunities require amount, date_closed and sales_stage, so those must be set.
test("an Opportunity satisfies the fields SuiteCRM requires", () => {
  const r = buildRecord("Opportunities", MSG, { accountId: "acc1" });
  assert.equal(r.attributes.amount, "0");
  assert.match(r.attributes.date_closed, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.attributes.sales_stage, "Prospecting");
  assert.equal(r.attributes.account_id, "acc1");
});

test("a Meeting hangs off the record the email was filed against", () => {
  const r = buildRecord("Meetings", MSG, { parent: { type: "Accounts", id: "a9" } });
  assert.equal(r.attributes.parent_type, "Accounts");
  assert.equal(r.attributes.parent_id, "a9");
  assert.equal(r.attributes.duration_hours, "1");
  assert.equal(r.attributes.duration_minutes, "0");
  assert.match(r.attributes.date_start, /^\d{4}-\d{2}-\d{2} \d{2}:00:00$/);
});

test("a follow-up Task names what it is following up", () => {
  const r = buildRecord("Tasks", MSG, { parent: { type: "Contacts", id: "c1" } });
  assert.equal(r.attributes.name, "Follow up: Credit check for Rubix");
  assert.equal(r.attributes.contact_id, "c1");
  assert.equal(r.attributes.parent_type, "Contacts");
  assert.match(r.attributes.date_due, /^\d{4}-\d{2}-\d{2} \d{2}:00:00$/);
});

test("what the user typed always beats the default", () => {
  const r = buildRecord("Opportunities", MSG, {
    form: { name: "Rubix — annual licence", amount: "48000", sales_stage: "Negotiation/Review" },
  });
  assert.equal(r.attributes.name, "Rubix — annual licence");
  assert.equal(r.attributes.amount, "48000");
  assert.equal(r.attributes.sales_stage, "Negotiation/Review");
});

test("a blank field falls back to the default rather than saving empty", () => {
  const r = buildRecord("Opportunities", MSG, { form: { name: "  ", amount: "" } });
  assert.equal(r.attributes.name, "Credit check for Rubix");
  assert.equal(r.attributes.amount, "0");
});

test("no Account means no account_id, rather than an empty one", () => {
  const r = buildRecord("Cases", MSG, {});
  assert.equal(r.attributes.account_id, undefined);
  assert.deepEqual(r.relate, []);
});

test("a very long body is truncated rather than rejected by the CRM", () => {
  const long = { ...MSG, bodyText: "x".repeat(50000) };
  const r = buildRecord("Cases", long, {});
  assert.ok(r.attributes.description.length <= 20100, r.attributes.description.length);
});

test("an unknown kind is refused, not silently mis-created", () => {
  assert.throws(() => buildRecord("Invoices", MSG, {}), /Cannot create a Invoices/);
});

test("a message with no subject still produces a named record", () => {
  const bare = { header: {}, bodyText: "" };
  for (const kind of Object.keys(CREATABLE)) {
    const r = buildRecord(kind, bare, {});
    assert.ok(r.attributes.name && r.attributes.name.trim(), `${kind} produced an empty name`);
  }
  assert.equal(defaultsFor("Cases", bare).name, "(no subject)");
});
