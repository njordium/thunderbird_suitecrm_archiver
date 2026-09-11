/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Generating an OAuth2 client secret.
 *
 * Why this exists rather than leaving people to invent one: SuiteCRM stores the
 * secret as `hash('sha256', $secret)`, a single round of a fast hash, with no
 * salt and no iterations (modules/OAuth2Clients/OAuth2Clients.php). Against a
 * copy of the database, a human-chosen secret falls to a wordlist immediately,
 * and an unsalted digest is also rainbow-table material. A long random one is
 * immune to both regardless of how it is stored.
 *
 * 32 bytes gives 256 bits, matching the width of the hash it will be reduced to
 *, more would add nothing a SHA-256 digest can carry.
 */

const DEFAULT_BYTES = 32;

/**
 * A cryptographically random secret, as lowercase hex.
 * @param {number} [bytes]
 * @returns {string}
 */
export function generateSecret(bytes = DEFAULT_BYTES) {
  const n = Math.max(16, Math.min(64, Math.trunc(bytes) || DEFAULT_BYTES));
  const buf = new Uint8Array(n);

  // Web Crypto only. Math.random is not a source of secrets, and silently
  // falling back to it would be worse than failing.
  const source = globalThis.crypto;
  if (!source?.getRandomValues) {
    throw new Error("No cryptographic random source is available.");
  }
  source.getRandomValues(buf);

  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bits of entropy in a hex secret of this length. */
export function entropyBits(secret) {
  const hex = String(secret || "").trim();
  return /^[0-9a-f]*$/i.test(hex) ? Math.floor(hex.length / 2) * 8 : 0;
}

/**
 * Is this secret strong enough to survive an unsalted fast hash?
 * @returns {{ok: boolean, bits: number, note: string}}
 */
export function assessSecret(secret) {
  const s = String(secret || "").trim();
  if (!s) return { ok: false, bits: 0, note: "" };

  const isHex = /^[0-9a-f]+$/i.test(s);
  const bits = isHex ? entropyBits(s) : 0;

  if (isHex && bits >= 128) {
    return { ok: true, bits, note: `${bits}-bit random secret.` };
  }
  if (isHex && bits >= 64) {
    return { ok: false, bits, note: `Only ${bits} bits. Generate a longer one.` };
  }
  return {
    ok: false,
    bits,
    note: "SuiteCRM stores this as a plain SHA-256 with no salt, so a memorable " +
          "secret is guessable from a stolen database. Generate a random one.",
  };
}
