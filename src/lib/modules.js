/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Which SuiteCRM modules we search, and how.
 *
 * DIRECT: the bean owns an `email1` field, so ModuleService's email-join
 * branch can resolve an address straight to records. This is the real,
 * verified capability, see docs/RESEARCH.md.
 *
 * INDIRECT: no address of its own. These are reached by traversing a
 * relationship from a matched Contact or Account. A name-LIKE search against
 * them is the obvious alternative and a poor one: an Opportunity's name rarely
 * contains the person's, so searching it by email never matches.
 */

export const DIRECT_MODULES = ["Contacts", "Leads", "Accounts", "Prospects"];

/**
 * Plural display names for the built-in four.
 *
 * SuiteCRM calls the Targets module "Prospects" internally, so that is the name
 * the API takes and the name a failure comes back under. Showing it raw made a
 * warning about a module nobody has heard of: the settings said Targets while
 * the error said Prospects. Everything user-facing goes through here.
 */
export const MODULE_TITLES = {
  Contacts: "Contacts", Leads: "Leads", Accounts: "Accounts", Prospects: "Targets",
};

/** What to call a module in front of a person, given the CRM's own labels. */
export function moduleTitle(name, labels = {}) {
  return MODULE_TITLES[name] || labels?.[name] || name;
}

/**
 * Whether a per-module search failure means the module is out of reach for
 * good, as opposed to one request going wrong.
 *
 * A revoked ACL answers 403, a module removed in Studio answers 404, and a
 * module the API does not recognise answers 400. Those are facts about this
 * user and this CRM, and retrying them every lookup only produces the same
 * warning again. A 5xx, a timeout or a network error is the other kind: the
 * module may be perfectly fine a minute later, so nothing is turned off.
 */
export function failureIsPermanent({ status = null } = {}) {
  return status === 400 || status === 403 || status === 404;
}

export const STRIKES_BEFORE_DISABLING = 3;

/**
 * What to do about a module whose search failed, once a plain read has been
 * tried as well.
 *
 * Three outcomes, because the failures are not alike. A read that succeeds
 * means the module is fine and that one query went wrong, so nothing changes.
 * A read refused with a definitive status is a fact about this user's access,
 * so the module goes. Anything else, a 500 or a connection that died, might be
 * the server having a moment, and turning a module off over one bad minute
 * would be its own bug: it takes three separate lookups before we accept it.
 */
export function moduleVerdict({ readSucceeded = false, status = null, strikes = 0 } = {}) {
  if (readSucceeded) return { action: "keep", strikes: 0 };
  if (failureIsPermanent({ status })) return { action: "disable", strikes: strikes + 1 };

  const next = strikes + 1;
  return next >= STRIKES_BEFORE_DISABLING
    ? { action: "disable", strikes: next }
    : { action: "strike", strikes: next };
}

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

/** Fields to request per module, keeps payloads small and predictable. */
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

/**
 * Fields worth reading for a Case resolved from a subject reference.
 *
 * Deliberately not a MODULE_FIELDS entry: that map is indexed by module name
 * when searching by email address, and a Case has no address of its own.
 * Verified against a live instance.
 */
export const CASE_FIELDS = [
  "id", "name", "case_number", "status", "priority",
  "account_name", "account_id", "assigned_user_name", "date_modified",
];

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

/** Who owns the record, often the deciding factor between two matches. */
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
 * list, yet writing them is the only way to record who an email was from. A
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
 * while an array lists exactly which ones, and an empty array means none. If
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
