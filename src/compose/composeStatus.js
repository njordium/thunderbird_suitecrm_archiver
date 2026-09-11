/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Compose-window strip: who you are writing to, in CRM terms.
 *
 * Half of what belongs in a CRM is what you send. This shows whether the
 * recipient is already known before the message goes, which is the moment when
 * creating a Lead is cheap and remembering to do it later is not.
 *
 * Runs inside the compose document, so, like the message banner, it namespaces
 * everything, resets its own styles, and builds nodes rather than parsing HTML.
 */

const ROOT_ID = "suitecrm-compose-status";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function styles() {
  const style = el("style");
  style.textContent = `
#${ROOT_ID} {
  --scc-bg: #f6f8fa; --scc-fg: #1a222c; --scc-muted: #5d6874;
  --scc-line: #d9dee4; --scc-accent: #0f7267; --scc-ok: #1c8b4f; --scc-warn: #8a6100;
  all: initial; display: block; box-sizing: border-box;
  font: 12.5px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--scc-fg); background: var(--scc-bg);
  border-bottom: 1px solid var(--scc-line); padding: 6px 12px;
}
@media (prefers-color-scheme: dark) {
  #${ROOT_ID} {
    --scc-bg: #232b34; --scc-fg: #e4e9ee; --scc-muted: #98a4b1;
    --scc-line: #333c47; --scc-accent: #3fcdbc; --scc-ok: #48c98a; --scc-warn: #d7a344;
  }
}
#${ROOT_ID} .scc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
#${ROOT_ID} .scc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--scc-muted); flex: none; }
#${ROOT_ID} .scc-dot.is-found { background: var(--scc-ok); }
#${ROOT_ID} .scc-dot.is-warn { background: var(--scc-warn); }
#${ROOT_ID} .scc-muted { color: var(--scc-muted); }
#${ROOT_ID} button {
  all: unset; box-sizing: border-box; cursor: pointer; margin-left: auto;
  font: 600 11.5px/1 system-ui, sans-serif; padding: 4px 10px; border-radius: 4px;
  border: 1px solid var(--scc-accent); color: var(--scc-accent);
}
#${ROOT_ID} button:focus-visible { outline: 2px solid var(--scc-accent); outline-offset: 2px; }
`;
  return style;
}

function render(state) {
  document.getElementById(ROOT_ID)?.remove();
  if (!state) return;

  const root = el("div");
  root.id = ROOT_ID;
  root.appendChild(styles());

  const row = el("div", "scc-row");
  const dot = el("span", "scc-dot");
  row.appendChild(dot);
  row.appendChild(el("span", null, state.text));
  if (state.detail) row.appendChild(el("span", "scc-muted", state.detail));

  if (state.tone === "found") dot.classList.add("is-found");
  if (state.tone === "warn") dot.classList.add("is-warn");

  if (state.action) {
    const btn = el("button", null, state.action.label);
    btn.addEventListener("click", () => {
      browser.runtime.sendMessage({ type: state.action.type, payload: state.action.payload });
      btn.disabled = true;
      btn.textContent = state.action.done || "Done";
    });
    row.appendChild(btn);
  }

  root.appendChild(row);
  document.body?.insertBefore(root, document.body.firstChild);
}

let lastKey = "";

async function refresh() {
  try {
    const res = await browser.runtime.sendMessage({ type: "composeStatus" });
    if (!res?.ok || !res.result || res.result.hidden) {
      lastKey = "";
      return render(null);
    }
    const s = res.result;
    // Re-rendering on every keystroke would fight the user's focus.
    const key = JSON.stringify([s.tone, s.text, s.detail]);
    if (key === lastKey) return;
    lastKey = key;
    render(s);
  } catch {
    render(null);
  }
}

// Recipients change as the user types, so poll gently rather than on every event.
refresh();
setInterval(refresh, 2500);
