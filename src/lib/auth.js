/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * OAuth2 against the SuiteCRM V8 API.
 *
 * WHY PASSWORD GRANT: SuiteCRM registers an AuthCodeGrant on its authorization
 * server (Api/V8/Config/services/middlewares.php) but exposes no /authorize
 * route (Api/V8/Config/routes.php), there is no endpoint that can issue an
 * authorization code. Upstream issue #7854, open since 2019. So a browser
 * redirect flow is impossible against a stock instance.
 *
 * WHAT WE DO INSTEAD: password grant exactly once, then persist ONLY the
 * refresh token and rotate it. Access tokens live 1h; refresh tokens live 1
 * month (P1M) and every refresh mints a fresh one, so the clock resets on each
 * use. The password is never written to disk.
 */

import { log } from "./log.js";
import * as store from "./store.js";
import { normaliseBaseUrl, isMixedContentRisk } from "./url.js";
import * as diag from "./diagnostics.js";
// 7.x vs 8.x layouts. Shared with the connection test so the two can never
// disagree about where the API might be.
import { API_SUFFIXES } from "./probe.js";

export { normaliseBaseUrl };

const EXPIRY_SKEW_MS = 60_000;      // refresh a minute early

export class AuthError extends Error {
  constructor(message, { code = null, status = null, needsLogin = false } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    this.needsLogin = needsLogin;
  }
}

async function postToken(apiBase, payload) {
  const url = `${apiBase}/access_token`;
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Note the grant type, never the payload, it carries the password.
    diag.recordRequest({
      method: "POST", url, error: e.message,
      ms: Date.now() - started, note: `grant=${payload.grant_type}`,
    });
    throw new AuthError(`Could not reach ${apiBase}: ${e.message}`);
  }
  diag.recordRequest({
    method: "POST", url, status: res.status,
    ms: Date.now() - started, note: `grant=${payload.grant_type}`,
  });

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* HTML error page, probably */ }

  if (!body) {
    throw new AuthError(
      `${apiBase} did not return JSON (HTTP ${res.status}). ` +
      `This usually means the V8 API is not at this path.`,
      { status: res.status }
    );
  }
  if (!res.ok || body.error) {
    const code = body.error || "unknown_error";
    const hint = body.hint || body.error_description || body.message || "";
    throw new AuthError(hint ? `${code}: ${hint}` : code, { code, status: res.status });
  }
  return body;
}

/**
 * Find whether the V8 API lives at /Api or /legacy/Api.
 * Probes with a deliberately invalid client: a live endpoint answers with a
 * JSON OAuth error, a wrong path answers 404/HTML.
 */
export async function discoverApiBase(baseUrl) {
  const errors = [];
  for (const suffix of API_SUFFIXES) {
    const apiBase = baseUrl + suffix;
    try {
      await postToken(apiBase, {
        grant_type: "client_credentials",
        client_id: "__probe__",
        client_secret: "__probe__",
      });
      return apiBase; // shouldn't succeed, but it proves the endpoint is alive
    } catch (e) {
      // ANY structured JSON OAuth error means we reached a real token endpoint.
      // Do not require a specific code: a stock SuiteCRM 8 answers an unknown
      // client with HTTP 500 {"error":"unknown_error", ...}, which is still a
      // live endpoint. Only a non-JSON body (postToken sets no code) means the
      // API is not at this path.
      if (e.code) {
        log.info("V8 API found at", apiBase, `(probe returned ${e.code})`);
        return apiBase;
      }
      errors.push(`${apiBase}: ${e.message}`);
    }
  }
  throw new AuthError(
    "Could not find the SuiteCRM V8 API. Tried:\n" + errors.join("\n") +
    "\n\nCheck the URL, and that Api/V8/OAuth2/private.key and public.key exist on the server."
  );
}

function storeTokens(body) {
  const now = Date.now();
  return store.setTokens({
    accessToken: body.access_token,
    accessExpiresAt: now + (Number(body.expires_in) || 3600) * 1000,
    refreshToken: body.refresh_token || null,
    refreshObtainedAt: now,
  });
}

/**
 * One-time interactive sign-in. The password is used for this single request
 * and then discarded, it is never persisted.
 */
export async function login({ baseUrl, clientId, clientSecret, username, password }) {
  const base = normaliseBaseUrl(baseUrl);

  // Opt-in enforcement. The add-on cannot toggle its own content security policy
  // at runtime, that key is static, so this is the honest equivalent: refuse
  // to send the password over a plaintext connection at all.
  // isMixedContentRisk rather than a bare startsWith: http://localhost is
  // trustworthy to the platform, so refusing it would block a local test
  // instance for no gain. The quoted name matches the checkbox in settings.
  if ((await store.getPrefs()).requireHttps && isMixedContentRisk(base)) {
    throw new AuthError(
      `"Refuse to sign in over an unencrypted connection" is on, and ${base} is ` +
      `unencrypted. Use an https:// address, or turn that setting off if this is a ` +
      `trusted test system.`
    );
  }

  const apiBase = await discoverApiBase(base);

  const body = await postToken(apiBase, {
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
    scope: "",
  });

  if (!body.refresh_token) {
    log.warn("Token response carried no refresh_token; re-login will be needed hourly.");
  }

  await store.setConnection({ baseUrl: base, apiBase, clientId, clientSecret, username });
  await storeTokens(body);
  return { apiBase, hasRefreshToken: Boolean(body.refresh_token) };
}

// Single-flight guard. Refresh tokens ROTATE: two concurrent refreshes would
// race and invalidate each other, logging the user out. All callers share one.
let inFlightRefresh = null;

async function doRefresh() {
  const conn = await store.getConnection();
  const tokens = await store.getTokens();
  if (!conn) throw new AuthError("Not configured", { needsLogin: true });
  if (!tokens?.refreshToken) {
    throw new AuthError("Session expired and no refresh token is stored.", { needsLogin: true });
  }

  let body;
  try {
    body = await postToken(conn.apiBase, {
      grant_type: "refresh_token",
      client_id: conn.clientId,
      client_secret: conn.clientSecret,
      refresh_token: tokens.refreshToken,
      scope: "",
    });
  } catch (e) {
    // Refresh token expired (>1 month unused) or revoked server-side.
    if (e.code === "invalid_request" || e.code === "invalid_grant" || e.status === 401) {
      await store.clearTokens();
      throw new AuthError(
        "Your SuiteCRM session has expired. Please sign in again.",
        { needsLogin: true, code: e.code }
      );
    }
    throw e;
  }

  await storeTokens(body);
  log.info("Access token refreshed; refresh token rotated.");
  return body.access_token;
}

export function refresh() {
  if (!inFlightRefresh) {
    inFlightRefresh = doRefresh().finally(() => { inFlightRefresh = null; });
  }
  return inFlightRefresh;
}

/** Returns a valid access token, refreshing transparently when near expiry. */
export async function getAccessToken({ force = false } = {}) {
  const tokens = await store.getTokens();
  if (!tokens) throw new AuthError("Not signed in", { needsLogin: true });

  if (!force && tokens.accessToken && Date.now() < tokens.accessExpiresAt - EXPIRY_SKEW_MS) {
    return tokens.accessToken;
  }
  return refresh();
}

export async function getStatus() {
  const conn = await store.getConnection();
  const tokens = await store.getTokens();
  if (!conn) return { state: "unconfigured" };
  if (!tokens?.refreshToken && !tokens?.accessToken) {
    return { state: "signed_out", baseUrl: conn.baseUrl, username: conn.username };
  }
  return {
    state: "signed_in",
    baseUrl: conn.baseUrl,
    apiBase: conn.apiBase,
    username: conn.username,
    accessExpiresAt: tokens.accessExpiresAt,
    // Refresh TTL is P1M from issue, and rotates on every use.
    refreshExpiresAt: tokens.refreshObtainedAt ? tokens.refreshObtainedAt + 30 * 864e5 : null,
  };
}

export async function logout({ forget = false } = {}) {
  await store.clearTokens();
  if (forget) await store.remove("connection");
}
