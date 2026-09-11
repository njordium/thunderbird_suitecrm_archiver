/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { generateSecret, entropyBits, assessSecret } from "../src/lib/secret.js";

globalThis.crypto ??= webcrypto;

test("a generated secret is 64 lowercase hex characters, 256 bits", () => {
  const s = generateSecret();
  assert.equal(s.length, 64);
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.equal(entropyBits(s), 256);
});

test("two secrets are never the same", () => {
  const seen = new Set(Array.from({ length: 200 }, () => generateSecret()));
  assert.equal(seen.size, 200, "the generator repeated itself");
});

test("the length is clamped to something sane", () => {
  assert.equal(generateSecret(8).length, 32, "too short is raised to 16 bytes");
  assert.equal(generateSecret(999).length, 128, "absurdly long is capped at 64 bytes");
  assert.equal(generateSecret(0).length, 64, "zero falls back to the default");
});

// Falling back to Math.random would produce something that looks identical and
// is worthless. Failing loudly is the only acceptable behaviour.
test("with no cryptographic source it refuses rather than inventing one", () => {
  // Node defines globalThis.crypto as a getter, so a plain assignment is
  // silently ignored, the first version of this test passed without ever
  // removing the source it claimed to remove.
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    assert.throws(() => generateSecret(), /No cryptographic random source/);
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }
});

test("entropy is counted only for real hex", () => {
  assert.equal(entropyBits("abcdef01"), 32);
  assert.equal(entropyBits("hunter2!"), 0, "not hex, so not countable as entropy");
  assert.equal(entropyBits(""), 0);
});

// SuiteCRM stores the secret as an unsalted single-round SHA-256, so a
// memorable secret is recoverable from a stolen database.
test("a memorable secret is rejected with the reason", () => {
  const r = assessSecret("SuiteCRM2026!");
  assert.equal(r.ok, false);
  assert.match(r.note, /no salt/i);
});

test("a short random secret is rejected as too short, not as weak in kind", () => {
  const r = assessSecret("abcdef0123456789");   // 64 bits
  assert.equal(r.ok, false);
  assert.match(r.note, /Only 64 bits/);
});

test("a generated secret passes", () => {
  const r = assessSecret(generateSecret());
  assert.ok(r.ok);
  assert.equal(r.bits, 256);
});

test("an empty field is not scolded", () => {
  assert.deepEqual(assessSecret(""), { ok: false, bits: 0, note: "" });
  assert.equal(assessSecret(null).note, "");
});
