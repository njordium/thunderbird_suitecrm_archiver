/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * RFC 5322 mailbox handling, and the CC/domain logic that decides which
 * addresses the user may pick as the archive target.
 */

/** Parse one mailbox string: `"Doe, Jane" <jane@x.se>` -> {name, email}. */
export function parseMailbox(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  const angle = s.match(/^(.*)<([^<>]+)>\s*$/);
  let name = "", email = "";
  if (angle) {
    name = angle[1].trim();
    email = angle[2].trim();
  } else {
    email = s;
  }

  // Unquote and unescape a quoted display name.
  if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  name = name.replace(/\s+/g, " ").trim();

  email = email.replace(/^mailto:/i, "").trim().toLowerCase();
  if (!isEmail(email)) return null;
  if (name.toLowerCase() === email) name = "";
  return { name, email };
}

function parseMailboxList(list) {
  const arr = Array.isArray(list) ? list : splitAddressList(String(list || ""));
  return arr.map(parseMailbox).filter(Boolean);
}

/** Split on commas that are not inside quotes or angle brackets. */
export function splitAddressList(s) {
  const out = [];
  let buf = "", inQuote = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inQuote = !inQuote;
    else if (!inQuote && c === "<") depth++;
    else if (!inQuote && c === ">") depth--;
    if (c === "," && !inQuote && depth <= 0) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.map((x) => x.trim()).filter(Boolean);
}

const isEmail = (e) => /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]{2,}$/.test(String(e || ""));
export const domainOf = (e) => String(e || "").split("@")[1]?.toLowerCase() || "";
export const localPartOf = (e) => String(e || "").split("@")[0] || "";

/**
 * Domains where a shared suffix says nothing about a shared organisation, so
 * "same domain as the sender" must not be used to group people.
 */
const CONSUMER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "protonmail.com", "proton.me", "gmx.com", "gmx.de", "mail.com",
  "zoho.com", "yandex.com", "fastmail.com", "hey.com",
  "telia.com", "bredband.net", "comhem.se", "spray.se", "hotmail.se", "live.se",
]);
export const isConsumerDomain = (d) => CONSUMER_DOMAINS.has(String(d || "").toLowerCase());

/** Strip common no-reply / automation senders, never worth a CRM record. */
const NOREPLY = /^(no-?reply|do-?not-?reply|donotreply|bounce|mailer-daemon|postmaster|notifications?|automated|auto-?confirm|support-?bot)([.\-_+]|$)/i;
export const isNoReply = (email) => NOREPLY.test(localPartOf(email));

/**
 * Build the candidate set for a message, in priority order.
 *
 * Ranking, highest first:
 *
 *   1. **To:** recipients, the people the message is actually addressed to.
 *   2. **Cc:** recipients, copied in, so secondary.
 *   3. Bcc, which is rare and usually only visible on your own sent mail.
 *
 * The default target is the sender, because for received mail that is who wrote
 * to you. **Except on mail you sent yourself**: there the sender is one of your
 * own identities and worth nothing to a CRM, so the first To: recipient becomes
 * the default, which is exactly the person the message was for.
 *
 * Colleagues are grouped by the *target's* domain, not blindly by the sender's,
 * so the grouping still makes sense once the target moves.
 *
 * @returns {{primary, sameDomain: [], otherDomain: [], excludedSelf: [], sentByMe: boolean}}
 */
export function buildCandidates({ author, recipients = [], ccList = [], bccList = [] }, {
  ownAddresses = [],
  includeCc = true,
} = {}) {
  const own = new Set(ownAddresses.map((a) => String(a).toLowerCase()));
  const from = parseMailbox(author);

  const tag = (list, role) => parseMailboxList(list).map((m) => ({ ...m, role }));
  const to = tag(recipients, "to");
  const cc = tag(ccList, "cc");
  const bcc = tag(bccList, "bcc");

  // To: outranks Cc:, which outranks Bcc.
  const ranked = [...to, ...(includeCc ? cc : []), ...bcc];

  const sentByMe = Boolean(from && own.has(from.email));

  // On your own sent mail the sender is you, so the recipient is the contact.
  let primary = null;
  if (!sentByMe && from) {
    primary = { ...from, role: "from" };
  } else {
    primary = ranked.find((c) => !own.has(c.email)) || (from ? { ...from, role: "from" } : null);
  }

  const targetDomain = primary ? domainOf(primary.email) : "";
  const groupable = Boolean(targetDomain) && !isConsumerDomain(targetDomain);

  const seen = new Set(primary ? [primary.email] : []);
  const sameDomain = [], otherDomain = [], excludedSelf = [];

  // The sender still deserves a place among the alternatives on sent mail.
  const pool = sentByMe && from ? [...ranked, { ...from, role: "from" }] : ranked;

  for (const c of pool) {
    if (seen.has(c.email)) continue;
    seen.add(c.email);
    if (own.has(c.email)) { excludedSelf.push(c); continue; }
    if (groupable && domainOf(c.email) === targetDomain) sameDomain.push(c);
    else otherDomain.push(c);
  }

  return {
    primary,
    sameDomain,
    otherDomain,
    excludedSelf,
    sentByMe,
    senderDomain: targetDomain,   // named for the UI; it is the target's domain
    groupable,
  };
}

/** Every address in the message, deduped, used for "who else is in the CRM". */
export function allAddresses(header) {
  const out = new Map();
  for (const m of [
    ...(header.author ? parseMailboxList([header.author]) : []),
    ...parseMailboxList(header.recipients || []),
    ...parseMailboxList(header.ccList || []),
    ...parseMailboxList(header.bccList || []),
  ]) {
    if (!out.has(m.email)) out.set(m.email, m);
  }
  return [...out.values()];
}
