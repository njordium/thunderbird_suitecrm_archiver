/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Catching a duplicate person before one is created.
 *
 * The same human writing from a second address is how a CRM quietly rots: two
 * Contacts, two histories, and neither tells the whole story. The address lookup
 * cannot see it, because the address is precisely what differs, so before
 * creating, compare names.
 */

/** Fold accents and punctuation so "Jörgensen" matches "Jorgensen". */
export function normaliseName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How alike are two names, 0..1?
 *
 * Token-based rather than character-based: people reorder names, add middle
 * names and drop them, and "Anna Karin Nilsson" against "Anna Nilsson" should
 * score high while "Anna Nilsson" against "Anders Nilsson" should not.
 */
export function nameSimilarity(a, b) {
  const at = normaliseName(a).split(" ").filter(Boolean);
  const bt = normaliseName(b).split(" ").filter(Boolean);
  if (!at.length || !bt.length) return 0;

  const [shorter, longer] = at.length <= bt.length ? [at, bt] : [bt, at];
  const pool = [...longer];
  let matched = 0;

  for (const token of shorter) {
    const exact = pool.indexOf(token);
    if (exact !== -1) { pool.splice(exact, 1); matched += 1; continue; }
    // An initial standing in for a full name: "A Nilsson" vs "Anna Nilsson".
    const initial = pool.findIndex((p) => (token.length === 1 && p.startsWith(token)) ||
                                          (p.length === 1 && token.startsWith(p)));
    if (initial !== -1) { pool.splice(initial, 1); matched += 0.5; }
  }

  return matched / longer.length;
}

const STRONG = 0.8;

/**
 * Candidates that might be the same person.
 *
 * @param {object} person   the details about to be created
 * @param {Array}  existing records already on the Account or domain
 * @returns {Array} ranked, most similar first
 */
export function findPossibleDuplicates(person, existing, { threshold = STRONG } = {}) {
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ");
  if (!normaliseName(name)) return [];

  const email = String(person.email1 || "").toLowerCase();

  return (existing || [])
    .map((rec) => {
      const theirName = [rec.first_name, rec.last_name].filter(Boolean).join(" ") || rec.name || "";
      const score = nameSimilarity(name, theirName);
      const sameAddress = Boolean(email) && String(rec.email1 || "").toLowerCase() === email;
      return { record: rec, score: sameAddress ? 1 : score, sameAddress, name: theirName };
    })
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);
}
