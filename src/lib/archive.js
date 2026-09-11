/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Turn a Thunderbird message into a SuiteCRM Emails record, attached to a
 * chosen parent record, with its attachments as related Notes.
 *
 * The field mapping and the message_id de-duplication strategy are the
 * conventional ones for SuiteCRM's Emails module, and correct, see
 * docs/RESEARCH.md for what the API actually accepts.
 */

import { log } from "./log.js";
import { EMAIL_LINK_FIELD } from "./modules.js";
import { extractPlainText, htmlToText } from "./signature.js";
import * as store from "./store.js";

/**
 * Fields to read back for de-duplication.
 *
 * `from_addr` is accepted on write but NEVER returned by the V8 API, it is a
 * non-db field populated from a relationship. `from_addr_name` is the readable
 * one. Asking for the wrong one silently yields undefined, which made the
 * sender cross-check below accept everything.
 */
const EMAIL_FIELDS = ["id", "name", "message_id", "date_sent_received",
                      "from_addr_name", "parent_type", "parent_id"];

/** SuiteCRM's own "archived email" marker. */
const ARCHIVED_TYPE = "archived";
const ARCHIVED_STATUS = "archived";

/** `YYYY-MM-DD HH:MM:SS` in UTC, which is what the Emails bean stores. */
export function toCrmDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Message-ID without the angle brackets, which is how SuiteCRM stores it. */
export function normaliseMessageId(raw) {
  return String(raw || "").trim().replace(/^</, "").replace(/>$/, "");
}

function headerValue(full, name) {
  const h = full?.headers?.[name.toLowerCase()];
  return Array.isArray(h) ? h[0] : h || "";
}

function joinAddresses(list) {
  if (!list) return "";
  return (Array.isArray(list) ? list : [list]).filter(Boolean).join(", ");
}

/**
 * Read everything we need out of Thunderbird for one message.
 */
export async function readMessage(messageId) {
  const header = await browser.messages.get(messageId);
  const full = await browser.messages.getFull(messageId, { decodeContent: true });

  const bodies = extractPlainText(full);
  const bodyText = bodies.text || htmlToText(bodies.html);

  let attachments = [];
  try {
    attachments = await browser.messages.listAttachments(messageId);
  } catch (e) {
    log.warn("Could not list attachments:", e.message);
  }

  // A vCard beats every signature heuristic, so pull it eagerly if present.
  let vcard = null;
  const card = attachments.find((a) => /vcard|x-vcard|\.vcf$/i.test(a.contentType + " " + (a.name || "")));
  if (card) {
    try {
      vcard = await (await browser.messages.getAttachmentFile(messageId, card.partName)).text();
    } catch (e) {
      log.warn("Could not read vCard attachment:", e.message);
    }
  }

  return {
    messageId,
    header,
    full,
    bodyText,
    bodyHtml: bodies.html,
    attachments,
    vcard,
    rfcMessageId: normaliseMessageId(header.headerMessageId || headerValue(full, "message-id")),
  };
}

/**
 * Build the Emails attributes payload.
 */
/**
 * @param {boolean} [opts.backdate] Set the record's creation date to the message's
 *   own send time. SuiteCRM orders activity timelines by `date_entered`, so
 *   without this an older message shows up under today's date. The V8 API
 *   honours an explicit `date_entered`, which is verified in tools/e2e.mjs.
 */
export function buildEmailAttributes(msg, { parentType, parentId, assignedUserId, backdate = false, subject = null }) {
  const h = msg.header;
  const chosen = typeof subject === "string" ? subject.trim() : "";
  const attrs = {
    // An overridden subject is what the user typed in the archiving window. It
    // changes the CRM record only; the message in Thunderbird is untouched.
    name: chosen || h.subject || "(no subject)",
    message_id: msg.rfcMessageId,
    from_addr: h.author || "",
    to_addrs: joinAddresses(h.recipients),
    cc_addrs: joinAddresses(h.ccList),
    bcc_addrs: joinAddresses(h.bccList),
    description: msg.bodyText || "",
    description_html: msg.bodyHtml || "",
    date_sent_received: toCrmDateTime(h.date),
    type: ARCHIVED_TYPE,
    status: ARCHIVED_STATUS,
  };
  if (backdate) {
    const sent = toCrmDateTime(h.date);
    if (sent) attrs.date_entered = sent;
  }
  if (parentType) attrs.parent_type = parentType;
  if (parentId) attrs.parent_id = parentId;
  if (assignedUserId) attrs.assigned_user_id = assignedUserId;

  // Drop nulls so we never blank a field the CRM already has.
  for (const k of Object.keys(attrs)) if (attrs[k] === null) delete attrs[k];
  return attrs;
}

/** Base64 without blowing the stack on large files. */
async function fileToBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * SuiteCRM refuses uploads whose extension is in $sugar_config['upload_badext'].
 * The defaults include html, htm, js, php and more, so ordinary attachments do
 * get rejected. We surface that per-file rather than failing the archive.
 */
const LIKELY_BLOCKED = /\.(php\d?|phtml|pl|cgi|py|asp|aspx|cfm|js|jsp|vbs|html?|shtml|htaccess|sh|exe|bat|cmd|com|hta)$/i;

/**
 * Filenames worth putting in the Documents module rather than as a Note.
 * A signed contract belongs somewhere searchable and versioned; a screenshot
 * pasted into a reply does not.
 */
const DOCUMENT_WORTHY = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv)$/i;

export function shouldBeDocument(filename, mode) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return DOCUMENT_WORTHY.test(String(filename || ""));   // "smart"
}

async function archiveAttachment(client, msg, emailRecordId, att, prefs, parent) {
  const file = await browser.messages.getAttachmentFile(msg.messageId, att.partName);
  const filename = att.name || `attachment-${att.partName}`;

  let uploadName = filename;
  if (LIKELY_BLOCKED.test(filename) && prefs.renameBlockedAttachments) {
    uploadName = `${filename}.txt`;
  }

  const base64 = await fileToBase64(file);
  const describe = `Attachment of archived email (${att.contentType || "unknown type"}, ${att.size || file.size} bytes)`;

  if (shouldBeDocument(filename, prefs.attachmentDestination)) {
    // Documents are versioned and searchable, which is the point of putting a
    // contract there. The upload uses the same filename/filecontents pair.
    try {
      const doc = await client.createRecord("Documents", {
        document_name: filename,
        filename: uploadName,
        filecontents: base64,
        description: describe,
        revision: "1",
        active_date: toCrmDateTime(msg.header?.date) || undefined,
      });

      // Relate it to the email and to whatever the email was filed against, so
      // it is reachable from the record rather than only from the message.
      for (const link of [
        { module: "Emails", id: emailRecordId },
        parent?.type && parent?.id ? { module: parent.type, id: parent.id } : null,
      ].filter(Boolean)) {
        try {
          await client.createRelationship("Documents", doc.id, link.module, link.id);
        } catch (e) {
          log.debug(`Document link to ${link.module} not created:`, e.message);
        }
      }
      return { name: filename, documentId: doc.id, module: "Documents", renamed: uploadName !== filename };
    } catch (e) {
      // Falling back to a Note is better than losing the attachment.
      log.warn(`Could not store "${filename}" as a Document, falling back to a Note:`, e.message);
    }
  }

  const note = await client.createNoteWithFile({
    name: filename,
    parent_type: "Emails",
    parent_id: emailRecordId,
    description: describe,
    filename: uploadName,
    filecontents: base64,
  });

  try {
    await client.createRelationship("Emails", emailRecordId, "Notes", note.id);
  } catch (e) {
    log.debug("Emails<->Notes link not created (harmless on some editions):", e.message);
  }
  return { name: filename, noteId: note.id, module: "Notes", renamed: uploadName !== filename };
}

/** Bare address out of a From header, for comparing two records' senders. */
export function senderAddress(value) {
  const s = String(value || "").trim();
  const angled = s.match(/<([^<>]+)>\s*$/);
  return (angled ? angled[1] : s).replace(/^mailto:/i, "").trim().toLowerCase();
}

/**
 * Does an existing Emails record plausibly describe this same message?
 * Compares the sender, which the Message-ID alone does not establish.
 */
export function sameSender(rec, msg) {
  const theirs = senderAddress(rec.from_addr_name ?? rec.from_addr);
  const ours = senderAddress(msg.header.author);
  if (theirs && ours) return theirs === ours;

  // No readable sender on the stored record, fall back to the send time, which
  // the API does return. A minute of slack absorbs rounding and timezone edges.
  const theirTime = Date.parse(rec.date_sent_received);
  const ourTime = msg.header.date ? new Date(msg.header.date).getTime() : NaN;
  if (!Number.isNaN(theirTime) && !Number.isNaN(ourTime)) {
    return Math.abs(theirTime - ourTime) < 60_000;
  }

  return true;   // nothing readable to contradict it
}

/** Inline images referenced by the HTML body, not real user attachments. */
const isInline = (att) =>
  Boolean(att.contentId) || (/^image\//i.test(att.contentType || "") && !att.name);

/**
 * Archive one message.
 *
 * @param {CrmClient} client
 * @param {object} msg              from readMessage()
 * @param {{type,id,label}} parent  the record to file the email under
 * @param {Array}  alsoLink         extra {module,id} records to relate
 */
export async function archiveMessage(client, msg, parent, { alsoLink = [], onProgress = () => {}, subject = null } = {}) {
  if (!parent || !parent.type || !parent.id) {
    throw new Error("No CRM record was chosen to file this email against.");
  }

  const prefs = await store.getPrefs();
  const result = { created: false, updated: false, emailId: null, attachments: [], warnings: [] };

  let assignedUserId = null;
  try {
    onProgress("Identifying CRM user…");
    const me = await client.getCurrentUser();
    assignedUserId = me?.data?.id || me?.data?.attributes?.id || null;
  } catch (e) {
    result.warnings.push(`Could not determine the CRM user; the email will be unassigned. (${e.message})`);
  }

  // De-duplicate: if this Message-ID is already archived, re-parent it instead
  // of creating a second copy.
  let existing = null;
  if (msg.rfcMessageId) {
    onProgress("Checking whether this email is already archived…");
    try {
      const found = await client.getRecords("Emails", {
        filter: { message_id: { eq: msg.rfcMessageId } },
        fields: EMAIL_FIELDS,
        size: 5,
      });
      // A Message-ID is chosen by whoever sent the mail and is not authenticated,
      // so a match alone is not proof of identity. Require the sender to agree
      // before re-parenting an existing record; otherwise a message crafted to
      // carry a known Message-ID could silently re-file unrelated correspondence.
      existing = found.find((rec) => sameSender(rec, msg)) || null;
      if (found.length && !existing) {
        result.warnings.push(
          "Another archived email carries the same Message-ID but a different sender, " +
          "so a separate record was created rather than re-filing that one."
        );
      }
    } catch (e) {
      result.warnings.push(`Duplicate check failed, continuing: ${e.message}`);
    }
  }

  const attrs = buildEmailAttributes(msg, {
    parentType: parent.type,
    parentId: parent.id,
    assignedUserId,
    backdate: prefs.useOriginalDate,
    subject,
  });

  if (existing) {
    onProgress("Updating the existing email record…");
    // Remember where it was filed, so undo restores rather than deletes: this
    // record existed before we touched it and belongs to whoever made it.
    result.previousParent = {
      type: existing.parent_type || "",
      id: existing.parent_id || "",
    };
    // Only re-parent; don't rewrite the body of an email already stored.
    const rec = await client.updateRecord("Emails", existing.id, {
      parent_type: parent.type,
      parent_id: parent.id,
    });
    result.emailId = rec?.id || existing.id;
    result.updated = true;
  } else {
    onProgress("Creating the email record…");
    const rec = await client.createRecord("Emails", attrs);
    result.emailId = rec?.id;
    result.created = true;
  }

  if (!result.emailId) throw new Error("SuiteCRM did not return an id for the email record.");

  // Relate to the parent and to any extra records the user ticked.
  const links = [{ module: parent.type, id: parent.id }, ...alsoLink];
  for (const l of links) {
    const linkField = EMAIL_LINK_FIELD[l.module];
    if (!linkField) continue;
    try {
      await client.createRelationship("Emails", result.emailId, l.module, l.id);
    } catch (e) {
      // parent_type/parent_id already ties them together; the link is a bonus.
      log.debug(`Relationship Emails->${l.module} not created:`, e.message);
    }
  }

  // Attachments.
  if (prefs.archiveAttachments && msg.attachments.length && !existing) {
    const wanted = msg.attachments.filter((a) => {
      if (prefs.skipInlineImages && isInline(a)) return false;
      if (/vcard|x-vcard/i.test(a.contentType || "")) return true;
      return true;
    });

    for (let i = 0; i < wanted.length; i++) {
      const att = wanted[i];
      onProgress(`Uploading attachment ${i + 1} of ${wanted.length}: ${att.name || att.partName}…`);
      try {
        result.attachments.push(await archiveAttachment(client, msg, result.emailId, att, prefs, parent));
      } catch (e) {
        const blocked = LIKELY_BLOCKED.test(att.name || "");
        result.warnings.push(
          blocked
            ? `"${att.name}" was rejected by SuiteCRM's upload_badext policy. ` +
              `Enable "rename blocked attachments" in options to store it as .txt.`
            : `Could not upload "${att.name || att.partName}": ${e.message}`
        );
      }
    }
  } else if (existing && msg.attachments.length) {
    result.warnings.push("Attachments were left alone because this email was already archived.");
  }

  return result;
}
