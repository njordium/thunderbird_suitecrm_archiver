/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { CrmClient } from "../src/lib/crm.js";

/** A client with a stubbed field list, so no network is involved. */
function clientWithFields(module, fields) {
  const c = new CrmClient("http://example.invalid/Api");
  c._fieldCache = new Map([[module, fields === null ? null : new Set(fields)]]);
  return c;
}

test("attributes the module does not have are dropped", async () => {
  // Contacts has no `website` field; Leads does. Sending it fails the whole create.
  const c = clientWithFields("Contacts", ["first_name", "last_name", "email1", "title"]);
  const { attributes, dropped } = await c.filterAttributes("Contacts", {
    first_name: "Jane", last_name: "Doe", email1: "jane@acme.se", website: "https://acme.se",
  });
  assert.deepEqual(dropped, ["website"]);
  assert.equal(attributes.website, undefined);
  assert.equal(attributes.first_name, "Jane");
});

// Regression: /meta/fields/Emails does not list from_addr, to_addrs, cc_addrs or
// bcc_addrs, but SuiteCRM accepts them on write. A filter that keeps only what
// meta reports silently discarded the sender and every recipient.
test("Emails address fields survive even though meta/fields omits them", async () => {
  const c = clientWithFields("Emails", ["name", "message_id", "description", "from_addr_name"]);
  const { attributes, dropped } = await c.filterAttributes("Emails", {
    name: "Subject",
    message_id: "abc@example.com",
    from_addr: "Jane <jane@acme.se>",
    to_addrs: "bob@acme.se",
    cc_addrs: "zoe@acme.se",
    bcc_addrs: "",
    description: "body",
  });
  assert.equal(attributes.from_addr, "Jane <jane@acme.se>", "sender must not be dropped");
  assert.equal(attributes.to_addrs, "bob@acme.se", "recipients must not be dropped");
  assert.equal(attributes.cc_addrs, "zoe@acme.se");
  assert.deepEqual(dropped, [], "nothing should have been dropped");
});

test("upload directives survive on Notes", async () => {
  const c = clientWithFields("Notes", ["name", "parent_type", "parent_id", "description"]);
  const { attributes, dropped } = await c.filterAttributes("Notes", {
    name: "quote.txt", parent_type: "Emails", parent_id: "x",
    filename: "quote.txt", filecontents: "YmFzZTY0",
  });
  assert.equal(attributes.filename, "quote.txt");
  assert.equal(attributes.filecontents, "YmFzZTY0");
  assert.deepEqual(dropped, []);
});

test("an unknown field list means nothing is filtered", async () => {
  // If /meta/fields cannot be read we must not guess and start dropping data.
  const c = clientWithFields("Contacts", null);
  const input = { anything: 1, at_all: 2 };
  const { attributes, dropped } = await c.filterAttributes("Contacts", input);
  assert.deepEqual(attributes, input);
  assert.deepEqual(dropped, []);
});
