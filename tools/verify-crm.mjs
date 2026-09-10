#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * End-to-end probe of a SuiteCRM V8 instance for everything this add-on needs.
 *
 * Credentials come from the environment, never from arguments, so they stay out
 * of your shell history and out of any transcript.
 *
 *   CRM_URL=http://host:port \
 *   CRM_CLIENT_ID=... CRM_CLIENT_SECRET=... \
 *   CRM_USERNAME=... CRM_PASSWORD=... \
 *   node tools/verify-crm.mjs [--write] [--email someone@example.com]
 *
 * Read-only by default. --write additionally creates and then deletes a
 * throwaway Contact and Email to prove the create path works.
 */

const args = process.argv.slice(2);
const DO_WRITE = args.includes("--write");
const PROBE_EMAIL = (args[args.indexOf("--email") + 1] || "").includes("@")
  ? args[args.indexOf("--email") + 1] : null;

const CFG = {
  url: process.env.CRM_URL,
  clientId: process.env.CRM_CLIENT_ID,
  clientSecret: process.env.CRM_CLIENT_SECRET,
  username: process.env.CRM_USERNAME,
  password: process.env.CRM_PASSWORD,
};

const missing = Object.entries(CFG).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error("Missing environment variables for: " + missing.join(", "));
  console.error("\nSee docs/SETUP.md for how to create the OAuth2 client.");
  process.exit(2);
}

let pass = 0, fail = 0, skip = 0;
const results = [];

function record(status, name, detail = "") {
  const icon = { PASS: "\x1b[32m✓\x1b[0m", FAIL: "\x1b[31m✗\x1b[0m", SKIP: "\x1b[33m–\x1b[0m" }[status];
  console.log(`${icon} ${name}${detail ? "\n    " + String(detail).replace(/\n/g, "\n    ") : ""}`);
  results.push({ status, name, detail });
  if (status === "PASS") pass++; else if (status === "FAIL") fail++; else skip++;
}

async function step(name, fn, { optional = false } = {}) {
  try {
    const detail = await fn();
    record("PASS", name, detail);
    return true;
  } catch (e) {
    record(optional ? "SKIP" : "FAIL", name, e.message);
    return false;
  }
}

const base = CFG.url.replace(/\/+$/, "").split("/index.php")[0];
let apiBase = null, token = null, refreshToken = null;

async function api(method, path, { query = null, body = null } = {}) {
  const qs = query ? "?" + encodeQuery(query).join("&") : "";
  const res = await fetch(`${apiBase}/V8${path}${qs}`, {
    method,
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/vnd.api+json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  if (!res.ok) {
    const e = json?.errors ?? json?.error ?? text.slice(0, 300);
    const one = Array.isArray(e) ? e[0] : e;
    throw new Error(`HTTP ${res.status}: ${typeof one === "string" ? one : one?.detail || one?.title || JSON.stringify(one)}`);
  }
  return json;
}

function encodeQuery(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) encodeQuery(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : v)}`);
  }
  return out;
}

async function tokenRequest(payload, apiB = apiBase) {
  const res = await fetch(`${apiB}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}) — the API is probably not at ${apiB}`);
  }
  if (!res.ok || body.error) {
    throw new Error(`${body.error || res.status}: ${body.hint || body.error_description || body.message || ""}`);
  }
  return body;
}

// ---------------------------------------------------------------------------

console.log(`\nSuiteCRM V8 verification — ${base}\n${"─".repeat(60)}`);

console.log("\n\x1b[1m1. Discovery & authentication\x1b[0m");

await step("Locate the V8 API (/Api vs /legacy/Api)", async () => {
  const tried = [];
  for (const suffix of ["/Api", "/legacy/Api"]) {
    try {
      await tokenRequest({ grant_type: "client_credentials", client_id: "__probe__", client_secret: "__probe__" }, base + suffix);
      apiBase = base + suffix; return `alive at ${apiBase}`;
    } catch (e) {
      if (!/Non-JSON response/.test(e.message)) { apiBase = base + suffix; return `alive at ${apiBase} (probe: ${e.message})`; }
      tried.push(`${base + suffix}: ${e.message}`);
    }
  }
  throw new Error("No V8 API found.\n" + tried.join("\n"));
});
if (!apiBase) { summarise(); process.exit(1); }

const authed = await step("Password grant → access token", async () => {
  const body = await tokenRequest({
    grant_type: "password",
    client_id: CFG.clientId, client_secret: CFG.clientSecret,
    username: CFG.username, password: CFG.password, scope: "",
  });
  token = body.access_token;
  refreshToken = body.refresh_token || null;
  return `expires_in=${body.expires_in}s  refresh_token=${refreshToken ? "yes" : "NO"}`;
});
if (!authed) { summarise(); process.exit(1); }

await step("Refresh token rotates (the whole point of the design)", async () => {
  if (!refreshToken) throw new Error("No refresh token was issued — check the client is a Password client.");
  const body = await tokenRequest({
    grant_type: "refresh_token",
    client_id: CFG.clientId, client_secret: CFG.clientSecret,
    refresh_token: refreshToken, scope: "",
  });
  const rotated = body.refresh_token && body.refresh_token !== refreshToken;
  token = body.access_token;
  refreshToken = body.refresh_token || refreshToken;
  return rotated ? "new refresh token issued — rotation confirmed" : "WARNING: refresh token was NOT rotated";
});

console.log("\n\x1b[1m2. Read endpoints\x1b[0m");

await step("GET /V8/current-user", async () => {
  const r = await api("GET", "/current-user");
  const a = r?.data?.attributes || {};
  return `id=${r?.data?.id} user_name=${a.user_name ?? "?"}`;
});

await step("GET /V8/meta/modules", async () => {
  const r = await api("GET", "/meta/modules");
  const mods = Object.keys(r?.data?.attributes || r?.data || {});
  const want = ["Contacts", "Leads", "Accounts", "Opportunities", "Emails", "Notes"];
  const have = want.filter((m) => mods.includes(m));
  return `${mods.length} modules; of the ones we need, present: ${have.join(", ") || "none detected"}`;
});

console.log("\n\x1b[1m3. The email→record lookup (the critical path)\x1b[0m");

for (const mod of ["Contacts", "Leads", "Accounts", "Prospects"]) {
  await step(`GET /V8/module/${mod}?filter[email1][eq] — the email_addr_bean_rel join`, async () => {
    const probe = PROBE_EMAIL || "verify-probe-no-such-address@example.invalid";
    const r = await api("GET", `/module/${mod}`, {
      query: { filter: { email1: { eq: probe } }, page: { size: 3 } },
    });
    const n = Array.isArray(r?.data) ? r.data.length : r?.data ? 1 : 0;
    return `join executed, ${n} match(es) for ${probe}`;
  }, { optional: mod === "Prospects" });
}

await step("filter[email1][like] for domain→Account matching", async () => {
  const r = await api("GET", "/module/Accounts", {
    query: { filter: { email1: { like: "%@example.invalid" } }, page: { size: 3 } },
  });
  return `accepted; ${Array.isArray(r?.data) ? r.data.length : 0} match(es)`;
});

await step("filter on a plain field (no email join)", async () => {
  const r = await api("GET", "/module/Contacts", {
    query: { filter: { last_name: { like: "a%" } }, page: { size: 3 }, fields: { Contacts: ["id", "last_name"] } },
  });
  return `accepted; ${Array.isArray(r?.data) ? r.data.length : 0} row(s)`;
});

await step("CONFIRM email2 is unusable (known SuiteCRM bug)", async () => {
  try {
    await api("GET", "/module/Contacts", { query: { filter: { email2: { eq: "x@y.z" } }, page: { size: 1 } } });
    return "email2 filter did NOT error on this build — the docs note may not apply here";
  } catch (e) {
    return `errors as expected, so the client is right to avoid it (${e.message.slice(0, 110)})`;
  }
});

await step("Every MODULE_FIELDS list is valid on this instance", async () => {
  // An unknown field name returns HTTP 400, so a stale list makes the resolver
  // report "not in the CRM" for records that do exist.
  const { MODULE_FIELDS } = await import("../src/lib/modules.js");
  const broken = [];
  for (const [mod, fields] of Object.entries(MODULE_FIELDS)) {
    try {
      await api("GET", `/module/${mod}`, { query: { page: { size: 1 }, fields: { [mod]: fields } } });
    } catch (e) {
      broken.push(`${mod}: ${e.message}`);
    }
  }
  if (broken.length) throw new Error(broken.join("; "));
  return `${Object.keys(MODULE_FIELDS).length} module field lists accepted`;
});

await step("Emails de-duplication lookup by message_id", async () => {
  const r = await api("GET", "/module/Emails", {
    query: { filter: { message_id: { eq: "verify-probe@example.invalid" } }, page: { size: 1 } },
  });
  return `accepted; ${Array.isArray(r?.data) ? r.data.length : 0} match(es)`;
});

console.log("\n\x1b[1m4. Write endpoints\x1b[0m");

if (!DO_WRITE) {
  record("SKIP", "Create/link/delete round-trip", "pass --write to exercise the create path");
} else {
  const stamp = Date.now();
  let contactId = null, emailId = null, noteId = null;

  await step("POST /V8/module — create a throwaway Contact", async () => {
    const r = await api("POST", "/module", {
      body: { data: { type: "Contacts", attributes: {
        first_name: "ZZVerify", last_name: `Probe${stamp}`,
        email1: `zzverify.${stamp}@example.invalid`,
        title: "Automated verification record",
      } } },
    });
    contactId = r?.data?.id;
    return `id=${contactId}`;
  });

  if (contactId) {
    await step("The new Contact is findable by email1 (join writes through)", async () => {
      const r = await api("GET", "/module/Contacts", {
        query: { filter: { email1: { eq: `zzverify.${stamp}@example.invalid` } }, page: { size: 3 } },
      });
      const ids = (Array.isArray(r?.data) ? r.data : []).map((d) => d.id);
      if (!ids.includes(contactId)) throw new Error("Created contact was NOT returned by the email1 filter");
      return "round-trip confirmed";
    });

    await step("POST /V8/module — create an Email under it", async () => {
      const r = await api("POST", "/module", {
        body: { data: { type: "Emails", attributes: {
          name: "Verification probe",
          message_id: `zzverify-${stamp}@example.invalid`,
          from_addr: `zzverify.${stamp}@example.invalid`,
          description: "Created by tools/verify-crm.mjs",
          date_sent_received: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""),
          type: "archived", status: "archived",
          parent_type: "Contacts", parent_id: contactId,
        } } },
      });
      emailId = r?.data?.id;
      return `id=${emailId}`;
    });

    if (emailId) {
      await step("POST relationships — link Email to Contact", async () =>
        api("POST", `/module/Emails/${emailId}/relationships`, {
          body: { data: { type: "Contacts", id: contactId } },
        }).then(() => "linked"));

      await step("POST /V8/module — Note with a base64 attachment", async () => {
        const r = await api("POST", "/module", {
          body: { data: { type: "Notes", attributes: {
            name: "verify.txt", parent_type: "Emails", parent_id: emailId,
            filename: "verify.txt",
            filecontents: Buffer.from("verification payload\n").toString("base64"),
          } } },
        });
        noteId = r?.data?.id;
        return `id=${noteId} — upload path works`;
      });

      await step("GET relationships — Contact → Opportunities (lazy expansion)", async () => {
        const r = await api("GET", `/module/Contacts/${contactId}/relationships/opportunities`);
        return `link traversable; ${Array.isArray(r?.data) ? r.data.length : 0} related`;
      }, { optional: true });
    }

    console.log("\n\x1b[1m5. Cleanup\x1b[0m");
    for (const [mod, id] of [["Notes", noteId], ["Emails", emailId], ["Contacts", contactId]]) {
      if (!id) continue;
      await step(`DELETE ${mod}/${id}`, async () => {
        await api("DELETE", `/module/${mod}/${id}`);
        return "removed";
      });
    }
  }
}

summarise();

function summarise() {
  console.log("\n" + "─".repeat(60));
  console.log(`\x1b[1mSummary:\x1b[0m ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (apiBase) console.log(`API base: ${apiBase}`);
  if (fail) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => r.status === "FAIL")) console.log(`  • ${r.name}\n    ${r.detail}`);
  }
  console.log();
}
process.exit(fail ? 1 : 0);
