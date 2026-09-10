/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Reconstructing a conversation.
 *
 * Thunderbird exposes no thread or conversation API, so the thread is rebuilt
 * from RFC 5322 headers:
 *
 *   - `References` and `In-Reply-To` name every ancestor of this message, and
 *     `messages.query({headerMessageId})` finds each one locally.
 *   - Descendants cannot be looked up that way, since nothing indexes "messages
 *     that reference me". They are found by subject and then *verified* against
 *     the reference chain, so an unrelated message that merely shares a subject
 *     is never pulled in.
 */

import { log } from "./log.js";

const MAX_THREAD = 50;

/** Message-IDs out of a References / In-Reply-To header value. */
export function parseReferences(value) {
  if (!value) return [];
  const out = [];
  for (const m of String(value).matchAll(/<([^<>\s]+)>/g)) out.push(m[1]);
  return out;
}

/** "Re: Fwd: Quarterly review" -> "quarterly review", for matching siblings. */
export function normaliseSubject(subject) {
  return String(subject || "")
    .replace(/^\s*((re|fw|fwd|aw|sv|vs|antw|rif)\s*(\[\d+\])?\s*:\s*)+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function headerValue(full, name) {
  const v = full?.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v.join(" ") : v || "";
}

/** Every Message-ID this message is related to, itself included. */
export function threadIdsOf(header, full) {
  const ids = new Set();
  const own = String(header?.headerMessageId || "").replace(/^<|>$/g, "");
  if (own) ids.add(own);
  for (const id of parseReferences(headerValue(full, "references"))) ids.add(id);
  for (const id of parseReferences(headerValue(full, "in-reply-to"))) ids.add(id);
  return ids;
}

async function queryMessages(queryInfo) {
  const res = await browser.messages.query(queryInfo);
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.messages)) return res.messages;
  return [];
}

/**
 * Find every message in this one's conversation, oldest first.
 *
 * @returns {Promise<Array<object>>} MessageHeaders, always including the starting message.
 */
export async function findThread(messageId, { maxMessages = MAX_THREAD } = {}) {
  const header = await browser.messages.get(messageId);
  const full = await browser.messages.getFull(messageId);

  const wanted = threadIdsOf(header, full);
  const found = new Map([[messageId, header]]);

  // Ancestors: each referenced Message-ID, looked up directly.
  for (const id of wanted) {
    if (found.size >= maxMessages) break;
    try {
      for (const m of await queryMessages({ headerMessageId: id })) {
        if (!found.has(m.id)) found.set(m.id, m);
      }
    } catch (e) {
      log.debug(`thread: lookup failed for ${id}:`, e.message);
    }
  }

  // Descendants and siblings: same subject, then verified against the chain.
  const subject = normaliseSubject(header.subject);
  if (subject) {
    let candidates = [];
    // Scope to the message's own account. Unscoped, this searches every account
    // in the profile — on a mailbox with sixteen of them that alone took about
    // two seconds, and a conversation does not span accounts anyway.
    const accountId = header?.folder?.accountId;
    const scoped = accountId ? { subject, accountId } : { subject };
    try {
      candidates = await queryMessages(scoped);
    } catch (e) {
      log.debug("thread: subject query failed:", e.message);
      if (accountId) {
        try { candidates = await queryMessages({ subject }); }
        catch (e2) { log.debug("thread: unscoped retry failed:", e2.message); }
      }
    }

    // Reading every candidate is the other half of the cost, so cap the work.
    if (candidates.length > maxMessages * 2) {
      log.debug(`thread: ${candidates.length} subject matches, examining the first ${maxMessages * 2}`);
      candidates = candidates.slice(0, maxMessages * 2);
    }

    for (const cand of candidates) {
      if (found.size >= maxMessages) break;
      if (found.has(cand.id)) continue;
      if (normaliseSubject(cand.subject) !== subject) continue;

      try {
        const candFull = await browser.messages.getFull(cand.id);
        const candIds = threadIdsOf(cand, candFull);
        // Related only if the two reference sets actually overlap.
        const related = [...candIds].some((id) => wanted.has(id));
        if (related) {
          found.set(cand.id, cand);
          for (const id of candIds) wanted.add(id);
        }
      } catch (e) {
        log.debug(`thread: could not inspect ${cand.id}:`, e.message);
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => new Date(a.date || 0) - new Date(b.date || 0)
  );
}
