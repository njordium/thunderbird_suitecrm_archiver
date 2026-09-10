/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { parseReferences, normaliseSubject, threadIdsOf } from "../src/lib/thread.js";

test("parseReferences pulls every Message-ID out of the header", () => {
  const refs = "<a@x.com> <b@y.com>\n  <c@z.com>";
  assert.deepEqual(parseReferences(refs), ["a@x.com", "b@y.com", "c@z.com"]);
  assert.deepEqual(parseReferences(""), []);
  assert.deepEqual(parseReferences(null), []);
});

test("normaliseSubject strips reply and forward prefixes in several languages", () => {
  const want = "quarterly review";
  for (const s of [
    "Quarterly review", "Re: Quarterly review", "RE: Quarterly review",
    "Fwd: Quarterly review", "FW: Re: Quarterly review",
    "SV: Quarterly review",      // Swedish/Norwegian
    "AW: Quarterly review",      // German
    "Re[2]: Quarterly review",
    "Re: Re: Fwd:  Quarterly   review",
  ]) {
    assert.equal(normaliseSubject(s), want, `failed for ${s}`);
  }
});

test("normaliseSubject leaves a subject that merely starts with 'Reply' alone", () => {
  assert.equal(normaliseSubject("Replacement parts"), "replacement parts");
  assert.equal(normaliseSubject("Review of Q3"), "review of q3");
});

test("threadIdsOf gathers the message and its whole ancestry", () => {
  const header = { headerMessageId: "<c@z.com>" };
  const full = {
    headers: {
      references: ["<a@x.com> <b@y.com>"],
      "in-reply-to": ["<b@y.com>"],
    },
  };
  const ids = threadIdsOf(header, full);
  assert.deepEqual([...ids].sort(), ["a@x.com", "b@y.com", "c@z.com"]);
});

test("threadIdsOf copes with a message that has no references", () => {
  const ids = threadIdsOf({ headerMessageId: "<solo@x.com>" }, { headers: {} });
  assert.deepEqual([...ids], ["solo@x.com"]);
});

test("threadIdsOf tolerates a missing Message-ID entirely", () => {
  assert.deepEqual([...threadIdsOf({}, { headers: {} })], []);
});
