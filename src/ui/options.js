/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateSecret, assessSecret } from "../lib/secret.js";
import { originPatternFor } from "../lib/url.js";
import { describeProbe } from "../lib/probe.js";
import { DEFAULT_CASE_MACRO, caseRefPattern } from "../lib/caseRef.js";
import { moduleTitle } from "../lib/modules.js";

const $ = (id) => document.getElementById(id);

async function call(type, payload = {}) {
  const res = await browser.runtime.sendMessage({ type, payload });
  if (!res) throw new Error("The background page did not respond.");
  if (!res.ok) throw new Error(res.error.message);
  return res.result;
}

const PREF_KEYS = [
  "archiveAttachments",
  "skipInlineImages",
  "renameBlockedAttachments",
  "includeCcRecipients",
  "debugMode",
  "requireHttps",
  "useOriginalDate",
  "matchCaseReferences",
  "showSenderBadge",
  "showMessageBanner",
  "tagArchivedMessages",
  "showComposeStatus",
  "archiveOnSend",
  "crmAddressBook",
];

function fmt(ts) {
  if (!ts) return ", ";
  const d = new Date(ts);
  const days = Math.round((ts - Date.now()) / 864e5);
  if (days > 1) return `${d.toLocaleDateString()} (about ${days} days)`;
  const mins = Math.round((ts - Date.now()) / 60000);
  if (mins > 0) return `${d.toLocaleTimeString()} (${mins} min)`;
  return `${d.toLocaleString()}, expired, will renew on next use`;
}

async function refreshConnection() {
  const status = await call("getStatus");
  const signedIn = status.state === "signed_in";

  $("signed-in").hidden = !signedIn;
  $("login-form").hidden = signedIn;

  if (signedIn) {
    $("si-url").textContent = status.baseUrl;
    $("si-user").textContent = status.username || ", ";
    $("si-access").textContent = fmt(status.accessExpiresAt);
    $("si-refresh").textContent = fmt(status.refreshExpiresAt);
  } else if (status.baseUrl) {
    $("in-url").value = status.baseUrl;
    $("in-username").value = status.username || "";
  }
}

async function refreshPrefs() {
  const prefs = await call("getPrefs");
  for (const key of PREF_KEYS) {
    const input = $(`p-${key}`);
    if (input) input.checked = Boolean(prefs[key]);
  }
  $("p-logLevel").value = prefs.logLevel || "info";
  $("p-attachmentDestination").value = prefs.attachmentDestination || "smart";
  $("p-caseSubjectMacro").value = prefs.caseSubjectMacro || "";
  describeCaseMacro();
}

/** Say whether the macro can identify a case, and show what it will match. */
function describeCaseMacro() {
  const note = $("case-macro-note");
  const macro = $("p-caseSubjectMacro").value.trim();

  if (!macro) {
    note.className = "field-note";
    note.textContent = `Empty, so the default ${DEFAULT_CASE_MACRO} is used.`;
    return;
  }
  if (!caseRefPattern(macro)) {
    note.className = "field-note is-warn";
    note.textContent = "Must contain %1, where the case number appears. Not saved until it does.";
    return;
  }
  note.className = "field-note is-ok";
  note.textContent = `Matches a subject containing ${macro.replace("%1", "1234")}.`;
}

function bindPrefs() {
  for (const key of PREF_KEYS) {
    const input = $(`p-${key}`);
    if (input) input.addEventListener("change", () => call("setPrefs", { [key]: input.checked }));
  }
  $("p-logLevel").addEventListener("change", (e) => call("setPrefs", { logLevel: e.target.value }));
  $("p-attachmentDestination").addEventListener("change",
    (e) => call("setPrefs", { attachmentDestination: e.target.value }));

  // A macro without %1 cannot identify a case, and one saved silently would
  // simply stop the feature working with no indication why. Say so, and do not
  // save it.
  $("p-caseSubjectMacro").addEventListener("input", describeCaseMacro);
  $("p-caseSubjectMacro").addEventListener("change", (e) => {
    const macro = e.target.value.trim();
    if (macro && !macro.includes("%1")) return;
    call("setPrefs", { caseSubjectMacro: macro || DEFAULT_CASE_MACRO });
  });
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("login-status");
  const btn = $("btn-signin");

  // Ask for the host permission FIRST, before any await. The user's click grants
  // a transient activation that permissions.request() requires, and awaiting
  // anything at all, including a message to the background page, spends it.
  // Requesting a permission already held resolves true without prompting, so
  // there is no need to check permissions.contains() beforehand.
  let origin = "", granted = false, permissionError = null;
  try {
    origin = originPatternFor($("in-url").value);
    granted = await browser.permissions.request({ origins: [origin] });
  } catch (err) {
    permissionError = err;
  }

  status.hidden = false;
  status.className = "status is-info";
  status.textContent = "Locating the SuiteCRM API and signing in…";
  btn.disabled = true;

  if (permissionError) {
    status.className = "status is-error";
    status.textContent =
      `Could not ask for permission to contact ${origin || "your CRM"}: ` +
      `${permissionError.message}. Open this add-on's Permissions tab and enable ` +
      `access, then sign in again.`;
    btn.disabled = false;
    return;
  }

  try {
    if (!granted) {
      throw new Error(
        `Permission to contact ${origin} was not granted, so the add-on cannot reach ` +
        `your CRM. You can also grant it under this add-on's Permissions tab.`
      );
    }

    const res = await call("login", {
      baseUrl: $("in-url").value,
      clientId: $("in-client-id").value,
      clientSecret: $("in-client-secret").value,
      username: $("in-username").value,
      password: $("in-password").value,
    });

    $("in-password").value = "";
    status.className = "status is-info";
    status.textContent = res.hasRefreshToken
      ? `Signed in. API at ${res.apiBase}. You should not need to sign in again.`
      : `Signed in at ${res.apiBase}, but the server issued no refresh token, ` +
        `check that this is a Password client, or you will be signed out hourly.`;
    await refreshConnection();
  } catch (err) {
    status.className = "status is-error";
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("btn-signout").addEventListener("click", async () => {
  await call("logout", {});
  await refreshConnection();
});

$("btn-forget").addEventListener("click", async () => {
  await call("logout", { forget: true });
  for (const id of ["in-url", "in-client-id", "in-client-secret", "in-username", "in-password"]) $(id).value = "";
  await refreshConnection();
});

// Say plainly when the CRM address is unencrypted. The password grant sends the
// password in the request body, so on http:// it crosses the network in the clear.
function checkScheme() {
  const box = $("http-warning");
  const raw = $("in-url").value.trim();
  if (/^http:\/\//i.test(raw)) {
    box.hidden = false;
    box.textContent =
      "This address is unencrypted (http://). Your CRM password and access tokens will " +
      "cross the network in the clear, readable by anyone on the same network. Acceptable " +
      "for a test system on a trusted LAN; use https:// for anything real.";
  } else {
    box.hidden = true;
  }
}
$("in-url").addEventListener("input", checkScheme);
$("in-url").addEventListener("change", checkScheme);

/** Open the setup guide by default until the connection actually works. */
async function collapseSetupWhenConnected() {
  const status = await call("getStatus");
  const card = $("setup-card");
  if (status.state === "signed_in") card.classList.add("is-collapsed");
}

bindPrefs();
checkScheme();
collapseSetupWhenConnected();
refreshConnection();
refreshPrefs();
refreshModules().catch(() => {});

// --- About -----------------------------------------------------------------

// Where a problem should actually go. The homepage is a company site, which is
// no use to someone holding a bug, and until now nothing in the add-on pointed
// at the issue tracker, the address only existed in the README and the store
// listing, neither of which is in front of you when something breaks.
const SUPPORT_URL = "https://github.com/njordium/thunderbird_suitecrm_archiver/issues";

async function renderAbout() {
  const m = browser.runtime.getManifest();
  $("about-version").textContent = m.version;
  $("about-desc").textContent = m.description || "";

  try {
    const info = await browser.runtime.getBrowserInfo();
    $("about-host").textContent = `${info.name} ${info.version}`;
  } catch {
    $("about-host").textContent = ", ";
  }

  // developer.url takes precedence, matching what the Details tab links to.
  const site = m.developer?.url || m.homepage_url;
  $("btn-home").hidden = !site;
  $("btn-home").addEventListener("click", () => {
    if (site) browser.tabs.create({ url: site });
  });

  $("btn-support").addEventListener("click", () => {
    browser.tabs.create({ url: SUPPORT_URL });
  });

  const author = m.developer?.name || m.author;
  if (author) $("about-desc").title = `By ${author}`;
}

$("btn-notes").addEventListener("click", async () => {
  const box = $("notes");
  if (!box.hidden) { box.hidden = true; return; }

  if (!box.dataset.loaded) {
    try {
      // Built from structured data rather than assigned as HTML. The file is
      // ours, but innerHTML is the wrong habit for a privileged page and
      // Thunderbird's review linter flags it, the day this content comes from
      // anywhere else, the mistake would already be made.
      const res = await fetch(browser.runtime.getURL("src/ui/release-notes.json"));
      const blocks = await res.json();

      box.textContent = "";
      for (const block of blocks) {
        if (block.t === "ul") {
          const ul = document.createElement("ul");
          for (const item of block.v) {
            const li = document.createElement("li");
            li.textContent = item;
            ul.appendChild(li);
          }
          box.appendChild(ul);
        } else {
          const el = document.createElement(block.t === "h2" ? "h3" : block.t === "h3" ? "h4" : "p");
          el.textContent = block.v;
          box.appendChild(el);
        }
      }
      box.dataset.loaded = "1";
    } catch (e) {
      box.textContent = `Could not load the release notes: ${e.message}`;
    }
  }
  box.hidden = false;
});

renderAbout();


// --- Setup guide toggle -----------------------------------------------------

const setupToggle = $("btn-toggle-setup");
setupToggle.addEventListener("click", () => {
  const card = $("setup-card");
  const hidden = card.classList.toggle("is-hidden");
  setupToggle.textContent = hidden ? "Show" : "Hide";
  setupToggle.setAttribute("aria-expanded", String(!hidden));
  call("setPrefs", { setupGuideHidden: hidden }).catch(() => {});
});

// --- Mail accounts ----------------------------------------------------------

async function renderAccounts() {
  const box = $("account-list");
  const prefs = await call("getPrefs");
  let accounts = [];
  try {
    accounts = await call("listAccounts");
  } catch (e) {
    box.textContent = `Could not list accounts: ${e.message}`;
    return;
  }

  box.textContent = "";
  if (!accounts.length) {
    box.textContent = "No mail accounts found.";
    return;
  }

  // null means every account, so an account added later works without a visit here.
  // An array lists exactly which ones, and an empty array means none.
  const enabled = prefs.enabledAccounts;
  const allOn = !Array.isArray(enabled);

  for (const acct of accounts) {
    const row = document.createElement("label");
    row.className = "acct-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = allOn || enabled.includes(acct.id);
    cb.dataset.accountId = acct.id;

    const body = document.createElement("div");
    body.className = "acct-body";
    const name = document.createElement("div");
    name.className = "acct-name";
    name.textContent = acct.name || acct.id;
    body.appendChild(name);
    if (acct.email) {
      const mail = document.createElement("div");
      mail.className = "acct-mail";
      mail.textContent = acct.email;
      body.appendChild(mail);
    }

    cb.addEventListener("change", () => {
      row.classList.toggle("is-on", cb.checked);
      saveAccounts();
    });
    row.classList.toggle("is-on", cb.checked);
    row.append(cb, body);
    box.appendChild(row);
  }
  updateAccountHint(accounts.length);
}

/** Tick or untick every account at once. */
function setAllAccounts(on) {
  const boxes = [...document.querySelectorAll("#account-list input[type=checkbox]")];
  for (const cb of boxes) {
    cb.checked = on;
    cb.closest(".acct-row")?.classList.toggle("is-on", on);
  }
  saveAccounts();
}

$("btn-acct-all").addEventListener("click", () => setAllAccounts(true));
$("btn-acct-none").addEventListener("click", () => setAllAccounts(false));

async function saveAccounts() {
  const boxes = [...document.querySelectorAll("#account-list input[type=checkbox]")];
  const picked = boxes.filter((b) => b.checked).map((b) => b.dataset.accountId);

  // All ticked is stored as null, meaning "no restriction", so accounts added
  // later still work. Anything else is the explicit list, including none at all,
  // which must stay distinguishable from "all".
  const value = picked.length === boxes.length ? null : picked;
  await call("setPrefs", { enabledAccounts: value });
  updateAccountHint(boxes.length);
}

function updateAccountHint(total) {
  const boxes = [...document.querySelectorAll("#account-list input[type=checkbox]")];
  const on = boxes.filter((b) => b.checked).length;
  $("account-hint").textContent = on === total
    ? `All ${total} enabled, including any added later`
    : on === 0
      ? "None enabled, the button will not work anywhere"
      : `${on} of ${total} enabled`;
}

(async () => {
  const prefs = await call("getPrefs");
  if (prefs.setupGuideHidden) {
    $("setup-card").classList.add("is-hidden");
    setupToggle.textContent = "Show";
    setupToggle.setAttribute("aria-expanded", "false");
  }
})();

renderAccounts();


// --- Host permission ---------------------------------------------------------

/**
 * The permission prompt is part of signing in, so this row stays hidden during
 * the normal flow, it would just duplicate what Sign in already does.
 *
 * It appears in one case only: already signed in, but the host permission has
 * since been withdrawn (from the add-on's Permissions tab, say). Without a
 * one-click re-grant the only way back would be signing in again, password and
 * all, to recover a permission that was never really lost.
 */
async function refreshPermissionRow() {
  const row = $("perm-row");
  const raw = $("in-url").value.trim();
  row.hidden = true;

  if (!raw) return;

  let info, status;
  try {
    [info, status] = await Promise.all([
      call("checkOrigin", { baseUrl: raw }),
      call("getStatus"),
    ]);
  } catch { return; }

  if (info.invalidUrl || info.granted) return;
  if (status.state !== "signed_in") return;   // Sign in will ask for it

  row.hidden = false;
  row.classList.add("is-missing");
  $("btn-grant").hidden = false;
  $("perm-title").textContent = "Access to your CRM has been withdrawn";
  $("perm-detail").textContent =
    `You are signed in, but Thunderbird is blocking requests to ${info.origin}. ` +
    `Restore it here rather than signing in again.`;
}

// The click handler's only job is the request, so the user activation is still
// live when it runs. Anything awaited first would spend it.
$("btn-grant").addEventListener("click", async () => {
  let origin = "";
  let granted = false, err = null;
  try {
    origin = originPatternFor($("in-url").value);
    granted = await browser.permissions.request({ origins: [origin] });
  } catch (e) {
    err = e;
  }

  const status = $("login-status");
  status.hidden = false;
  if (err) {
    status.className = "status is-error";
    status.textContent =
      `Could not ask for permission (${err.message}). Open this add-on's Permissions tab ` +
      `and turn on access for websites, then come back.`;
  } else if (!granted) {
    status.className = "status is-warn";
    status.textContent =
      `Permission for ${origin} was not granted. You can also enable it under this ` +
      `add-on's Permissions tab.`;
  } else {
    status.className = "status is-info";
    status.textContent = `Access to ${origin} granted.`;
  }
  await refreshPermissionRow();
});

$("in-url").addEventListener("change", refreshPermissionRow);

// --- Connection diagnostics --------------------------------------------------

$("btn-probe").addEventListener("click", async () => {
  // Ask for access FIRST, before any await, for the same reason Sign in does:
  // the click's transient activation is what permissions.request() needs, and a
  // message to the background page spends it. This is also the difference
  // between a test that reports a problem and a test that resolves it, the
  // permission is required to reach the CRM, so a test that cannot obtain it
  // can only ever tell the user to press a different button.
  // Requesting one already held resolves true without prompting.
  let askedNow = false, permissionError = null;
  try {
    await browser.permissions.request({ origins: [originPatternFor($("in-url").value)] });
    askedNow = true;
  } catch (e) {
    permissionError = e;
  }

  const out = $("probe-out");
  out.hidden = false;
  out.textContent = "Testing…";

  let r;
  try {
    r = await call("probeConnection", { baseUrl: $("in-url").value });
  } catch (e) {
    out.textContent = `Could not run the test: ${e.message}`;
    return;
  }

  const report = describeProbe(r, { askedNow });
  out.textContent = "";

  const h = document.createElement("h4");
  h.textContent = `Testing ${r.base}`;
  out.appendChild(h);

  const verdict = document.createElement("div");
  verdict.className = "verdict " + report.tone;
  verdict.textContent = report.verdict;
  out.appendChild(verdict);

  const dl = document.createElement("dl");
  dl.className = "rows";
  for (const [label, value, tone] of report.rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.className = tone;
    dd.textContent = value;
    dl.append(dt, dd);
  }
  out.appendChild(dl);

  for (const a of report.attempts) {
    const pre = document.createElement("pre");
    pre.className = a.live ? "attempt is-live" : "attempt";
    pre.textContent = [a.url, `  ${a.headline}`, `  ${a.detail}`, a.body ? `  ${a.body}` : ""]
      .filter(Boolean).join("\n");
    out.appendChild(pre);
  }

  const fixes = report.fixes.slice();
  if (permissionError) {
    fixes.unshift(
      `Thunderbird would not accept the access request (${permissionError.message}). ` +
      `Turn on access for websites under this add-on's Permissions tab instead.`
    );
  }

  if (fixes.length) {
    const ul = document.createElement("ul");
    ul.className = "fix";
    for (const f of fixes) {
      const li = document.createElement("li");
      li.textContent = f;
      ul.appendChild(li);
    }
    out.appendChild(ul);
  }

  await refreshPermissionRow();
});

refreshPermissionRow();


// --- Troubleshooting ---------------------------------------------------------

let debugReportText = "";

async function refreshDebugState() {
  const box = $("debug-state");
  try {
    const st = await call("diagnosticsStatus");
    box.classList.toggle("is-on", st.enabled);
    box.textContent = "";
    const dot = document.createElement("span");
    dot.className = "dot";
    box.appendChild(dot);
    box.appendChild(document.createTextNode(
      st.enabled
        ? `Recording. ${st.entries} entr${st.entries === 1 ? "y" : "ies"} captured.`
        : st.entries
          ? `Not recording. ${st.entries} entries from an earlier session are still stored.`
          : "Not recording."
    ));
  } catch {
    box.textContent = "";
  }
}

$("p-debugMode").addEventListener("change", async (e) => {
  if (e.target.checked) {
    $("debug-state").textContent = "Recording. Reproduce the problem, then create the report.";
  }
  await refreshDebugState();
});

$("btn-debug-report").addEventListener("click", async () => {
  const out = $("debug-out");
  const pre = $("debug-text");
  out.hidden = false;
  pre.textContent = "Collecting…";
  $("debug-saved").textContent = "";

  try {
    const res = await call("buildDebugReport", {
      includeEmails: $("dbg-emails").checked,
      includeHost: $("dbg-host").checked,
    });
    debugReportText = res.text;
    pre.textContent = res.text;
  } catch (e) {
    pre.textContent = `Could not build the report: ${e.message}`;
    debugReportText = "";
  }
  await refreshDebugState();
});

// --- Which modules are searched ----------------------------------------------

// Rendered from whatever the last discovery found, so the built-in four are
// always present even before anyone presses the button, and even if the CRM is
// unreachable.
let moduleState = { builtIn: [], extra: [], labels: {}, selected: null, trouble: {} };

function renderModules() {
  const box = $("module-list");
  box.textContent = "";

  const all = [...moduleState.builtIn, ...moduleState.extra];
  if (!all.length) { box.textContent = "Sign in to choose modules."; return; }

  const selected = Array.isArray(moduleState.selected) ? moduleState.selected : moduleState.builtIn;

  for (const name of all) {
    const label = document.createElement("label");
    if (!moduleState.builtIn.includes(name)) label.className = "is-extra";

    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = selected.includes(name);
    tick.dataset.module = name;
    tick.addEventListener("change", saveModules);

    // The CRM's own label, which is localised and the only sensible name for a
    // custom module. The built-in four are named centrally, where "Targets"
    // reads better than SuiteCRM's internal "Prospects".
    const title = moduleTitle(name, moduleState.labels);
    label.append(tick, document.createTextNode(title));

    // A module the CRM refused. Marked rather than hidden: someone whose
    // access was revoked should see that it happened and be able to take it up
    // on their own side, not find the module quietly missing.
    const bad = moduleState.trouble?.[name]?.disabled ? moduleState.trouble[name] : null;
    if (bad) {
      const mark = document.createElement("span");
      mark.className = "mod-bad";
      mark.textContent = "\u2715";
      mark.title = bad.status
        ? `The CRM refused this module (HTTP ${bad.status}): ${bad.error}`
        : `The CRM refused this module: ${bad.error}`;
      mark.setAttribute("aria-label", `${title}: refused by the CRM`);
      label.append(mark);
      label.classList.add("is-refused");
    }

    box.appendChild(label);
  }
}

function saveModules() {
  const picked = [...$("module-list").querySelectorAll("input:checked")]
    .map((i) => i.dataset.module);

  // Storing null rather than the same four keeps "the default" distinguishable
  // from "someone chose exactly the default", so a later change to the default
  // still reaches them. Nothing ticked also falls back, since searching no
  // module at all would look like a broken add-on rather than a choice.
  const isDefault = picked.length === moduleState.builtIn.length &&
    moduleState.builtIn.every((m) => picked.includes(m));

  moduleState.selected = isDefault || !picked.length ? null : picked;
  call("setPrefs", { searchModules: moduleState.selected });

  $("module-note").textContent = picked.length
    ? ""
    : "Nothing ticked, so the four built-in modules are used.";
}

async function refreshModules({ discover = false } = {}) {
  const note = $("module-note");
  if (discover) note.textContent = "Asking the CRM…";
  try {
    const res = await call("listCrmModules", { recheck: discover });
    moduleState = {
      builtIn: res.builtIn, extra: res.extra || [],
      labels: res.labels || {}, selected: res.selected, trouble: res.trouble || {},
    };
    renderModules();

    const refused = Object.entries(moduleState.trouble)
      .filter(([, t]) => t?.disabled)
      .map(([m]) => moduleTitle(m, moduleState.labels));
    if (refused.length) {
      note.textContent = `${refused.join(", ")} ${refused.length === 1 ? "was" : "were"} ` +
        `refused by the CRM and turned off. Hover the mark for the reason. ` +
        `Fix the access in SuiteCRM, then press Re-scan modules to re-test.`;
      return;
    }
    note.textContent = res.error
      ? `Could not ask the CRM for more modules (${res.error}).`
      : discover
        ? (moduleState.extra.length
            ? `Found ${moduleState.extra.length} more module(s) you can search by address.`
            : "No other module you have access to has an email address field.")
        : "";
  } catch (e) {
    $("module-list").textContent = "Sign in to choose modules.";
    note.textContent = discover ? e.message : "";
  }
}

$("btn-refresh-modules").addEventListener("click", () => refreshModules({ discover: true }));

// --- Sharing the connection settings ----------------------------------------

$("btn-export-conn").addEventListener("click", async () => {
  const status = $("login-status");
  status.hidden = false;
  try {
    const { settings } = await call("exportConnection");
    const text = JSON.stringify(settings, null, 2) + "\n";
    const filename = "suitecrm-archiver-connection.json";

    // A blob URL plus the downloads API, for the same reason the debug report
    // uses it: a plain <a download> is unreliable from an embedded options page.
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    try {
      await browser.downloads.download({ url, filename, saveAs: true });
      status.className = "status is-info";
      status.textContent =
        `Saved ${filename}. It holds the CRM address, client id and secret, and no token. ` +
        `Treat it as you would the secret itself.`;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch (e) {
    status.className = "status is-error";
    status.textContent = e.message;
  }
});

$("btn-import-conn").addEventListener("click", () => $("in-import-conn").click());

$("in-import-conn").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";                 // so the same file can be picked twice
  if (!file) return;

  const status = $("login-status");
  status.hidden = false;
  try {
    const conn = await call("importConnection", { text: await file.text() });

    // Filled into the form rather than stored, so the values are visible and
    // signing in stays a deliberate act. A file must not be able to repoint the
    // add-on at another server on its own.
    $("in-url").value = conn.baseUrl;
    $("in-client-id").value = conn.clientId;
    $("in-client-secret").value = conn.clientSecret;
    await refreshPermissionRow();

    status.className = "status is-info";
    status.textContent =
      "Settings loaded into the form. Add your own CRM username and password, then Sign in.";
    $("in-username").focus();
  } catch (err) {
    status.className = "status is-error";
    status.textContent = err.message;
  }
});

$("btn-debug-save").addEventListener("click", async () => {
  if (!debugReportText) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `suitecrm-archiver-debug-${stamp}.txt`;
  const note = $("debug-saved");

  // A blob URL plus the downloads API, because a plain <a download> is not
  // reliable from an options page embedded in the Add-ons Manager.
  const url = URL.createObjectURL(new Blob([debugReportText], { type: "text/plain" }));
  try {
    await browser.downloads.download({ url, filename, saveAs: true });
    note.textContent = `Saved as ${filename}`;
  } catch (e) {
    note.textContent = `Could not save (${e.message}), use Copy to clipboard instead.`;
  } finally {
    // Give the download a moment to start before revoking the URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
});

$("btn-debug-copy").addEventListener("click", async () => {
  if (!debugReportText) return;
  const note = $("debug-saved");
  try {
    await navigator.clipboard.writeText(debugReportText);
    note.textContent = "Copied to the clipboard.";
  } catch (e) {
    note.textContent = `Could not copy (${e.message}), select the text below instead.`;
  }
});

// ---------------------------------------------------------------------------
// What is remembered on this computer
// ---------------------------------------------------------------------------

/** Say what is actually there, so the button is not a leap of faith. */
async function refreshHistoryState() {
  const line = $("history-state");
  try {
    const { targets, recents } = await call("historySize");
    const btn = $("btn-clear-history");
    if (!targets && !recents) {
      line.textContent = "Nothing is remembered yet.";
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    const parts = [];
    if (targets) parts.push(`${targets} ${targets === 1 ? "address" : "addresses"} with a remembered record`);
    if (recents) parts.push(`${recents} ${recents === 1 ? "subject" : "subjects"} in the Recent list`);
    line.textContent = `${parts.join(", ")}.`;
  } catch (e) {
    line.textContent = `Could not read what is stored (${e.message}).`;
  }
}

$("btn-clear-history").addEventListener("click", async () => {
  const line = $("history-state");
  try {
    await call("clearHistory");
    line.textContent = "Cleared.";
    $("btn-clear-history").disabled = true;
  } catch (e) {
    line.textContent = `Could not clear it (${e.message}).`;
  }
});

refreshHistoryState();


$("btn-debug-clear").addEventListener("click", async () => {
  await call("clearDiagnostics");
  debugReportText = "";
  $("debug-out").hidden = true;
  await refreshDebugState();
});

refreshDebugState();


// ---------------------------------------------------------------------------
// Site access left over from website checks
// ---------------------------------------------------------------------------

/**
 * Checking a guessed website needs access to that one site. That access is now
 * handed back as soon as the check finishes, but grants made before that change
 * are still held, one per sender ever checked, so offer to release them.
 */
async function refreshStrayPermissions() {
  const box = $("stray-perms");
  box.hidden = true;
  $("stray-note").textContent = "";

  let info;
  try {
    info = await call("strayHostPermissions");
  } catch {
    return;
  }
  if (!info.stray.length) return;

  const list = $("stray-list");
  list.textContent = "";
  for (const origin of info.stray) {
    const li = document.createElement("li");
    li.textContent = origin;
    list.appendChild(li);
  }
  box.hidden = false;
  $("btn-drop-perms").textContent =
    info.stray.length === 1 ? "Release this site" : `Release these ${info.stray.length} sites`;
}

$("btn-drop-perms").addEventListener("click", async () => {
  const btn = $("btn-drop-perms");
  btn.disabled = true;
  try {
    const info = await call("strayHostPermissions");
    const { removed } = await call("dropHostPermissions", { origins: info.stray });
    $("stray-note").textContent =
      removed ? `Released ${removed}.` : "Nothing could be released.";
    await refreshStrayPermissions();
  } catch (e) {
    $("stray-note").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

refreshStrayPermissions();


// ---------------------------------------------------------------------------
// Client secret
// ---------------------------------------------------------------------------

/**
 * SuiteCRM stores the secret as a single unsalted SHA-256, so its strength rests
 * entirely on being random. Generating one here removes the temptation to
 * invent something memorable, and puts it on the clipboard because it has to be
 * pasted into SuiteCRM before it can ever be read back.
 */
$("btn-gen-secret").addEventListener("click", async () => {
  const field = $("in-client-secret");
  const note = $("secret-note");

  if (field.value.trim() &&
      !confirm("Replace the secret in this field?\n\nThe current one will be lost unless " +
               "you have it saved elsewhere.")) {
    return;
  }

  let secret;
  try {
    secret = generateSecret();
  } catch (e) {
    note.className = "field-note is-warn";
    note.textContent = e.message;
    return;
  }

  field.value = secret;
  field.type = "text";                // it has to be read to be pasted onwards
  $("btn-show-secret").textContent = "hide";
  $("secret-guidance").hidden = false;

  try {
    await navigator.clipboard.writeText(secret);
    note.className = "field-note is-ok";
    note.textContent = "256-bit secret generated and copied to the clipboard.";
  } catch {
    note.className = "field-note is-ok";
    note.textContent = "256-bit secret generated. Select and copy it.";
  }
});

/**
 * The secret has to travel from here into SuiteCRM's Change Secret field, and a
 * stored one cannot be read back out of SuiteCRM afterwards. Selecting text out
 * of a password input is fiddly, so offer the copy directly, it stays useful
 * long after the generate step, when the field is filled from saved settings.
 */
$("btn-copy-secret").addEventListener("click", async () => {
  const secret = $("in-client-secret").value;
  const note = $("secret-note");

  if (!secret) {
    note.className = "field-note is-warn";
    note.textContent = "There is no secret to copy.";
    return;
  }

  try {
    await navigator.clipboard.writeText(secret);
    note.className = "field-note is-ok";
    note.textContent = "Secret copied to the clipboard.";
  } catch (e) {
    // Reveal it rather than leaving the user with a failure and a row of dots.
    $("in-client-secret").type = "text";
    $("btn-show-secret").textContent = "hide";
    note.className = "field-note is-warn";
    note.textContent = `Could not reach the clipboard (${e.message}). The secret is shown now, copy it by hand.`;
  }
});

$("btn-show-secret").addEventListener("click", () => {
  const field = $("in-client-secret");
  const showing = field.type === "text";
  field.type = showing ? "password" : "text";
  $("btn-show-secret").textContent = showing ? "show" : "hide";
});

/** Say plainly when a typed secret is too weak for how SuiteCRM stores it. */
$("in-client-secret").addEventListener("input", () => {
  const note = $("secret-note");
  const { ok, note: text } = assessSecret($("in-client-secret").value);
  note.className = "field-note" + (ok ? " is-ok" : text ? " is-warn" : "");
  note.textContent = text;
});
