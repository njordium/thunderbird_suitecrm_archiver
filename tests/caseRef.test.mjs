/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { findCaseNumber, caseRefPattern, looksLikeReply, DEFAULT_CASE_MACRO } from "../src/lib/caseRef.js";

test("SuiteCRM's own default macro is matched", () => {
  assert.equal(DEFAULT_CASE_MACRO, "[CASE:%1]");
  assert.equal(findCaseNumber("[CASE:1234] Printer is jammed"), "1234");
});

test("the macro is found anywhere in the subject, not only at the start", () => {
  assert.equal(findCaseNumber("Re: [CASE:88] follow-up"), "88");
  assert.equal(findCaseNumber("Sv: Sv: printer [CASE:88]"), "88");
});

test("case is ignored, since mail systems rewrite subjects", () => {
  assert.equal(findCaseNumber("[case:7] hello"), "7");
  assert.equal(findCaseNumber("[Case:7] hello"), "7");
});

test("whitespace inserted by a mail system does not break the match", () => {
  assert.equal(findCaseNumber("[CASE: 1234] wrapped"), "1234");
  assert.equal(findCaseNumber("[CASE:1234 ] wrapped"), "1234");
});

test("leading zeros resolve to the same case", () => {
  assert.equal(findCaseNumber("[CASE:0042] padded"), "42");
  assert.equal(findCaseNumber("[CASE:0] zero is a number"), "0");
});

test("a subject with no reference yields null", () => {
  assert.equal(findCaseNumber("Quarterly review"), null);
  assert.equal(findCaseNumber(""), null);
  assert.equal(findCaseNumber(null), null);
  assert.equal(findCaseNumber(undefined), null);
});

test("the macro text without a number is not a match", () => {
  assert.equal(findCaseNumber("[CASE:] empty"), null);
  assert.equal(findCaseNumber("about CASE handling in general"), null);
});

// A customised instance is the norm rather than the exception, so the pattern is
// built from the configured template instead of being hard-coded.
test("a customised macro works", () => {
  assert.equal(findCaseNumber("[TICKET:99] hi", "[TICKET:%1]"), "99");
  assert.equal(findCaseNumber("Ref #500 please", "#%1"), "500");
  assert.equal(findCaseNumber("(SUPPORT 77) x", "(SUPPORT %1)"), "77");
});

// The older SugarCRM style put the number after the macro rather than inside it.
test("a trailing-number macro works too", () => {
  assert.equal(findCaseNumber("MACRO 4321 subject", "MACRO %1"), "4321");
});

test("regex metacharacters in a macro are escaped, not interpreted", () => {
  // If [ ] . ( ) were interpreted, this would match far more than intended.
  assert.equal(findCaseNumber("[CASE:12] x", "[CASE:%1]"), "12");
  assert.equal(findCaseNumber("aXCASEY12", "[CASE:%1]"), null,
    "the brackets must be literal, not a character class");
  assert.equal(findCaseNumber("A.1 x", "A.%1"), "1");
  assert.equal(findCaseNumber("AB1 x", "A.%1"), null, "the dot must be literal");
});

test("a macro with no %1 placeholder is refused", () => {
  // Such a macro cannot identify a case, and a pattern built from it would
  // match the literal text on every reply in the thread.
  assert.equal(caseRefPattern("[CASE]"), null);
  assert.equal(findCaseNumber("[CASE] 12", "[CASE]"), null);
  assert.equal(caseRefPattern(""), null, "an empty macro cannot identify a case");
  assert.equal(caseRefPattern(null), null);
  assert.equal(caseRefPattern("   "), null, "whitespace is not a macro");
  // Omitting the argument entirely is different from passing an empty one: it
  // means "use the instance default", which is a working macro.
  assert.ok(caseRefPattern(undefined) instanceof RegExp);
  assert.equal(findCaseNumber("[CASE:5] x"), "5");
});

test("an absurdly long digit run is not treated as a case number", () => {
  assert.equal(findCaseNumber("[CASE:1234567890123456789] x"), null,
    "a 19-digit run is not a case number and must not be queried");
});

test("looksLikeReply recognises the prefixes that actually occur", () => {
  for (const s of ["Re: x", "RE: x", "Sv: x", "SV: x", "Aw: x", "VS: x", "Fwd: x", "Fw: x", "VB: x"]) {
    assert.ok(looksLikeReply(s), `${s} should read as a reply or forward`);
  }
  assert.ok(!looksLikeReply("Report on x"));
  assert.ok(!looksLikeReply("Revenue: x"), "Revenue must not be mistaken for Re:");
  assert.ok(!looksLikeReply(""));
});
