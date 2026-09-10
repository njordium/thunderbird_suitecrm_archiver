/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { normaliseName, nameSimilarity, findPossibleDuplicates } from "../src/lib/duplicates.js";

test("names fold accents, case and punctuation", () => {
  assert.equal(normaliseName("Mads Becker Jørgensen"), "mads becker j rgensen");
  assert.equal(normaliseName("O'Brien, Sean"), "o brien sean");
  assert.equal(normaliseName("  Anna   Nilsson "), "anna nilsson");
});

test("the same name in any order scores as a match", () => {
  assert.equal(nameSimilarity("Anna Nilsson", "Anna Nilsson"), 1);
  assert.equal(nameSimilarity("Anna Nilsson", "Nilsson Anna"), 1);
  assert.equal(nameSimilarity("anna nilsson", "ANNA NILSSON"), 1);
});

test("a dropped middle name still scores high", () => {
  assert.ok(nameSimilarity("Anna Karin Nilsson", "Anna Nilsson") >= 0.6);
});

test("different people with a shared surname do not match", () => {
  assert.ok(nameSimilarity("Anna Nilsson", "Anders Nilsson") < 0.8,
            nameSimilarity("Anna Nilsson", "Anders Nilsson"));
});

test("an initial standing in for a first name is recognised", () => {
  assert.ok(nameSimilarity("A Nilsson", "Anna Nilsson") >= 0.5);
});

test("an empty name never matches anything", () => {
  assert.equal(nameSimilarity("", "Anna Nilsson"), 0);
  assert.equal(nameSimilarity("Anna Nilsson", ""), 0);
});

test("a likely duplicate is surfaced, an unrelated colleague is not", () => {
  const existing = [
    { id: "1", first_name: "Anna", last_name: "Nilsson", email1: "anna@acme.se" },
    { id: "2", first_name: "Anders", last_name: "Nilsson", email1: "anders@acme.se" },
  ];
  const hits = findPossibleDuplicates(
    { first_name: "Anna", last_name: "Nilsson", email1: "a.nilsson@gmail.com" }, existing);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].record.id, "1");
});

// The same address is proof, not a guess, so it ranks above any name score.
test("a matching address is treated as certain", () => {
  const existing = [{ id: "9", first_name: "Totally", last_name: "Different", email1: "same@acme.se" }];
  const hits = findPossibleDuplicates(
    { first_name: "Anna", last_name: "Nilsson", email1: "SAME@acme.se" }, existing);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].score, 1);
  assert.ok(hits[0].sameAddress);
});

test("nothing to compare against yields nothing", () => {
  assert.deepEqual(findPossibleDuplicates({ first_name: "A", last_name: "B" }, []), []);
  assert.deepEqual(findPossibleDuplicates({ first_name: "A", last_name: "B" }, null), []);
  assert.deepEqual(findPossibleDuplicates({}, [{ first_name: "A", last_name: "B" }]), []);
});

test("candidates come back most similar first", () => {
  const existing = [
    { id: "far", first_name: "Anna Karin", last_name: "Nilsson" },
    { id: "exact", first_name: "Anna", last_name: "Nilsson" },
  ];
  const hits = findPossibleDuplicates({ first_name: "Anna", last_name: "Nilsson" }, existing,
                                      { threshold: 0.5 });
  assert.equal(hits[0].record.id, "exact");
});
