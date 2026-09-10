/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Small shims over Thunderbird API shapes that changed across versions.
 *
 * The message-display API is the one that actually caught us out: current
 * builds expose only `getDisplayedMessages()` (plural) returning a MessageList,
 * while older code and older builds used `getDisplayedMessage()` (singular)
 * returning a lone MessageHeader. The names differ by one character, so a
 * substring check "verifies" the wrong one — hence a pure function with tests.
 */

/**
 * Reduce whatever a message-display call returned to a single MessageHeader.
 *
 * Handles a MessageList (`{id, messages: [...]}`), a plain array, a lone
 * MessageHeader, and nothing at all.
 *
 * @returns {object|null}
 */
export function unwrapMessageList(result) {
  if (!result) return null;
  if (Array.isArray(result)) return result[0] || null;
  if (Array.isArray(result.messages)) return result.messages[0] || null;
  return result.id !== undefined ? result : null;
}
