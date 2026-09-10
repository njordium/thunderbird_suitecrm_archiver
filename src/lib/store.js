/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Thin, typed-ish wrapper over browser.storage.local.
 *
 * Storage layout:
 *   connection = { baseUrl, apiBase, clientId, clientSecret, username }
 *   tokens     = { accessToken, accessExpiresAt, refreshToken, refreshObtainedAt }
 *   prefs      = { ... }
 *   identities = cached list of the user's own addresses
 *
 * NOTE ON SECRETS: a WebExtension has no OS keychain access. clientSecret and
 * refreshToken live in storage.local, which is plain-text on disk inside the
 * Thunderbird profile. Far better than keeping the CRM password itself — a
 * refresh token is revocable and rotates on every use — but it is not a secret
 * vault. The reasoning behind that trade-off is in docs/RESEARCH.md.
 */

const DEFAULT_PREFS = {
  archiveAttachments: true,
  skipInlineImages: true,
  renameBlockedAttachments: false,
  includeCcRecipients: true,
  showOtherDomainRecipients: false,
  autoSearchOnOpen: true,
  // null means the built-in four. An array replaces them, which is how a site
  // stops searching a module it never uses, or adds a custom one.
  searchModules: null,
  /**
   * Which accounts the archiving button works in.
   *
   *   null      every account, including ones added later (the default)
   *   [ids...]  exactly these accounts — an empty array means none
   *
   * `null` rather than `[]` for "all", because `[]` has to be available to mean
   * "none"; otherwise unticking every account would silently re-enable them all.
   */
  enabledAccounts: null,
  setupGuideHidden: false,
  debugMode: false,
  requireHttps: false,
  archiveWholeThread: false,
  useOriginalDate: true,
  // A reply to case mail carries SuiteCRM's own subject macro, which names
  // exactly one Case. See src/lib/caseRef.js for why that beats an address
  // lookup for those messages.
  matchCaseReferences: true,
  caseSubjectMacro: "[CASE:%1]",
  showSenderBadge: true,
  showMessageBanner: true,
  tagArchivedMessages: true,
  showComposeStatus: true,
  archiveOnSend: false,
  crmAddressBook: true,
  // "smart" | "always" | "never" — where attachments are stored.
  attachmentDestination: "smart",
  logLevel: "info",
};

export async function get(key, fallback = null) {
  const res = await browser.storage.local.get(key);
  return Object.prototype.hasOwnProperty.call(res, key) ? res[key] : fallback;
}

export async function set(key, value) {
  await browser.storage.local.set({ [key]: value });
}

export async function remove(key) {
  await browser.storage.local.remove(key);
}

export const getConnection = () => get("connection", null);
export const setConnection = (c) => set("connection", c);

export const getTokens = () => get("tokens", null);
export const setTokens = (t) => set("tokens", t);
export const clearTokens = () => remove("tokens");

/**
 * Preferences are read constantly — several times per archive, once per badge
 * lookup, once per displayed message — and every read was a separate
 * storage.local round trip. They change rarely, so hold them in memory and drop
 * the copy whenever anything writes, including from another window.
 */
let prefsCache = null;

export async function getPrefs() {
  if (prefsCache) return prefsCache;
  prefsCache = { ...DEFAULT_PREFS, ...(await get("prefs", {})) };
  return prefsCache;
}

export async function setPrefs(patch) {
  const next = { ...(await getPrefs()), ...patch };
  prefsCache = next;
  await set("prefs", next);
  return next;
}

/** Forget the cached copy — for tests, and when storage changes elsewhere. */
function invalidatePrefs() { prefsCache = null; }

// The settings page and the popup are separate contexts writing the same key,
// so a change made in one must not leave the other serving a stale copy.
try {
  browser.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.prefs) invalidatePrefs();
  });
} catch { /* no storage events available; the in-process path still invalidates */ }

export { DEFAULT_PREFS };
