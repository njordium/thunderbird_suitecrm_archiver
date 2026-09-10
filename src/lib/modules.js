/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Which SuiteCRM modules we search, and how.
 *
 * DIRECT: the bean owns an `email1` field, so ModuleService's email-join
 * branch can resolve an address straight to records. This is the real,
 * verified capability — see docs/RESEARCH.md.
 *
 * INDIRECT: no address of its own. These are reached by traversing a
 * relationship from a matched Contact or Account. A name-LIKE search against
 * them is the obvious alternative and a poor one: an Opportunity's name rarely
 * contains the person's, so searching it by email never matches.
 */

export const DIRECT_MODULES = ["Contacts", "Leads", "Accounts", "Prospects"];

export const MODULE_LABEL = {
  Contacts: "Contact",
  Leads: "Lead",
  Accounts: "Account",
  Prospects: "Target",
  Opportunities: "Opportunity",
  AOS_Quotes: "Quote",
  Project: "Project",
  Cases: "Case",
  Meetings: "Meeting",
  Tasks: "Task",
  Documents: "Document",
};

/** Fields to request per module — keeps payloads small and predictable. */
export const MODULE_FIELDS = {
  Contacts: ["id", "first_name", "last_name", "title", "account_name", "account_id",
             "email1", "phone_work", "phone_mobile", "assigned_user_name", "date_modified"],
  // account_id is set only once a Lead has been converted, and is what lets a
  // Case or Opportunity attach to the Account behind it. Costs nothing to ask
  // for; an unconverted Lead simply returns it empty.
  Leads:    ["id", "first_name", "last_name", "title", "account_name", "account_id", "status",
             "email1", "phone_work", "phone_mobile", "assigned_user_name", "date_modified"],
  Accounts: ["id", "name", "email1", "phone_office", "website", "billing_address_city",
             "billing_address_country", "assigned_user_name", "date_modified"],
  Prospects:["id", "first_name", "last_name", "title", "account_name",
             "email1", "assigned_user_name", "date_modified"],
};

/** How a matched record reaches further records worth offering. */
export const RELATED_LINKS = {
  Contacts: [
    { module: "Opportunities", link: "opportunities" },
    { module: "AOS_Quotes",    link: "aos_quotes" },
    { module: "Cases",         link: "cases" },
    { module: "Project",       link: "project" },
  ],
  Accounts: [
    { module: "Opportunities", link: "opportunities" },
    { module: "AOS_Quotes",    link: "aos_quotes" },
    { module: "Cases",         link: "cases" },
    { module: "Project",       link: "project" },
    { module: "Contacts",      link: "contacts" },
  ],
  Leads: [],
  Prospects: [],
};

/**
 * Link field on the Emails bean for each target module. Used in addition to
 * parent_type/parent_id so the email shows up in the record's Activity panel.
 */
export const EMAIL_LINK_FIELD = {
  Contacts: "contacts",
  Leads: "leads",
  Accounts: "accounts",
  Prospects: "prospects",
  Opportunities: "opportunities",
  AOS_Quotes: "aos_quotes",
  Project: "project",
  Cases: "cases",
};

/** Human label for a record, whatever module it came from. */
export function recordLabel(rec) {
  if (!rec) return "";
  const person = [rec.first_name, rec.last_name].filter(Boolean).join(" ").trim();
  return person || rec.name || rec.document_name || rec.id;
}

/** Who owns the record — often the deciding factor between two matches. */
export function recordOwner(rec) {
  return rec?.assigned_user_name || "";
}

export function recordSubtitle(rec) {
  const bits = [];
  if (rec.title) bits.push(rec.title);
  if (rec.account_name && rec.module !== "Accounts") bits.push(rec.account_name);
  if (rec.status) bits.push(rec.status);
  if (rec.module === "Accounts") {
    if (rec.billing_address_city) bits.push(rec.billing_address_city);
    if (rec.website) bits.push(String(rec.website).replace(/^https?:\/\//, ""));
  }
  return bits.filter(Boolean).join(" · ");
}


/**
 * Fields SuiteCRM accepts on write but does not report from /meta/fields.
 *
 * The Emails bean stores addresses through a relationship, so `from_addr` and
 * friends are bean properties rather than columns and never appear in the field
 * list — yet writing them is the only way to record who an email was from. A
 * naive "drop anything meta does not know" filter therefore throws away the
 * sender and every recipient, silently. Keep these regardless.
 */
export const WRITE_ONLY_FIELDS = {
  Emails: ["from_addr", "from_name", "to_addrs", "cc_addrs", "bcc_addrs", "reply_to_addr"],
  Notes: ["filename", "filecontents"],
  Documents: ["filename", "filecontents"],
};

/** Upload directives, valid on any module that accepts a file. */
export const UPLOAD_FIELDS = ["filename", "filecontents"];


/**
 * Should the add-on act on a message in this account?
 *
 * The encoding matters: `null` means every account, including ones added later,
 * while an array lists exactly which ones — and an empty array means none. If
 * "all" were also `[]`, unticking every account would silently re-enable them.
 *
 * @param {null|string[]} enabled
 * @param {string|undefined} accountId
 */
export function accountAllowed(enabled, accountId) {
  if (!Array.isArray(enabled)) return { allowed: true };
  if (enabled.length === 0) return { allowed: false, noneEnabled: true };
  // Cannot tell which account it came from: allow, rather than block silently.
  if (!accountId) return { allowed: true };
  return { allowed: enabled.includes(accountId) };
}
