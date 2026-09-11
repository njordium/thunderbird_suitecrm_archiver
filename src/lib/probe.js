/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Turning a connection probe into a verdict a person can act on.
 *
 * Kept separate from the options page for two reasons: the judgement here is
 * subtle enough to deserve tests, and the background page needs the same
 * classification to decide when to stop probing.
 *
 * The subtlety worth naming: SuiteCRM answers every origin with
 * Access-Control-Allow-Origin: *, so an unauthenticated probe reaches it with no
 * host permission at all. "Reached" and "granted" are therefore independent, and
 * a report that conflates them either overstates success or invents a failure.
 */

/** The suffixes a SuiteCRM V8 API can live under, in the order they are tried. */
export const API_SUFFIXES = ["/Api", "/legacy/Api"];

/**
 * What one attempt against a token endpoint tells us.
 *
 * A live endpoint answers an invalid client with a JSON OAuth error. Stock
 * SuiteCRM makes that an HTTP 500 rather than a 401, untidy of it, but the JSON
 * body is what proves the V8 stack is loaded and the database reachable, so the
 * status code is not the signal. A wrong path answers with an HTML error page.
 */
export function classifyAttempt(attempt) {
  if (!attempt || !attempt.reached) {
    return {
      live: false,
      headline: "did not connect",
      detail: String((attempt && attempt.error) || "no response"),
    };
  }

  const status = attempt.status;
  let body = null;
  try { body = JSON.parse(attempt.body); } catch { /* not JSON */ }

  if (!body || typeof body !== "object") {
    return {
      live: false,
      headline: `HTTP ${status}, not the V8 API`,
      detail: "The reply was not JSON, so the V8 API is not at this path.",
    };
  }

  if (body.access_token) {
    return {
      live: true,
      headline: `HTTP ${status}, a token was issued`,
      detail: "Unexpected for an invalid client, but it proves the endpoint is live.",
    };
  }

  if (body.error) {
    return {
      live: true,
      headline: `HTTP ${status}, expected`,
      detail:
        "The test deliberately sends an invalid client id, and only a working V8 " +
        "token endpoint rejects it with a JSON OAuth error. This reply is the proof " +
        "that SuiteCRM's API is here, its OAuth2 code is loaded and its database is " +
        "reachable. It is not a fault.",
    };
  }

  return {
    live: true,
    headline: `HTTP ${status}, JSON reply`,
    detail: "JSON came back, so the endpoint is live.",
  };
}

/** Where the API turned out to be, as a path rather than a whole URL. */
function apiPathOf(url, base) {
  return String(url).replace(/\/access_token$/, "").replace(base, "") || "/";
}

function transportRow(r) {
  if (!r.insecure) return ["transport", "https, encrypted", "ok"];
  if (!r.mixedContentRisk) {
    return ["transport", "http, unencrypted, but localhost, which the platform trusts", "ok"];
  }
  return [
    "transport",
    "http, unencrypted, so your CRM password crosses the network in the clear each " +
    "time you sign in. Fine for a test system; use https in production.",
    "warn",
  ];
}

/**
 * The whole report: a verdict, the rows beneath it, each attempt explained, and
 * what to do next. `askedNow` says whether this run already prompted for the
 * host permission, which changes the advice from "press Sign in" to "choose
 * Allow", telling someone to trigger a prompt they just dismissed is no help.
 */
export function describeProbe(r, { askedNow = false } = {}) {
  const attempts = (r.attempts || []).map((a) => ({ ...a, ...classifyAttempt(a) }));
  const live = attempts.find((a) => a.live) || null;
  const rows = [];
  const fixes = [];
  let tone, verdict;

  if (live && r.granted) {
    tone = "ok";
    verdict = `SuiteCRM's V8 API answered at ${r.base}${apiPathOf(live.url, r.base)}. ` +
      `Nothing is blocking this connection.`;
  } else if (live) {
    tone = "warn";
    verdict = `SuiteCRM's V8 API answered at ${r.base}${apiPathOf(live.url, r.base)}. ` +
      `The server is fine, the one step left is granting this add-on access to ` +
      `${r.hostname}.`;
    fixes.push(
      askedNow
        ? `Thunderbird's request for access to ${r.hostname} was dismissed. Run the test ` +
          `again and choose Allow, or turn on access under this add-on's Permissions tab.`
        : `Press Sign in, which asks for that access first, or turn it on under this ` +
          `add-on's Permissions tab.`
    );
    fixes.push(
      `Until then the add-on will not sign in. This test got through because SuiteCRM ` +
      `accepts unauthenticated requests from any origin, which is not enough for the ` +
      `requests that carry your token.`
    );
  } else if (!r.granted) {
    tone = "bad";
    verdict = `Nothing reached ${r.hostname}, and this add-on has not been granted access ` +
      `to it, so that is the first thing to rule out.`;
    fixes.push(
      askedNow
        ? `Run the test again and choose Allow when Thunderbird asks for access to ${r.hostname}.`
        : `Press Sign in, which asks for that access first, or turn it on under this ` +
          `add-on's Permissions tab.`
    );
  } else {
    // Nothing answered, and access is granted. The plaintext-CSP explanation used
    // to lead here, but that override now ships in the manifest and the build
    // fails without it, so the network is by far the likelier cause and gets the
    // verdict. The CSP note stays as a secondary check for anyone on an old build.
    tone = "bad";
    verdict = `Access is granted, but ${r.hostname}:${r.port} did not answer.`;
    fixes.push(
      `Confirm the CRM is reachable from this machine, opening ${r.base} in a browser is ` +
      `the quickest check, and that no firewall blocks port ${r.port}.`
    );
    fixes.push(
      "If it opens in a browser but not here, check the V8 API is installed: " +
      "Api/V8/OAuth2/private.key and public.key must exist on the server."
    );
    if (r.insecure) {
      fixes.push(
        "On an older build, an http:// CRM cannot be reached at all: Manifest V3 defaults " +
        "to a policy containing upgrade-insecure-requests, which silently rewrites http:// " +
        "to https://. This build overrides that, so check you are running the current one."
      );
      fixes.push(
        `A port forward sidesteps every plaintext restriction: ` +
        `ssh -L ${r.port}:localhost:${r.port} <user>@${r.hostname}, then set the CRM ` +
        `address to http://localhost:${r.port}`
      );
      fixes.push(
        "Check Settings → General → Config Editor for dom.security.https_only_mode, if it " +
        "is true, Thunderbird refuses unencrypted requests."
      );
    }
  }

  rows.push([
    `access to ${r.hostname}`,
    r.granted ? "granted" : "not granted yet",
    r.granted ? "ok" : "warn",
  ]);
  rows.push(transportRow(r));
  if (live) rows.push(["api path", apiPathOf(live.url, r.base), "ok"]);

  return { tone, verdict, rows, attempts, fixes };
}
