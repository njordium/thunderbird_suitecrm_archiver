#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Seed the test SuiteCRM with synthetic data for exercising the add-on.
 *
 * The demo data that ships with SuiteCRM has addresses like
 * `support.the.dev@example.name`, which are fine for proving an API call works
 * but useless for judging whether the add-on behaves sensibly. This creates
 * records that look like real correspondence: Nordic companies, several people
 * per Account sharing a domain, a Lead who has not been converted, a Contact
 * reachable at a personal address, and open Opportunities and Cases.
 *
 * Everything is clearly marked and reversible:
 *   node tools/seed-crm.mjs           create
 *   node tools/seed-crm.mjs --remove  delete everything it created
 *   node tools/seed-crm.mjs --list    show what exists
 *
 * All names, domains and numbers are invented. Domains use .example / .test,
 * which are reserved by RFC 2606 and cannot resolve to anyone real.
 */

const args = process.argv.slice(2);
const MODE = args.includes("--remove") ? "remove" : args.includes("--list") ? "list" : "create";

const CFG = {
  url: process.env.CRM_URL,
  clientId: process.env.CRM_CLIENT_ID,
  clientSecret: process.env.CRM_CLIENT_SECRET,
  username: process.env.CRM_USERNAME,
  password: process.env.CRM_PASSWORD,
};
const missing = Object.entries(CFG).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error("Missing environment variables: " + missing.join(", "));
  console.error("See docs/SETUP.md.");
  process.exit(2);
}

/** Marks every record this script creates, so removal is exact. */
const TAG = "[seed]";

// ---------------------------------------------------------------------------
// The data. Three companies, each with people, so the add-on's colleague
// grouping and Account suggestions have something real to work against.
// ---------------------------------------------------------------------------

const COMPANIES = [
  {
    account: {
      name: "Vasaloppet Logistik AB",
      website: "https://vasaloppet-logistik.example",
      phone_office: "08-501 296 40",
      billing_address_street: "Mätarvägen 3B",
      billing_address_postalcode: "196 37",
      billing_address_city: "Kungsängen",
      billing_address_country: "Sweden",
      industry: "Transportation",
      description: `${TAG} Synthetic account for add-on testing.`,
    },
    domain: "vasaloppet-logistik.example",
    contacts: [
      { first_name: "Britta", last_name: "Hagberg", title: "Kontorschef",
        phone_work: "08-501 296 46", phone_mobile: "+46 70 412 88 10" },
      { first_name: "Anders", last_name: "Hagberg", title: "Transportledare",
        phone_work: "08-501 296 47" },
      { first_name: "Yusuf", last_name: "Demir", title: "Ekonomiansvarig",
        phone_work: "08-501 296 51", phone_mobile: "+46 73 991 04 22" },
    ],
    opportunities: [
      { name: "Ramavtal distribution 2027", amount: "480000", sales_stage: "Proposal/Price Quote" },
    ],
    cases: [
      { name: "Fakturor saknar referensnummer", priority: "P2" },
    ],
  },
  {
    account: {
      name: "Nordlys Data AS",
      website: "https://nordlysdata.example",
      phone_office: "+47 22 45 11 00",
      billing_address_street: "Storgata 14",
      billing_address_postalcode: "0184",
      billing_address_city: "Oslo",
      billing_address_country: "Norway",
      industry: "Technology",
      description: `${TAG} Synthetic account for add-on testing.`,
    },
    domain: "nordlysdata.example",
    contacts: [
      { first_name: "Ingrid", last_name: "Dahl", title: "Chief Technology Officer",
        phone_work: "+47 22 45 11 04", phone_mobile: "+47 918 22 043" },
      { first_name: "Sean", last_name: "Mac Dermott", title: "Head of Security",
        phone_work: "+47 22 45 11 09" },
    ],
    opportunities: [
      { name: "Sikkerhetsgjennomgang Q1", amount: "215000", sales_stage: "Negotiation/Review" },
      { name: "Utvidet supportavtale", amount: "96000", sales_stage: "Prospecting" },
    ],
    cases: [],
  },
  {
    account: {
      name: "Kaskelot Consulting ApS",
      website: "https://kaskelot.example",
      phone_office: "+45 33 12 88 40",
      billing_address_street: "Gothersgade 51",
      billing_address_postalcode: "1123",
      billing_address_city: "København",
      billing_address_country: "Denmark",
      industry: "Consulting",
      description: `${TAG} Synthetic account for add-on testing.`,
    },
    domain: "kaskelot.example",
    contacts: [
      { first_name: "Mette", last_name: "Sørensen", title: "Partner",
        phone_work: "+45 33 12 88 41", phone_mobile: "+45 20 44 71 66" },
    ],
    opportunities: [],
    cases: [
      { name: "Adgang til rapportportalen", priority: "P1" },
    ],
  },
];

/** People not attached to an Account, which is what a Lead is for. */
const LEADS = [
  { first_name: "Petra", last_name: "Lindholm", title: "Inköpschef",
    account_name: "Bergslagens Verkstad AB", email1: "petra.lindholm@bergslagens-verkstad.example",
    phone_work: "0223-412 90", phone_mobile: "+46 70 554 21 08",
    website: "https://bergslagens-verkstad.example", status: "New", lead_source: "Email",
    description: `${TAG} Synthetic lead for add-on testing.` },
  { first_name: "Tomasz", last_name: "Kowalczyk", title: "Operations Manager",
    account_name: "Baltic Freight Oy", email1: "t.kowalczyk@balticfreight.example",
    phone_mobile: "+358 40 559 21 03", status: "New", lead_source: "Email",
    description: `${TAG} Synthetic lead for add-on testing.` },
];

/**
 * A contact who also writes from a personal address. This is the case the
 * address lookup cannot solve on its own, and the reason manual search exists.
 */
const PERSONAL_ADDRESS = {
  who: "Ingrid Dahl",
  address: "ingrid.dahl.private@example.test",
};

// ---------------------------------------------------------------------------

/**
 * A name as it would actually appear in an address.
 *
 * NFD decomposition alone is not enough for Nordic names: ø, æ and ð have no
 * combining form, so stripping marks leaves "Sørensen" as "srensen". These are
 * the transliterations those languages themselves use.
 */
const TRANSLITERATE = {
  "ø": "o", "æ": "ae", "å": "a", "ä": "a", "ö": "o", "ü": "u",
  "ð": "d", "þ": "th", "ß": "ss", "ł": "l", "đ": "d",
};

export function localPart(name) {
  return String(name)
    .toLowerCase()
    .replace(/[øæåäöüðþßłđ]/g, (c) => TRANSLITERATE[c] ?? c)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z.]/g, "");
}

let apiBase = null, token = null;

async function tokenRequest(payload, base) {
  const res = await fetch(`${base}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Non-JSON from ${base}`); }
  if (!res.ok || body.error) throw new Error(body.hint || body.error || `HTTP ${res.status}`);
  return body;
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
    const e = json?.errors ?? json?.error ?? text.slice(0, 200);
    const one = Array.isArray(e) ? e[0] : e;
    throw new Error(`HTTP ${res.status}: ${typeof one === "string" ? one : one?.detail || JSON.stringify(one)}`);
  }
  return json;
}

const create = async (type, attributes) =>
  (await api("POST", "/module", { body: { data: { type, attributes } } }))?.data?.id;

const link = async (module, id, relType, relId) => {
  try {
    await api("POST", `/module/${module}/${id}/relationships`, { body: { data: { type: relType, id: relId } } });
  } catch (e) {
    console.log(`      (link ${module}->${relType} skipped: ${e.message.slice(0, 60)})`);
  }
};

async function findSeeded(module, field = "description") {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const res = await api("GET", `/module/${module}`, {
      query: { filter: { [field]: { like: `%${TAG}%` } }, page: { size: 100, number: page } },
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    out.push(...rows.map((r) => ({ id: r.id, name: r.attributes?.name || r.attributes?.last_name || r.id })));
    if (rows.length < 100) break;
  }
  return out;
}

const SEEDED_MODULES = ["Cases", "Opportunities", "Contacts", "Leads", "Accounts"];

// ---------------------------------------------------------------------------

console.log(`\nSynthetic CRM data, ${CFG.url}\n${"─".repeat(58)}`);

for (const suffix of ["/Api", "/legacy/Api"]) {
  const base = CFG.url.replace(/\/+$/, "") + suffix;
  try {
    await tokenRequest({ grant_type: "client_credentials", client_id: "__probe__", client_secret: "__probe__" }, base);
    apiBase = base; break;
  } catch (e) {
    if (!/Non-JSON/.test(e.message)) { apiBase = base; break; }
  }
}
if (!apiBase) { console.error("Could not find the V8 API."); process.exit(1); }

const auth = await tokenRequest({
  grant_type: "password",
  client_id: CFG.clientId, client_secret: CFG.clientSecret,
  username: CFG.username, password: CFG.password, scope: "",
}, apiBase);
token = auth.access_token;
console.log(`signed in at ${apiBase}\n`);

if (MODE === "list" || MODE === "remove") {
  let total = 0;
  for (const module of SEEDED_MODULES) {
    const found = await findSeeded(module);
    if (!found.length) continue;
    console.log(`${module}: ${found.length}`);
    for (const r of found) console.log(`   ${r.name}`);
    total += found.length;

    if (MODE === "remove") {
      for (const r of found) {
        try { await api("DELETE", `/module/${module}/${r.id}`); }
        catch (e) { console.log(`   ! could not delete ${r.name}: ${e.message.slice(0, 70)}`); }
      }
    }
  }
  console.log(`\n${MODE === "remove" ? "Removed" : "Found"} ${total} seeded record(s).\n`);
  process.exit(0);
}

// ---- create ---------------------------------------------------------------

let counts = { Accounts: 0, Contacts: 0, Leads: 0, Opportunities: 0, Cases: 0 };

for (const company of COMPANIES) {
  const accountId = await create("Accounts", company.account);
  counts.Accounts++;
  console.log(`Account  ${company.account.name}`);

  const contactIds = [];
  for (const c of company.contacts) {
    const email = localPart(`${c.first_name}.${c.last_name}`) + "@" + company.domain;

    const id = await create("Contacts", {
      ...c,
      email1: email,
      account_id: accountId,
      primary_address_street: company.account.billing_address_street,
      primary_address_postalcode: company.account.billing_address_postalcode,
      primary_address_city: company.account.billing_address_city,
      primary_address_country: company.account.billing_address_country,
      description: `${TAG} Synthetic contact for add-on testing.`,
    });
    await link("Contacts", id, "Accounts", accountId);
    contactIds.push(id);
    counts.Contacts++;
    console.log(`   Contact ${c.first_name} ${c.last_name} <${email}>`);
  }

  for (const o of company.opportunities) {
    const id = await create("Opportunities", {
      ...o,
      account_id: accountId,
      date_closed: new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10),
      description: `${TAG} Synthetic opportunity for add-on testing.`,
    });
    if (contactIds[0]) await link("Opportunities", id, "Contacts", contactIds[0]);
    counts.Opportunities++;
    console.log(`   Opportunity ${o.name} (${o.amount})`);
  }

  for (const c of company.cases) {
    const id = await create("Cases", {
      ...c,
      account_id: accountId,
      description: `${TAG} Synthetic case for add-on testing.`,
    });
    if (contactIds[0]) await link("Cases", id, "Contacts", contactIds[0]);
    counts.Cases++;
    console.log(`   Case ${c.name}`);
  }
  console.log("");
}

for (const lead of LEADS) {
  await create("Leads", lead);
  counts.Leads++;
  console.log(`Lead     ${lead.first_name} ${lead.last_name} <${lead.email1}>`);
}

console.log(`\n${"─".repeat(58)}`);
console.log("Created: " + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", "));
console.log(`\nAll records are marked "${TAG}" in their description.`);
console.log("Remove them with:  node tools/seed-crm.mjs --remove");
console.log(`\nA contact who also writes from a personal address, for testing manual search:`);
console.log(`   ${PERSONAL_ADDRESS.who}, ${PERSONAL_ADDRESS.address} (not in the CRM by design)\n`);
