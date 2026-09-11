/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Reading a Case reference out of an email subject.
 *
 * SuiteCRM stamps outbound case mail with a macro carrying the case number, so
 * the reply comes back still carrying it. From
 * modules/InboundEmail/InboundEmail.php:
 *
 *   $email->name = str_replace('%1', $c->case_number, $c->getEmailSubjectMacro())
 *                . " " . $email->name;
 *
 * and the same file documents parsing '[CASE:%1]' on the way back in. So a
 * reply to a case notification arrives as "[CASE:1234] Printer is jammed".
 *
 * That matters because it is the one situation where the correct destination is
 * unambiguous and an address lookup is the wrong tool: the sender may not be in
 * the CRM at all, or may have several records, while the subject names exactly
 * one Case.
 *
 * The macro is configurable per instance (`inbound_email_case_subject_macro` in
 * config.php) and the V8 API does not expose it, so it is a preference here
 * rather than something discoverable. Building the pattern from the template
 * rather than hard-coding one keeps a customised macro working, and covers the
 * older SugarCRM style where the number followed the macro instead of sitting
 * inside it.
 */

/** SuiteCRM's own default, from its InboundEmail documentation. */
export const DEFAULT_CASE_MACRO = "[CASE:%1]";

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Clean up a macro as a person is likely to supply it.
 *
 * The value lives in the CRM's config.php, so it gets copied from there, which
 * means it arrives wrapped in PHP quoting or as the whole assignment line. The
 * metacharacters inside it are escaped rather than removed, because they are
 * literal parts of the macro: stripping the brackets and colon from [CASE:%1]
 * would leave a pattern that no longer matches [CASE:1234] at all.
 */
export function normaliseMacro(input) {
  let t = String(input ?? "").trim();

  // $sugar_config['inbound_email_case_subject_macro'] = '[CASE:%1]';
  const assigned = t.match(/=\s*(.+?)\s*;?\s*$/);
  if (assigned && /\$?sugar_config|=/.test(t)) t = assigned[1].trim();

  t = t.replace(/;+\s*$/, "").trim();

  // Matching quotes, including the smart quotes a document or email adds.
  const quoted = t.match(/^(['"\u2018\u201c\u00ab])(.*)(['"\u2019\u201d\u00bb])$/);
  if (quoted) t = quoted[2].trim();

  return t;
}

/**
 * A pattern matching the macro with its number captured.
 *
 * Returns null for a template with no `%1`, because such a macro cannot
 * identify a case and a pattern built from it would match the literal text on
 * every reply in a thread.
 */
export function caseRefPattern(macro = DEFAULT_CASE_MACRO) {
  const template = normaliseMacro(macro);
  if (!template || !template.includes("%1")) return null;

  // Tolerate whitespace where the template has none: subjects get re-wrapped and
  // re-encoded by intermediate mail systems, and "[CASE: 1234]" should still
  // match a "[CASE:%1]" macro.
  // 11 digits, because SuiteCRM declares case_number as int with len 11, and a
  // signed MySQL int cannot exceed 2147483647 anyway. Without a bound, a loose
  // macro such as "#%1" would capture an order or tracking number out of an
  // unrelated subject and send it to the CRM as a case lookup.
  //
  // The trailing lookahead is what makes the bound mean "reject" rather than
  // "truncate". Bounded capture alone matched the first 11 digits of a 19-digit
  // number and produced a plausible but wrong case number, which is worse than
  // no match at all. There is no matching lookbehind: the macro's own literal
  // always sits immediately before the digits, so nothing can precede them, and
  // asserting it would break a macro whose literal part ends in a digit.
  //
  // Horizontal whitespace only, and bounded: a subject reaches us as one
  // unfolded line, so a newline here is not a real case, and \s* is looser than
  // anything that actually occurs. This absorbs a stray space from a mail
  // system without absorbing anything strange.
  const pattern = template
    .split("%1")
    .map(escapeRe)
    .join("[ \\t]{0,4}(\\d{1,11})(?!\\d)[ \\t]{0,4}");

  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;                    // a macro that will not compile
  }
}

/**
 * The case number in a subject, or null.
 *
 * Returns a string rather than a number: case_number is an int in SuiteCRM but
 * it goes straight back into a query, and parsing then re-serialising it only
 * creates opportunities to lose a leading zero or overflow.
 */
export function findCaseNumber(subject, macro = DEFAULT_CASE_MACRO) {
  const re = caseRefPattern(macro);
  if (!re) return null;

  const m = re.exec(String(subject || ""));
  if (!m) return null;

  // Strip leading zeros so "[CASE:0042]" and "[CASE:42]" resolve to the same
  // record, but keep a single zero rather than emptying the string.
  const digits = m[1].replace(/^0+(?=\d)/, "");
  return digits || null;
}

/**
 * Does this subject look like a reply or forward of case mail?
 *
 * Not used to decide whether to look the case up, only to describe why a Case
 * was offered. Kept separate so the caller can word it accurately.
 */
export function looksLikeReply(subject) {
  return /^\s*(re|aw|sv|vs|fwd?|vb|antw)\s*:/i.test(String(subject || ""));
}

/**
 * Find the Case a reply belongs to from its reference chain.
 *
 * The subject macro is the documented route and it costs nothing, but it only
 * works while the macro survives: an administrator changes
 * `inbound_email_case_subject_macro`, a mailing system rewrites the subject, or
 * the person replying trims it. `References` is not edited by hand in the same
 * way, and SuiteCRM stored its own outbound case mail as an `Emails` record
 * carrying that Message-ID with the Case as its parent. So any ancestor of this
 * reply can name the Case even when the subject no longer does.
 *
 * Nearest ancestor first, since the message being replied to is the likeliest
 * to be the case mail, and bounded, so an old thread cannot turn one lookup
 * into thirty requests.
 */
export async function findCaseByReferences(client, ids, { max = 5, log = null } = {}) {
  const chain = [...(ids || [])].filter(Boolean);
  // The chain runs oldest to newest, so the immediate parent is at the end.
  const nearestFirst = chain.reverse().slice(0, max);

  for (const messageId of nearestFirst) {
    let records = [];
    try {
      records = await client.getRecords("Emails", {
        filter: { message_id: { eq: messageId } },
        fields: ["id", "name", "parent_type", "parent_id"],
        size: 1,
      });
    } catch (e) {
      // One unreadable ancestor must not stop the rest of the chain.
      log?.debug?.(`Case reference lookup failed for ${messageId}: ${e.message}`);
      continue;
    }

    const hit = (records || []).find((r) => r?.parent_type === "Cases" && r?.parent_id);
    if (hit) return { caseId: hit.parent_id, viaMessageId: messageId };
  }
  return null;
}
