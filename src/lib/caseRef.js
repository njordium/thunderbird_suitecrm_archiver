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
 * A pattern matching the macro with its number captured.
 *
 * Returns null for a template with no `%1`, because such a macro cannot
 * identify a case and a pattern built from it would match the literal text on
 * every reply in a thread.
 */
export function caseRefPattern(macro = DEFAULT_CASE_MACRO) {
  const template = String(macro || "").trim();
  if (!template || !template.includes("%1")) return null;

  // Tolerate whitespace where the template has none: subjects get re-wrapped and
  // re-encoded by intermediate mail systems, and "[CASE: 1234]" should still
  // match a "[CASE:%1]" macro.
  const pattern = template
    .split("%1")
    .map(escapeRe)
    .join("\\s*(\\d{1,12})\\s*");

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
