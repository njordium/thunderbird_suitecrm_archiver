/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The toolbar badge: is the sender of the message on screen in the CRM?
 *
 * Answering passively is what makes the add-on useful before it is clicked, but
 * it means a CRM request per message viewed. Two things keep that honest: a
 * short delay so arrowing down a folder does not fire a request per row, and a
 * per-address cache so repeat correspondents cost one lookup.
 */

import { log } from "./log.js";

const LOOKUP_DELAY_MS = 400;

const BADGE = {
  found:   { colour: "#1c8b4f", title: (n, who) => `${n} CRM record${n === 1 ? "" : "s"} for ${who}` },
  missing: { colour: "#8a8f98", title: (_n, who) => `${who} is not in SuiteCRM yet` },
  error:   { colour: "#9a6400", title: () => "Could not reach SuiteCRM" },
};

/**
 * @param {object} deps
 * @param {(email:string)=>Promise<number|null>} deps.count  records for an address, null on failure
 * @param {(tabId:number, text:string, colour:string, title:string)=>Promise<void>} deps.paint
 */
export function createBadgeUpdater({ count, paint, delayMs = LOOKUP_DELAY_MS }) {
  const timers = new Map();

  async function run(tabId, sender) {
    const who = sender.name || sender.email;
    let n = null;
    try {
      n = await count(sender.email);
    } catch (e) {
      log.debug("badge lookup failed:", e.message);
    }

    if (n === null) {
      return paint(tabId, "!", BADGE.error.colour, BADGE.error.title());
    }
    if (n === 0) {
      return paint(tabId, "·", BADGE.missing.colour, BADGE.missing.title(0, who));
    }
    return paint(tabId, String(Math.min(n, 99)), BADGE.found.colour, BADGE.found.title(n, who));
  }

  return {
    /** Schedule a lookup, replacing any pending one for the same tab. */
    schedule(tabId, sender) {
      this.cancel(tabId);
      if (!sender?.email) return paint(tabId, "", "", "Archive to SuiteCRM");
      const t = setTimeout(() => {
        timers.delete(tabId);
        run(tabId, sender).catch((e) => log.debug("badge paint failed:", e.message));
      }, delayMs);
      timers.set(tabId, t);
    },

    cancel(tabId) {
      const t = timers.get(tabId);
      if (t) { clearTimeout(t); timers.delete(tabId); }
    },

    clear(tabId) {
      this.cancel(tabId);
      return paint(tabId, "", "", "Archive to SuiteCRM");
    },

    get pending() { return timers.size; },
  };
}
