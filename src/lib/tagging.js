/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Marking archived mail with a Thunderbird tag.
 *
 * A tag is worth more than a note in our own storage: it colours the row, can be
 * a message-list column, and drives saved searches and filters, so "everything
 * not yet archived" becomes a folder view without us building one. It also stops
 * two people archiving the same message twice.
 */

import { log } from "./log.js";

export const TAG_KEY = "suitecrm-archived";
const TAG_LABEL = "SuiteCRM";
const TAG_COLOUR = "#1a6ea8";

/**
 * Create the tag if the profile does not have it yet.
 * Thunderbird keys tags by a string the user never sees, so a tag renamed in
 * Thunderbird's own settings is still found here.
 */
async function ensureTag() {
  const api = browser.messages?.tags;
  if (!api) return null;

  try {
    const existing = await api.list();
    const found = existing.find((t) => t.key === TAG_KEY);
    if (found) return found.key;

    await api.create(TAG_KEY, TAG_LABEL, TAG_COLOUR);
    log.info(`Created the "${TAG_LABEL}" tag.`);
    return TAG_KEY;
  } catch (e) {
    log.warn("Could not create the archive tag:", e.message);
    return null;
  }
}

/**
 * Add the tag to a message, keeping whatever tags it already had.
 * Failure is never fatal: the email is in the CRM either way, and losing the
 * archive over a tag would be absurd.
 */
export async function tagMessage(messageId) {
  const key = await ensureTag();
  if (!key) return false;

  try {
    const header = await browser.messages.get(messageId);
    const tags = new Set(header.tags || []);
    if (tags.has(key)) return true;
    tags.add(key);
    await browser.messages.update(messageId, { tags: [...tags] });
    return true;
  } catch (e) {
    log.warn(`Could not tag message ${messageId}:`, e.message);
    return false;
  }
}

/** Remove the tag again, for undo. */
export async function untagMessage(messageId) {
  try {
    const header = await browser.messages.get(messageId);
    const tags = (header.tags || []).filter((t) => t !== TAG_KEY);
    await browser.messages.update(messageId, { tags });
    return true;
  } catch (e) {
    log.debug(`Could not remove the tag from ${messageId}:`, e.message);
    return false;
  }
}

/** Merge a tag into an existing list without duplicating or reordering. */
export function withTag(existing, key = TAG_KEY) {
  const tags = Array.isArray(existing) ? existing : [];
  return tags.includes(key) ? [...tags] : [...tags, key];
}

export function withoutTag(existing, key = TAG_KEY) {
  return (Array.isArray(existing) ? existing : []).filter((t) => t !== key);
}
