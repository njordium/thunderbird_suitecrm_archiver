/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { SearchCache, narrowHits, recordMatches } from "../src/lib/searchCache.js";

const hits = (names) => ({ Contacts: names.map((n, i) => ({ id: String(i), last_name: n })) });

test("an exact term comes back from the cache", () => {
  const c = new SearchCache();
  c.set("lind", { total: 2 });
  assert.deepEqual(c.get("LIND"), { total: 2 }, "should be case-insensitive");
  assert.deepEqual(c.get("  lind "), { total: 2 }, "and whitespace-insensitive");
  assert.equal(c.get("lindq"), undefined);
});

// Typing forward is the common case: each keystroke is a longer term whose
// results must be a subset of the shorter one's.
test("a longer term narrows from a complete prefix result", () => {
  const c = new SearchCache();
  c.set("lind", { hits: hits(["Lindqvist", "Lindberg"]) }, { complete: true });
  const from = c.narrowableFrom("lindq");
  assert.ok(from, "should narrow from 'lind'");
  assert.equal(from.term, "lind");
});

// A truncated page may have omitted a record the longer term would match, so
// narrowing from it would silently lose results.
test("a truncated result is never narrowed from", () => {
  const c = new SearchCache();
  c.set("lind", { hits: hits(["Lindqvist"]) }, { complete: false });
  assert.equal(c.narrowableFrom("lindq"), undefined);
});

test("the longest usable prefix wins, so the least is filtered", () => {
  const c = new SearchCache();
  c.set("li", { hits: hits(["A"]) }, { complete: true });
  c.set("lind", { hits: hits(["B"]) }, { complete: true });
  assert.equal(c.narrowableFrom("lindqv").term, "lind");
});

test("an unrelated term never narrows from another", () => {
  const c = new SearchCache();
  c.set("lind", { hits: hits(["Lindqvist"]) }, { complete: true });
  assert.equal(c.narrowableFrom("berg"), undefined);
  assert.equal(c.narrowableFrom("lin"), undefined, "a shorter term is not a narrowing");
});

test("entries expire so a new CRM record eventually appears", () => {
  let clock = 0;
  const c = new SearchCache({ ttlMs: 100, now: () => clock });
  c.set("lind", { total: 1 }, { complete: true });
  clock = 50;
  assert.ok(c.get("lind"));
  clock = 200;
  assert.equal(c.get("lind"), undefined);
  assert.equal(c.narrowableFrom("lindq"), undefined, "a stale prefix must not be narrowed from");
});

test("narrowing keeps only what still matches, across every field", () => {
  const source = {
    Contacts: [
      { id: "1", first_name: "Anna", last_name: "Lindqvist" },
      { id: "2", first_name: "Bo", last_name: "Lindberg" },
      { id: "3", first_name: "Cee", last_name: "Berg", account_name: "Lindq Holdings" },
    ],
  };
  const r = narrowHits(source, "lindq");
  assert.equal(r.total, 2, JSON.stringify(r.hits));
  assert.deepEqual(r.hits.Contacts.map((x) => x.id), ["1", "3"]);
});

test("narrowing to nothing reports not found rather than an empty module", () => {
  const r = narrowHits(hits(["Lindqvist"]), "zzz");
  assert.equal(r.found, false);
  assert.deepEqual(r.hits, {});
});

test("a record matches on any of the fields the CRM searches", () => {
  const rec = { first_name: "Anna", last_name: "Nilsson", account_name: "Acme AB",
                email1: "anna@acme.se", title: "CTO" };
  for (const term of ["anna", "nilsson", "acme", "@acme.se", "cto"]) {
    assert.ok(recordMatches(rec, term), `should match "${term}"`);
  }
  assert.ok(!recordMatches(rec, "zzz"));
});

test("the cache is capped so it cannot grow without limit", () => {
  const c = new SearchCache({ max: 3 });
  for (const t of ["a1", "a2", "a3", "a4", "a5"]) c.set(t, { total: 1 });
  assert.equal(c.size, 3);
});
