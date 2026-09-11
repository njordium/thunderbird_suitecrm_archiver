/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Caching for incremental search, as used by the address-book provider.
 *
 * Typing a name fires a search per keystroke, and each one is several CRM
 * requests. Two observations make almost all of them unnecessary:
 *
 *   1. The same term is asked repeatedly, backspacing and retyping, or two
 *      compose windows. A plain cache handles that.
 *   2. More importantly, results for a longer term are a SUBSET of results for
 *      its prefix. If "Lind" returned every match rather than a truncated page,
 *      then "Lindq" cannot match anything "Lind" did not, so it can be filtered
 *      from what we already hold rather than asked again.
 *
 * The second only holds when the earlier result was complete. A truncated page
 * may have omitted a record the longer term would have found, so a truncated
 * result is never narrowed, that would silently lose matches.
 */

export class SearchCache {
  constructor({ ttlMs = 60_000, max = 40, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.entries = new Map();
  }

  #key(term) { return String(term || "").trim().toLowerCase(); }

  #live(entry) { return entry && this.now() - entry.at <= this.ttlMs; }

  /** An exact hit for this term, if we have a fresh one. */
  get(term) {
    const key = this.#key(term);
    const hit = this.entries.get(key);
    if (!this.#live(hit)) { this.entries.delete(key); return undefined; }
    return hit.value;
  }

  /**
   * The shortest complete prefix result this term can be narrowed from.
   * @returns {{value, term}|undefined}
   */
  narrowableFrom(term) {
    const key = this.#key(term);
    if (key.length < 2) return undefined;

    let best;
    for (const [candidate, entry] of this.entries) {
      if (!this.#live(entry)) continue;
      if (!entry.complete) continue;                 // truncated: may be missing matches
      if (candidate.length >= key.length) continue;  // not a shorter prefix
      if (!key.startsWith(candidate)) continue;
      if (!best || candidate.length > best.term.length) best = { value: entry.value, term: candidate };
    }
    return best;
  }

  /**
   * @param {boolean} complete  false when the CRM truncated the page, which
   *   makes the result unsafe to narrow from.
   */
  set(term, value, { complete = true } = {}) {
    const key = this.#key(term);
    if (!key) return value;
    this.entries.delete(key);
    this.entries.set(key, { value, complete, at: this.now() });
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return value;
  }

  clear() { this.entries.clear(); }
  get size() { return this.entries.size; }
}

/** Does this record match a free-text term, the way the CRM search would? */
export function recordMatches(rec, term) {
  const t = String(term || "").toLowerCase();
  if (!t) return true;
  return [rec.first_name, rec.last_name, rec.name, rec.account_name, rec.email1, rec.title]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(t));
}

/** Narrow an earlier result set to a longer term, without asking the CRM. */
export function narrowHits(hits, term) {
  const out = {};
  for (const [module, records] of Object.entries(hits || {})) {
    const kept = records.filter((r) => recordMatches(r, term));
    if (kept.length) out[module] = kept;
  }
  const total = Object.values(out).reduce((n, r) => n + r.length, 0);
  return { hits: out, total, found: total > 0 };
}
