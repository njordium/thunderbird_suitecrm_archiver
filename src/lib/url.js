/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * CRM base-URL handling.
 *
 * Lives apart from auth.js so the options page can normalise a URL *synchronously*.
 * That matters: browser.permissions.request() only works while the user's click is
 * still "active", and any await before it — including a runtime.sendMessage round
 * trip to the background page — spends that activation and makes the call throw
 * "permissions.request may only be called from a user input handler".
 */

export class UrlError extends Error {
  constructor(message) { super(message); this.name = "UrlError"; }
}

/** Strip a trailing slash and any accidental /index.php the user pasted. */
export function normaliseBaseUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) throw new UrlError("CRM URL is required");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  u = u.split("/index.php")[0];
  u = u.replace(/\/+$/, "");
  // Tolerate someone pasting the API path itself.
  u = u.replace(/\/(legacy\/)?Api(\/V8)?\/?$/i, (m, legacy) => (legacy ? "/legacy" : ""));
  u = u.replace(/\/legacy$/i, "/legacy");
  return u;
}

/**
 * The host permission pattern for a CRM base URL.
 *
 * Deliberately built from protocol + hostname with NO port. Firefox — and so
 * Thunderbird — does not support a port in a match pattern (bug 1362809), and an
 * invalid pattern makes permissions.request() and permissions.contains() throw
 * rather than return false. Using `origin` here, which keeps the port, silently
 * broke every request to a CRM served on a non-default port.
 *
 * The consequence is that granting access covers that host on any port. That is
 * the narrowest grant the platform can express.
 */
export function originPatternFor(baseUrl) {
  const u = new URL(normaliseBaseUrl(baseUrl));
  return `${u.protocol}//${u.hostname}/*`;
}


/**
 * Origins Gecko treats as "potentially trustworthy" even over plain http.
 *
 * This matters because add-on pages are secure contexts, and a fetch from a
 * secure context to a non-trustworthy http:// origin is blocked as mixed
 * content before any packet is sent. localhost is exempt; a LAN address is not.
 */
export function isTrustworthyPlaintext(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/** Would a request to this base URL be blocked as mixed content? */
export function isMixedContentRisk(baseUrl) {
  try {
    const u = new URL(normaliseBaseUrl(baseUrl));
    return u.protocol === "http:" && !isTrustworthyPlaintext(u.hostname);
  } catch {
    return false;
  }
}
