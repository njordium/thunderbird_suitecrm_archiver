/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Relative dates for record cards.
 *
 * When two records match the same address, "last modified 3 days ago" is what
 * decides between them; a timestamp makes you do the arithmetic yourself.
 */

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/**
 * @param {string|number|Date} when
 * @param {Date} [now]
 * @returns {string} e.g. "3 days ago", "just now", "" when unparseable
 */
export function timeAgo(when, now = new Date()) {
  if (!when) return "";
  const then = when instanceof Date ? when : new Date(when);
  const t = then.getTime();
  if (Number.isNaN(t)) return "";

  const diff = now.getTime() - t;
  if (diff < 0) return then.toLocaleDateString();          // dated in the future
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return plural(Math.floor(diff / HOUR), "hour");

  const days = Math.floor(diff / DAY);
  if (days === 1) return "yesterday";
  if (days < 30) return plural(days, "day");
  if (days < 365) return plural(Math.floor(days / 30), "month");

  // Beyond a year, the actual date is more useful than "2 years ago".
  return then.toLocaleDateString();
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
