/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Background event page.
 *
 * Every CRM request is issued from here, never from the popup. Two reasons:
 * privileged extension contexts with a matching host permission are exempt
 * from CORS enforcement (so no .htaccess hack on the CRM), and the popup can be
 * torn down mid-flight by Thunderbird without aborting an in-progress archive.
 */

import { log, setLogLevel, setLogSink } from "../lib/log.js";
import * as diag from "../lib/diagnostics.js";
import * as store from "../lib/store.js";
import * as auth from "../lib/auth.js";
import { CrmClient, CrmError } from "../lib/crm.js";
import { buildCandidates, allAddresses, parseMailbox, domainOf, isConsumerDomain } from "../lib/addresses.js";
import { originPatternFor, isMixedContentRisk } from "../lib/url.js";
import { API_SUFFIXES, classifyAttempt } from "../lib/probe.js";
import { accountAllowed, MODULE_LABEL, recordLabel, MODULE_FIELDS, DIRECT_MODULES, CASE_FIELDS } from "../lib/modules.js";
import { resolveAddress, findAccountsByDomain, expandRelated, searchRecords } from "../lib/resolver.js";
import { parseContact } from "../lib/signature.js";
import { readMessage, archiveMessage } from "../lib/archive.js";
import { findThread } from "../lib/thread.js";
import { findCaseNumber } from "../lib/caseRef.js";
import { unwrapMessageList } from "../lib/tbcompat.js";
import { tagMessage, untagMessage } from "../lib/tagging.js";
import { buildRecord, defaultsFor, CREATABLE, dateTimeInDays } from "../lib/createFromEmail.js";
import { recordToVCard, usableForAddressBook } from "../lib/vcard.js";
import { findPossibleDuplicates } from "../lib/duplicates.js";
import { LookupCache } from "../lib/lookupCache.js";
import { createBadgeUpdater } from "../lib/badge.js";
import { SearchCache, narrowHits } from "../lib/searchCache.js";
import { parseMailbox as parseFrom } from "../lib/addresses.js";

// Route every log line into the diagnostics buffer, then apply the console level.
setLogSink((level, args) => diag.record(level, args));

/**
 * The message listener is registered FIRST, before anything optional.
 *
 * A background script is a single top-level program: if any statement throws,
 * everything after it never runs. Registering this last meant that one optional
 * listener failing — an API the profile does not expose, a permission not
 * granted — left the popup with "Receiving end does not exist" and the whole
 * add-on dead, rather than one feature missing.
 */
browser.runtime.onMessage.addListener((message, sender) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  return handler(message.payload || message, sender).then(
    (result) => ({ ok: true, result }),
    (error) => {
      log.error(`${message.type} failed:`, error);
      return {
        ok: false,
        error: {
          message: error?.message || String(error),
          needsLogin: Boolean(error?.needsLogin) ||
                      (error instanceof CrmError && error.status === 401),
          name: error?.name || "Error",
        },
      };
    }
  );
});


/**
 * Register an optional listener without letting it take the add-on down.
 * A feature that cannot start should be absent, not fatal.
 */
function optional(label, register) {
  try {
    register();
    log.debug(`listener registered: ${label}`);
  } catch (e) {
    log.warn(`Could not register ${label}; that feature is unavailable:`, e.message);
  }
}

(async () => {
  const prefs = await store.getPrefs();
  setLogLevel(prefs.logLevel);
  await diag.setEnabled(prefs.debugMode);
  if (prefs.debugMode) await diag.loadPersisted();
  await syncBannerScript();
  await syncComposeScript();
})();

/** Cache of the user's own addresses, so we never offer to archive against self. */
let ownAddressCache = null;
async function getOwnAddresses() {
  if (ownAddressCache) return ownAddressCache;
  const out = new Set();
  try {
    for (const account of await browser.accounts.list(false)) {
      for (const identity of account.identities || []) {
        if (identity.email) out.add(identity.email.toLowerCase());
      }
    }
  } catch (e) {
    log.warn("Could not enumerate identities:", e.message);
  }
  ownAddressCache = [...out];
  return ownAddressCache;
}
optional("accounts.onCreated/onDeleted", () => {
  browser.accounts?.onCreated?.addListener(() => { ownAddressCache = null; });
  browser.accounts?.onDeleted?.addListener(() => { ownAddressCache = null; });
});

/**
 * Is this message in an account the user enabled?
 *
 * This scopes what the add-on acts on. It is not a Thunderbird permission
 * boundary — messagesRead covers the whole profile either way — so it is
 * deliberately fail-open when the account cannot be determined.
 */
async function accountScope(header) {
  const enabled = (await store.getPrefs()).enabledAccounts;
  const accountId = header?.folder?.accountId;
  const verdict = accountAllowed(enabled, accountId);
  if (verdict.allowed) return verdict;
  if (verdict.noneEnabled) return { allowed: false, accountName: null, noneEnabled: true };

  let accountName = accountId;
  try {
    const account = await browser.accounts.get(accountId, false);
    accountName = account?.name || accountId;
  } catch { /* fall back to the id */ }

  return { allowed: false, accountName };
}

/**
 * What the last archive created, so it can be taken back.
 * Held in memory only: an undo that survives a restart would be offering to
 * delete something the user has long since forgotten about.
 */
let lastArchive = null;

/**
 * A task to come back to this, created alongside the archive.
 * Never fatal: the email is filed either way, and failing the archive because a
 * reminder could not be made would be the wrong trade.
 */
async function createFollowUp(client, msg, parent, days, archived) {
  try {
    const due = dateTimeInDays(days, 9);
    const spec = buildRecord("Tasks", msg, { form: { date_due: due }, parent });
    const created = await client.createRecord("Tasks", spec.attributes);
    if (created?.id && archived?.emailId) {
      try {
        await client.createRelationship("Tasks", created.id, "Emails", archived.emailId);
      } catch { /* the parent link is enough */ }
    }
    return { id: created?.id || null, due: due.slice(0, 10) };
  } catch (e) {
    log.warn("Could not create the follow-up task:", e.message);
    (archived.warnings ||= []).push(`The email was archived, but the follow-up task could not be created: ${e.message}`);
    return null;
  }
}

/** Keep a short, bounded history of what was filed, for the popup's Recent list. */
async function noteRecent(msg, parent) {
  try {
    const entries = await store.get("recentArchives", []);
    entries.unshift({
      subject: msg?.header?.subject || "",
      module: parent?.type || "",
      id: parent?.id || "",
      label: parent?.label || "",
      at: Date.now(),
    });
    await store.set("recentArchives", entries.slice(0, 30));
  } catch (e) {
    log.debug("Could not record the recent archive:", e.message);
  }
}

/** Capture exactly what an archive changed, so undo can reverse only that. */
function rememberArchive(entries, parent) {
  const emails = [];
  const noteIds = [];
  const messageIds = [];

  for (const { res, messageId } of entries) {
    if (!res?.emailId) continue;
    emails.push({
      id: res.emailId,
      created: Boolean(res.created),
      previousParent: res.previousParent || null,
    });
    for (const a of res.attachments || []) if (a.noteId) noteIds.push(a.noteId);
    if (messageId !== undefined) messageIds.push(messageId);
  }

  lastArchive = emails.length
    ? { emails, noteIds, messageIds, label: parent?.label || "", at: Date.now() }
    : null;
}

/** messageId -> the ids of every message in its conversation. */
const threadCache = new Map();

/** Per-message scratch space so the popup can reopen without re-reading the message. */
const messageCache = new Map();
const MESSAGE_CACHE_LIMIT = 20;
function cacheMessage(id, value) {
  messageCache.set(id, value);
  if (messageCache.size > MESSAGE_CACHE_LIMIT) {
    messageCache.delete(messageCache.keys().next().value);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const handlers = {
  /**
   * The connection settings an administrator can hand to colleagues.
   *
   * One OAuth2 client serves a whole organisation, so the address, client id and
   * secret are identical for everyone, and without this each person types all
   * three by hand. Everyone's own username and password stay their own.
   *
   * The refresh token is deliberately absent, and so is the username. A token
   * identifies one person's session and would let whoever opened the file act as
   * them; sharing it would be worse than sharing the password it replaced.
   */
  async exportConnection() {
    const conn = await store.getConnection();
    if (!conn?.baseUrl) throw new Error("There is nothing to export until you have signed in.");
    return {
      settings: {
        format: "suitecrm-archiver-connection",
        version: 1,
        baseUrl: conn.baseUrl,
        clientId: conn.clientId || "",
        clientSecret: conn.clientSecret || "",
      },
    };
  },

  /**
   * Read settings back in, without signing anyone in.
   *
   * Returns the values for the form rather than storing them, so the user sees
   * what arrived and still has to press Sign in. Importing straight into storage
   * would mean a file could silently repoint the add-on at another server.
   */
  async importConnection({ text }) {
    let parsed;
    try {
      parsed = JSON.parse(String(text || ""));
    } catch {
      throw new Error("That file is not valid JSON.");
    }
    if (!parsed || parsed.format !== "suitecrm-archiver-connection") {
      throw new Error("That file was not written by this add-on.");
    }
    if (!parsed.baseUrl) throw new Error("That file has no CRM address in it.");

    // Refuse anything that is not http(s), so a file cannot point the add-on at
    // a scheme the rest of the code does not expect.
    //
    // The scheme is checked on the raw value, before normalising. normaliseBaseUrl
    // prepends https:// to anything whose scheme it does not recognise, which
    // turns "file:///etc/passwd" into "https://file:///etc/passwd" — a URL that
    // then passes a protocol check while meaning nothing. Rejecting first gives
    // the user a clear answer instead of a puzzling address.
    const raw = String(parsed.baseUrl).trim();
    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
    if (scheme && !/^https?$/i.test(scheme[1])) {
      throw new Error(`"${raw}" uses ${scheme[1]}:, and only http and https are supported.`);
    }

    let baseUrl;
    try {
      baseUrl = auth.normaliseBaseUrl(raw);
      const { protocol, hostname } = new URL(baseUrl);
      if (protocol !== "http:" && protocol !== "https:") throw new Error("scheme");
      if (!hostname || hostname.includes(":")) throw new Error("host");

      // Strip any userinfo. "http://evil.com@crm.local/" reaches crm.local, but
      // it reads as evil.com to whoever glances at the field, and this value may
      // have come from a file someone else prepared.
      const u = new URL(baseUrl);
      if (u.username || u.password) {
        u.username = "";
        u.password = "";
        baseUrl = auth.normaliseBaseUrl(u.toString());
      }
    } catch {
      throw new Error(`"${raw}" is not a usable http or https address.`);
    }

    return {
      baseUrl,
      clientId: String(parsed.clientId || ""),
      clientSecret: String(parsed.clientSecret || ""),
    };
  },

  /**
   * Modules this user could search by email address.
   *
   * Discovery is additive rather than authoritative, and SuiteCRM's own code
   * says why. Api/V8/Helper/ModuleListProvider::getModuleList applies three
   * filters in order:
   *
   *   query_module_access_list($current_user)   per-user module access
   *   ACLController::filterModuleList()          ACL
   *   removeInvisibleModules()                   the global $modInvisList
   *
   * So the list genuinely differs per user, which is the useful part. But the
   * third filter is global, and $modInvisList contains Prospects — so Targets
   * never appears here even for an administrator, while the add-on searches it
   * successfully. Treating this list as the whole truth would make Targets
   * vanish from the settings while still working, hence the built-in four are
   * always offered.
   *
   * Each entry carries the user's own ACL actions, so a module they cannot list
   * or view is filtered out before it is ever offered. That is cheaper and more
   * accurate than discovering the refusal later, and it means one person's
   * settings do not offer another person's modules.
   */
  async listCrmModules() {
    const client = await CrmClient.create();
    const chosen = (await store.getPrefs()).searchModules;
    const base = { builtIn: DIRECT_MODULES, extra: [], labels: {}, selected: chosen };

    let entries;
    try {
      const res = await client.getModuleList();
      entries = res?.data?.attributes;
      if (!entries || typeof entries !== "object") throw new Error("unexpected module list shape");
    } catch (e) {
      log.warn("Could not list CRM modules:", e.message);
      return { ...base, error: e.message };
    }

    const labels = {};
    const candidates = [];
    for (const [name, info] of Object.entries(entries)) {
      if (DIRECT_MODULES.includes(name)) continue;

      // The access array is this user's own ACL actions. Without list and view
      // a search would be refused, so the module is not worth offering.
      const access = Array.isArray(info?.access) ? info.access : [];
      if (!access.includes("list") || !access.includes("view")) continue;

      if (info?.label) labels[name] = info.label;
      candidates.push(name);
    }

    // Only modules that survived the access filter are checked for an address
    // field, which keeps this to a handful of requests rather than one per
    // module in the CRM. A module without email1 cannot be searched by address.
    const searchable = await Promise.all(candidates.map(async (name) => {
      try {
        return (await client.getFieldNames(name)).includes("email1") ? name : null;
      } catch {
        return null;
      }
    }));

    return { ...base, extra: searchable.filter(Boolean).sort(), labels };
  },

  async getStatus() {
    return auth.getStatus();
  },

  /** Is the host permission for this CRM actually held right now? */
  async checkOrigin({ baseUrl }) {
    let origin = "";
    try {
      origin = originPatternFor(baseUrl);
    } catch (e) {
      return { origin: "", granted: false, invalidUrl: e.message };
    }
    let granted = false;
    try {
      granted = await browser.permissions.contains({ origins: [origin] });
    } catch (e) {
      log.warn("permissions.contains failed:", e.message);
      return { origin, granted: false, checkFailed: e.message };
    }
    let all = null;
    try {
      all = await browser.permissions.getAll();
    } catch { /* informational only */ }
    return { origin, granted, allOrigins: all?.origins || [] };
  },

  /**
   * Diagnose a connection failure precisely. "NetworkError" alone cannot tell
   * apart a missing host permission, a blocked plaintext request, and a server
   * that is genuinely unreachable — so probe and report which it is.
   */
  async probeConnection({ baseUrl }) {
    const base = auth.normaliseBaseUrl(baseUrl);
    const origin = originPatternFor(baseUrl);
    const granted = await browser.permissions.contains({ origins: [origin] }).catch(() => false);

    // Stop at the first endpoint that answers, exactly as discoverApiBase does.
    // Probing on past a success would report a second identical failure for a
    // path the add-on will never use, which reads as a fault rather than as the
    // irrelevance it is.
    const attempts = [];
    for (const suffix of API_SUFFIXES) {
      const url = base + suffix + "/access_token";
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            grant_type: "client_credentials",
            client_id: "__probe__",
            client_secret: "__probe__",
          }),
        });
        const text = (await res.text()).slice(0, 240);
        attempts.push({ url, reached: true, status: res.status, body: text });
      } catch (e) {
        attempts.push({ url, reached: false, error: String(e && e.message || e) });
      }
      if (classifyAttempt(attempts[attempts.length - 1]).live) break;
    }

    return {
      base,
      origin,
      granted,
      insecure: base.startsWith("http://"),
      mixedContentRisk: isMixedContentRisk(baseUrl),
      hostname: new URL(base).hostname,
      port: new URL(base).port || (base.startsWith("https://") ? "443" : "80"),
      attempts,
    };
  },

  async login(payload) {
    // The options page requests the host permission inside its own click handler,
    // because permissions.request() needs a live user activation that does not
    // survive a message into this event page. Here we only verify.
    const origin = originPatternFor(payload.baseUrl);

    let granted = false;
    try {
      granted = await browser.permissions.contains({ origins: [origin] });
    } catch (e) {
      // A throw here means the pattern itself was rejected. Say so plainly
      // rather than proceeding into an opaque NetworkError.
      log.error("permissions.contains rejected the pattern:", origin, e.message);
      throw new Error(
        `Thunderbird rejected the permission pattern "${origin}" (${e.message}).`
      );
    }


    if (!granted) {
      throw new Error(
        `This add-on has not been given permission to contact ${origin}. ` +
        `Enable it under the add-on's Permissions tab, then sign in again.`
      );
    }

    const res = await auth.login(payload);
    ownAddressCache = null;
    return res;
  },

  async logout(payload) {
    return auth.logout(payload || {});
  },

  /** Let the popup and options page write into the diagnostics buffer. */
  async logFromUi({ level, text }) {
    const fn = log[level] || log.info;
    fn(`[ui] ${text}`);
    return true;
  },

  async getPrefs() { return store.getPrefs(); },
  async setPrefs(patch) {
    await store.setPrefs(patch);
    if (patch.logLevel) setLogLevel(patch.logLevel);
    if ("showMessageBanner" in patch) await syncBannerScript();
    if ("showComposeStatus" in patch) await syncComposeScript();
    if ("debugMode" in patch) {
      if (patch.debugMode) await diag.loadPersisted();
      await diag.setEnabled(patch.debugMode);
    }
    return store.getPrefs();
  },

  async diagnosticsStatus() {
    return { enabled: diag.isEnabled(), entries: diag.size() };
  },

  async clearDiagnostics() {
    await diag.clear();
    return { entries: 0 };
  },

  /**
   * Gather the environment and render a shareable report. Secrets are never in
   * the buffer to begin with; addresses and the CRM host are masked unless the
   * user explicitly opts to include them.
   */
  async buildDebugReport({ includeEmails = false, includeHost = false } = {}) {
    await diag.loadPersisted();

    const manifest = browser.runtime.getManifest();
    const ctx = {
      addon: {
        name: manifest.name,
        version: manifest.version,
        id: manifest.browser_specific_settings?.gecko?.id || "?",
      },
      prefs: await store.getPrefs(),
      connection: await store.getConnection(),
    };

    try { ctx.host = await browser.runtime.getBrowserInfo(); } catch { ctx.host = null; }
    try { ctx.platform = await browser.runtime.getPlatformInfo(); } catch { ctx.platform = null; }
    try { ctx.permissions = await browser.permissions.getAll(); } catch { ctx.permissions = null; }

    const status = await auth.getStatus();
    const tokens = await store.getTokens();
    ctx.auth = {
      state: status.state,
      accessExpiresAt: tokens?.accessExpiresAt || null,
      refreshObtainedAt: tokens?.refreshObtainedAt || null,
      hasRefreshToken: Boolean(tokens?.refreshToken),
    };

    ctx.crmOriginGranted = null;
    if (ctx.connection?.baseUrl) {
      try {
        ctx.crmOriginGranted = await browser.permissions.contains({
          origins: [originPatternFor(ctx.connection.baseUrl)],
        });
      } catch { /* leave unknown */ }
    }

    try {
      const accounts = await browser.accounts.list(false);
      const enabled = ctx.prefs.enabledAccounts;
      ctx.accounts = {
        total: accounts.length,
        enabled: !Array.isArray(enabled) ? "all"
               : enabled.length === 0 ? "none"
               : `${enabled.length} of ${accounts.length}`,
      };
    } catch { ctx.accounts = null; }

    // The stored secret must not travel even masked.
    if (ctx.connection) delete ctx.connection.clientSecret;

    return {
      text: diag.buildReport(ctx, { includeEmails, includeHost }),
      entries: diag.size(),
    };
  },

  /** Accounts the user can tick in settings. */
  async listAccounts() {
    const accounts = await browser.accounts.list(false);
    return accounts.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.identities?.[0]?.email || "",
    }));
  },

  /**
   * Everything the popup needs on open: the message, who it could be filed
   * against, and — for the default address — the CRM lookup already done.
   */
  async prepareMessage({ messageId }) {
    const t0 = Date.now();
    const msg = await readMessage(messageId);
    const tRead = Date.now();
    cacheMessage(messageId, msg);

    const scope = await accountScope(msg.header);
    if (!scope.allowed) {
      return {
        messageId,
        blockedByAccount: true,
        accountName: scope.accountName,
        noneEnabled: Boolean(scope.noneEnabled),
      };
    }

    const prefs = await store.getPrefs();
    const own = await getOwnAddresses();
    const candidates = buildCandidates(msg.header, {
      ownAddresses: own,
      includeCc: prefs.includeCcRecipients,
    });

    // Parsing the subject costs nothing, so it belongs here on the fast path.
    // Turning the number into a record is a CRM request, so the popup asks for
    // that separately, in parallel with the address lookup.
    const caseRef = prefs.matchCaseReferences
      ? findCaseNumber(msg.header.subject, prefs.caseSubjectMacro)
      : null;

    const timings = { readMessage: tRead - t0, total: Date.now() - t0 };
    log.debug(`prepareMessage: read ${timings.readMessage}ms, total ${timings.total}ms`);

    // Thread discovery is NOT done here. It runs a subject query across every
    // account and then reads each candidate, which took ~2s on a mailbox with
    // sixteen accounts — all of it before the popup could render. The popup
    // asks for it separately, once it is on screen.
    return {
      messageId,
      subject: msg.header.subject,
      date: msg.header.date,
      caseRef,
      candidates,
      attachmentCount: msg.attachments.filter((a) => !a.contentId).length,
      hasVCard: Boolean(msg.vcard),
      timings,
    };
  },

  /**
   * Reconstruct the conversation. Deliberately a separate call: it is the slow
   * part, and the popup must not wait for it before rendering.
   */
  async getThreadInfo({ messageId }) {
    const t0 = Date.now();
    try {
      const thread = await findThread(messageId);
      threadCache.set(messageId, thread.map((m) => m.id));
      log.debug(`findThread: ${thread.length} message(s) in ${Date.now() - t0}ms`);
      return { threadCount: thread.length, ms: Date.now() - t0 };
    } catch (e) {
      log.warn("Could not reconstruct the conversation:", e.message);
      return { threadCount: 1, error: e.message };
    }
  },

  /**
   * Who is this message from, for the in-message banner?
   * Split from the lookup so the strip can draw immediately and fill in after.
   */
  async bannerContext(_payload, sender) {
    const prefs = await store.getPrefs();
    if (!prefs.showMessageBanner) return { hidden: true };

    const tabId = sender?.tab?.id;
    let header = null;
    try {
      // The same unwrapping the shortcut handler needs, so both use one helper.
      header = unwrapMessageList(
        await browser.messageDisplay.getDisplayedMessages(tabId)
      )[0] || null;
    } catch (e) {
      log.debug("banner: could not read the displayed message:", e.message);
    }
    if (!header) return { hidden: true };

    const scope = await accountScope(header);
    if (!scope.allowed) return { hidden: true };

    const own = await getOwnAddresses();
    const candidates = buildCandidates(header, { ownAddresses: own });
    const primary = candidates.primary;
    if (!primary) return { hidden: true };

    return { email: primary.email, who: primary.name || primary.email };
  },

  /** The CRM side of the banner, cached like the badge. */
  async bannerLookup({ email }) {
    const status = await auth.getStatus();
    if (status.state !== "signed_in") {
      return { status: "error", message: "Not signed in to SuiteCRM" };
    }

    const resolved = await resolveCached(email);
    if (!resolved) return { status: "error", message: "Could not reach SuiteCRM" };
    if (!resolved.found) return { status: "none" };

    const flat = Object.entries(resolved.hits)
      .flatMap(([module, recs]) => recs.map((r) => ({ ...r, module })));
    const top = flat[0];

    const parts = [MODULE_LABEL[top.module] || top.module];
    if (top.account_name && top.module !== "Accounts") parts.push(top.account_name);
    else if (top.title) parts.push(top.title);
    if (top.assigned_user_name) parts.push(`owned by ${top.assigned_user_name}`);

    const chips = Object.entries(resolved.hits)
      .map(([module, recs]) => ({ label: MODULE_LABEL[module] || module, count: recs.length }));

    return {
      status: "found",
      summary: parts.join(" · "),
      top: { module: top.module, id: top.id },
      chips: chips.length > 1 ? chips : [],
    };
  },

  /** Fan out across all address-bearing modules for one address. */
  /**
   * Turn a case number from a subject into its Case record.
   *
   * Separate from lookupAddress so the popup can run both at once: the subject
   * names a Case, the sender names people, and neither answer depends on the
   * other. A number that no longer resolves returns null rather than throwing,
   * because a reference to a deleted Case is an ordinary thing to find in old
   * mail and must not stop the window working.
   */
  async lookupCase({ number }) {
    if (!number) return { found: null };
    try {
      const client = await CrmClient.create();
      const rec = await client.getCaseByNumber(number, CASE_FIELDS);
      return { number, found: rec ? { ...rec, module: "Cases" } : null };
    } catch (e) {
      log.warn(`Could not resolve case ${number}:`, e.message);
      return { number, found: null, error: e.message };
    }
  },

  async lookupAddress({ email }) {
    const client = await CrmClient.create();
    // Read once, outside the .then, so the arrow stays synchronous.
    const modules = await effectiveModules();
    const [resolved, accounts] = await Promise.all([
      // Usually already answered by the badge a moment ago.
      resolveCached(email).then((r) => r ?? resolveAddress(client, email, { modules })),
      accountsForDomain(client, email),
    ]);
    return { ...resolved, accountsByDomain: accounts };
  },

  /**
   * Undo the last archive.
   *
   * Deletes only what that archive created — never a record that already
   * existed. Re-filing an email that was already in the CRM changes its parent
   * rather than creating anything, so undoing it must restore the old parent,
   * not delete somebody else's email.
   */
  async undoLastArchive() {
    const undo = lastArchive;
    if (!undo) throw new Error("There is nothing to undo.");

    const client = await CrmClient.create();
    const removed = [];
    const restored = [];
    const problems = [];

    // Notes first: a Note whose parent Email is gone is an orphan.
    for (const noteId of undo.noteIds) {
      try {
        await client.request("DELETE", `/module/Notes/${encodeURIComponent(noteId)}`);
        removed.push(`Notes/${noteId}`);
      } catch (e) { problems.push(`Note ${noteId}: ${e.message}`); }
    }

    for (const email of undo.emails) {
      try {
        if (email.created) {
          await client.request("DELETE", `/module/Emails/${encodeURIComponent(email.id)}`);
          removed.push(`Emails/${email.id}`);
        } else if (email.previousParent) {
          await client.updateRecord("Emails", email.id, {
            parent_type: email.previousParent.type || "",
            parent_id: email.previousParent.id || "",
          });
          restored.push(email.id);
        }
      } catch (e) { problems.push(`Email ${email.id}: ${e.message}`); }
    }

    for (const messageId of undo.messageIds) await untagMessage(messageId);

    lastArchive = null;
    senderCache.invalidate(); domainCache.invalidate(); searchCache.clear();
    return { removed: removed.length, restored: restored.length, problems };
  },

  /** Who the compose window is addressed to, in CRM terms. */
  async composeStatus(_payload, sender) {
    const prefs = await store.getPrefs();
    if (!prefs.showComposeStatus) return { hidden: true };

    const tabId = sender?.tab?.id;
    if (tabId === undefined) return { hidden: true };

    let details = null;
    try {
      details = await browser.compose.getComposeDetails(tabId);
    } catch (e) {
      log.debug("compose: could not read details:", e.message);
      return { hidden: true };
    }

    const own = new Set(await getOwnAddresses());
    const recipients = [...(details.to || []), ...(details.cc || [])]
      .map((r) => parseFrom(typeof r === "string" ? r : r?.address || ""))
      .filter(Boolean)
      .filter((r) => !own.has(r.email));

    if (!recipients.length) return { hidden: true };

    const status = await auth.getStatus();
    if (status.state !== "signed_in") {
      return { tone: "warn", text: "Not signed in to SuiteCRM" };
    }

    const first = recipients[0];
    const more = recipients.length - 1;
    const suffix = more > 0 ? ` (+${more} more)` : "";

    let total;
    try {
      total = await countRecordsFor(first.email);
    } catch (e) {
      return { tone: "warn", text: "Could not reach SuiteCRM", detail: e.message };
    }
    if (total === null) return { tone: "warn", text: "Could not reach SuiteCRM" };

    const who = first.name || first.email;
    if (total > 0) {
      return {
        tone: "found",
        text: `${who} is in SuiteCRM`,
        detail: `${total} record${total === 1 ? "" : "s"}${suffix}`,
      };
    }

    return {
      tone: "none",
      text: `${who} is not in SuiteCRM`,
      detail: suffix.trim(),
      action: {
        label: "Create Lead",
        type: "createLeadForAddress",
        payload: { email: first.email, name: first.name || "" },
        done: "Lead created",
      },
    };
  },

  /**
   * Create a Lead straight from the compose window, from just a name and address.
   * There is no signature to read here, so this deliberately fills in nothing it
   * cannot see — a stub the user completes later beats invented details.
   */
  async createLeadForAddress({ email, name }) {
    const client = await CrmClient.create();
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    const attributes = {
      last_name: parts.length > 1 ? parts.slice(1).join(" ") : (parts[0] || email),
      email1: email,
      lead_source: "Email",
    };
    if (parts.length > 1) attributes.first_name = parts[0];

    const created = await client.createRecord("Leads", attributes);
    senderCache.invalidate(email);
    log.info(`Created Lead ${created?.id} for ${email}`);
    return { id: created?.id, module: "Leads" };
  },

  /**
   * Does this website actually respond?
   *
   * Guessing https://<email domain> is right most of the time and wrong often
   * enough to be worth checking before it lands in the CRM. The check needs a
   * host permission for that specific site, which the caller requests from a
   * real click — we never reach out to a third party without that, and never
   * send credentials or cookies.
   */
  /**
   * Host permissions the add-on holds that it has no lasting need for.
   *
   * The CRM host is a standing requirement. Nothing else is. Earlier versions
   * fetched a guessed website to confirm it, which took a host permission for
   * each sender's domain, so checking twenty senders left twenty standing grants
   * in the Permissions tab for a one-second fetch each. That check now opens the
   * page in the browser and asks for nothing, but the old grants persist — this
   * finds them so Settings can offer to clear them.
   */
  async strayHostPermissions() {
    const conn = await store.getConnection();
    let keep = null;
    if (conn?.baseUrl) {
      try { keep = originPatternFor(conn.baseUrl); } catch { /* unparseable */ }
    }

    let granted = { origins: [] };
    try { granted = await browser.permissions.getAll(); } catch { /* none */ }

    const stray = (granted.origins || []).filter((o) => {
      if (o === keep) return false;
      // A wildcard is something the user chose deliberately, most likely to get
      // past a permission prompt. Not ours to withdraw.
      if (o.includes("://*/") || o === "<all_urls>") return false;
      return true;
    });
    return { stray, keep };
  },

  async dropHostPermissions({ origins }) {
    if (!origins?.length) return { removed: 0 };
    let removed = 0;
    for (const origin of origins) {
      try {
        if (await browser.permissions.remove({ origins: [origin] })) removed++;
      } catch (e) {
        log.debug(`Could not release ${origin}:`, e.message);
      }
    }
    log.info(`Released ${removed} host permission(s) no longer needed.`);
    return { removed };
  },

  /** Starting values for the create-a-record form, from the message. */
  async recordDefaults({ messageId, kind }) {
    const msg = messageCache.get(messageId) || (await readMessage(messageId));
    return { kind, values: defaultsFor(kind, msg), meta: CREATABLE[kind] || null };
  },

  /**
   * Create a Case, Opportunity, Meeting or Task from the email, then archive the
   * email against it — so the record and the correspondence that started it are
   * linked from the moment it exists.
   */
  async createFromEmail({ messageId, kind, form, parent, archive: alsoArchive = true }) {
    const msg = messageCache.get(messageId) || (await readMessage(messageId));
    const client = await CrmClient.create();
    const onProgress = (text) => {
      browser.runtime.sendMessage({ type: "archiveProgress", text }).catch(() => {});
    };

    let assignedUserId = null;
    try {
      const me = await client.getCurrentUser();
      assignedUserId = me?.data?.id || null;
    } catch (e) {
      log.debug("Could not identify the CRM user:", e.message);
    }

    // An Account for the record: the target itself, or the one it belongs to.
    let accountId = null;
    if (parent?.type === "Accounts") accountId = parent.id;
    else if (parent?.accountId) accountId = parent.accountId;

    onProgress(`Creating the ${CREATABLE[kind]?.label || kind}…`);
    const spec = buildRecord(kind, msg, { form, parent, accountId, assignedUserId });
    const created = await client.createRecord(spec.module, spec.attributes);
    if (!created?.id) throw new Error(`SuiteCRM did not return an id for the new ${kind}.`);

    for (const rel of spec.relate) {
      try {
        await client.createRelationship(spec.module, created.id, rel.module, rel.id);
      } catch (e) {
        log.debug(`Could not link ${spec.module} to ${rel.module}:`, e.message);
      }
    }

    const result = {
      module: spec.module,
      id: created.id,
      label: spec.attributes.name,
      warnings: [],
    };

    // File the email against the new record, so the two are joined.
    if (alsoArchive) {
      onProgress("Filing the email against it…");
      try {
        const archived = await archiveMessage(
          client, msg,
          { type: spec.module, id: created.id, label: spec.attributes.name },
          { onProgress }
        );
        result.emailId = archived.emailId;
        result.warnings.push(...archived.warnings);
        if ((await store.getPrefs()).tagArchivedMessages) await tagMessage(messageId);
        rememberArchive([{ res: archived, messageId }], { label: spec.attributes.name });
      } catch (e) {
        result.warnings.push(`The ${CREATABLE[kind]?.label || kind} was created, but the email could not be filed against it: ${e.message}`);
      }
    }

    senderCache.invalidate(); domainCache.invalidate(); searchCache.clear();
    return result;
  },

  /** What has been archived lately, newest first. */
  async recentArchives() {
    const entries = await store.get("recentArchives", []);
    return { entries: entries.slice(0, 15) };
  },

  /**
   * Where mail from this address was filed last time.
   * Kept to a bounded number of addresses so it cannot grow without limit.
   */
  async recallTarget({ email }) {
    const map = await store.get("lastTargets", {});
    return { target: map[String(email || "").toLowerCase()] || null };
  },

  async rememberTarget({ email, target }) {
    const key = String(email || "").toLowerCase();
    if (!key || !target?.id) return false;

    const map = await store.get("lastTargets", {});
    map[key] = { type: target.type, id: target.id, label: target.label, at: Date.now() };

    const MAX = 400;
    const keys = Object.keys(map);
    if (keys.length > MAX) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
      for (const k of keys.slice(0, keys.length - MAX)) delete map[k];
    }
    await store.set("lastTargets", map);
    return true;
  },

  /** Free-text search, for when the sender's address matches nothing. */
  async searchCrm({ text }) {
    return cachedSearch(String(text || "").trim(), await effectiveModules(), 10);
  },

  /** Which of the other people on this message are already known to the CRM. */
  async lookupOthers({ messageId }) {
    const msg = messageCache.get(messageId) || (await readMessage(messageId));
    const own = new Set(await getOwnAddresses());
    const others = allAddresses(msg.header).filter((a) => !own.has(a.email));

    // Through the shared cache: the sender was almost certainly resolved by the
    // badge already, and a colleague looked up once stays looked up. Twelve
    // addresses used to mean forty-eight requests every time the picker opened.
    const settled = await Promise.allSettled(
      others.slice(0, 12).map((a) => resolveCached(a.email).then((r) => [a.email, r ? r.total : null]))
    );
    const counts = {};
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value[1] !== null) counts[s.value[0]] = s.value[1];
    }
    return counts;
  },

  async expandRecord({ record }) {
    const client = await CrmClient.create();
    return expandRelated(client, record);
  },

  /** Prefill for the create-Lead / create-Contact form, from the signature. */
  async proposeContact({ messageId, email, name }) {
    const msg = messageCache.get(messageId) || (await readMessage(messageId));

    const sender = parseMailbox(msg.header.author);
    const target = (email || "").toLowerCase();
    const isAuthor = !target || (sender && sender.email === target);

    // For a colleague we pass their own mailbox, and parseContact then takes
    // only company-level details from the sender's signature.
    const author = isAuthor
      ? msg.header.author
      : (name ? `${name} <${email}>` : email);

    const parsed = parseContact({
      author,
      bodyText: msg.bodyText,
      vcard: msg.vcard,
      isAuthor,
    });

    // Offer existing Accounts on the same domain to link a new Contact to.
    let accountsByDomain = [];
    try {
      const client = await CrmClient.create();
      accountsByDomain = await accountsForDomain(client, parsed.fields.email1 || email);
    } catch (e) {
      log.warn("Account suggestion failed:", e.message);
    }
    return { ...parsed, accountsByDomain };
  },

  /**
   * Might this person already be in the CRM under another address?
   *
   * The address lookup cannot answer this, because the address is exactly what
   * differs. Compare names among the people already on the same Account or
   * email domain, which is where a second record for the same human turns up.
   */
  async findDuplicates({ person, accountId }) {
    const client = await CrmClient.create();
    const pool = new Map();

    const collect = (records) => {
      for (const r of records) if (!pool.has(r.id)) pool.set(r.id, { ...r, module: "Contacts" });
    };

    try {
      if (accountId) {
        collect(await client.getRecords("Contacts", {
          filter: { account_id: { eq: accountId } },
          fields: MODULE_FIELDS.Contacts, size: 50,
        }));
      }
    } catch (e) {
      log.debug("duplicate check: account lookup failed:", e.message);
    }

    const domain = domainOf(person.email1 || "");
    if (domain && !isConsumerDomain(domain)) {
      try {
        collect(await client.getRecords("Contacts", {
          filter: { email1: { like: `%@${domain}` } },
          fields: MODULE_FIELDS.Contacts, size: 50,
        }));
      } catch (e) {
        log.debug("duplicate check: domain lookup failed:", e.message);
      }
    }

    const candidates = findPossibleDuplicates(person, [...pool.values()]);
    return {
      candidates: candidates.slice(0, 5).map((c) => ({
        id: c.record.id,
        module: c.record.module || "Contacts",
        name: c.name,
        email1: c.record.email1 || "",
        title: c.record.title || "",
        account_name: c.record.account_name || "",
        sameAddress: c.sameAddress,
        score: Math.round(c.score * 100),
      })),
      compared: pool.size,
    };
  },

  /** Add an address to a record that already exists, instead of duplicating it. */
  async addAddressToRecord({ module, id, email }) {
    const client = await CrmClient.create();
    const updated = await client.updateRecord(module, id, { email1: email });
    senderCache.invalidate(email);
    return { id: updated?.id || id, module };
  },

  async createRecord({ module, attributes }) {
    const client = await CrmClient.create();
    return client.createRecord(module, attributes);
  },

  /** Create an Account and a Contact under it, in one step. */
  async createContactWithAccount({ contact, account, accountId }) {
    const client = await CrmClient.create();
    let resolvedAccountId = accountId || null;

    if (!resolvedAccountId && account?.name) {
      const created = await client.createRecord("Accounts", account);
      resolvedAccountId = created.id;
    }
    const attrs = { ...contact };
    if (resolvedAccountId) attrs.account_id = resolvedAccountId;

    const created = await client.createRecord("Contacts", attrs);
    if (resolvedAccountId) {
      try {
        await client.createRelationship("Contacts", created.id, "Accounts", resolvedAccountId);
      } catch (e) {
        log.debug("Contact->Account link not created:", e.message);
      }
    }
    return { contact: created, accountId: resolvedAccountId };
  },

  /**
   * Archive one message, an explicit selection, or a whole conversation.
   *
   * @param {number[]} [messageIds] messages the user ticked in the list
   * @param {boolean}  [wholeThread] archive everything in this conversation
   */
  async archive({ messageId, parent, alsoLink, wholeThread = false, messageIds = null,
                  useOriginalDate = null, followUpDays = null, subject = null }) {
    // The popup can override the stored preference for this archive only.
    if (useOriginalDate !== null) await store.setPrefs({ useOriginalDate });

    const client = await CrmClient.create();
    const onProgress = (text) => {
      browser.runtime.sendMessage({ type: "archiveProgress", text }).catch(() => {});
    };

    const explicit = Array.isArray(messageIds) && messageIds.length > 1;
    const prefs = await store.getPrefs();

    if (!wholeThread && !explicit) {
      const msg = messageCache.get(messageId) || (await readMessage(messageId));
      // The subject override applies to a single message only. A thread or a
      // hand-picked selection each carry their own subjects, and forcing one
      // edited line onto all of them would lose information rather than tidy it,
      // so the loop below deliberately does not pass it.
      const res = await archiveMessage(client, msg, parent, {
        alsoLink: alsoLink || [], onProgress, subject,
      });
      if (prefs.tagArchivedMessages) res.tagged = await tagMessage(messageId);
      rememberArchive([{ res, messageId }], parent);
      await noteRecent(msg, parent);
      if (followUpDays) res.followUp = await createFollowUp(client, msg, parent, followUpDays, res);
      senderCache.invalidate(); domainCache.invalidate(); searchCache.clear();
      return { ...res, canUndo: true };
    }

    let ids, mode;
    if (explicit) {
      ids = messageIds;
      mode = "selection";
    } else {
      ids = threadCache.get(messageId) || (await findThread(messageId)).map((m) => m.id);
      mode = "thread";
    }

    const done = [];
    const combined = {
      created: false, updated: false, emailId: null,
      attachments: [], warnings: [],
      thread: { total: ids.length, archived: 0, skipped: 0, mode },
    };

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      onProgress(`Archiving message ${i + 1} of ${ids.length}…`);
      try {
        const msg = messageCache.get(id) || (await readMessage(id));
        const res = await archiveMessage(client, msg, parent, {
          alsoLink: alsoLink || [],
          onProgress: (t) => onProgress(`Message ${i + 1} of ${ids.length}: ${t}`),
        });
        combined.thread.archived++;
        combined.created ||= res.created;
        combined.updated ||= res.updated;
        if (id === messageId || !combined.emailId) combined.emailId = res.emailId;
        combined.attachments.push(...res.attachments);
        combined.warnings.push(...res.warnings);
        if (prefs.tagArchivedMessages) await tagMessage(id);
        done.push({ res, messageId: id });
      } catch (e) {
        combined.thread.skipped++;
        combined.warnings.push(`Message ${i + 1} of ${ids.length} could not be archived: ${e.message}`);
      }
    }
    rememberArchive(done, parent);
    if (done.length) await noteRecent(messageCache.get(messageId), parent);
    senderCache.invalidate(); domainCache.invalidate(); searchCache.clear();
    return { ...combined, canUndo: done.length > 0 };
  },

  /** Deep link so the user can jump straight to the record they just filed into. */
  async openRecord({ module, id }) {
    const conn = await store.getConnection();
    if (!conn) return;
    const url = `${conn.baseUrl}/index.php?module=${encodeURIComponent(module)}&action=DetailView&record=${encodeURIComponent(id)}`;
    await browser.tabs.create({ url });
  },
};

// ---------------------------------------------------------------------------
// In-message banner
// ---------------------------------------------------------------------------

const BANNER_SCRIPT_ID = "suitecrm-banner";
const COMPOSE_SCRIPT_ID = "suitecrm-compose";

/**
 * Register the message-display script at runtime rather than through the
 * manifest. The `message_display_scripts` manifest key only exists from
 * Thunderbird 151, and the floor here is 140 — but the stronger reason is that
 * registering at runtime lets the setting genuinely unregister the script,
 * where the manifest key would leave it injected and self-hiding.
 */
let bannerSync = null;
async function syncBannerScript() {
  // Two calls overlapping would unregister and re-register at the same time,
  // which can leave the script registered twice or not at all. Share one run.
  if (bannerSync) return bannerSync;
  bannerSync = doSyncBannerScript().finally(() => { bannerSync = null; });
  return bannerSync;
}

async function doSyncBannerScript() {
  const wanted = (await store.getPrefs()).showMessageBanner;
  const api = browser.scripting?.messageDisplay;

  try {
    if (api) {
      const existing = await api.getRegisteredScripts({ ids: [BANNER_SCRIPT_ID] }).catch(() => []);
      if (existing.length) await api.unregisterScripts({ ids: [BANNER_SCRIPT_ID] });
      if (wanted) {
        await api.registerScripts([{
          id: BANNER_SCRIPT_ID,
          js: ["src/messageview/banner.js"],
          runAt: "document_idle",
        }]);
      }
      log.debug(`banner script ${wanted ? "registered" : "unregistered"}`);
      return;
    }

    // scripting.messageDisplay is the only route under Manifest V3. Its
    // predecessor, browser.messageDisplayScripts, is max_manifest_version 2, so
    // there is nothing to fall back to — say so rather than failing silently.
    log.warn("scripting.messageDisplay is unavailable; the in-message banner cannot be shown.");
  } catch (e) {
    log.warn("Could not register the in-message banner:", e.message);
  }
}

/** The same runtime-registration dance for the compose window. */
let composeSync = null;
async function syncComposeScript() {
  if (composeSync) return composeSync;
  composeSync = doSyncComposeScript().finally(() => { composeSync = null; });
  return composeSync;
}

async function doSyncComposeScript() {
  const wanted = (await store.getPrefs()).showComposeStatus;
  const api = browser.scripting?.compose;

  try {
    if (api) {
      const existing = await api.getRegisteredScripts({ ids: [COMPOSE_SCRIPT_ID] }).catch(() => []);
      if (existing.length) await api.unregisterScripts({ ids: [COMPOSE_SCRIPT_ID] });
      if (wanted) {
        await api.registerScripts([{
          id: COMPOSE_SCRIPT_ID,
          js: ["src/compose/composeStatus.js"],
          runAt: "document_idle",
        }]);
      }
      return;
    }
    log.warn("scripting.compose is unavailable; the compose strip cannot be shown.");
  } catch (e) {
    log.warn("Could not register the compose strip:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Sender badge
// ---------------------------------------------------------------------------

/**
 * One cache for every "who is this address in the CRM?" question.
 *
 * The badge, the in-message strip, the compose strip and the popup all asked
 * the same thing independently, so viewing a message and then opening the popup
 * ran the four-module fan-out twice within a second. They now share the whole
 * resolved answer, not just its count.
 */
const senderCache = new LookupCache();

/**
 * Incremental search, which the address book runs on every keystroke.
 *
 * Typing a nine-character name fired eight searches, each several requests.
 * Results for a longer term are a subset of results for its prefix, so once a
 * prefix has been answered completely the rest is filtering in memory.
 */
const searchCache = new SearchCache();
const AB_PAGE = 25;

/**
 * Which modules to search for an address.
 *
 * DIRECT_MODULES is the default rather than the rule. A site that never uses
 * Targets should not pay for searching them, and a site whose business lives in
 * a custom module has no route at all without this.
 *
 * Anything the user chose is trusted as a module name and passed to the API. A
 * name that is wrong comes back as a per-module failure, which resolveAddress
 * already reports without taking down the rest of the lookup.
 */
async function effectiveModules() {
  const chosen = (await store.getPrefs()).searchModules;
  if (!Array.isArray(chosen)) return DIRECT_MODULES;
  const clean = chosen.filter((m) => typeof m === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(m));
  return clean.length ? clean : DIRECT_MODULES;
}

async function cachedSearch(term, modules, size) {
  const exact = searchCache.get(term);
  if (exact) return exact;

  const prefix = searchCache.narrowableFrom(term);
  if (prefix) {
    const narrowed = narrowHits(prefix.value.hits, term);
    log.debug(`search "${term}": narrowed from "${prefix.term}" without asking the CRM`);
    // Still complete: it came from a complete set, filtered further.
    return searchCache.set(term, { ...narrowed, term, failures: [] }, { complete: true });
  }

  const client = await CrmClient.create();
  const found = await searchRecords(client, term, { modules, size });
  // A module that filled its page may have more behind it, so this result
  // cannot be safely narrowed from.
  const truncated = Object.values(found.hits).some((r) => r.length >= size);
  return searchCache.set(term, found, { complete: !truncated });
}

/** Accounts matching a domain — asked on every popup open, rarely different. */
const domainCache = new LookupCache();

async function accountsForDomain(client, email) {
  const key = domainOf(email);
  if (!key) return [];
  const hit = domainCache.get(key);
  if (hit !== undefined) return hit;
  return domainCache.set(key, await findAccountsByDomain(client, email));
}

/** The full lookup, cached. Returns null when the CRM cannot be asked. */
async function resolveCached(email) {
  const cached = senderCache.get(email);
  if (cached !== undefined) return cached;

  const status = await auth.getStatus();
  if (status.state !== "signed_in") return senderCache.set(email, null);

  try {
    const client = await CrmClient.create();
    return senderCache.set(email, await resolveAddress(client, email, { modules: await effectiveModules() }));
  } catch (e) {
    log.debug(`lookup failed for ${email}:`, e.message);
    return senderCache.set(email, null);
  }
}

async function countRecordsFor(email) {
  const resolved = await resolveCached(email);
  return resolved ? resolved.total : null;
}

const badge = createBadgeUpdater({
  count: countRecordsFor,
  async paint(tabId, text, colour, title) {
    const action = browser.messageDisplayAction;
    if (!action) return;
    try {
      await action.setBadgeText({ tabId, text });
      if (colour) await action.setBadgeBackgroundColor({ tabId, color: colour });
      await action.setTitle({ tabId, title });
    } catch (e) {
      log.debug("badge paint rejected:", e.message);
    }
  },
});

optional("messageDisplay.onMessagesDisplayed", () =>
  browser.messageDisplay?.onMessagesDisplayed?.addListener(async (tab, messages) => {
  const prefs = await store.getPrefs();
  if (!prefs.showSenderBadge) return badge.clear(tab.id);

  const list = Array.isArray(messages) ? messages : messages?.messages || [];
  const header = list[0];
  if (!header) return badge.clear(tab.id);

  // Respect the account filter: a badge for an account the user switched off
  // would promise something the button then refuses to do.
  const scope = await accountScope(header);
  if (!scope.allowed) return badge.clear(tab.id);

  const own = new Set(await getOwnAddresses());
  const candidates = buildCandidates(header, { ownAddresses: [...own] });
  badge.schedule(tab.id, candidates.primary || null);
  }));

optional("tabs.onRemoved", () =>
  browser.tabs?.onRemoved?.addListener((tabId) => badge.cancel(tabId)));

// ---------------------------------------------------------------------------
// CRM-backed address book
// ---------------------------------------------------------------------------

/**
 * A read-only address book fed by the CRM, so typing a name in To: finds people
 * from SuiteCRM without exporting anything.
 *
 * Registered at the top level and synchronously, which the API requires: a
 * listener added inside an async block is dropped when the background page
 * suspends, and the address book disappears with it.
 *
 * Queries live rather than keeping a local copy — always current, nothing on
 * disk, and no sync logic to get wrong. The cost is that autocomplete needs the
 * CRM to be reachable, which is the honest trade.
 */
optional("addressBooks.provider.onSearchRequest", () =>
  browser.addressBooks?.provider?.onSearchRequest?.addListener(async (node, searchString) => {
  const empty = { isCompleteResult: true, results: [] };
  const term = String(searchString || "").trim();
  if (term.length < 2) return empty;

  try {
    const prefs = await store.getPrefs();
    if (!prefs.crmAddressBook) return empty;

    const status = await auth.getStatus();
    if (status.state !== "signed_in") return empty;

    const found = await cachedSearch(term, ["Contacts", "Leads"], AB_PAGE);

    const results = Object.entries(found.hits)
      .flatMap(([module, recs]) => recs.map((r) => ({ ...r, module })))
      .filter(usableForAddressBook)
      .map((rec) => ({ vCard: recordToVCard(rec) }));

    log.debug(`address book: ${results.length} result(s) for "${term}"`);
    // Not a complete result: this is a filtered view of a larger CRM, and
    // claiming completeness would let Thunderbird cache an answer that is not.
    return { isCompleteResult: false, results };
  } catch (e) {
    log.debug("address book lookup failed:", e.message);
    return empty;
  }
  }));

// ---------------------------------------------------------------------------
// Archive on send
// ---------------------------------------------------------------------------

/**
 * File outbound mail automatically, but only against a record that already
 * exists. Creating records from unattended sending is how a CRM fills with
 * entries nobody reviewed, so this never creates anything — it files, or it
 * does nothing and says so in the log.
 */
optional("compose.onAfterSend", () =>
  browser.compose?.onAfterSend?.addListener(async (tab, sendInfo) => {
  try {
    const prefs = await store.getPrefs();
    if (!prefs.archiveOnSend) return;
    if (sendInfo?.mode === "sendLater") return;

    const ids = sendInfo?.messages?.map((m) => m.id) || [];
    if (!ids.length) return log.debug("archive-on-send: no saved copy to archive");

    const status = await auth.getStatus();
    if (status.state !== "signed_in") return log.debug("archive-on-send: not signed in");

    for (const messageId of ids) {
      const msg = await readMessage(messageId);
      const scope = await accountScope(msg.header);
      if (!scope.allowed) continue;

      const own = await getOwnAddresses();
      const candidates = buildCandidates(msg.header, { ownAddresses: own });
      const target = candidates.primary;
      if (!target) continue;

      const client = await CrmClient.create();
      const resolved = await resolveAddress(client, target.email);
      if (!resolved.found) {
        log.info(`archive-on-send: ${target.email} is not in the CRM; not filing.`);
        continue;
      }

      const [module, records] = Object.entries(resolved.hits)[0];
      const record = records[0];
      await archiveMessage(client, msg, {
        type: module, id: record.id, label: recordLabel({ ...record, module }),
      });
      if (prefs.tagArchivedMessages) await tagMessage(messageId);
      senderCache.invalidate(target.email);
      log.info(`archive-on-send: filed under ${module}/${record.id}`);
    }
  } catch (e) {
    // Never let this surface as an error during sending — the mail has gone.
    log.warn("archive-on-send failed:", e.message);
  }
  }));

/**
 * Context menu on the message list.
 *
 * The toolbar button and its window are right for one message you are reading
 * and wrong for a folder you are tidying, which is where a right-click belongs.
 * Three entries, deliberately: opening the window, filing against the remembered
 * record, and creating. Any more and a menu becomes a form, which is what the
 * window is for.
 *
 * "File against the last record" is rewritten on every open to name the actual
 * record, and hidden when there is nothing remembered for that sender. A menu
 * item that reads "file against the last record" and then does nothing is worse
 * than no item at all.
 */
const MENU_OPEN = "suitecrm-menu-open";
const MENU_LAST = "suitecrm-menu-last";
const MENU_CREATE = "suitecrm-menu-create";

/** The remembered target for a selection, but only when they all agree. */
async function rememberedFor(headers) {
  if (!headers.length) return null;

  const own = await getOwnAddresses();
  const map = await store.get("lastTargets", {});
  let agreed = null;

  for (const header of headers) {
    const [primary] = buildCandidates(header, { ownAddresses: own, includeCc: false });
    const target = primary?.email ? map[primary.email.toLowerCase()] : null;
    if (!target?.id) return null;
    const key = `${target.type}:${target.id}`;
    if (agreed && agreed.key !== key) return null;   // a mixed selection has no one answer
    agreed = { key, target };
  }
  return agreed?.target || null;
}

optional("menus.create", () => {
  browser.menus.create({
    id: MENU_OPEN,
    title: "Archive to SuiteCRM…",
    contexts: ["message_list"],
  });
  browser.menus.create({
    id: MENU_LAST,
    title: "File against the last record",
    contexts: ["message_list"],
    visible: false,
  });
  browser.menus.create({
    id: MENU_CREATE,
    title: "Create a record from this email…",
    contexts: ["message_list"],
  });

  browser.menus.onShown.addListener(async (info) => {
    const headers = unwrapMessageList(info.selectedMessages);
    let title = null;

    if (headers.length) {
      const target = await rememberedFor(headers);
      if (target) {
        title = headers.length > 1
          ? `File ${headers.length} messages against ${target.label}`
          : `File against ${target.label}`;
      }
    }

    await browser.menus.update(MENU_LAST, { visible: Boolean(title), title: title || " " });
    // Creating from several messages at once has no sensible meaning: each would
    // need its own confirmation of the guessed fields.
    await browser.menus.update(MENU_CREATE, { visible: headers.length === 1 });
    browser.menus.refresh();
  });

  browser.menus.onClicked.addListener(async (info) => {
    const headers = unwrapMessageList(info.selectedMessages);
    if (!headers.length) return;

    try {
      if (info.menuItemId === MENU_OPEN || info.menuItemId === MENU_CREATE) {
        // The window needs a displayed message to work on, so select the first
        // of them and let it open on that.
        await browser.messageDisplayAction.openPopup();
        return;
      }
      if (info.menuItemId !== MENU_LAST) return;

      const target = await rememberedFor(headers);
      if (!target) return;

      const client = await CrmClient.create();
      const prefs = await store.getPrefs();
      const done = [];

      for (const header of headers) {
        const scope = await accountScope(header);
        if (!scope.allowed) {
          log.info(`menu: ${scope.accountName} is not enabled; skipping a message.`);
          continue;
        }
        const msg = messageCache.get(header.id) || (await readMessage(header.id));
        const res = await archiveMessage(client, msg, target);
        if (prefs.tagArchivedMessages) await tagMessage(header.id);
        done.push({ res, messageId: header.id });
      }

      if (done.length) {
        rememberArchive(done, target);
        senderCache.invalidate(); domainCache.invalidate(); searchCache.clear();
        log.info(`menu: filed ${done.length} message(s) under ${target.type}/${target.id}`);
      }
    } catch (e) {
      log.warn(`menu ${info.menuItemId} failed:`, e.message);
    }
  });
});

/**
 * Keyboard shortcuts.
 *
 * Two, because filing is either a decision or a repetition. archive-open is the
 * decision: it opens the window on the displayed message. archive-last is the
 * repetition: it files against whatever that sender's mail went to last time,
 * with no window at all, which is the case that actually happens twenty times
 * in a row.
 *
 * archive-last deliberately does nothing when there is no remembered record.
 * Guessing a destination without showing anything would file mail somewhere the
 * user never chose, and the undo only helps if they notice.
 */
optional("commands.onCommand", () =>
  browser.commands.onCommand.addListener(async (name) => {
    try {
      if (name === "archive-open") {
        await browser.messageDisplayAction.openPopup();
        return;
      }
      if (name !== "archive-last") return;

      const [msgHeader] = unwrapMessageList(
        await browser.messageDisplay.getDisplayedMessages()
      ) || [];
      if (!msgHeader) return;

      const msg = messageCache.get(msgHeader.id) || (await readMessage(msgHeader.id));
      const scope = await accountScope(msg.header);
      if (!scope.allowed) {
        log.info(`archive-last: ${scope.accountName} is not enabled; ignoring.`);
        return;
      }

      const own = await getOwnAddresses();
      const [primary] = buildCandidates(msg.header, { ownAddresses: own, includeCc: false });
      if (!primary?.email) return;

      const map = await store.get("lastTargets", {});
      const target = map[primary.email.toLowerCase()];
      if (!target?.id) {
        log.info(`archive-last: nothing remembered for ${primary.email}; opening the window instead.`);
        await browser.messageDisplayAction.openPopup();
        return;
      }

      const client = await CrmClient.create();
      const res = await archiveMessage(client, msg, target);
      if ((await store.getPrefs()).tagArchivedMessages) await tagMessage(msgHeader.id);
      rememberArchive([{ res, messageId: msgHeader.id }], target);
      senderCache.invalidate(primary.email);
      log.info(`archive-last: filed under ${target.type}/${target.id}`);
    } catch (e) {
      log.warn(`shortcut ${name} failed:`, e.message);
    }
  }));

log.info("SuiteCRM Email Archiver background page ready.");
