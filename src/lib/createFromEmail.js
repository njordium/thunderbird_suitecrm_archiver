/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Turning an email into a business record: a Case, an Opportunity, a Meeting or
 * a follow-up Task.
 *
 * Filing an email is passive. Most mail that matters should start something, and
 * doing that here means the description, the contact and the Account are already
 * right instead of being retyped.
 *
 * Enum values are a hazard: /meta/fields reports a field's type and whether it is
 * required, but NOT its permitted values, and those differ between SuiteCRM
 * versions and customised installs. So this sets only what it can be sure of and
 * lets the bean's own defaults fill in status, priority and the like, except
 * where the field is genuinely required, where a widely-present default is used
 * and shown to the user before saving.
 */

import { toCrmDateTime } from "./archive.js";

const DESCRIPTION_LIMIT = 20000;

export const CREATABLE = {
  Cases: {
    label: "Case",
    blurb: "An enquiry or support request to work through.",
    fields: ["name"],
  },
  Opportunities: {
    label: "Opportunity",
    blurb: "A deal in the pipeline, against the Account.",
    fields: ["name", "amount", "date_closed", "sales_stage"],
  },
  Meetings: {
    label: "Meeting",
    blurb: "A meeting with the sender as invitee.",
    fields: ["name", "date_start", "duration_hours"],
  },
  Tasks: {
    label: "Follow-up task",
    blurb: "Something to come back to, assigned to you.",
    fields: ["name", "date_due"],
  },
};

/**
 * Which kinds can actually be linked to the record the email is being filed
 * against. SuiteCRM decides this, not us, and it is not uniform, verified
 * against a live instance by attempting each relationship:
 *
 *   Case         -> Lead    400 "Link field has not found in Case ... for Lead"
 *   Case         -> Target  400
 *   Opportunity  -> Target  400
 *   Opportunity  -> Lead    201
 *
 * Activities are the exception: a Meeting or Task names any module as its
 * parent, so those two are always available.
 *
 * Cases and Opportunities hang off an Account. A Contact or an Account supplies
 * one directly. A *converted* Lead carries account_id as well, so it supplies
 * one too, which is why an unconverted Lead can take an Opportunity (through
 * the leads relationship) but not a Case.
 *
 * Offering a kind that cannot be linked would create records attached to
 * nobody, under a form that claims otherwise, so the ones that cannot link are
 * not offered at all.
 */
export function creatableFor(parent) {
  const kinds = ["Meetings", "Tasks"];       // always linkable, via parent_type
  if (!parent?.type) return ["Cases", "Opportunities", ...kinds];

  const hasAccount = parent.type === "Accounts" ||
                     parent.type === "Contacts" ||
                     Boolean(parent.accountId);

  const out = [];
  if (hasAccount) out.push("Cases");
  if (hasAccount || parent.type === "Leads") out.push("Opportunities");
  return [...out, ...kinds];
}

/** Why a kind is missing, for the note under the picker. */
export function unavailableReason(parent) {
  if (!parent?.type) return "";
  const missing = ["Cases", "Opportunities"].filter((k) => !creatableFor(parent).includes(k));
  if (!missing.length) return "";

  const label = missing.map((k) => CREATABLE[k].label).join(" and ");
  if (parent.type === "Prospects") {
    return `${label} cannot be created against a Target, SuiteCRM has no relationship ` +
           `between them. Convert the Target first if you need one.`;
  }
  return `${label} cannot be created against a Lead that has not been converted, ` +
         `SuiteCRM attaches ${missing.length > 1 ? "them" : "it"} to an Account, and an ` +
         `unconverted Lead has none. Convert the Lead first if you need one.`;
}

/** `YYYY-MM-DD`, days from now. */
export function dateInDays(days, from = new Date()) {
  const d = new Date(from.getTime() + days * 864e5);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD HH:MM:SS` at a given hour, days from now. */
export function dateTimeInDays(days, hour = 9, from = new Date()) {
  const d = new Date(from.getTime() + days * 864e5);
  d.setUTCHours(hour, 0, 0, 0);
  return toCrmDateTime(d);
}

const trim = (text) => String(text || "").slice(0, DESCRIPTION_LIMIT);

/**
 * Sensible starting values, shown in the form so nothing is saved unseen.
 * Only `sales_stage` is a guessed enum, and only because Opportunities require
 * one; "Prospecting" is the first entry in SuiteCRM's stock list.
 */
export function defaultsFor(kind, msg) {
  const subject = msg?.header?.subject || "(no subject)";
  switch (kind) {
    case "Cases":
      return { name: subject };
    case "Opportunities":
      return {
        name: subject,
        amount: "0",
        date_closed: dateInDays(30),
        sales_stage: "Prospecting",
      };
    case "Meetings":
      return { name: subject, date_start: dateTimeInDays(1, 9), duration_hours: "1" };
    case "Tasks":
      return { name: `Follow up: ${subject}`, date_due: dateTimeInDays(3, 9) };
    default:
      return { name: subject };
  }
}

/**
 * Build the create payload.
 *
 * @param {string} kind        one of CREATABLE
 * @param {object} msg         from readMessage()
 * @param {object} ctx
 * @param {object} ctx.form    the values the user confirmed
 * @param {object} ctx.parent  the record the email is filed against
 * @param {string} [ctx.accountId]
 * @param {string} [ctx.assignedUserId]
 * @returns {{module: string, attributes: object, relate: Array}}
 */
export function buildRecord(kind, msg, { form = {}, parent = null, accountId = null, assignedUserId = null } = {}) {
  if (!CREATABLE[kind]) throw new Error(`Cannot create a ${kind} from an email.`);

  const values = { ...defaultsFor(kind, msg), ...stripEmpty(form) };
  const body = trim(msg?.bodyText || "");
  const from = msg?.header?.author ? `From: ${msg.header.author}\n\n` : "";

  const attributes = {
    name: values.name,
    description: from + body,
  };
  if (assignedUserId) attributes.assigned_user_id = assignedUserId;

  const relate = [];

  switch (kind) {
    case "Cases":
      if (accountId) attributes.account_id = accountId;
      if (parent?.type === "Contacts") relate.push({ module: "Contacts", id: parent.id });
      break;

    case "Opportunities":
      if (accountId) attributes.account_id = accountId;
      attributes.amount = values.amount ?? "0";
      attributes.date_closed = values.date_closed;
      attributes.sales_stage = values.sales_stage;
      if (parent?.type === "Contacts") relate.push({ module: "Contacts", id: parent.id });
      // Opportunities are the one Case-like module SuiteCRM does relate to a
      // Lead, converted or not. Verified against a live instance: POST to
      // /Opportunities/{id}/relationships with a Lead returns 201.
      if (parent?.type === "Leads") relate.push({ module: "Leads", id: parent.id });
      break;

    case "Meetings":
      attributes.date_start = values.date_start;
      attributes.duration_hours = String(values.duration_hours ?? "1");
      attributes.duration_minutes = "0";
      if (parent?.type && parent?.id) {
        attributes.parent_type = parent.type;
        attributes.parent_id = parent.id;
      }
      if (parent?.type === "Contacts") relate.push({ module: "Contacts", id: parent.id });
      break;

    case "Tasks":
      attributes.date_due = values.date_due;
      if (parent?.type && parent?.id) {
        attributes.parent_type = parent.type;
        attributes.parent_id = parent.id;
      }
      if (parent?.type === "Contacts") attributes.contact_id = parent.id;
      break;

    default:
      break;
  }

  return { module: kind, attributes, relate };
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = v;
  }
  return out;
}
