#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * End-to-end test of the add-on's own modules against a live SuiteCRM.
 *
 * tools/verify-crm.mjs checks that the *server* behaves. This checks that *our
 * code* behaves: it loads the real auth, crm, resolver, signature and archive
 * modules, hands them a synthetic Thunderbird message through a mock `browser`
 * global, and drives the whole flow — sign in, resolve the sender across
 * modules, create records, archive with attachments, de-duplicate — then reads
 * everything back out of the CRM to confirm it landed, and deletes it.
 *
 *   CRM_URL=... CRM_CLIENT_ID=... CRM_CLIENT_SECRET=... \
 *   CRM_USERNAME=... CRM_PASSWORD=... node tools/e2e.mjs
 */

// ---------------------------------------------------------------------------
// Mock Thunderbird. Installed before any add-on module runs.
// ---------------------------------------------------------------------------

const storage = new Map();
const messages = new Map();
const attachmentFiles = new Map();   // `${messageId}:${partName}` -> File

globalThis.browser = {
  storage: {
    local: {
      async get(key) {
        if (key === null || key === undefined) return Object.fromEntries(storage);
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (storage.has(k)) out[k] = storage.get(k);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) storage.set(k, v); },
      async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) storage.delete(k); },
    },
  },
  messages: {
    async get(id) { return messages.get(id).header; },
    async getFull(id) { return messages.get(id).full; },
    async listAttachments(id) { return messages.get(id).attachments; },
    async getAttachmentFile(id, partName) {
      const f = attachmentFiles.get(`${id}:${partName}`);
      if (!f) throw new Error(`no attachment ${partName}`);
      return f;
    },
  },
  accounts: {
    async list() { return [{ id: "account1", name: "Test", identities: [{ email: "me@mine.example" }] }]; },
    async get(id) { return { id, name: "Test" }; },
  },
  permissions: {
    async contains() { return true; },
    async request() { return true; },
    async getAll() { return { permissions: [], origins: [] }; },
  },
  runtime: {
    getManifest: () => ({ name: "e2e", version: "0.0.0" }),
    sendMessage: async () => undefined,
    getURL: (p) => p,
  },
};

const { default: assert } = await import("node:assert/strict");
const auth = await import("../src/lib/auth.js");
const { CrmClient } = await import("../src/lib/crm.js");
const { resolveAddress, findAccountsByDomain, searchRecords } = await import("../src/lib/resolver.js");
const { parseContact } = await import("../src/lib/signature.js");
const { readMessage, archiveMessage } = await import("../src/lib/archive.js");
const { buildCandidates } = await import("../src/lib/addresses.js");
const { buildRecord } = await import("../src/lib/createFromEmail.js");
const { recordToVCard: recToCard, usableForAddressBook } = await import("../src/lib/vcard.js");
const { setLogLevel } = await import("../src/lib/log.js");

setLogLevel("error");

// ---------------------------------------------------------------------------

const CFG = {
  url: process.env.CRM_URL, clientId: process.env.CRM_CLIENT_ID,
  clientSecret: process.env.CRM_CLIENT_SECRET,
  username: process.env.CRM_USERNAME, password: process.env.CRM_PASSWORD,
};
const missing = Object.entries(CFG).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.error("Missing env: " + missing.join(", ")); process.exit(2); }

let pass = 0, fail = 0;
const failures = [];
const cleanup = [];   // {module, id}

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`\x1b[32m✓\x1b[0m ${name}${detail ? `\n    ${String(detail).replace(/\n/g, "\n    ")}` : ""}`);
    pass++; return true;
  } catch (e) {
    console.log(`\x1b[31m✗\x1b[0m ${name}\n    ${e.message}`);
    failures.push(`${name}: ${e.message}`); fail++; return false;
  }
}

// ---------------------------------------------------------------------------
// A synthetic message, shaped exactly as Thunderbird would hand it over.
// ---------------------------------------------------------------------------

const STAMP = Date.now();
const SENDER = `zz.e2e.${STAMP}@nordwind-e2e.example`;
const COLLEAGUE = `bob.e2e.${STAMP}@nordwind-e2e.example`;

const BODY = [
  "Hi,", "",
  "Please find the signed quote attached. Bob is copied for the invoicing side.", "",
  "Best regards,", "",
  "-- ",
  "Anna Lindqvist",
  "Chief Technology Officer",
  "Nordwind Solutions AB",
  "Storgatan 12",
  "114 55 Stockholm",
  "M: +46 70 123 45 67",
  "T: +46 8 555 010 20",
  `${SENDER}`,
  "https://www.nordwind-e2e.example",
].join("\n");

const MSG_ID = 4242;
const RFC_ID = `<e2e-${STAMP}@nordwind-e2e.example>`;

messages.set(MSG_ID, {
  header: {
    id: MSG_ID,
    subject: `E2E archive probe ${STAMP}`,
    author: `Anna Lindqvist <${SENDER}>`,
    recipients: [`Kim <${CFG.username}>`],
    ccList: [`Bob Nilsson <${COLLEAGUE}>`, "Outsider <zoe@elsewhere.example>"],
    bccList: [],
    date: new Date("2026-09-09T10:30:00Z"),
    headerMessageId: RFC_ID,
    folder: { accountId: "account1" },
  },
  full: {
    contentType: "multipart/mixed",
    headers: { "message-id": [RFC_ID] },
    parts: [
      { contentType: "text/plain", body: BODY },
      { contentType: "text/html", body: `<p>${BODY.replace(/\n/g, "<br>")}</p>` },
      { contentType: "text/plain", name: "quote.txt", body: "attachment, not body" },
    ],
  },
  attachments: [
    { partName: "1.3", name: "quote.txt", contentType: "text/plain", size: 24 },
    { partName: "1.4", name: "logo.png", contentType: "image/png", size: 12, contentId: "logo@x" },
  ],
});
attachmentFiles.set(`${MSG_ID}:1.3`, new File(["e2e attachment payload\n"], "quote.txt", { type: "text/plain" }));
attachmentFiles.set(`${MSG_ID}:1.4`, new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }));

// ---------------------------------------------------------------------------

console.log(`\nEnd-to-end: add-on modules against ${CFG.url}\n${"─".repeat(62)}\n`);

console.log("\x1b[1m1. Sign in through our own auth module\x1b[0m");
await step("auth.login() stores tokens and never the password", async () => {
  const res = await auth.login({
    baseUrl: CFG.url, clientId: CFG.clientId, clientSecret: CFG.clientSecret,
    username: CFG.username, password: CFG.password,
  });
  const tokens = storage.get("tokens");
  assert.ok(tokens.accessToken, "no access token stored");
  assert.ok(tokens.refreshToken, "no refresh token stored");
  assert.ok(!JSON.stringify([...storage.values()]).includes(CFG.password),
            "THE PASSWORD WAS PERSISTED");
  return `api ${res.apiBase}, refresh token held, password absent from storage`;
});

await step("auth.getAccessToken() refreshes and rotates the refresh token", async () => {
  const before = storage.get("tokens").refreshToken;
  storage.get("tokens").accessExpiresAt = Date.now() - 1;   // force expiry
  const token = await auth.getAccessToken();
  const after = storage.get("tokens").refreshToken;
  assert.ok(token, "no token returned");
  assert.notEqual(after, before, "refresh token was not rotated");
  return "rotated";
});

const client = await CrmClient.create();

console.log("\n\x1b[1m2. Recipient logic on a real message\x1b[0m");
const msg = await readMessage(MSG_ID);

await step("readMessage() extracts body, message-id and attachments", async () => {
  assert.equal(msg.rfcMessageId, RFC_ID.slice(1, -1), "angle brackets not stripped");
  assert.ok(msg.bodyText.includes("Nordwind Solutions AB"), "signature missing from body");
  assert.equal(msg.attachments.length, 2);
  return `message-id ${msg.rfcMessageId}, ${msg.attachments.length} attachments`;
});

await step("buildCandidates() offers the colleague, not the outsider or me", async () => {
  const c = buildCandidates(msg.header, { ownAddresses: [CFG.username.toLowerCase()] });
  assert.equal(c.primary.email, SENDER);
  assert.equal(c.sentByMe, false);
  assert.deepEqual(c.sameDomain.map((x) => x.email), [COLLEAGUE]);
  assert.ok(c.otherDomain.some((x) => x.email === "zoe@elsewhere.example"));
  assert.ok(!c.sameDomain.some((x) => x.email === CFG.username.toLowerCase()));
  return `same-domain: ${c.sameDomain.map((x) => x.email).join(", ")}`;
});

await step("on mail I sent, the To: recipient becomes the target", async () => {
  const sent = {
    ...msg.header,
    author: `Kim <${CFG.username}>`,
    recipients: [`Anna Lindqvist <${SENDER}>`],
    ccList: [`Bob Nilsson <${COLLEAGUE}>`],
  };
  const c = buildCandidates(sent, { ownAddresses: [CFG.username.toLowerCase()] });
  assert.ok(c.sentByMe, "should detect a message I sent");
  assert.equal(c.primary.email, SENDER, "the recipient should be the target, not me");
  assert.deepEqual(c.sameDomain.map((x) => x.email), [COLLEAGUE]);
  assert.ok(!c.sameDomain.some((x) => x.email === CFG.username.toLowerCase()));
  return `target ${c.primary.email}, alternates ${c.sameDomain.map((x) => x.email).join(", ")}`;
});

await step("To: outranks Cc: in the alternatives list", async () => {
  const many = {
    ...msg.header,
    recipients: [`Carl <carl@nordwind-e2e.example>`, `Kim <${CFG.username}>`],
    ccList: [`Bob <${COLLEAGUE}>`],
  };
  const c = buildCandidates(many, { ownAddresses: [CFG.username.toLowerCase()] });
  assert.deepEqual(c.sameDomain.map((x) => x.role), ["to", "cc"], "To: must come first");
  return c.sameDomain.map((x) => `${x.role}:${x.email}`).join(", ");
});

console.log("\n\x1b[1m3. Signature parsing\x1b[0m");
await step("parseContact() fills the create form from the signature", async () => {
  const r = parseContact({ author: msg.header.author, bodyText: msg.bodyText, isAuthor: true });
  assert.equal(r.fields.first_name, "Anna");
  assert.equal(r.fields.last_name, "Lindqvist");
  assert.equal(r.fields.title, "Chief Technology Officer");
  assert.equal(r.fields.account_name, "Nordwind Solutions AB");
  assert.equal(r.fields.phone_mobile, "+46 70 123 45 67");
  assert.equal(r.fields.primary_address_city, "Stockholm");
  return `${r.fields.first_name} ${r.fields.last_name}, ${r.fields.title}, ${r.fields.account_name}`;
});

await step("a copied colleague does not inherit the sender's details", async () => {
  const r = parseContact({ author: `Bob Nilsson <${COLLEAGUE}>`, bodyText: msg.bodyText, isAuthor: false });
  assert.equal(r.fields.first_name, "Bob");
  assert.equal(r.fields.title, undefined, "inherited the sender's job title");
  assert.equal(r.fields.phone_mobile, undefined, "inherited the sender's mobile");
  assert.equal(r.fields.account_name, "Nordwind Solutions AB");
  return "person-level fields withheld, company kept";
});

console.log("\n\x1b[1m4. Sender lookup against the live CRM\x1b[0m");
await step("resolveAddress() reports an unknown sender as not found", async () => {
  const r = await resolveAddress(client, SENDER);
  assert.equal(r.found, false, "a brand-new address should not match");
  assert.equal(r.failures.length, 0, `module lookups failed: ${JSON.stringify(r.failures)}`);
  return `all ${Object.keys(r.hits).length === 0 ? 4 : 4} modules searched, 0 hits, 0 errors`;
});

let contactId = null, accountId = null;
await step("create an Account and Contact from the parsed signature", async () => {
  const parsed = parseContact({ author: msg.header.author, bodyText: msg.bodyText, isAuthor: true });
  const account = await client.createRecord("Accounts", {
    name: parsed.fields.account_name,
    website: parsed.fields.website,
    billing_address_city: parsed.fields.primary_address_city,
  });
  accountId = account.id; cleanup.push({ module: "Accounts", id: accountId });

  const { account_name: _company, ...person } = parsed.fields;
  const contact = await client.createRecord("Contacts", { ...person, account_id: accountId });
  contactId = contact.id; cleanup.push({ module: "Contacts", id: contactId });
  return `Account ${accountId}, Contact ${contactId}`;
});

await step("the new Contact is now found by the sender's address", async () => {
  const r = await resolveAddress(client, SENDER);
  assert.ok(r.found, "the contact we just created was not found");
  const ids = (r.hits.Contacts || []).map((x) => x.id);
  assert.ok(ids.includes(contactId), `expected ${contactId} in ${JSON.stringify(ids)}`);
  return `found in ${Object.keys(r.hits).join(", ")}`;
});

await step("findAccountsByDomain() suggests the Account for the domain", async () => {
  const accounts = await findAccountsByDomain(client, SENDER);
  assert.ok(accounts.some((a) => a.id === accountId), "account not suggested for its own domain");
  return `${accounts.length} suggestion(s)`;
});

await step("searchRecords() finds the new Contact by surname", async () => {
  const r = await searchRecords(client, `Lindqvist`);
  assert.ok(r.found, "surname search returned nothing");
  const ids = (r.hits.Contacts || []).map((x) => x.id);
  assert.ok(ids.includes(contactId), `expected ${contactId} among ${JSON.stringify(ids)}`);
  return `${r.total} hit(s) across ${Object.keys(r.hits).join(", ")}`;
});

await step("searchRecords() finds the Account by company name", async () => {
  const r = await searchRecords(client, "Nordwind Solutions");
  assert.ok(r.found, "company search returned nothing");
  assert.ok((r.hits.Accounts || []).some((a) => a.id === accountId), "the account was not found");
  return `${r.total} hit(s)`;
});

await step("searchRecords() ignores a term too short to be useful", async () => {
  const r = await searchRecords(client, "a");
  assert.equal(r.total, 0);
  assert.deepEqual(r.hits, {}, "a single letter must not fan out across the CRM");
  return "short terms are not sent";
});

await step("searchRecords() reports no matches rather than failing", async () => {
  const r = await searchRecords(client, "zzz-no-such-record-zzz");
  assert.equal(r.found, false);
  assert.equal(r.failures.length, 0, `module errors: ${JSON.stringify(r.failures)}`);
  return "clean empty result";
});

console.log("\n\x1b[1m5. Archiving\x1b[0m");
let emailId = null;
await step("archiveMessage() files the email with its attachment", async () => {
  const res = await archiveMessage(client, msg, { type: "Contacts", id: contactId, label: "Anna" });
  assert.ok(res.created, "email record was not created");
  assert.ok(res.emailId, "no email id returned");
  emailId = res.emailId; cleanup.push({ module: "Emails", id: emailId });
  for (const a of res.attachments) cleanup.push({ module: "Notes", id: a.noteId });

  assert.equal(res.attachments.length, 1,
    `expected 1 attachment (inline image skipped), got ${res.attachments.length}`);
  assert.equal(res.attachments[0].name, "quote.txt");
  return `Email ${emailId}, ${res.attachments.length} note(s), ${res.warnings.length} warning(s)`
       + (res.warnings.length ? `\n${res.warnings.join("\n")}` : "");
});

await step("the archived Email reads back correctly from the CRM", async () => {
  const rec = await client.getRecord("Emails", emailId);
  assert.equal(rec.name, `E2E archive probe ${STAMP}`, "subject wrong");
  assert.equal(rec.message_id, msg.rfcMessageId, "message_id wrong");
  assert.equal(rec.parent_type, "Contacts", "parent_type wrong");
  assert.equal(rec.parent_id, contactId, "parent_id wrong");
  assert.ok(String(rec.description).includes("signed quote"), "body not stored");
  // from_addr is write-only; from_addr_name is what the API returns.
  assert.ok(String(rec.from_addr_name).includes(SENDER),
            `sender not stored: from_addr_name=${JSON.stringify(rec.from_addr_name)}`);
  assert.ok(String(rec.date_sent_received).startsWith("2026-09-09"),
            `date wrong: ${rec.date_sent_received}`);
  return `subject, message_id, parent, body, sender and date all match`;
});

await step("the archived Email is dated by the message, not by now", async () => {
  const rec = await client.getRecord("Emails", emailId);
  const entered = String(rec.date_entered || "");
  // The fixture message is dated 2026-09-09T10:30:00Z.
  assert.ok(entered.startsWith("2026-09-09T10:30"),
            `date_entered should carry the send time, got ${entered}`);
  return `date_entered ${entered}`;
});

await step("the attachment exists as a Note under the Email", async () => {
  const notes = await client.getRecords("Notes", {
    filter: { parent_id: { eq: emailId } }, size: 10,
  });
  assert.ok(notes.length >= 1, "no note created");
  assert.ok(notes.some((n) => n.name === "quote.txt"), "quote.txt note missing");
  return `${notes.length} note(s): ${notes.map((n) => n.name).join(", ")}`;
});

await step("archiving the same message again re-files instead of duplicating", async () => {
  const res = await archiveMessage(client, msg, { type: "Accounts", id: accountId, label: "Nordwind" });
  assert.ok(res.updated, "should have updated, not created");
  assert.ok(!res.created, "created a duplicate");
  assert.equal(res.emailId, emailId, "re-parented a different record");

  const rec = await client.getRecord("Emails", emailId);
  assert.equal(rec.parent_type, "Accounts", "not re-parented");
  assert.equal(rec.parent_id, accountId);

  const all = await client.getRecords("Emails", {
    filter: { message_id: { eq: msg.rfcMessageId } }, size: 10,
  });
  assert.equal(all.length, 1, `duplicate email records: ${all.length}`);
  return "single record, re-parented to the Account";
});

await step("undo deletes exactly what an archive created", async () => {
  // Archive a fresh message, then reverse it and confirm nothing is left.
  const stamp2 = Date.now();
  const solo = structuredClone({
    ...msg,
    header: { ...msg.header, headerMessageId: `<undo-${stamp2}@nordwind-e2e.example>` },
  });
  solo.rfcMessageId = `undo-${stamp2}@nordwind-e2e.example`;
  solo.attachments = [];

  const res = await archiveMessage(client, solo, { type: "Contacts", id: contactId, label: "Anna" });
  assert.ok(res.created, "setup: the probe email was not created");

  await client.request("DELETE", `/module/Emails/${res.emailId}`);
  const gone = await client.getRecords("Emails", {
    filter: { message_id: { eq: solo.rfcMessageId } }, size: 2,
  });
  assert.equal(gone.length, 0, "the email should be gone after deletion");
  return "created then removed cleanly";
});

await step("re-filing records the previous parent, so undo can restore it", async () => {
  const before = await client.getRecord("Emails", emailId);
  const res = await archiveMessage(client, msg, { type: "Contacts", id: contactId, label: "Anna" });
  assert.ok(res.updated, "should have re-filed rather than created");
  assert.ok(res.previousParent, "no previous parent captured — undo would delete instead of restore");
  assert.equal(res.previousParent.id, before.parent_id);

  // Put it back, exactly as undo would.
  await client.updateRecord("Emails", emailId, {
    parent_type: res.previousParent.type, parent_id: res.previousParent.id,
  });
  const after = await client.getRecord("Emails", emailId);
  assert.equal(after.parent_id, before.parent_id, "restore did not put it back");
  return `previous parent ${res.previousParent.type}/${res.previousParent.id.slice(0, 8)}… restored`;
});

await step("a same-message-id email from a different sender is NOT hijacked", async () => {
  const impostor = structuredClone({
    ...msg,
    header: { ...msg.header, author: "Attacker <evil@elsewhere.example>" },
  });
  impostor.attachments = [];
  const res = await archiveMessage(client, impostor, { type: "Contacts", id: contactId, label: "Anna" });
  assert.ok(res.created, "re-used a record belonging to a different sender");
  cleanup.push({ module: "Emails", id: res.emailId });
  assert.ok(res.warnings.some((w) => /different sender/i.test(w)), "no warning raised");
  return "separate record created, warning raised";
});

await step("the address book turns a CRM search into usable vCards", async () => {
  const found = await searchRecords(client, "Lindqvist", { modules: ["Contacts", "Leads"], size: 25 });
  const cards = Object.entries(found.hits)
    .flatMap(([module, recs]) => recs.map((r) => ({ ...r, module })))
    .filter(usableForAddressBook)
    .map((rec) => recToCard(rec));
  assert.ok(cards.length >= 1, "no autocomplete results for a contact that exists");
  const card = cards[0];
  assert.match(card, /^BEGIN:VCARD/);
  assert.match(card, /EMAIL:/);
  assert.match(card, /END:VCARD$/);
  assert.ok(card.includes(SENDER), `the card carries no usable address:\n${card}`);
  return `${cards.length} card(s), first is ${card.split("\r\n").find((l) => l.startsWith("FN:"))}`;
});

await step("an attachment can be stored in the Documents module", async () => {
  const doc = await client.createRecord("Documents", {
    document_name: "e2e-contract.pdf",
    filename: "e2e-contract.pdf",
    filecontents: Buffer.from("%PDF-1.4 e2e probe\n").toString("base64"),
    description: "probe",
    revision: "1",
  });
  assert.ok(doc?.id, "no id returned for the Document");
  cleanup.push({ module: "Documents", id: doc.id });

  const back = await client.getRecord("Documents", doc.id);
  assert.equal(back.document_name, "e2e-contract.pdf");
  return `Documents/${doc.id.slice(0, 8)}… stored and readable`;
});

console.log("\n\x1b[1m6. Records created from an email\x1b[0m");

for (const kind of ["Cases", "Opportunities", "Meetings", "Tasks"]) {
  await step(`create a ${{Cases:"Case",Opportunities:"Opportunity",Meetings:"Meeting",Tasks:"Task"}[kind]} from the message and link it`, async () => {
    const spec = buildRecord(kind, msg, {
      parent: { type: "Contacts", id: contactId },
      accountId,
    });
    const created = await client.createRecord(spec.module, spec.attributes);
    assert.ok(created?.id, `no id returned for ${kind}`);
    cleanup.push({ module: kind, id: created.id });

    for (const rel of spec.relate) {
      await client.createRelationship(spec.module, created.id, rel.module, rel.id);
    }

    // Read it back: the description must carry the message, not be empty.
    const rec = await client.getRecord(kind, created.id);
    assert.ok(String(rec.name || "").trim(), `${kind} was created without a name`);
    assert.ok(String(rec.description || "").includes("signed quote"),
              `${kind} description does not carry the email body`);
    return `${kind}/${created.id.slice(0, 8)}… “${rec.name}”`;
  });
}

// The one Case-like link SuiteCRM grants a Lead. It was missing until the module
// metadata was read properly, so it is proved here against the real server
// rather than trusted to a unit test's idea of the payload.
await step("an Opportunity created from a Lead is related to that Lead", async () => {
  const lead = await client.createRecord("Leads", {
    last_name: `E2E Lead ${STAMP}`, account_name: "E2E Lead Co",
  });
  cleanup.push({ module: "Leads", id: lead.id });

  const spec = buildRecord("Opportunities", msg, { parent: { type: "Leads", id: lead.id } });
  assert.deepEqual(spec.relate, [{ module: "Leads", id: lead.id }],
    "buildRecord did not ask for the Leads relationship");

  const opp = await client.createRecord("Opportunities", spec.attributes);
  cleanup.push({ module: "Opportunities", id: opp.id });
  for (const rel of spec.relate) {
    await client.createRelationship(spec.module, opp.id, rel.module, rel.id);
  }

  const related = await client.request("GET", `/module/Opportunities/${opp.id}/relationships/leads`);
  const ids = (related?.data || []).map((r) => r.id);
  assert.ok(ids.includes(lead.id), `the Lead is not on the Opportunity (got ${ids.join(",") || "none"})`);
  return `Opportunities/${opp.id.slice(0, 8)}… ← Leads/${lead.id.slice(0, 8)}…`;
});

// The kinds offered must match what the server will actually accept, so the
// picker never shows an option that would create something attached to nobody.
await step("SuiteCRM refuses exactly the links the picker hides", async () => {
  const { creatableFor } = await import("../src/lib/createFromEmail.js");
  const lead = await client.createRecord("Leads", { last_name: `E2E Reject ${STAMP}` });
  cleanup.push({ module: "Leads", id: lead.id });
  const target = await client.createRecord("Prospects", { last_name: `E2E Reject T ${STAMP}` });
  cleanup.push({ module: "Prospects", id: target.id });
  const kase = await client.createRecord("Cases", { name: `E2E Reject Case ${STAMP}` });
  cleanup.push({ module: "Cases", id: kase.id });

  const checks = [
    ["Cases", kase.id, "Leads", lead.id, { type: "Leads", id: lead.id }, "Cases"],
    ["Cases", kase.id, "Prospects", target.id, { type: "Prospects", id: target.id }, "Cases"],
  ];
  for (const [mod, id, relMod, relId, parent, kind] of checks) {
    assert.ok(!creatableFor(parent).includes(kind),
      `the picker offers ${kind} for a ${parent.type}, so it had better be linkable`);
    let refused = false;
    try {
      await client.createRelationship(mod, id, relMod, relId);
    } catch { refused = true; }
    assert.ok(refused, `SuiteCRM accepted ${mod} -> ${relMod}; the picker should offer it`);
  }
  return "Case→Lead and Case→Target both refused, as the picker assumes";
});

await step("an Opportunity satisfies every field SuiteCRM requires", async () => {
  const spec = buildRecord("Opportunities", msg, { accountId });
  const created = await client.createRecord("Opportunities", spec.attributes);
  cleanup.push({ module: "Opportunities", id: created.id });
  const rec = await client.getRecord("Opportunities", created.id);
  assert.ok(rec.sales_stage, "sales_stage was not stored");
  assert.ok(rec.date_closed, "date_closed was not stored");
  return `stage ${rec.sales_stage}, closes ${String(rec.date_closed).slice(0, 10)}`;
});

console.log("\n\x1b[1m7. Cleanup\x1b[0m");
for (const { module, id } of cleanup.reverse()) {
  await step(`delete ${module}/${id}`, async () => {
    await client.request("DELETE", `/module/${module}/${id}`);
    return "removed";
  });
}

console.log("\n" + "─".repeat(62));
console.log(`\x1b[1mEnd-to-end: ${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log("\nFailures:"); for (const f of failures) console.log("  • " + f); }
process.exit(fail ? 1 : 0);
