/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Building vCards for the CRM-backed address book.
 *
 * Thunderbird stores contacts as vCard, so a provider returns vCard strings
 * rather than field maps. Escaping matters: a comma, semicolon or newline in a
 * company name would otherwise split the record into the wrong fields.
 */

/** RFC 6350 §3.4 — escape the characters that delimit vCard values. */
export function escapeValue(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    // A lone CR must fold into the same escape; leaving it raw puts a control
    // character inside a value.
    .replace(/\r\n?/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    // "\\;" and not "\;": the latter is just ";" in a JS string literal, so
    // this rule silently did nothing and semicolons split N and ORG into the
    // wrong components.
    .replace(/;/g, "\\;");
}

const line = (name, value) => (value ? `${name}:${escapeValue(value)}` : null);

/**
 * A CRM record as a vCard.
 *
 * @param {object} rec  a flattened Contact, Lead or Prospect
 * @returns {string}
 */
export function recordToVCard(rec) {
  const first = rec.first_name || "";
  const last = rec.last_name || "";
  const full = [first, last].filter(Boolean).join(" ").trim() || rec.name || rec.email1 || "";

  const lines = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `N:${escapeValue(last)};${escapeValue(first)};;;`,
    line("FN", full),
    line("EMAIL", rec.email1),
    line("ORG", rec.account_name),
    line("TITLE", rec.title),
    rec.phone_work ? `TEL;TYPE=work:${escapeValue(rec.phone_work)}` : null,
    rec.phone_mobile ? `TEL;TYPE=cell:${escapeValue(rec.phone_mobile)}` : null,
    // Where the record came from, so a duplicate in a local book is tellable apart.
    line("NOTE", `SuiteCRM ${rec.module || ""}`.trim()),
    rec.id ? `UID:suitecrm-${escapeValue(rec.module || "record")}-${escapeValue(rec.id)}` : null,
    "END:VCARD",
  ];

  return lines.filter(Boolean).join("\r\n");
}

/** Only records with an address are useful for autocomplete. */
export function usableForAddressBook(rec) {
  return Boolean(rec && rec.email1 && String(rec.email1).includes("@"));
}
