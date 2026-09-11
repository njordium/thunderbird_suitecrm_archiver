/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * A strip injected above the message body showing who the sender is in the CRM.
 *
 * This is the passive half of the add-on: context without a click. It runs as a
 * message display script, so it lives in the message's own document and must not
 * assume anything about that page, hence its own namespaced class names, no
 * global styles, and everything built with createElement rather than innerHTML,
 * because the surrounding document is untrusted email content.
 */

const ROOT_ID = "suitecrm-archiver-banner";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function removeExisting() {
  document.getElementById(ROOT_ID)?.remove();
}

function styles() {
  const css = `
#${ROOT_ID} {
  --scb-line: #d9dee4; --scb-bg: #f6f8fa; --scb-fg: #1a222c; --scb-muted: #5d6874;
  --scb-accent: #0f7267; --scb-ok: #1c8b4f; --scb-warn: #8a6100;
  all: initial;
  display: block; box-sizing: border-box;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--scb-fg); background: var(--scb-bg);
  border-bottom: 1px solid var(--scb-line);
  padding: 8px 14px;
}
@media (prefers-color-scheme: dark) {
  #${ROOT_ID} {
    --scb-line: #333c47; --scb-bg: #232b34; --scb-fg: #e4e9ee; --scb-muted: #98a4b1;
    --scb-accent: #3fcdbc; --scb-ok: #48c98a; --scb-warn: #d7a344;
  }
}
#${ROOT_ID} .scb-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
#${ROOT_ID} .scb-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--scb-muted); }
#${ROOT_ID} .scb-dot.is-found { background: var(--scb-ok); }
#${ROOT_ID} .scb-dot.is-warn  { background: var(--scb-warn); }
#${ROOT_ID} .scb-who { font-weight: 600; }
#${ROOT_ID} .scb-meta { color: var(--scb-muted); }
#${ROOT_ID} .scb-sep { color: var(--scb-line); }
#${ROOT_ID} .scb-actions { margin-left: auto; display: flex; gap: 6px; }
#${ROOT_ID} button {
  all: unset; box-sizing: border-box; cursor: pointer;
  font: 600 12px/1 system-ui, sans-serif;
  padding: 5px 11px; border-radius: 4px;
  border: 1px solid var(--scb-accent); color: var(--scb-accent);
}
#${ROOT_ID} button.is-primary { background: var(--scb-accent); color: var(--scb-bg); }
#${ROOT_ID} button:focus-visible { outline: 2px solid var(--scb-accent); outline-offset: 2px; }
#${ROOT_ID} .scb-links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 5px; }
#${ROOT_ID} .scb-chip {
  font-size: 11.5px; color: var(--scb-muted);
  border: 1px solid var(--scb-line); border-radius: 3px; padding: 2px 7px;
}
#${ROOT_ID} .scb-chip b { color: var(--scb-fg); font-weight: 600; }
`;
  const style = el("style");
  style.textContent = css;
  return style;
}

function render(state) {
  removeExisting();

  const root = el("div");
  root.id = ROOT_ID;
  root.appendChild(styles());

  const row = el("div", "scb-row");
  const dot = el("span", "scb-dot");
  row.appendChild(dot);

  const who = el("span", "scb-who");
  row.appendChild(who);

  const meta = el("span", "scb-meta");
  row.appendChild(meta);

  const actions = el("div", "scb-actions");
  row.appendChild(actions);
  root.appendChild(row);

  if (state.status === "loading") {
    who.textContent = state.who || "Checking SuiteCRM…";
    meta.textContent = "";
  } else if (state.status === "error") {
    dot.classList.add("is-warn");
    who.textContent = state.who || "";
    meta.textContent = state.message || "SuiteCRM could not be reached";
  } else if (state.status === "found") {
    dot.classList.add("is-found");
    who.textContent = state.who;
    meta.textContent = state.summary;

    const open = el("button", null, "Open in SuiteCRM");
    open.addEventListener("click", () => {
      browser.runtime.sendMessage({ type: "openRecord", payload: state.top });
    });
    actions.appendChild(open);

    if (state.chips?.length) {
      const links = el("div", "scb-links");
      for (const c of state.chips) {
        const chip = el("span", "scb-chip");
        chip.appendChild(el("b", null, String(c.count)));
        chip.appendChild(document.createTextNode(" " + c.label));
        links.appendChild(chip);
      }
      root.appendChild(links);
    }
  } else {
    who.textContent = state.who;
    meta.textContent = "Not in SuiteCRM";
  }

  document.body?.insertBefore(root, document.body.firstChild);
  return root;
}

/** Ask the background for this message's CRM context and draw it. */
async function run() {
  try {
    const info = await browser.runtime.sendMessage({ type: "bannerContext" });
    if (!info?.ok || !info.result) return removeExisting();
    const r = info.result;
    if (r.hidden) return removeExisting();

    render({ status: "loading", who: r.who });
    const found = await browser.runtime.sendMessage({
      type: "bannerLookup",
      payload: { email: r.email },
    });

    if (!found?.ok) {
      return render({ status: "error", who: r.who, message: found?.error?.message });
    }
    render({ ...found.result, who: r.who });
  } catch {
    // A message view that cannot reach the background is not worth a broken banner.
    removeExisting();
  }
}

run();
