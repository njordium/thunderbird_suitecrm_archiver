/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Resolve an email address to CRM records, across every module at once.
 *
 * This is the central design decision: instead of asking the user to pick a
 * module and then type a search, we fan out across all address-bearing modules
 * in parallel the moment the popup opens, and present whatever we found. The
 * sender's address is already known, so making someone retype it is work the
 * add-on should be doing.
 */

import { log } from "./log.js";
import { DIRECT_MODULES, MODULE_FIELDS, RELATED_LINKS } from "./modules.js";
import { domainOf, isConsumerDomain } from "./addresses.js";

/**
 * Search one module for an exact address match.
 * Relies on ModuleService rewriting `<table>.email1` into the
 * email_addresses / email_addr_bean_rel join.
 */
async function searchModuleByEmail(client, module, email) {
  return client.getRecords(module, {
    filter: { email1: { eq: email } },
    fields: MODULE_FIELDS[module],
    size: 10,
  });
}

/**
 * Fan out across all direct modules concurrently.
 * allSettled, not all: a module may be disabled, renamed, or ACL-blocked for
 * this user, and that must not take down the whole lookup.
 */
export async function resolveAddress(client, email, { modules = DIRECT_MODULES } = {}) {
  const settled = await Promise.allSettled(
    modules.map((m) => searchModuleByEmail(client, m, email).then((records) => ({ module: m, records })))
  );

  const hits = {};
  const failures = [];
  let total = 0;

  settled.forEach((r, i) => {
    const module = modules[i];
    if (r.status === "fulfilled") {
      if (r.value.records.length) {
        hits[module] = r.value.records;
        total += r.value.records.length;
      }
    } else {
      log.warn(`Lookup failed for ${module}:`, r.reason?.message);
      failures.push({ module, error: r.reason?.message || String(r.reason) });
    }
  });

  return { email, hits, failures, total, found: total > 0 };
}

/**
 * Find Accounts that plausibly own a domain, for "create a Contact under the
 * right Account" when the person themselves is unknown.
 *
 * Skipped for consumer domains, matching every gmail.com address to an
 * Account whose contact happens to use Gmail would be noise.
 */
export async function findAccountsByDomain(client, email) {
  const domain = domainOf(email);
  if (!domain || isConsumerDomain(domain)) return [];

  const attempts = [
    // Someone at this Account already has an address on the domain.
    { filter: { email1: { like: `%@${domain}` } } },
    // Or the Account's website carries it.
    { filter: { website: { like: `%${domain}%` } } },
  ];

  const byId = new Map();
  for (const a of attempts) {
    try {
      const recs = await client.getRecords("Accounts", {
        ...a, fields: MODULE_FIELDS.Accounts, size: 10,
      });
      for (const r of recs) if (!byId.has(r.id)) byId.set(r.id, r);
    } catch (e) {
      log.warn("Account domain lookup failed:", e.message);
    }
  }
  return [...byId.values()];
}

/**
 * Expand a matched record into the things linked to it (Opportunities, Quotes,
 * Cases, Projects). Called lazily when the user opens a record's disclosure,
 * so the initial search stays fast.
 */
export async function expandRelated(client, record) {
  const links = RELATED_LINKS[record.module] || [];
  if (!links.length) return {};

  const settled = await Promise.allSettled(
    links.map((l) =>
      client.getRelated(record.module, record.id, l.link)
        .then((records) => ({ module: l.module, records }))
    )
  );

  const out = {};
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.records.length) {
      out[r.value.module] = r.value.records;
    } else if (r.status === "rejected") {
      log.debug(`No ${links[i].link} link on ${record.module}:`, r.reason?.message);
    }
  });
  return out;
}


/**
 * Free-text search, for when the address lookup finds nothing.
 *
 * A known contact writing from a personal address, a shared info@ mailbox, a
 * domain that changed at a rebrand, the automatic lookup misses all of these,
 * and without this the only way forward is creating a duplicate.
 *
 * Searches names and company names per module, since SuiteCRM has no
 * cross-module search in the V8 API. Values are escaped server-side.
 */
export async function searchRecords(client, text, { modules = DIRECT_MODULES, size = 10 } = {}) {
  const term = String(text || "").trim();
  if (term.length < 2) return { term, hits: {}, total: 0, failures: [] };

  const like = `%${term}%`;

  /** The fields worth matching, per module. */
  const searchable = (module) => {
    if (module === "Accounts") return ["name"];
    if (term.includes("@")) return ["email1"];      // someone pasted an address
    return ["last_name", "first_name", "account_name"];
  };

  const settled = await Promise.allSettled(modules.map(async (module) => {
    const fields = searchable(module);
    // One request per field: the V8 filter joins with a single operator, so
    // mixing an OR across fields with the implicit deleted=0 AND is not
    // expressible in one call.
    const perField = await Promise.allSettled(fields.map((f) =>
      client.getRecords(module, {
        filter: { [f]: { like } },
        fields: MODULE_FIELDS[module],
        size,
      })
    ));

    const byId = new Map();
    for (const r of perField) {
      if (r.status !== "fulfilled") continue;
      for (const rec of r.value) if (!byId.has(rec.id)) byId.set(rec.id, rec);
    }
    return { module, records: [...byId.values()].slice(0, size) };
  }));

  const hits = {};
  const failures = [];
  let total = 0;
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value.records.length) { hits[r.value.module] = r.value.records; total += r.value.records.length; }
    } else {
      failures.push({ module: modules[i], error: r.reason?.message || String(r.reason) });
    }
  });

  return { term, hits, total, failures, found: total > 0 };
}
