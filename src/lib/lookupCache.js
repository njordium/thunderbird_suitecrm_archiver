/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * A small time-limited cache for "is this address in the CRM?".
 *
 * The badge asks that question for every message the user looks at, so without a
 * cache, arrowing down a folder would fire one request per row. Entries are held
 * per address for the session, and expire so a record created elsewhere shows up
 * within a few minutes rather than never.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX = 500;

export class LookupCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.entries = new Map();
  }

  #key(email) { return String(email || "").trim().toLowerCase(); }

  /** @returns the cached value, or undefined when absent or stale. */
  get(email) {
    const key = this.#key(email);
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency so the cap evicts what is genuinely unused.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(email, value) {
    const key = this.#key(email);
    if (!key) return value;
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return value;
  }

  /** Drop one address, or everything, used after creating or archiving. */
  invalidate(email = null) {
    if (email === null) this.entries.clear();
    else this.entries.delete(this.#key(email));
  }

  get size() { return this.entries.size; }
}
