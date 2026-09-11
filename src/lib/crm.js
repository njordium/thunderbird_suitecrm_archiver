/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * SuiteCRM V8 REST client (JSON:API-flavoured).
 *
 * Filter contract, verified against Api/V8/JsonApi/Repository/Filter.php:
 *   ?filter[operator]=or&filter[<field>][<op>]=<value>
 *   ops: eq, neq, gt, gte, lt, lte, like   (joined by and|or)
 *   Values go through DBManager::quoted() server-side, so they are escaped.
 *   The field must exist in the bean's field_defs or the API 400s.
 *
 * Email addresses: ModuleService::getRecords() special-cases a filter
 * mentioning `email1` and rewrites `<table>.email1` into a join over
 * email_addresses + email_addr_bean_rel. That is the only supported way to
 * search by address.
 *
 * CAUTION: the same code checks for `email2` but the str_replace only ever
 * rewrites `.email1`, so an email2 filter yields invalid SQL. Never filter on
 * email2. See docs/RESEARCH.md.
 */

import { log } from "./log.js";
import * as auth from "./auth.js";
import * as store from "./store.js";
import * as diag from "./diagnostics.js";
import { WRITE_ONLY_FIELDS, UPLOAD_FIELDS } from "./modules.js";

export class CrmError extends Error {
  constructor(message, { status = null, detail = null, needsLogin = false } = {}) {
    super(message);
    this.name = "CrmError";
    this.status = status;
    this.detail = detail;
    this.needsLogin = needsLogin;
  }
}

/** Encode nested objects as bracketed query params: {filter:{a:{eq:1}}} -> filter[a][eq]=1 */
function encodeQuery(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      encodeQuery(v, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : v)}`);
    }
  }
  return out;
}

function describeErrors(body, status) {
  if (!body) return `HTTP ${status}`;
  if (typeof body === "string") return body.slice(0, 300);
  const e = body.errors ?? body.error;
  if (!e) return `HTTP ${status}`;
  const one = Array.isArray(e) ? e[0] : e;
  if (typeof one === "string") return one;
  return one.detail || one.title || one.message || JSON.stringify(one).slice(0, 300);
}

export class CrmClient {
  constructor(apiBase) { this.apiBase = apiBase; }

  static async create() {
    const conn = await store.getConnection();
    if (!conn) throw new CrmError("SuiteCRM connection is not configured.", { needsLogin: true });
    return new CrmClient(conn.apiBase);
  }

  async request(method, path, { query = null, body = null, _retried = false } = {}) {
    const token = await auth.getAccessToken();
    const qs = query ? encodeQuery(query).join("&") : "";
    const url = `${this.apiBase}/V8${path}${qs ? "?" + qs : ""}`;

    const headers = { Accept: "application/vnd.api+json", Authorization: `Bearer ${token}` };
    if (body) headers["Content-Type"] = "application/vnd.api+json";

    log.debug(method, url);
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      diag.recordRequest({ method, url, error: e.message, ms: Date.now() - started });
      throw new CrmError(`Network error contacting SuiteCRM: ${e.message}`);
    }
    diag.recordRequest({ method, url, status: res.status, ms: Date.now() - started });

    // Access token rejected mid-flight, refresh once and retry.
    if (res.status === 401 && !_retried) {
      log.info("401 from CRM; forcing token refresh and retrying once.");
      try {
        await auth.getAccessToken({ force: true });
      } catch (e) {
        throw new CrmError(e.message, { status: 401, needsLogin: true });
      }
      return this.request(method, path, { query, body, _retried: true });
    }

    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }

    if (!res.ok) {
      throw new CrmError(describeErrors(parsed, res.status), {
        status: res.status,
        detail: parsed,
        needsLogin: res.status === 401,
      });
    }
    return parsed;
  }

  // ---- reads -------------------------------------------------------------

  getCurrentUser() { return this.request("GET", "/current-user"); }
  getModuleList()  { return this.request("GET", "/meta/modules"); }
  getModuleFields(module) { return this.request("GET", `/meta/fields/${encodeURIComponent(module)}`); }

  /**
   * @param {string} module
   * @param {object} opts.filter  e.g. { operator:"or", email1:{ eq:"a@b.c" } }
   * @param {string[]} opts.fields
   */
  async getRecords(module, { filter = null, fields = null, size = 20, number = 1, sort = null } = {}) {
    const build = (withFields) => {
      const query = { page: { size, number } };
      if (filter) query.filter = filter;
      if (withFields && fields) query.fields = { [module]: fields };
      if (sort) query.sort = sort;
      return query;
    };

    try {
      return normaliseList(
        await this.request("GET", `/module/${encodeURIComponent(module)}`, { query: build(true) })
      );
    } catch (e) {
      // An unrecognised field name is a hard 400, not a silent omission. On a
      // customised or older instance that would make this module look empty and
      // the record look absent, so fall back to the bean's default fields
      // rather than reporting "not in the CRM" for something that is.
      if (fields && e.status === 400 && /is not found/i.test(e.message)) {
        log.warn(`${module}: ${e.message}, retrying with default fields.`);
        return normaliseList(
          await this.request("GET", `/module/${encodeURIComponent(module)}`, { query: build(false) })
        );
      }
      throw e;
    }
  }

  /**
   * The Case with this case_number, or null.
   *
   * case_number is an int in SuiteCRM and filterable, verified against a live
   * instance. A number nobody has used is an empty result rather than an error,
   * so a stale reference degrades to "not found" instead of a failure.
   */
  async getCaseByNumber(number, fields = null) {
    const rows = await this.getRecords("Cases", {
      filter: { case_number: { eq: String(number) } },
      fields,
      size: 1,
    });
    return rows[0] || null;
  }

  async getRecord(module, id, fields = null) {
    const query = fields ? { fields: { [module]: fields } } : null;
    const res = await this.request("GET", `/module/${encodeURIComponent(module)}/${encodeURIComponent(id)}`, { query });
    return normaliseOne(res);
  }

  async getRelated(module, id, linkFieldName) {
    const res = await this.request(
      "GET",
      `/module/${encodeURIComponent(module)}/${encodeURIComponent(id)}/relationships/${encodeURIComponent(linkFieldName)}`
    );
    return normaliseList(res);
  }

  // ---- field metadata ----------------------------------------------------

  /**
   * The field names a module actually accepts, cached for the session.
   *
   * Modules differ in ways that are not obvious: Leads has `website`, Contacts
   * does not, and sending an unknown attribute makes the whole create fail with
   * "Property website in Contact module is invalid". Since our create payloads
   * are assembled from a parsed email signature, we cannot know in advance which
   * fields a given instance supports, so ask, and drop what it will not take.
   */
  async getFieldNames(module) {
    if (!this._fieldCache) this._fieldCache = new Map();
    if (this._fieldCache.has(module)) return this._fieldCache.get(module);

    let names = null;
    try {
      const res = await this.getModuleFields(module);
      const attrs = res?.data?.attributes ?? res?.data ?? null;
      if (attrs && typeof attrs === "object") names = new Set(Object.keys(attrs));
    } catch (e) {
      log.warn(`Could not read field list for ${module}:`, e.message);
    }
    this._fieldCache.set(module, names);   // null means "unknown, do not filter"
    return names;
  }

  /**
   * Drop attributes the module does not have, so one stray field cannot fail the
   * whole write.
   *
   * Crucially this is not "keep only what /meta/fields reports": several fields
   * are writable without being listed there, the Emails addresses in
   * particular, and dropping those loses the sender and recipients without any
   * error. WRITE_ONLY_FIELDS names them explicitly.
   */
  async filterAttributes(module, attributes) {
    const names = await this.getFieldNames(module);
    if (!names) return { attributes, dropped: [] };

    const alwaysKeep = new Set([...UPLOAD_FIELDS, ...(WRITE_ONLY_FIELDS[module] || [])]);
    const kept = {}, dropped = [];
    for (const [k, v] of Object.entries(attributes)) {
      if (alwaysKeep.has(k) || names.has(k)) kept[k] = v;
      else dropped.push(k);
    }
    if (dropped.length) log.info(`${module}: dropping unsupported field(s): ${dropped.join(", ")}`);
    return { attributes: kept, dropped };
  }

  // ---- writes ------------------------------------------------------------

  async createRecord(module, attributes) {
    const { attributes: safe } = await this.filterAttributes(module, attributes);
    const res = await this.request("POST", "/module", {
      body: { data: { type: module, attributes: safe } },
    });
    return normaliseOne(res);
  }

  async updateRecord(module, id, attributes) {
    const { attributes: safe } = await this.filterAttributes(module, attributes);
    const res = await this.request("PATCH", "/module", {
      body: { data: { type: module, id, attributes: safe } },
    });
    return normaliseOne(res);
  }

  /** Link two records. Non-fatal by convention, callers may ignore failures. */
  async createRelationship(module, id, relatedType, relatedId) {
    return this.request("POST", `/module/${encodeURIComponent(module)}/${encodeURIComponent(id)}/relationships`, {
      body: { data: { type: relatedType, id: relatedId } },
    });
  }

  /**
   * Notes carry attachments. Passing `filename` flips ModuleService into its
   * upload branch; `filecontents` must be base64 with no data: prefix.
   */
  createNoteWithFile(attributes) { return this.createRecord("Notes", attributes); }
}

// ---- response shaping ----------------------------------------------------

function flatten(entry) {
  if (!entry) return null;
  return { id: entry.id, module: entry.type, ...(entry.attributes || {}) };
}

function normaliseOne(res) {
  const d = res?.data;
  return flatten(Array.isArray(d) ? d[0] : d);
}

function normaliseList(res) {
  const d = res?.data;
  if (!d) return [];
  return (Array.isArray(d) ? d : [d]).map(flatten).filter(Boolean);
}
