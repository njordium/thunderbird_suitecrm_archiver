/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Diagnostics capture for support reports.
 *
 * A debug report is meant to be pasted into an issue tracker or an email, so the
 * guiding rule is that nothing in it should be harmful if it ends up public.
 * Secrets are never recorded at all rather than recorded and stripped, and the
 * things that are merely sensitive — addresses, the CRM host — are masked by
 * default with an explicit opt-in to include them.
 *
 * The ring buffer is mirrored into storage.local because an MV3 event page is
 * suspended when idle, which would otherwise discard the log between the failure
 * and the moment the user goes looking for it.
 */

const MAX_EVENTS = 400;
const FLUSH_DELAY_MS = 1000;
const STORAGE_KEY = "debugLog";

let buffer = [];
let enabled = false;
let flushTimer = null;
let loaded = false;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Things that must never be written down, whatever the settings say. */
const SECRET_PATTERNS = [
  [/("?(?:access_token|refresh_token|client_secret|password|secret|authorization)"?\s*[:=]\s*"?)([^",&\s}]+)/gi, "$1<redacted>"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>"],
  // JWTs, which the CRM issues as access tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "<jwt redacted>"],
  // Long opaque hex or base64 blobs — refresh tokens and client secrets.
  [/\b[A-Fa-f0-9]{40,}\b/g, "<hex redacted>"],
];

/** Escape a string for literal use inside a RegExp. */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripSecrets(text) {
  let out = String(text ?? "");
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

const EMAIL_RE = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@)([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/**
 * Undo percent-encoding before anything tries to redact.
 *
 * This is not cosmetic. Recorded URLs are built with encodeURIComponent, which
 * turns `@` into `%40` — so an address inside a query string did not match the
 * masking pattern and went into the report verbatim, while the very same
 * address in a plain log line was masked correctly. The report told the user
 * addresses were masked, and for most of its content that was false.
 *
 * Decoding repeats until the text stops changing rather than a fixed number of
 * times: how deeply a value happens to be encoded is a property of the input,
 * not something to assume. The bound only guarantees termination.
 */
const MAX_DECODE_PASSES = 5;

export function decodePercent(text) {
  let out = String(text ?? "");
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    if (!/%[0-9A-Fa-f]{2}/.test(out)) break;
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch {
      // Malformed encoding: decode the sequences that actually matter for
      // redaction rather than giving up and emitting the raw text.
      out = out.replace(/%2540/gi, "@").replace(/%40/gi, "@");
      break;
    }
  }
  return out;
}

/** `jane.doe@acme.se` -> `j***@acme.se`, keeping the domain, which is what debugging needs. */
export function maskEmails(text) {
  return String(text ?? "").replace(EMAIL_RE, (m, first, at, domain) => `${first}***${at}${domain}`);
}

/** Keep enough of an identifier to compare two reports, not enough to use it. */
export function maskId(value, keep = 8) {
  const s = String(value ?? "");
  if (!s) return "";
  return s.length <= keep ? s : `${s.slice(0, keep)}…(${s.length} chars)`;
}

export function maskHost(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//<host>${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch {
    return "<url>";
  }
}

function scrub(text, { includeEmails, includeHost, baseUrl }) {
  // Decode first: a redaction that runs before decoding sees %40, not @.
  let out = stripSecrets(decodePercent(text));
  if (!includeEmails) out = maskEmails(out);
  if (!includeHost && baseUrl) {
    out = out.split(baseUrl).join("<crm-url>");
    try {
      const u = new URL(baseUrl);
      // Host first (it carries the port, so it is the longer match), then the
      // bare hostname. The second is not redundant: the granted permission
      // pattern is deliberately built without a port — see originPatternFor —
      // so on a CRM at a non-default port the "hosts" line contained the real
      // hostname while the report's header claimed the host was masked.
      // Case-insensitively, because a hostname is case-insensitive and the two
      // strings need not have been typed the same way.
      for (const name of [u.host, u.hostname]) {
        if (!name) continue;
        out = out.replace(new RegExp(escapeRe(name), "gi"), "<crm-host>");
      }
    } catch { /* not a parseable URL */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export async function setEnabled(on) {
  enabled = Boolean(on);
  if (!enabled) {
    // Turning the switch off has to leave nothing behind. Someone who disables
    // detailed logging reasonably believes the log is gone, and up to
    // MAX_EVENTS entries — carrying email addresses and CRM URLs — would
    // otherwise sit in the profile until they happened to press Clear.
    await clear();
    return;
  }
  record("info", ["diagnostics: detailed logging enabled"]);
}

export const isEnabled = () => enabled;

function push(entry) {
  buffer.push(entry);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: buffer });
    } catch { /* a full disk should not break archiving */ }
  }, FLUSH_DELAY_MS);
}

/** Note a log line. Secrets are stripped here, at capture time, not at export. */
export function record(level, args) {
  if (!enabled) return;
  const text = args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    })
    .join(" ");
  push({ t: Date.now(), kind: "log", level, text: stripSecrets(text) });
}

/** Note one CRM request. Bodies are never recorded — only shape and outcome. */
export function recordRequest({ method, url, status, ms, error, note }) {
  if (!enabled) return;
  push({
    t: Date.now(),
    kind: "net",
    method,
    // Decoded at capture time too, so the buffer holds a readable URL and a
    // secret hidden by encoding is stripped rather than stored.
    url: stripSecrets(decodePercent(url)),
    status: status ?? null,
    ms: ms ?? null,
    error: error ? stripSecrets(String(error)) : null,
    note: note || null,
  });
}

export async function loadPersisted() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    if (Array.isArray(stored[STORAGE_KEY])) buffer = stored[STORAGE_KEY].slice(-MAX_EVENTS);
  } catch { /* nothing to restore */ }
}

export async function clear() {
  buffer = [];
  // A flush already scheduled would write the buffer back out after the
  // removal, so cancel it rather than race it.
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try { await browser.storage.local.remove(STORAGE_KEY); } catch { /* ignore */ }
}

export const size = () => buffer.length;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ts = (t) => new Date(t).toISOString().replace("T", " ").replace("Z", "");

/**
 * @param {object} ctx  environment gathered by the caller (background page)
 * @param {object} opts { includeEmails, includeHost }
 */
export function buildReport(ctx, opts = {}) {
  const o = { includeEmails: false, includeHost: false, ...opts };
  const baseUrl = ctx.connection?.baseUrl || "";
  const s = (t) => scrub(t, { ...o, baseUrl });

  const L = [];
  L.push("SuiteCRM Email Archiver — debug report");
  L.push(`generated  ${ts(Date.now())} (UTC)`);
  L.push("");
  L.push("This report is written to be safe to share. Passwords, client secrets and");
  L.push("access/refresh tokens are never recorded. Email addresses and the CRM host are");
  L.push(`${o.includeEmails || o.includeHost ? "PARTLY INCLUDED at your request" : "masked"}.`);
  L.push("Message subjects and bodies are never captured.");
  L.push("");

  L.push("── Add-on ─────────────────────────────────────────────");
  L.push(`name        ${ctx.addon?.name}`);
  L.push(`version     ${ctx.addon?.version}`);
  L.push(`id          ${ctx.addon?.id}`);
  L.push("");

  L.push("── Thunderbird ────────────────────────────────────────");
  L.push(`application ${ctx.host?.name || "?"} ${ctx.host?.version || "?"}`);
  L.push(`build       ${ctx.host?.buildID || "?"}`);
  L.push(`platform    ${ctx.platform?.os || "?"} / ${ctx.platform?.arch || "?"}`);
  L.push("");

  L.push("── Permissions ────────────────────────────────────────");
  L.push(`api         ${(ctx.permissions?.permissions || []).join(", ") || "(none)"}`);
  const origins = ctx.permissions?.origins || [];
  L.push(`hosts       ${origins.length ? origins.map((x) => s(x)).join(", ") : "(none granted)"}`);
  L.push(`crm host    ${ctx.crmOriginGranted === null ? "unknown" : ctx.crmOriginGranted ? "GRANTED" : "NOT GRANTED"}`);
  L.push("");

  L.push("── Connection ─────────────────────────────────────────");
  if (!ctx.connection) {
    L.push("not configured");
  } else {
    L.push(`crm url     ${o.includeHost ? ctx.connection.baseUrl : maskHost(ctx.connection.baseUrl)}`);
    L.push(`api base    ${o.includeHost ? ctx.connection.apiBase : maskHost(ctx.connection.apiBase)}`);
    L.push(`transport   ${String(ctx.connection.baseUrl).startsWith("http://") ? "http (UNENCRYPTED)" : "https"}`);
    L.push(`client id   ${maskId(ctx.connection.clientId)}`);
    L.push(`username    ${o.includeEmails ? ctx.connection.username : maskEmails(ctx.connection.username || "")}`);
    L.push(`signed in   ${ctx.auth?.state || "?"}`);
    L.push(`access tok  ${ctx.auth?.accessExpiresAt ? `expires ${ts(ctx.auth.accessExpiresAt)}` : "none"}`);
    L.push(`refresh tok ${ctx.auth?.hasRefreshToken ? `held, obtained ${ts(ctx.auth.refreshObtainedAt)}` : "NONE — this causes hourly sign-outs"}`);
  }
  L.push("");

  L.push("── Mail accounts ──────────────────────────────────────");
  L.push(`configured  ${ctx.accounts?.total ?? "?"}`);
  L.push(`enabled     ${ctx.accounts?.enabled ?? "all"}`);
  L.push("");

  L.push("── Settings ───────────────────────────────────────────");
  const prefEntries = Object.entries(ctx.prefs || {});
  // Width from the longest key, so a long name cannot run into its value.
  const width = prefEntries.reduce((w, [k]) => Math.max(w, k.length), 0) + 2;
  for (const [k, v] of prefEntries) {
    // Through the same redaction as everything else: a preference can hold an
    // address, and this block was the only part of the report skipping it.
    L.push(`${k.padEnd(width)}${s(JSON.stringify(v))}`);
  }
  L.push("");

  L.push(`── Event log (${buffer.length} entries) ─────────────────────────`);
  if (!buffer.length) {
    L.push("(empty — turn on detailed logging, reproduce the problem, then export)");
  } else {
    for (const e of buffer) {
      if (e.kind === "net") {
        const outcome = e.error ? `FAILED ${e.error}` : `HTTP ${e.status}`;
        L.push(`${ts(e.t)}  NET  ${e.method} ${s(e.url)}  ${outcome}${e.ms != null ? `  ${e.ms}ms` : ""}`);
      } else {
        L.push(`${ts(e.t)}  ${String(e.level).toUpperCase().padEnd(5)} ${s(e.text)}`);
      }
    }
  }
  L.push("");
  return L.join("\n");
}
