/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAddress, searchRecords, findAccountsByDomain } from "../src/lib/resolver.js";

/**
 * The address lookup is the critical path: it decides what the window offers,
 * and it is the one thing the listing promises out loud. It had no unit tests,
 * so these pin the behaviour a user would notice if it changed.
 *
 * A fake client, since none of this is about HTTP. `calls` records what each
 * test asked the CRM for, which is how the module-set behaviour is checked.
 */
function fakeClient({ byModule = {}, failing = {}, calls = [] } = {}) {
  return {
    calls,
    async getRecords(module, query) {
      calls.push({ module, query });
      if (failing[module]) {
        const e = new Error(failing[module].message || "refused");
        e.status = failing[module].status ?? null;
        throw e;
      }
      return byModule[module] ?? [];
    },
  };
}

const ANNA = { id: "c1", first_name: "Anna", last_name: "Lindqvist", email1: "anna@nordwind.example" };
const ACME = { id: "a1", name: "Nordwind Solutions AB", email1: "info@nordwind.example" };

test("a hit in one module is grouped under that module", async () => {
  const client = fakeClient({ byModule: { Contacts: [ANNA] } });
  const r = await resolveAddress(client, "anna@nordwind.example");
  assert.deepEqual(Object.keys(r.hits), ["Contacts"]);
  assert.equal(r.total, 1);
  assert.equal(r.found, true);
});

test("hits in several modules are all reported, and counted together", async () => {
  const client = fakeClient({ byModule: { Contacts: [ANNA], Accounts: [ACME] } });
  const r = await resolveAddress(client, "anna@nordwind.example");
  assert.deepEqual(Object.keys(r.hits).sort(), ["Accounts", "Contacts"]);
  assert.equal(r.total, 2);
});

test("an address in no module is reported as absent, not as an error", async () => {
  const r = await resolveAddress(fakeClient(), "nobody@nowhere.example");
  assert.deepEqual(r.hits, {});
  assert.equal(r.total, 0);
  assert.equal(r.found, false);
  assert.deepEqual(r.failures, []);
});

test("only the modules asked for are searched", async () => {
  const calls = [];
  const client = fakeClient({ calls });
  await resolveAddress(client, "anna@nordwind.example", { modules: ["Contacts", "Leads"] });
  assert.deepEqual(calls.map((c) => c.module), ["Contacts", "Leads"]);
});

test("the default is the four built-in modules, Targets included", async () => {
  const calls = [];
  await resolveAddress(fakeClient({ calls }), "anna@nordwind.example");
  assert.deepEqual(calls.map((c) => c.module).sort(),
    ["Accounts", "Contacts", "Leads", "Prospects"]);
});

test("the lookup filters on the exact address, not a pattern", async () => {
  const calls = [];
  await resolveAddress(fakeClient({ calls }), "anna@nordwind.example", { modules: ["Contacts"] });
  assert.deepEqual(calls[0].query.filter, { email1: { eq: "anna@nordwind.example" } });
});

/**
 * One module failing must not take the others down with it. This is what the
 * Prospects warning was about: Targets is absent from /meta/modules on some
 * instances, so a lookup has to survive it refusing.
 */
test("one module refusing leaves the other hits intact", async () => {
  const client = fakeClient({
    byModule: { Contacts: [ANNA] },
    failing: { Prospects: { status: 403, message: "no access" } },
  });
  const r = await resolveAddress(client, "anna@nordwind.example");
  assert.deepEqual(Object.keys(r.hits), ["Contacts"]);
  assert.equal(r.found, true, "a refusal elsewhere must not hide a real hit");
  assert.deepEqual(r.failures, [{ module: "Prospects", error: "no access" }]);
});

test("every module refusing is reported as failures, with no hits invented", async () => {
  const failing = Object.fromEntries(
    ["Contacts", "Leads", "Accounts", "Prospects"].map((m) => [m, { status: 500, message: "boom" }])
  );
  const r = await resolveAddress(fakeClient({ failing }), "anna@nordwind.example");
  assert.equal(r.found, false);
  assert.equal(r.failures.length, 4);
});

test("a failure carries the module and the CRM's own message, for the warning", async () => {
  const client = fakeClient({ failing: { Contacts: { status: 400, message: "Module does not exist" } } });
  const r = await resolveAddress(client, "x@y.example", { modules: ["Contacts"] });
  assert.deepEqual(r.failures, [{ module: "Contacts", error: "Module does not exist" }]);
});

// --- Free-text search ------------------------------------------------------

test("a term under two characters asks the CRM nothing", async () => {
  const calls = [];
  const client = fakeClient({ calls });
  for (const term of ["", " ", "a", null, undefined]) {
    const r = await searchRecords(client, term);
    assert.equal(r.total, 0);
  }
  assert.deepEqual(calls, [], "a one-letter search would match most of the CRM");
});

test("a name search looks at the name fields, not the address", async () => {
  const calls = [];
  await searchRecords(fakeClient({ calls }), "Lindqvist", { modules: ["Contacts"] });
  const fields = calls.map((c) => Object.keys(c.query.filter)[0]).sort();
  assert.deepEqual(fields, ["account_name", "first_name", "last_name"]);
});

test("a term containing @ is treated as an address", async () => {
  const calls = [];
  await searchRecords(fakeClient({ calls }), "anna@nordwind.example", { modules: ["Contacts"] });
  assert.deepEqual(calls.map((c) => Object.keys(c.query.filter)[0]), ["email1"]);
});

test("Accounts are searched by name even when the term is an address", async () => {
  const calls = [];
  await searchRecords(fakeClient({ calls }), "anna@nordwind.example", { modules: ["Accounts"] });
  assert.deepEqual(calls.map((c) => Object.keys(c.query.filter)[0]), ["name"]);
});

test("the same record found through two fields is returned once", async () => {
  const client = {
    async getRecords() { return [ANNA]; },
  };
  const r = await searchRecords(client, "Anna", { modules: ["Contacts"] });
  assert.equal(r.hits.Contacts.length, 1, "the same id came back per field and was not merged");
});

test("search wraps the term for a partial match", async () => {
  const calls = [];
  await searchRecords(fakeClient({ calls }), "Lindq", { modules: ["Accounts"] });
  assert.deepEqual(calls[0].query.filter, { name: { like: "%Lindq%" } });
});

// --- Domain to Account -----------------------------------------------------

test("a consumer domain is not matched to an Account", async () => {
  const calls = [];
  const found = await findAccountsByDomain(fakeClient({ calls }), "someone@gmail.com");
  assert.deepEqual(found, []);
  assert.deepEqual(calls, [], "every Gmail sender would otherwise match one Account");
});

test("a company domain is looked up by address and by website", async () => {
  const calls = [];
  await findAccountsByDomain(fakeClient({ calls }), "anna@nordwind.example");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => Object.keys(c.query.filter)[0]), ["email1", "website"]);
});

test("the same Account found both ways is returned once", async () => {
  const client = { async getRecords() { return [ACME]; } };
  const found = await findAccountsByDomain(client, "anna@nordwind.example");
  assert.equal(found.length, 1);
});
