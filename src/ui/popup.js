/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Popup controller.
 *
 * Flow: open → read the message → pick the sender as the default target →
 * fan out across every CRM module at once → present hits for one click.
 * No module dropdown, no manual search.
 */

import { MODULE_LABEL, moduleTitle, recordLabel, recordSubtitle, recordOwner } from "../lib/modules.js";
import { timeAgo } from "../lib/humanTime.js";
import { unwrapMessageList } from "../lib/tbcompat.js";
import { creatableFor, unavailableReason } from "../lib/createFromEmail.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  messageId: null,
  prepared: null,
  activeEmail: null,
  activeName: null,
  lookup: null,
  selected: null,       // {type, id, label}
  alsoLink: [],
  createKind: "Leads",
  wholeThread: false,
  threadCount: 1,
  useOriginalDate: true,
  selectedIds: [],
  searchTerm: "",
  pickerFilter: "",
  lastTarget: null,
  caseHit: null,        // a Case named in the subject, if any
  subjectOverride: null, // an edited subject, for this archive only
  confirmedBulk: false,
  recordKind: "Cases",
  followUp: false,
  selectedAccountId: null,
  archiveSelection: false,
  proposal: null,
  chosenAccountId: null,
};

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

async function call(type, payload = {}) {
  const res = await browser.runtime.sendMessage({ type, payload });
  if (!res) throw new Error("The background page did not respond.");
  if (!res.ok) {
    const err = new Error(res.error.message);
    err.needsLogin = res.error.needsLogin;
    throw err;
  }
  return res.result;
}

function showView(name) {
  for (const v of document.querySelectorAll(".view")) v.hidden = true;
  $(`view-${name}`).hidden = false;
}

function setLoading(on, text = "Loading…") {
  $("loading-text").textContent = text;
  $("loading").classList.toggle("is-on", on);
}

function setStatus(node, text, kind = "info") {
  if (!text) { node.hidden = true; return; }
  node.hidden = false;
  node.className = `status is-${kind}`;
  node.textContent = text;
}

browser.runtime.onMessage.addListener((m) => {
  if (m?.type === "archiveProgress") setLoading(true, m.text);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * The message the user means.
 *
 * Which API answers depends on where the button was clicked:
 *
 *   - Opened message, or a preview pane → `messageDisplay.getDisplayedMessages()`.
 *     (The singular getDisplayedMessage() does not exist in any version this
 *     add-on supports; the fallback for it was unreachable code.)
 *   - A row selected in the message list, with no preview → nothing is *displayed*,
 *     so the answer comes from `mailTabs.getSelectedMessages()` instead.
 *
 * The message-header button only ever sees the first case. The main toolbar
 * button sees both, which is why asking messageDisplay alone reported "no
 * message selected" while a message was plainly selected.
 */
async function getDisplayedMessage() {
  // Opened from the context menu as a standalone window, the message is named in
  // the URL. That is not a shortcut: a window of our own has no reader pane and
  // is not the active mail tab, so none of the discovery below would find what
  // the user actually right-clicked.
  const params = new URLSearchParams(location.search);
  const named = Number(params.get("messageId"));
  if (params.has("messageId")) document.body.classList.add("standalone");
  if (Number.isInteger(named) && named > 0) {
    const ids = (params.get("ids") || "")
      .split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    try {
      const header = await browser.messages.get(named);
      if (header) {
        report("debug", `popup: message ${named} named in the URL`);
        return { message: header, ids: ids.length ? ids : [named], via: "url" };
      }
    } catch (e) {
      report("warn", `popup: message ${named} from the URL could not be read: ${e.message}`);
    }
  }

  const attempts = [];

  const md = browser.messageDisplay;
  if (md && typeof md.getDisplayedMessages === "function") {
    attempts.push(["messageDisplay.getDisplayedMessages", () => md.getDisplayedMessages()]);
    attempts.push(["messageDisplay.getDisplayedMessages(tab)", async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      return tabs[0] ? md.getDisplayedMessages(tabs[0].id) : null;
    }]);
  }
  const mt = browser.mailTabs;
  if (mt && typeof mt.getSelectedMessages === "function") {
    attempts.push(["mailTabs.getSelectedMessages", () => mt.getSelectedMessages()]);
    attempts.push(["mailTabs.getSelectedMessages(tab)", async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      return tabs[0] ? mt.getSelectedMessages(tabs[0].id) : null;
    }]);
  }

  const tried = [];
  for (const [label, fn] of attempts) {
    try {
      const result = await fn();
      const found = unwrapMessageList(result);
      if (found) {
        const all = Array.isArray(result) ? result
                  : Array.isArray(result?.messages) ? result.messages
                  : [found];
        report("debug", `message found via ${label} (${all.length} selected)`);
        return { message: found, ids: all.map((m) => m.id) };
      }
      tried.push(`${label}: none`);
    } catch (e) {
      tried.push(`${label}: ${e.message}`);
    }
  }

  report("warn", "no message found. " + tried.join(" | "));
  return { message: null, ids: [] };
}

/** Send a line to the background diagnostics, so popup failures reach the report. */
function report(level, text) {
  browser.runtime.sendMessage({ type: "logFromUi", payload: { level, text } }).catch(() => {});
}

async function init() {
  // Show the window first and fill it in as answers arrive. Nothing here may
  // block on the CRM or on a mailbox-wide search: the popup used to wait about
  // two seconds for conversation discovery before it drew anything at all.
  showView("main");
  setSearching("Reading message…");

  try {
    const status = await call("getStatus");
    if (status.state !== "signed_in") return showAuthPrompt(status);

    const selection = await getDisplayedMessage();
    const message = selection.message;
    state.selectedIds = selection.ids;
    if (!message) {
      return showAuthPromptCustom(
        "No message selected",
        "Select a message in the list, or open one, then click the SuiteCRM button. " +
        "If a message is selected and you still see this, turn on \u201cRecord a detailed " +
        "log\u201d in settings and try again \u2014 the report will say which lookup failed."
      );
    }

    state.messageId = message.id;
    state.prepared = await call("prepareMessage", { messageId: message.id });

    if (state.prepared.blockedByAccount) {
      return state.prepared.noneEnabled
        ? showAuthPromptCustom(
            "No accounts are enabled",
            "Every mail account is switched off for filing. Tick the ones you want " +
            "under Mail accounts in the add-on's settings.")
        : showAuthPromptCustom(
            "This account is not enabled",
            `Filing is switched off for "${state.prepared.accountName}". ` +
            `Enable it under Mail accounts in the add-on's settings.`);
    }

    renderMessageHeader();
    await renderFooterOptions();

    const primary = state.prepared.candidates.primary;
    if (!primary) return renderNoSender();

    // Fire the CRM lookup and the conversation scan side by side; neither blocks
    // the other, and the window is already on screen for both.
    loadThreadInfo();
    await selectAddress(primary.email, primary.name);
  } catch (e) {
    report("error", `popup init failed: ${e.message}`);
    if (e.needsLogin) return showAuthPrompt({ state: "signed_out" }, e.message);
    $("results").textContent = "";
    setStatus($("status"), e.message, "error");
  }
}

/** Conversation discovery is slow, so it arrives after the window is usable. */
async function loadThreadInfo() {
  try {
    const info = await call("getThreadInfo", { messageId: state.messageId });
    state.threadCount = info.threadCount || 1;
    if (state.threadCount > 1) {
      $("thread-opt").hidden = false;
      $("thread-count").textContent = `(${state.threadCount} messages)`;
      updateArchiveLabel();
    }
  } catch (e) {
    report("warn", `thread lookup failed: ${e.message}`);
  }
}

/** A skeleton with a moving highlight, so a slow lookup still looks alive. */
function setSearching(label) {
  const box = $("results");
  box.textContent = "";
  const wrap = el("div", "searching");
  const head = el("div", "searching-head");
  head.append(el("span", "spinner-sm"), el("span", null, label));
  wrap.appendChild(head);
  for (let i = 0; i < 3; i++) wrap.appendChild(el("div", "skeleton-row"));
  box.appendChild(wrap);
}

function showAuthPrompt(status, extra = "") {
  const unconfigured = status.state === "unconfigured";
  showAuthPromptCustom(
    unconfigured ? "Connect to SuiteCRM" : "Sign in again",
    extra || (unconfigured
      ? "Set your CRM address and sign in once. After that the add-on keeps itself signed in."
      : "Your session could not be renewed. This happens if the add-on went unused for over a month.")
  );
}

function showAuthPromptCustom(title, text) {
  $("auth-title").textContent = title;
  $("auth-text").textContent = text;
  showView("auth");
  setLoading(false);
}

function renderMessageHeader() {
  const p = state.prepared;
  state.subjectOverride = null;
  $("subject-edit").hidden = true;
  $("msg-subject").hidden = false;
  $("msg-subject").classList.remove("is-edited");
  $("msg-subject").textContent = p.subject || "(no subject)";
  const when = p.date ? new Date(p.date).toLocaleString() : "";
  const bits = [when];
  if (p.attachmentCount) bits.push(`${p.attachmentCount} attachment${p.attachmentCount > 1 ? "s" : ""}`);
  if (p.hasVCard) bits.push("vCard attached");
  $("msg-meta").textContent = bits.filter(Boolean).join(" · ");
}

async function renderFooterOptions() {
  const prefs = await call("getPrefs");

  // The date choice is a setting, but it is also a per-message decision, so it
  // is offered here as well and starts from whatever the setting says.
  state.useOriginalDate = prefs.useOriginalDate !== false;
  $("chk-date").checked = state.useOriginalDate;
  $("chk-date").addEventListener("change", (e) => {
    state.useOriginalDate = e.target.checked;
    call("setPrefs", { useOriginalDate: e.target.checked }).catch(() => {});
  });
  // A follow-up on the archive action itself, which is the habitual pattern:
  // file it, then chase it. The full form is still there for anything richer.
  $("followup-days").disabled = true;
  $("chk-followup").addEventListener("change", (e) => {
    state.followUp = e.target.checked;
    $("followup-days").disabled = !e.target.checked;
  });

  const sent = state.prepared?.date ? new Date(state.prepared.date) : null;
  if (sent && !Number.isNaN(sent.getTime())) {
    $("date-hint").textContent = `(${sent.toLocaleDateString()})`;
  }

  $("chk-attachments").checked = prefs.archiveAttachments;
  const n = state.prepared.attachmentCount;
  $("att-count").textContent = n ? `(${n})` : "(none)";
  $("chk-attachments").disabled = !n;
  $("chk-attachments").addEventListener("change", (e) => {
    call("setPrefs", { archiveAttachments: e.target.checked }).catch(() => {});
  });

  // Several messages ticked in the list: archive them all, which is what the
  // add-on this replaces did (its only multi-message mode).
  const picked = state.selectedIds.length;
  if (picked > 1) {
    $("selection-opt").hidden = false;
    $("selection-count").textContent = `(${picked} selected)`;
    $("chk-selection").addEventListener("change", (e) => {
      state.archiveSelection = e.target.checked;
      if (e.target.checked) { state.wholeThread = false; $("chk-thread").checked = false; }
      updateArchiveLabel();
    });
  }

  // The thread checkbox is revealed by loadThreadInfo() once the scan finishes.
  state.wholeThread = Boolean(prefs.archiveWholeThread);
  $("chk-thread").checked = state.wholeThread;
  $("chk-thread").addEventListener("change", (e) => {
    state.wholeThread = e.target.checked;
    if (e.target.checked) { state.archiveSelection = false; $("chk-selection").checked = false; }
    updateArchiveLabel();
    call("setPrefs", { archiveWholeThread: e.target.checked }).catch(() => {});
  });
}

function updateArchiveLabel() {
  const btn = $("btn-archive");
  if (btn.disabled) return;
  const total = state.threadCount || 1;
  const target = state.selected ? (MODULE_LABEL[state.selected.type] || state.selected.type) : "";

  let n = 0;
  if (state.archiveSelection) n = state.selectedIds.length;
  else if (state.wholeThread && total > 1) n = total;

  btn.textContent = n > 1 ? `File ${n} messages under ${target}` : `File under ${target}`;
}

// ---------------------------------------------------------------------------
// Address selection
// ---------------------------------------------------------------------------

function renderAddressBar() {
  const c = state.prepared.candidates;
  const all = [c.primary, ...c.sameDomain, ...c.otherDomain].filter(Boolean);
  const active = all.find((a) => a.email === state.activeEmail) || c.primary;

  $("addr-name").textContent = active?.name || active?.email || "";
  $("addr-email").textContent = active?.name ? active.email : "";

  const label = document.querySelector(".addr-current .label");
  if (label) {
    label.textContent = c.sentByMe && active === c.primary
      ? "Filing for (recipient of your message)"
      : "Filing for";
  }

  // Only offer the switch when there is somebody to switch to.
  const switchable = c.sameDomain.length + (c.otherDomain.length ? 1 : 0);
  $("btn-change-addr").hidden = switchable === 0;
  if (c.sameDomain.length) {
    $("btn-change-addr").textContent = `Change (${c.sameDomain.length})`;
  }
}

function renderAddressPicker() {
  const c = state.prepared.candidates;
  const box = $("addr-options");
  box.textContent = "";

  const showOther = $("chk-other-domains").checked;
  const groups = [
    {
      label: c.sentByMe ? "Recipient (you sent this)" : "Sender",
      items: c.primary ? [c.primary] : [],
    },
    { label: `Also on ${c.senderDomain}`, items: c.sameDomain },
  ];
  if (showOther) groups.push({ label: "Other domains", items: c.otherDomain });

  for (const g of groups) {
    if (!g.items.length) continue;
    box.appendChild(el("div", "mod-head", g.label));
    for (const item of g.items) box.appendChild(addressOption(item));
  }

  $("picker-hint").textContent = c.groupable
    ? `To: first, then Cc:. Colleagues are grouped by ${c.senderDomain}.`
    : `${c.senderDomain} is a consumer domain, so people on it are not grouped as colleagues.`;

  $("other-domain-toggle").hidden = c.otherDomain.length === 0;
}

function addressOption(item) {
  const btn = el("button", "addr-opt");
  btn.classList.toggle("is-active", item.email === state.activeEmail);

  const who = el("div", "who");
  who.appendChild(el("b", null, item.name || item.email));
  if (item.name) who.appendChild(el("span", null, item.email));
  btn.appendChild(who);

  if (item.role && item.role !== "from") btn.appendChild(el("span", "role-tag", item.role));

  const tag = el("span", "crm-tag");
  tag.dataset.email = item.email;
  tag.textContent = "…";
  btn.appendChild(tag);

  btn.addEventListener("click", async () => {
    $("addr-picker").hidden = true;
    await selectAddress(item.email, item.name);
  });
  return btn;
}

/** Annotate the picker with how many CRM records each address already has. */
async function annotatePickerCounts() {
  try {
    const counts = await call("lookupOthers", { messageId: state.messageId });
    for (const tag of document.querySelectorAll(".crm-tag")) {
      const n = counts[tag.dataset.email];
      if (n === undefined) { tag.remove(); continue; }
      tag.textContent = n > 0 ? `${n} in CRM` : "not in CRM";
      tag.style.opacity = n > 0 ? "1" : ".55";
    }
  } catch {
    for (const tag of document.querySelectorAll(".crm-tag")) tag.remove();
  }
}

async function selectAddress(email, name) {
  state.activeEmail = email;
  state.activeName = name || null;
  state.searchTerm = "";
  if ($("crm-search").value && email) { $("crm-search").value = ""; $("btn-search-clear").hidden = true; }
  state.selected = null;
  state.alsoLink = [];
  $("btn-archive").disabled = true;
  renderAddressBar();
  setStatus($("status"), "");

  setSearching(`Searching SuiteCRM for ${email}…`);

  try {
    // Both are CRM requests and neither answer depends on the other, so
    // serialising them would show a slower window for no reason.
    const [lookup, memory, caseHit] = await Promise.all([
      call("lookupAddress", { email }),
      call("recallTarget", { email }).catch(() => null),
      (state.prepared?.caseRef || state.prepared?.caseRefs?.length)
        ? call("lookupCase", {
            number: state.prepared.caseRef,
            references: state.prepared.caseRefs || [],
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    state.lookup = lookup;
    state.lastTarget = memory?.target || null;
    state.caseHit = caseHit?.found || null;
    state.caseVia = caseHit?.via || null;
    renderResults();
  } catch (e) {
    $("results").textContent = "";
    if (e.needsLogin) return showAuthPrompt({ state: "signed_out" }, e.message);
    setStatus($("status"), e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * The Case the subject referred to.
 *
 * Its own group rather than mixed into the address hits, and labelled with
 * where it came from. The user needs to know this was matched on the subject
 * line and not on who wrote the message, because that is what makes it
 * trustworthy on a reply and worth ignoring on a forwarded thread.
 */
function renderCaseRef(rec) {
  const wrap = el("div", "mod-group case-ref");
  const head = el("div", "mod-head");
  // Where the match came from, because the two are worth telling apart: a
  // subject number is SuiteCRM's own marker, while a reference chain match
  // means the subject had lost it and the thread was followed instead.
  head.textContent = state.caseVia === "references"
    ? `Case #${rec.case_number}, from the reply chain`
    : `Case #${rec.case_number}, from the subject line`;
  wrap.appendChild(head);

  const card = el("div", "rec");
  card.dataset.key = `Cases:${rec.id}`;
  card.appendChild(el("div", "rec-name", rec.name || `Case ${rec.case_number}`));

  const bits = [rec.status, rec.priority, rec.account_name].filter(Boolean);
  if (bits.length) card.appendChild(el("div", "rec-sub", bits.join(" \u00b7 ")));

  card.addEventListener("click", () => selectRecord({ ...rec, module: "Cases" }));
  wrap.appendChild(card);
  return wrap;
}

function renderResults() {
  const box = $("results");
  box.textContent = "";
  const r = state.lookup;

  // A Case named in the subject goes first and is pre-selected. For a reply to
  // case mail this is the answer, and it is available even when the sender
  // matches no CRM record at all.
  if (state.caseHit) box.appendChild(renderCaseRef(state.caseHit));

  if (r.failures.length) {
    // The name the settings page uses, not SuiteCRM's internal one: a warning
    // about "Prospects" sends people looking for a module they do not have.
    const names = r.failures.map((f) => f.title || moduleTitle(f.module)).join(", ");
    const off = r.failures.some((f) => f.disabled);
    setStatus($("status"), off
      ? `${names} could not be searched, so it has been turned off in Preferences, where the reason is shown. Everything else was searched normally.`
      : `Could not search ${names}. Other modules were searched normally.`, "warn");
  }

  if (!r.found) return state.searchTerm ? renderNoSearchHits() : renderNotFound();

  // With thirty contacts on one domain the list is just long; let the user narrow it.
  const totalHits = Object.values(r.hits).reduce((n, recs) => n + recs.length, 0);
  if (totalHits > 6) box.appendChild(renderFilterRow(totalHits));

  for (const [module, records] of Object.entries(r.hits)) {
    const group = el("div", "mod-group");
    const head = el("div", "mod-head");
    head.appendChild(el("span", null, MODULE_LABEL[module] || module));
    head.appendChild(el("span", "muted", String(records.length)));
    group.appendChild(head);
    for (const rec of records) group.appendChild(recordCard({ ...rec, module }));
    box.appendChild(group);
  }

  const flat = Object.entries(r.hits).flatMap(([m, recs]) => recs.map((x) => ({ ...x, module: m })));
  if (state.searchTerm) return;

  // A Case named in the subject outranks both rules below. Those infer a
  // destination from who sent the message; this one reads it off the message
  // itself, which is stronger evidence and the whole point of matching it.
  if (state.caseHit) {
    selectRecord({ ...state.caseHit, module: "Cases" });
    setStatus($("status"),
      state.caseVia === "references"
        ? `Pre-selected Case #${state.caseHit.case_number}, from the thread this reply belongs to.`
        : `Pre-selected Case #${state.caseHit.case_number}, referenced in the subject.`, "info");
    return;
  }

  // Mail from the same person usually goes to the same record. Prefer what was
  // chosen last time over the first match, and say so rather than silently
  // picking something different from what is on screen.
  const remembered = state.lastTarget
    ? flat.find((x) => x.module === state.lastTarget.type && x.id === state.lastTarget.id)
    : null;

  if (remembered) {
    selectRecord(remembered, { remembered: true });
    setStatus($("status"), `Pre-selected: where you filed the last email from ${state.activeEmail}.`, "info");
  } else if (flat.length === 1) {
    selectRecord(flat[0]);
  }
}

function renderFilterRow(total) {
  const row = el("div", "filter-row");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Filter these matches…";
  input.value = state.pickerFilter || "";
  const count = el("span", "muted", `${total} matches`);

  const apply = () => {
    const term = input.value.trim().toLowerCase();
    state.pickerFilter = term;
    let shown = 0;
    for (const card of document.querySelectorAll(".rec")) {
      const hit = !term || card.textContent.toLowerCase().includes(term);
      card.hidden = !hit;
      if (hit) shown++;
    }
    // Hide a module heading whose records have all been filtered out.
    for (const group of document.querySelectorAll(".mod-group")) {
      const any = [...group.querySelectorAll(".rec")].some((c) => !c.hidden);
      group.hidden = !any;
    }
    count.textContent = term ? `${shown} of ${total}` : `${total} matches`;
  };

  input.addEventListener("input", apply);
  row.append(input, count);
  // Apply once so a filter survives a re-render.
  setTimeout(apply, 0);
  return row;
}

function renderNoSearchHits() {
  const wrap = el("div", "notfound");
  wrap.appendChild(el("p", "muted", `Nothing in SuiteCRM matches “${state.searchTerm}”.`));
  wrap.appendChild(el("p", "muted small", "Try a surname, or part of a company name."));
  $("results").appendChild(wrap);
}

// --- manual search ---------------------------------------------------------

let searchTimer = null;

async function runSearch(text) {
  const term = text.trim();
  state.searchTerm = term;
  state.selected = null;
  $("btn-archive").disabled = true;
  $("btn-search-clear").hidden = !term;

  if (!term) return selectAddress(state.activeEmail, state.activeName);   // back to the sender
  if (term.length < 2) return;

  setSearching(`Searching SuiteCRM for “${term}”…`);
  try {
    state.lookup = await call("searchCrm", { text: term });
    state.lookup.accountsByDomain = [];
    renderResults();
  } catch (e) {
    $("results").textContent = "";
    setStatus($("status"), e.message, "error");
  }
}

$("crm-search").addEventListener("input", (e) => {
  const value = e.target.value;
  clearTimeout(searchTimer);
  // Typing a name should not fire a request per keystroke.
  searchTimer = setTimeout(() => runSearch(value), 300);
});

$("btn-search-clear").addEventListener("click", () => {
  $("crm-search").value = "";
  runSearch("");
});

function recordCard(rec) {
  const card = el("div", "rec");
  card.dataset.key = `${rec.module}:${rec.id}`;

  const main = el("button", "rec-main");
  const check = el("span", "rec-check", "✓");
  const body = el("div", "rec-body");
  body.appendChild(el("div", "rec-title", recordLabel(rec)));
  const sub = recordSubtitle(rec);
  if (sub) body.appendChild(el("div", "rec-sub", sub));

  // Owner and age decide between two otherwise identical matches.
  const owner = recordOwner(rec);
  const age = timeAgo(rec.date_modified);
  if (owner || age) {
    const foot = el("div", "rec-foot");
    if (owner) foot.appendChild(el("span", "rec-owner", owner));
    if (age) foot.appendChild(el("span", "rec-age", age));
    body.appendChild(foot);
  }
  main.append(check, body);
  main.addEventListener("click", () => selectRecord(rec));
  card.appendChild(main);

  // Sometimes you only want to look at the Account, not file anything.
  const open = el("button", "rec-open", "Open");
  open.title = `Open this ${MODULE_LABEL[rec.module] || rec.module} in SuiteCRM`;
  open.addEventListener("click", (e) => {
    e.stopPropagation();
    call("openRecord", { module: rec.module, id: rec.id });
  });
  main.appendChild(open);

  // Lazy expansion into Opportunities / Quotes / Cases / Projects.
  if (rec.module === "Contacts" || rec.module === "Accounts") {
    const expand = el("button", "rec-expand", "Show linked records…");
    const holder = el("div", "rec-related");
    holder.hidden = true;
    expand.addEventListener("click", async () => {
      if (holder.dataset.loaded) {
        holder.hidden = !holder.hidden;
        expand.textContent = holder.hidden ? "Show linked records…" : "Hide linked records";
        return;
      }
      expand.textContent = "Loading…";
      try {
        const related = await call("expandRecord", { record: rec });
        holder.textContent = "";
        const entries = Object.entries(related);
        if (!entries.length) {
          expand.textContent = "No linked records";
          expand.disabled = true;
          return;
        }
        for (const [module, recs] of entries) {
          for (const r of recs) holder.appendChild(relatedItem({ ...r, module }));
        }
        holder.dataset.loaded = "1";
        holder.hidden = false;
        expand.textContent = "Hide linked records";
      } catch {
        expand.textContent = "Could not load linked records";
        expand.disabled = true;
      }
    });
    card.append(expand, holder);
  }
  return card;
}

function relatedItem(rec) {
  const btn = el("button", "rel-item");
  btn.dataset.key = `${rec.module}:${rec.id}`;
  btn.appendChild(el("span", "rel-mod", MODULE_LABEL[rec.module] || rec.module));
  btn.appendChild(el("span", null, recordLabel(rec)));
  btn.addEventListener("click", () => selectRecord(rec));
  return btn;
}

function selectRecord(rec, { remembered = false } = {}) {
  state.selected = { type: rec.module, id: rec.id, label: recordLabel(rec) };
  state.selectedWasRemembered = remembered;
  const key = `${rec.module}:${rec.id}`;

  for (const n of document.querySelectorAll(".rec")) n.classList.toggle("is-selected", n.dataset.key === key);
  for (const n of document.querySelectorAll(".rel-item")) n.classList.toggle("is-selected", n.dataset.key === key);

  $("btn-archive").disabled = false;
  $("btn-create-record").disabled = false;
  state.selectedAccountId = rec.account_id || (rec.module === "Accounts" ? rec.id : null);
  updateArchiveLabel();
}

function renderNotFound() {
  const box = $("results");
  const wrap = el("div", "notfound");
  wrap.appendChild(el("p", "muted", `${state.activeEmail} is not in SuiteCRM.`));

  const actions = el("div", "foot-actions");
  const lead = el("button", "btn btn-primary", "Create Lead");
  lead.addEventListener("click", () => openCreate("Leads"));
  const contact = el("button", "btn", "Create Contact");
  contact.addEventListener("click", () => openCreate("Contacts"));
  actions.append(lead, contact);
  wrap.appendChild(actions);

  const hint = el("p", "muted small",
    "Or search above by name or company. Useful when someone writes from a personal address.");
  wrap.appendChild(hint);

  if (state.lookup.accountsByDomain?.length) {
    const n = state.lookup.accountsByDomain.length;
    wrap.appendChild(el("p", "muted small",
      `${n} Account${n > 1 ? "s" : ""} on this domain already exist${n > 1 ? "" : "s"}, a new Contact can be linked to one.`));
  }
  box.appendChild(wrap);
}

/**
 * What was archived lately, so "did I already file that?" is answerable here
 * rather than by switching to the CRM.
 */
async function renderRecent() {
  const box = $("recent-list");
  try {
    const { entries } = await call("recentArchives");
    box.textContent = "";
    if (!entries.length) {
      box.appendChild(el("div", "muted small", "Nothing filed yet in this session."));
      return;
    }
    for (const e of entries) {
      const row = el("button", "recent-row");
      const body = el("div", "rec-body");
      body.appendChild(el("div", "recent-subject", e.subject || "(no subject)"));
      body.appendChild(el("div", "rec-sub",
        `${MODULE_LABEL[e.module] || e.module} · ${e.label} · ${timeAgo(e.at)}`));
      row.appendChild(body);
      row.addEventListener("click", () => call("openRecord", { module: e.module, id: e.id }));
      box.appendChild(row);
    }
  } catch (e) {
    box.textContent = "";
    box.appendChild(el("div", "muted small", `Could not read what was filed recently: ${e.message}`));
  }
}

$("btn-recent").addEventListener("click", () => {
  const panel = $("recent");
  panel.hidden = !panel.hidden;
  $("btn-recent").textContent = panel.hidden ? "Recently filed" : "Hide recent";
  if (!panel.hidden) renderRecent();
});

function renderNoSender() {
  $("results").appendChild(el("div", "muted small", "This message has no usable sender address."));
}

// ---------------------------------------------------------------------------
// Create Lead / Contact
// ---------------------------------------------------------------------------

const FORM_FIELDS = [
  "first_name", "last_name", "title", "email1",
  "phone_work", "phone_mobile", "phone_other", "phone_fax",
  "website", "account_name", "primary_address_street", "primary_address_postalcode",
  "primary_address_city", "primary_address_country",
];

async function openCreate(kind) {
  state.createKind = kind;
  showView("create");
  setLoading(true, "Reading the signature…");
  try {
    state.proposal = await call("proposeContact", {
      messageId: state.messageId,
      email: state.activeEmail,
      name: state.activeName,
    });
    renderCreateForm();
    checkForDuplicates();
  } catch (e) {
    setStatus($("create-status"), e.message, "error");
  } finally {
    setLoading(false);
  }
}

function renderCreateForm() {
  const { fields, confidence, signatureBlock, source, needsReview, accountsByDomain } = state.proposal;

  for (const btn of document.querySelectorAll("#create-kind .seg-btn")) {
    btn.classList.toggle("is-active", btn.dataset.kind === state.createKind);
  }
  $("create-title").textContent = state.createKind === "Leads" ? "New Lead" : "New Contact";

  const sourceText = {
    "vcard": "Pre-filled from the attached vCard.",
    "signature-delimited": "Pre-filled from the sender's signature block.",
    "signature-heuristic": "Pre-filled from the end of the message. Confirm the guessed fields.",
    "headers-only": "No signature found; only the address is known.",
    "colleague-of-sender":
      "This person was copied on the message, so only company details were taken " +
      "from the sender's signature, the job title and phone numbers are the sender's.",
  }[source] || "";
  $("create-source").textContent = sourceText;

  for (const key of FORM_FIELDS) {
    const input = $(`f-${key}`);
    if (!input) continue;
    input.value = fields[key] || "";
    const wrap = input.closest(".field");
    if (wrap) wrap.classList.toggle("needs-review", Boolean(fields[key]) && confidence[key] !== "high");
  }

  const reviewCount = needsReview.filter((k) => FORM_FIELDS.includes(k)).length;
  $("review-hint").textContent = reviewCount
    ? `${reviewCount} field${reviewCount > 1 ? "s" : ""} were guessed, confirm before saving`
    : "";

  const note = $("website-note");
  note.className = "field-note";
  note.textContent = confidence.website === "low" && fields.website
    ? "Guessed from the email domain. Check it before saving, or correct it."
    : "";

  $("sig-block").textContent = signatureBlock || "(none found)";
  $("sig-block-wrap").hidden = !signatureBlock;

  // Contacts have no `website` field in SuiteCRM; Leads do. Hide it rather than
  // sending something the module will reject.
  const websiteField = $("f-website").closest(".field");
  if (websiteField) websiteField.hidden = state.createKind === "Contacts";

  // Contacts hang off an Account; Leads carry the company name inline.
  $("account-block").hidden = false;
  renderAccountSuggestions(accountsByDomain || []);

  $("account-note").textContent = state.createKind === "Contacts"
    ? "A Contact needs an Account. Pick an existing one, or a new Account is created with this name."
    : "Stored on the Lead as the company name.";
}

function renderAccountSuggestions(accounts) {
  const box = $("account-suggestions");
  box.textContent = "";
  state.chosenAccountId = null;
  if (!accounts.length || state.createKind !== "Contacts") return;

  box.appendChild(el("div", "muted small", "Existing Accounts on this domain:"));
  for (const a of accounts) {
    const btn = el("button", "acct-sugg");
    const body = el("div", "rec-body");
    body.appendChild(el("div", "rec-title", a.name || "(unnamed)"));
    const sub = recordSubtitle({ ...a, module: "Accounts" });
    if (sub) body.appendChild(el("div", "rec-sub", sub));
    btn.appendChild(body);
    btn.addEventListener("click", () => {
      const already = state.chosenAccountId === a.id;
      state.chosenAccountId = already ? null : a.id;
      for (const n of box.querySelectorAll(".acct-sugg")) n.classList.remove("is-active");
      if (!already) {
        btn.classList.add("is-active");
        $("f-account_name").value = a.name || "";
      }
      $("account-note").textContent = state.chosenAccountId
        ? "The Contact will be linked to this existing Account."
        : "A new Account will be created with the name above.";
    });
    box.appendChild(btn);
  }
}

function collectForm() {
  const out = {};
  for (const key of FORM_FIELDS) {
    const input = $(`f-${key}`);
    if (input && input.value.trim()) out[key] = input.value.trim();
  }
  return out;
}

/**
 * Look for the same person under another address before creating a second one.
 * Runs when the create form opens, so the warning is there before the click.
 */
async function checkForDuplicates() {
  const box = $("dupes");
  box.hidden = true;
  if (state.createKind !== "Contacts") return;

  const form = collectForm();
  if (!form.first_name && !form.last_name) return;

  try {
    const { candidates } = await call("findDuplicates", {
      person: form,
      accountId: state.chosenAccountId,
    });
    if (!candidates.length) return;

    const list = $("dupes-list");
    list.textContent = "";
    for (const c of candidates) {
      const btn = el("button", "dupe");
      const body = el("div", "dupe-body");
      body.appendChild(el("div", "dupe-name", c.name));
      const sub = [c.title, c.account_name, c.email1].filter(Boolean).join(" · ");
      if (sub) body.appendChild(el("div", "dupe-sub", sub));
      btn.appendChild(body);
      btn.appendChild(el("span", "dupe-score", c.sameAddress ? "same address" : `${c.score}% match`));

      btn.addEventListener("click", () => useExistingRecord(c, form.email1));
      list.appendChild(btn);
    }
    box.hidden = false;
  } catch (e) {
    report("debug", `duplicate check failed: ${e.message}`);
  }
}

/** Use the record that already exists, adding this address to it. */
async function useExistingRecord(candidate, email) {
  setLoading(true, "Updating the existing record…");
  try {
    if (email && !candidate.sameAddress) {
      await call("addAddressToRecord", { module: candidate.module, id: candidate.id, email });
    }
    state.selected = { type: candidate.module, id: candidate.id, label: candidate.name };
    await doArchive();
  } catch (e) {
    setLoading(false);
    setStatus($("create-status"), e.message, "error");
  }
}

async function doCreate() {
  const form = collectForm();
  if (!form.last_name && !form.first_name) {
    return setStatus($("create-status"), "A first or last name is required.", "error");
  }
  // SuiteCRM requires last_name on both Leads and Contacts.
  if (!form.last_name) { form.last_name = form.first_name; delete form.first_name; }

  setLoading(true, "Creating the record…");
  try {
    let created;
    if (state.createKind === "Contacts") {
      const { account_name, ...contact } = form;
      const res = await call("createContactWithAccount", {
        contact,
        account: state.chosenAccountId ? null : (account_name ? { name: account_name } : null),
        accountId: state.chosenAccountId,
      });
      created = { module: "Contacts", ...res.contact };
    } else {
      created = await call("createRecord", { module: "Leads", attributes: form });
      created.module = "Leads";
    }

    state.selected = {
      type: created.module,
      id: created.id,
      label: recordLabel(created) || form.last_name,
    };
    await doArchive();
  } catch (e) {
    setLoading(false);
    if (e.needsLogin) return showAuthPrompt({ state: "signed_out" }, e.message);
    setStatus($("create-status"), e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

const CONFIRM_ABOVE = 10;

async function doArchive() {
  if (!state.selected) return;

  // A big archive is slow and hard to unpick, so ask once, and say what it
  // actually involves, since "40 messages" and "40 messages with 96
  // attachments" are different propositions.
  const count = state.archiveSelection ? state.selectedIds.length
              : state.wholeThread ? (state.threadCount || 1)
              : 1;

  if (count > CONFIRM_ABOVE && !state.confirmedBulk) {
    const atts = $("chk-attachments").checked
      ? " Attachments will be uploaded for each one."
      : "";
    const ok = confirm(
      `File ${count} messages under ${state.selected.label}?` + atts +
      "\n\nThis can take a while, and only the last message can be undone."
    );
    if (!ok) return;
    state.confirmedBulk = true;
  }

  setLoading(true, "Filing…");
  try {
    if (state.activeEmail && state.selected) {
      call("rememberTarget", { email: state.activeEmail, target: state.selected }).catch(() => {});
    }
    const res = await call("archive", {
      messageId: state.messageId,
      parent: state.selected,
      alsoLink: state.alsoLink,
      wholeThread: state.wholeThread,
      messageIds: state.archiveSelection ? state.selectedIds : null,
      useOriginalDate: state.useOriginalDate,
      followUpDays: state.followUp ? Number($("followup-days").value) || 3 : null,
      subject: state.subjectOverride,
    });
    renderDone(res);
  } catch (e) {
    setLoading(false);
    if (e.needsLogin) return showAuthPrompt({ state: "signed_out" }, e.message);
    const node = $("view-create").hidden ? $("status") : $("create-status");
    setStatus(node, e.message, "error");
  } finally {
    setLoading(false);
  }
}

function renderDone(res) {
  showView("done");
  $("btn-open-record").hidden = false;
  $("done-title").textContent = res.updated ? "Re-filed" : "Filed";

  const bits = [];
  if (res.recordKind) {
    $("done-title").textContent = `${MODULE_LABEL[res.recordKind] || res.recordKind} created`;
    bits.push(`${state.selected.label} is now in SuiteCRM.`);
    if (res.canUndo) bits.push("This email was filed against it.");
    $("done-text").textContent = bits.join(" ");
    const warn = $("done-warnings");
    warn.textContent = "";
    for (const w of res.warnings) warn.appendChild(el("li", null, w));
    $("btn-undo").hidden = !res.canUndo;
    $("btn-open-record").onclick = () =>
      call("openRecord", { module: state.selected.type, id: state.selected.id }).then(() => window.close());
    return;
  }
  if (res.thread) {
    $("done-title").textContent = res.thread.mode === "selection"
      ? "Selected messages filed" : "Conversation filed";
    bits.push(`${res.thread.archived} of ${res.thread.total} messages filed under ${state.selected.label}.`);
    if (res.thread.skipped) bits.push(`${res.thread.skipped} could not be filed.`);
  } else {
    bits.push(res.updated
      ? `This email was already in SuiteCRM; it now also sits under ${state.selected.label}.`
      : `Filed under ${state.selected.label}.`);
  }
  if (res.attachments.length) {
    bits.push(`${res.attachments.length} attachment${res.attachments.length > 1 ? "s" : ""} stored.`);
  }
  if (res.followUp) bits.push(`Follow-up task due ${res.followUp.due}.`);
  $("done-text").textContent = bits.join(" ");

  const warn = $("done-warnings");
  warn.textContent = "";
  for (const w of res.warnings) warn.appendChild(el("li", null, w));

  $("btn-open-record").onclick = () =>
    call("openRecord", { module: state.selected.type, id: state.selected.id }).then(() => window.close());

  $("btn-undo").hidden = !res.canUndo;
}

/**
 * Undo is offered while the window is open and no longer. It deletes only what
 * the archive created, an email that was already in the CRM is put back where
 * it was filed, never deleted.
 */
$("btn-undo").addEventListener("click", async () => {
  const btn = $("btn-undo");
  const note = $("undo-status");
  btn.disabled = true;
  note.hidden = false;
  note.className = "status is-info";
  note.textContent = "Undoing…";

  try {
    const r = await call("undoLastArchive");
    const bits = [];
    if (r.removed) bits.push(`${r.removed} record${r.removed === 1 ? "" : "s"} deleted`);
    if (r.restored) bits.push(`${r.restored} put back where ${r.restored === 1 ? "it was" : "they were"}`);
    note.className = r.problems.length ? "status is-warn" : "status is-info";
    note.textContent = (bits.join(", ") || "Nothing needed undoing") +
      (r.problems.length ? `. ${r.problems.join(" ")}` : ".");
    btn.hidden = true;
    $("done-title").textContent = "Filing undone";
    $("btn-open-record").hidden = true;
  } catch (e) {
    note.className = "status is-error";
    note.textContent = e.message;
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$("btn-open-options").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

$("btn-change-addr").addEventListener("click", async () => {
  const picker = $("addr-picker");
  picker.hidden = !picker.hidden;
  if (!picker.hidden) {
    renderAddressPicker();
    annotatePickerCounts();
  }
});
$("btn-close-picker").addEventListener("click", () => { $("addr-picker").hidden = true; });
$("chk-other-domains").addEventListener("change", () => { renderAddressPicker(); annotatePickerCounts(); });

// Editing the subject changes only what the CRM stores. The message in
// Thunderbird is never modified: this is for tidying "Re: Re: FW:" out of a
// record title, not for rewriting mail.
function showSubjectEditor() {
  $("in-subject").value = state.subjectOverride ?? state.prepared?.subject ?? "";
  $("msg-subject").hidden = true;
  $("subject-edit").hidden = false;
  $("in-subject").focus();
  $("in-subject").select();
}

function hideSubjectEditor() {
  $("subject-edit").hidden = true;
  $("msg-subject").hidden = false;
}

function commitSubject() {
  const typed = $("in-subject").value.trim();
  const original = (state.prepared?.subject || "").trim();

  // Only an actual change counts as an override, so clearing the field or
  // typing the original back restores the message's own subject.
  state.subjectOverride = typed && typed !== original ? typed : null;

  $("msg-subject").textContent = state.subjectOverride || original || "(no subject)";
  $("msg-subject").classList.toggle("is-edited", Boolean(state.subjectOverride));
  hideSubjectEditor();
}

$("msg-subject").addEventListener("click", showSubjectEditor);
$("btn-subject-done").addEventListener("click", commitSubject);
$("in-subject").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitSubject(); }
  if (e.key === "Escape") { e.preventDefault(); hideSubjectEditor(); }
});

// Strips the prefixes mail clients stack up, in any of the languages this
// add-on already handles and any number of times, so
// "Re: Sv: FW: Re: Quarterly review" becomes "Quarterly review".
$("btn-strip-re").addEventListener("click", () => {
  $("in-subject").value = $("in-subject").value
    .replace(/^(\s*(re|aw|sv|vs|fwd?|vb|antw|tr|rif)\s*:\s*)+/i, "")
    .trim();
  $("in-subject").focus();
});

$("btn-archive").addEventListener("click", doArchive);
$("btn-create").addEventListener("click", doCreate);
$("btn-back").addEventListener("click", () => showView("main"));
$("btn-close").addEventListener("click", () => window.close());

for (const btn of document.querySelectorAll("#create-kind .seg-btn")) {
  btn.addEventListener("click", () => {
    state.createKind = btn.dataset.kind;
    renderCreateForm();
    checkForDuplicates();
  });
}

init();


// ---------------------------------------------------------------------------
// Create a Case / Opportunity / Meeting / Task from this email
// ---------------------------------------------------------------------------

const RECORD_ROWS = {
  Cases:         [],
  Opportunities: ["row-opportunity", "row-stage"],
  Meetings:      ["row-meeting"],
  Tasks:         ["row-task"],
};

/** SuiteCRM stores "YYYY-MM-DD HH:MM:SS"; the input wants "YYYY-MM-DDTHH:MM". */
const toLocalInput = (crm) => String(crm || "").replace(" ", "T").slice(0, 16);
const fromLocalInput = (v) => (v ? v.replace("T", " ") + ":00" : "");

async function openRecordForm(kind) {
  const target = state.selected
    ? { ...state.selected, accountId: state.selectedAccountId || null }
    : null;

  // Only offer what SuiteCRM will actually link to this record. A hidden kind is
  // better than one that silently creates something attached to nobody under a
  // caption promising otherwise.
  const available = creatableFor(target);
  if (!available.includes(kind)) kind = available[0];

  state.recordKind = kind;
  showView("record");
  setStatus($("record-status"), "");

  for (const btn of document.querySelectorAll("#record-kind .seg-btn")) {
    const offered = available.includes(btn.dataset.kind);
    btn.hidden = !offered;
    btn.classList.toggle("is-active", offered && btn.dataset.kind === kind);
  }

  $("record-target").textContent = target
    ? `Linked to ${MODULE_LABEL[target.type] || target.type} · ${target.label}`
    : "No record selected, so it will not be linked to anyone.";

  const why = unavailableReason(target);
  $("record-unavailable").textContent = why;
  $("record-unavailable").hidden = !why;

  // Show only the fields this kind actually needs.
  for (const rows of Object.values(RECORD_ROWS)) {
    for (const id of rows) $(id).hidden = true;
  }
  for (const id of RECORD_ROWS[kind] || []) $(id).hidden = false;

  try {
    const { values, meta } = await call("recordDefaults", { messageId: state.messageId, kind });
    $("record-title").textContent = `New ${meta?.label || kind}`;
    $("record-blurb").textContent = meta?.blurb || "";
    $("btn-record-save").textContent = `Create ${meta?.label || kind}`;

    $("r-name").value = values.name || "";
    $("r-amount").value = values.amount ?? "";
    $("r-date_closed").value = values.date_closed || "";
    $("r-sales_stage").value = values.sales_stage || "";
    $("r-date_start").value = toLocalInput(values.date_start);
    $("r-duration_hours").value = values.duration_hours ?? "1";
    $("r-date_due").value = toLocalInput(values.date_due);

    $("record-hint").textContent = kind === "Opportunities"
      ? "Stage and amount are starting points. Adjust them in SuiteCRM."
      : "";
  } catch (e) {
    setStatus($("record-status"), e.message, "error");
  }
}

function collectRecordForm(kind) {
  const form = { name: $("r-name").value };
  if (kind === "Opportunities") {
    form.amount = $("r-amount").value;
    form.date_closed = $("r-date_closed").value;
    form.sales_stage = $("r-sales_stage").value;
  }
  if (kind === "Meetings") {
    form.date_start = fromLocalInput($("r-date_start").value);
    form.duration_hours = $("r-duration_hours").value;
  }
  if (kind === "Tasks") {
    form.date_due = fromLocalInput($("r-date_due").value);
  }
  return form;
}

$("btn-create-record").addEventListener("click", () => openRecordForm(state.recordKind || "Cases"));
$("btn-record-back").addEventListener("click", () => showView("main"));

for (const btn of document.querySelectorAll("#record-kind .seg-btn")) {
  btn.addEventListener("click", () => openRecordForm(btn.dataset.kind));
}

$("btn-record-save").addEventListener("click", async () => {
  const kind = state.recordKind;
  const form = collectRecordForm(kind);
  if (!form.name.trim()) {
    return setStatus($("record-status"), "Give the record a name.", "error");
  }

  setLoading(true, "Creating…");
  try {
    const res = await call("createFromEmail", {
      messageId: state.messageId,
      kind,
      form,
      parent: state.selected
        ? { ...state.selected, accountId: state.selectedAccountId || null }
        : null,
      archive: $("r-archive").checked,
    });

    state.selected = { type: res.module, id: res.id, label: res.label };
    renderDone({
      created: true,
      attachments: [],
      warnings: res.warnings || [],
      canUndo: Boolean(res.emailId),
      recordKind: kind,
    });
  } catch (e) {
    if (e.needsLogin) return showAuthPrompt({ state: "signed_out" }, e.message);
    setStatus($("record-status"), e.message, "error");
  } finally {
    setLoading(false);
  }
});
