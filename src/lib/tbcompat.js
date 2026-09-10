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
/**
 * Reduce the same shapes to an *array* of MessageHeaders.
 *
 * A separate function rather than a flag, because the two callers want genuinely
 * different things and confusing them is not a hypothetical: unwrapMessageList
 * returns one header, and using it where an array was meant made `.length`
 * undefined, `[0]` undefined and destructuring throw. That silently disabled a
 * context menu, two of its entries, a keyboard shortcut and the in-message
 * banner, all without a single error surfacing. Distinct names make the mistake
 * unavailable.
 *
 * @returns {object[]} possibly empty, never null
 */
export function unwrapMessageListAll(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result.filter(Boolean);
  if (Array.isArray(result.messages)) return result.messages.filter(Boolean);
  return result.id !== undefined ? [result] : [];
}

export function unwrapMessageList(result) {
  if (!result) return null;
  if (Array.isArray(result)) return result[0] || null;
  if (Array.isArray(result.messages)) return result.messages[0] || null;
  return result.id !== undefined ? result : null;
}
