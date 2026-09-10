/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { creatableFor, unavailableReason, buildRecord, CREATABLE } from "../src/lib/createFromEmail.js";

// What SuiteCRM actually permits, established by attempting each relationship
// against a live instance rather than by reading documentation:
//
//   Case        -> Lead    400  "Link field has not found in Case ... for Lead"
//   Case        -> Target  400
//   Opportunity -> Target  400
//   Opportunity -> Lead    201
//
// Meetings and Tasks name any module as parent_type, so they always link.

const contact = { type: "Contacts", id: "c1", accountId: "a1" };
const account = { type: "Accounts", id: "a1", accountId: "a1" };
const lead = { type: "Leads", id: "l1", accountId: null };
const converted = { type: "Leads", id: "l2", accountId: "a9" };
const target = { type: "Prospects", id: "p1", accountId: null };

test("a Contact can take all four kinds", () => {
  assert.deepEqual(creatableFor(contact).sort(),
    ["Cases", "Meetings", "Opportunities", "Tasks"]);
});

test("an Account can take all four kinds", () => {
  assert.deepEqual(creatableFor(account).sort(),
    ["Cases", "Meetings", "Opportunities", "Tasks"]);
});

test("an unconverted Lead takes an Opportunity but not a Case", () => {
  const kinds = creatableFor(lead);
  assert.ok(kinds.includes("Opportunities"), "SuiteCRM relates Opportunities to Leads");
  assert.ok(!kinds.includes("Cases"), "SuiteCRM has no Case-to-Lead relationship");
  assert.ok(kinds.includes("Meetings") && kinds.includes("Tasks"));
});

test("a converted Lead takes a Case, through the Account behind it", () => {
  assert.ok(creatableFor(converted).includes("Cases"),
    "a converted Lead carries account_id, and Cases attach to an Account");
});

test("a Target takes only the activity kinds", () => {
  assert.deepEqual(creatableFor(target).sort(), ["Meetings", "Tasks"]);
});

test("with nothing selected, everything is offered", () => {
  assert.deepEqual(creatableFor(null).sort(),
    ["Cases", "Meetings", "Opportunities", "Tasks"]);
});

test("every offered kind is a real kind", () => {
  for (const parent of [contact, account, lead, converted, target, null]) {
    for (const kind of creatableFor(parent)) {
      assert.ok(CREATABLE[kind], `${kind} is offered but is not creatable`);
    }
  }
});

// --- the explanation shown when a kind is missing ---------------------------

test("a Target is told why, and told what to do", () => {
  const why = unavailableReason(target);
  assert.match(why, /Case and Opportunity/);
  assert.match(why, /Target/);
  assert.match(why, /Convert the Target first/);
});

test("an unconverted Lead is told only about the Case", () => {
  const why = unavailableReason(lead);
  assert.match(why, /^Case /, "the Opportunity is available, so must not be named");
  assert.doesNotMatch(why, /Case and Opportunity/);
  assert.match(why, /Convert the Lead first/);
});

test("nothing is said when nothing is missing", () => {
  assert.equal(unavailableReason(contact), "");
  assert.equal(unavailableReason(account), "");
  assert.equal(unavailableReason(converted), "");
});

// --- the link itself --------------------------------------------------------

const msg = { header: { subject: "Credit check", author: "A <a@b.se>" }, bodyText: "hello" };

test("an Opportunity from a Lead is related to that Lead", () => {
  const spec = buildRecord("Opportunities", msg, { parent: lead });
  assert.deepEqual(spec.relate, [{ module: "Leads", id: "l1" }],
    "the leads relationship exists and the API accepts it — it must be used");
});

test("an Opportunity from a converted Lead links both ways", () => {
  const spec = buildRecord("Opportunities", msg, { parent: converted, accountId: "a9" });
  assert.equal(spec.attributes.account_id, "a9");
  assert.deepEqual(spec.relate, [{ module: "Leads", id: "l2" }]);
});

test("an Opportunity from a Contact is unchanged", () => {
  const spec = buildRecord("Opportunities", msg, { parent: contact, accountId: "a1" });
  assert.deepEqual(spec.relate, [{ module: "Contacts", id: "c1" }]);
  assert.equal(spec.attributes.account_id, "a1");
});

test("a Case from a converted Lead attaches to the Account", () => {
  const spec = buildRecord("Cases", msg, { parent: converted, accountId: "a9" });
  assert.equal(spec.attributes.account_id, "a9");
});

test("activities take any parent, including a Target", () => {
  for (const kind of ["Meetings", "Tasks"]) {
    const spec = buildRecord(kind, msg, { parent: target });
    assert.equal(spec.attributes.parent_type, "Prospects");
    assert.equal(spec.attributes.parent_id, "p1");
  }
});

// --- the field that makes the converted-Lead case possible ------------------

// creatableFor() decides on parent.accountId, which the popup takes from the
// resolved record. If the resolver stops asking Leads for account_id, every
// converted Lead silently loses the Case option and nothing else breaks — so
// the request list is asserted here rather than left implicit.
test("the resolver asks Leads for account_id", async () => {
  const { MODULE_FIELDS } = await import("../src/lib/modules.js");
  assert.ok(MODULE_FIELDS.Leads.includes("account_id"),
    "without it a converted Lead cannot offer a Case");
  assert.ok(MODULE_FIELDS.Contacts.includes("account_id"));
});
