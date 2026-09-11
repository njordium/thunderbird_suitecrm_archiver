/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Local-only contact extraction from an email: signature block, headers, and
 * any attached vCard. Nothing leaves the machine.
 *
 * Every field carries a confidence. The UI pre-fills `high` silently and
 * highlights `medium`/`low` for the user to confirm before saving, so a bad
 * guess never lands in the CRM unnoticed.
 */

import { parseMailbox, domainOf, isConsumerDomain, localPartOf } from "./addresses.js";

const HIGH = "high", MEDIUM = "medium", LOW = "low";

/**
 * A legal form only counts at the END of a line, and only when the line looks
 * like a company name. Matching these anywhere is how "Hi KB," became a company:
 * KB is a Swedish kommanditbolag, and also somebody's initials.
 */
const LEGAL_SUFFIX_END =
  /\b(AB|HB|KB|AS|A\/S|ApS|Oy|Oyj|GmbH|mbH|AG|Ltd|Limited|LLC|L\.L\.C|Inc|Corp|Co|PLC|B\.V|N\.V|S\.A|SARL|S\.R\.L|SpA|Pty|Group|Holding|Holdings|Consulting|Technologies|Solutions|Partners|Labs|Systems|Software|Ventures)\b\.?\s*$/i;

/** Openings and closings, never part of a signature's data. */
const GREETING = /^(hi|hej|hello|hey|dear|good\s+(morning|afternoon|evening)|tack|thanks|thank\s+you|cheers)\b/i;

const SIGN_OFF = /^(regards|best\s+regards|kind\s+regards|warm\s+regards|many\s+thanks|thanks|thank\s+you|sincerely|yours(\s+\w+)?|cheers|br|mvh|med\s+v(ä|a)nliga\s+h(ä|a)lsningar|v(ä|a)nliga\s+h(ä|a)lsningar|h(ä|a)lsningar|mit\s+freundlichen\s+gr(ü|u)(ß|ss)en|cordialement|saludos|(med\s+)?venn?lig\s+hilsen|(med\s+)?hilsen|(med\s+)?de\s+bedste\s+hilsner|ystävällisin\s+terveisin|terveisin)\b[,.!]?\s*$/i;

/**
 * Lines that carry no contact data and actively mislead the extractors:
 * inline-image placeholders whose ids look like phone numbers, cid: references,
 * certification strings whose standard numbers look like postcodes, and
 * marketing calls to action.
 */
const NOISE_LINE = [
  /^\s*\[(signature|image|cid)[^\]]*\]\s*$/i,
  /^\s*\[cid:[^\]]*\]\s*$/i,
  /\b(ISO|IEC|ANSI|NIST|PCI[- ]?DSS|SOC)\s*[\/\d]/i,
  /^\s*(CISM|CISA|CISSP|CIPP|PMP|MBA|CPA)\b/i,
  /^\s*(leave us a review|follow us|connect with me|book a meeting|schedule a call|unsubscribe)/i,
  /^\s*(confidential|this (e-?mail|message)|disclaimer|please consider the environment)/i,
  /^\s*(när du skickar|läs mer om vad det innebär|denna e-post|detta meddelande|dette er|denne e-?post)/i,
  /^\s*(download my public key|pgp|gpg fingerprint)/i,
];

const isNoise = (line) => NOISE_LINE.some((re) => re.test(line));

/** Nordic job titles are compounds, so a bare \bChef\b never matches them. */
const TITLE_COMPOUND = /\b\p{L}*(chef|ansvarig|ledare|konsult|direkt(ö|o)r|sjef|leder|s(ä|a)ljare|utvecklare|handl(ä|a)ggare|f(ö|o)rvaltare|controller|revisor|r(å|a)dgivare)\b/iu;

const TITLE_WORDS =
  /\b(CEO|CTO|CFO|COO|CIO|CMO|VD|VP|SVP|EVP|President|Founder|Co-?founder|Owner|Partner|Director|Head\s+of|Chief|Manager|Chef|Lead|Principal|Senior|Junior|Engineer|Developer|Utvecklare|Architect|Arkitekt|Consultant|Konsult|Analyst|Analytiker|Specialist|Advisor|Rådgivare|Sales|Säljare|Account\s+Executive|Marketing|Product|Project|Projektledare|Program|Designer|Administrator|Coordinator|Samordnare|Ansvarig|Assistant|Officer|Supervisor|Controller|Recruiter|Researcher|Scientist|Auktoriserad|Verkst(ä|a)llande|Kontorschef|Redovisningskonsult|Inköpare|Upphandlare|Utredare|Associate|Executive|Representative|Recruitment|Technician|Accountant|Solutions|Insights)\b/iu;

const SOCIAL_HOST = /(linkedin|twitter|x\.com|facebook|instagram|youtube|github|mastodon|bsky)\./i;

/** Is this a plain web address, rather than some other scheme entirely? */
function isWebUrl(value) {
  const s = String(value || "").trim();
  if (!s) return false;
  if (/^www\./i.test(s)) return true;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalise a signature line before anything reads it.
 *
 * Mail clients render links as `text<https://real/target>`, and tracking
 * wrappers bury the real address in a query string. Both leave long digit runs
 * lying around that the phone matcher would otherwise happily collect.
 */
/**
 * Some clients emit a signature as `*Name*Title` on a single line, the asterisks
 * being bold markers rather than text. Break each bold run onto its own line so
 * the name and title are seen separately.
 */
function normaliseBlock(block) {
  return String(block || "")
    .replace(/\*([^*\n]{2,60})\*/g, "\n$1\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function cleanLine(line) {
  return String(line || "")
    // `label<https://...>` -> `label`, keeping a bare `<https://...>` as the URL.
    // `label<https://real/target>` keeps the label; the target is recovered
    // separately by the bare-URL rule below, so it is intentionally dropped here.
    .replace(/([^\s<>]+)<https?:\/\/[^>]+>/g, (_m, label) => label)
    .replace(/<(https?:\/\/[^>]+)>/g, " $1 ")
    .replace(/\[(signature|image|cid)[^\]]*\]/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Lines that carry a registration number rather than a telephone number.
 *
 * A legal footer ("Org.nr/Corp. Id. No: 556369-6631, VAT No: SE556369663101")
 * is digits with human separators, which is exactly the shape a phone number
 * has. One of these landed in phone_work from a real message.
 */
const REGISTRATION_LINE =
  /\b(org\.?\s?nr|orgnr|org\.?\s?no|corp\.?\s?id|company\s+(no|number|reg)|reg\.?\s?no|registration\s+no|commercial\s+register|vat|moms|momsreg|cvr|business\s+id|y-tunnus|siret|siren|ust-?id|kvk|handelsregister)\b/i;

const PHONE_LABEL = {
  mobile: /\b(m|mob|mobil|mobile|cell|cellular|gsm|handy)\b\s*[.:]?\s*$/i,
  fax:    /\b(f|fax|telefax)\b\s*[.:]?\s*$/i,
  // A switchboard is the company's number, not this person's direct line.
  other:  /\b(v(ä|a)xel|vxl|switchboard|reception|kontor|office|hem|home)\b\s*[.:]?\s*$/iu,
  work:   /\b(t|tel|telephone|telefon|phone|ph|work|direct|direkt|dir|d|arbete)\b\s*[.:]?\s*$/i,
};

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

/** Depth-first walk of a MessagePart tree, collecting the best text/plain body. */
export function extractPlainText(part, acc = { text: "", html: "" }) {
  if (!part) return acc;
  const type = (part.contentType || "").toLowerCase();
  if (type.startsWith("text/plain") && part.body && !isAttachmentPart(part)) {
    acc.text += (acc.text ? "\n" : "") + part.body;
  } else if (type.startsWith("text/html") && part.body && !isAttachmentPart(part)) {
    acc.html += (acc.html ? "\n" : "") + part.body;
  }
  for (const child of part.parts || []) extractPlainText(child, acc);
  return acc;
}

const isAttachmentPart = (p) =>
  Boolean(p.name) || /attachment/i.test(p.headers?.["content-disposition"]?.[0] || "");

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop the quoted reply/forward trail so we parse only what this sender wrote. */
export function stripQuotedReply(text) {
  const lines = String(text || "").split(/\r?\n/);
  const cutMarkers = [
    /^\s*-{2,}\s*(Original Message|Ursprungligt meddelande|Opprinnelig melding|Forwarded message|Vidarebefordrat|Videresendt)/i,
    /^\s*_{5,}\s*$/,
    /^\s*-{5,}\s*$/,
    // "On … wrote:" and its Nordic, German, Dutch and French equivalents.
    /^\s*On .{5,120}\bwrote:\s*$/i,
    // The same line, wrapped: Gmail breaks before "wrote:" when the address is long.
    /^\s*On .{5,160}<[^>]+>\s*$/i,
    /^\s*wrote:\s*$/i,
    /^\s*Den .{5,120}\b(skrev|wrote)\b.*:?\s*$/i,
    /^\s*(Am|Op) .{5,120}\b(schrieb|schreef)\b.*:?\s*$/i,
    /^\s*Le .{5,120}\ba écrit\b.*:?\s*$/i,
    // Outlook-style quoted headers, in the languages this mailbox actually sees.
    /^\s*\*?(From|Från|Fra|Fra:|De|Von|Van)\*?\s*:\s*\S/i,
    /^\s*\*?(Sent|Skickat|Sendt|Enviado|Gesendet|Verzonden)\*?\s*:\s*\S/i,
    /^\s*\*?(To|Till|Til|Para|An|Aan)\*?\s*:\s*\S/i,
    /^\s*\*?(Subject|Ämne|Emne|Asunto|Betreff|Onderwerp)\*?\s*:\s*\S/i,
    /^\s*Sent from my \w+/i,
    /^\s*Skickat från min \w+/i,
  ];
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith(">")) { end = Math.min(end, i); break; }
    if (cutMarkers.some((re) => re.test(lines[i]))) { end = Math.min(end, i); break; }
  }
  return lines.slice(0, end).join("\n").trimEnd();
}

/**
 * Isolate the signature block.
 *
 * Order of preference:
 *   1. The RFC 3676 `-- ` separator, which is unambiguous.
 *   2. Everything after the last sign-off ("Regards," / "Med vänliga hälsningar").
 *      This is the reliable signal in real mail, where clients rarely emit `-- `.
 *
 * There is deliberately no "just take the last N lines" fallback. On a short
 * message that swallowed the greeting and the body, so a "Hi KB," opening became
 * the company name and a sentence became a job title. Returning nothing is
 * better than returning the message back as contact details.
 */
export function extractSignatureBlock(text, senderName = "") {
  const body = stripQuotedReply(text);
  const lines = body.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^--\s?$/.test(lines[i])) {
      return { block: lines.slice(i + 1).join("\n").trim(), delimited: true };
    }
  }

  // The last sign-off, so a quoted "Regards" earlier in the body loses.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SIGN_OFF.test(lines[i].trim())) {
      const after = lines.slice(i + 1);
      // The line right after a sign-off is usually just a first name; keep it,
      // the name extractor prefers the header anyway.
      const block = after.join("\n").trim();
      if (block) return { block, delimited: false, signOff: true };
    }
  }

  // No delimiter and no sign-off. Plenty of corporate mail ends that way: the
  // client appends a block of images, a name, a title and a phone number with
  // nothing to introduce it. The sender's own name is the anchor. Without it
  // this would be guessing at the last few lines of a message, which is how
  // body text ends up in a CRM record.
  if (senderName) {
    const wanted = senderName.toLowerCase().replace(/[^a-z]+/g, " ").trim();
    const surname = wanted.split(" ").filter((w) => w.length > 2).pop();
    const tail = Math.max(0, lines.length - 14);
    for (let i = lines.length - 1; i >= tail; i--) {
      const line = lines[i].toLowerCase().replace(/[^a-z]+/g, " ").trim();
      if (!line || line.length > 60) continue;
      const named = line === wanted || (surname && line.endsWith(surname) && line.split(" ").length <= 4);
      if (!named) continue;
      const block = lines.slice(i).join("\n").trim();
      if (block) return { block, delimited: false, signOff: false, anchored: true };
    }
  }

  return { block: "", delimited: false, signOff: false };
}

// ---------------------------------------------------------------------------
// vCard (preferred when present, structured beats heuristics)
// ---------------------------------------------------------------------------

export function parseVCard(raw) {
  const text = String(raw || "").replace(/\r\n[ \t]/g, "").replace(/\r\n/g, "\n");
  if (!/BEGIN:VCARD/i.test(text)) return null;

  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const [, prop, paramStr, value] = m;
    const key = prop.toUpperCase();
    const params = paramStr.toUpperCase();
    const v = value.trim();
    if (!v) continue;

    switch (key) {
      case "N": {
        const [last, first] = v.split(";");
        if (first) out.first_name = first.trim();
        if (last) out.last_name = last.trim();
        break;
      }
      case "FN": out.full_name = v; break;
      case "ORG": out.account_name = v.split(";")[0].trim(); break;
      case "TITLE": out.title = v; break;
      case "EMAIL": if (!out.email1) out.email1 = v.toLowerCase(); break;
      case "TEL":
        if (/CELL|MOBILE/.test(params)) out.phone_mobile ||= v;
        else if (/FAX/.test(params)) out.phone_fax ||= v;
        else out.phone_work ||= v;
        break;
      // Only a web address belongs in a website field. A vCard comes from an
      // attachment, so this value is untrusted: javascript:, data: and file:
      // URLs would otherwise be written to the CRM, where they may later be
      // rendered as a link for someone else to click.
      case "URL": if (isWebUrl(v)) out.website ||= v; break;
      case "ADR": {
        const p = v.split(";");
        out.primary_address_street ||= [p[1], p[2]].filter(Boolean).join(" ").trim();
        out.primary_address_city ||= (p[3] || "").trim();
        out.primary_address_state ||= (p[4] || "").trim();
        out.primary_address_postalcode ||= (p[5] || "").trim();
        out.primary_address_country ||= (p[6] || "").trim();
        break;
      }
      default: break;
    }
  }

  if (!out.first_name && out.full_name) Object.assign(out, splitPersonName(out.full_name));
  delete out.full_name;
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Field extraction from a signature block
// ---------------------------------------------------------------------------

/** Credentials and generational suffixes that follow a comma but are not a name. */
const NAME_SUFFIX = /^(PhD|Ph\.D\.?|MD|M\.D\.?|MBA|MSc|BSc|CPA|Esq\.?|Jr\.?|Sr\.?|I{2,3}|IV)$/i;

export function splitPersonName(full) {
  let cleaned = String(full || "").replace(/\s*\((.*?)\)\s*/g, " ").trim();

  // "Doe, Jane", the Last, First form that Exchange global address lists use.
  // Distinguish it from "Jane Doe, PhD", where the tail is a credential.
  const comma = cleaned.indexOf(",");
  if (comma > 0) {
    const head = cleaned.slice(0, comma).trim();
    const tail = cleaned.slice(comma + 1).trim();
    const tailWords = tail.split(/\s+/).filter(Boolean);

    if (tail && !tailWords.every((w) => NAME_SUFFIX.test(w.replace(/[.,]$/, "")))) {
      // A real given name follows the comma: swap the halves.
      return {
        first_name: tailWords.join(" "),
        last_name: head,
      };
    }
    cleaned = head; // just a credential, drop it
  }

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { last_name: parts[0] };

  // Keep nobiliary particles with the surname: "van der Berg", "de Boer".
  const particles = new Set(["van", "von", "de", "der", "den", "del", "di", "da", "dos",
                             "la", "le", "af", "bin", "al", "mc", "mac", "o'", "st", "ter", "ten"]);
  let split = parts.length - 1;
  for (let i = 1; i < parts.length - 1; i++) {
    if (particles.has(parts[i].toLowerCase())) { split = i; break; }
  }
  return {
    first_name: parts.slice(0, split).join(" "),
    last_name: parts.slice(split).join(" "),
  };
}

/**
 * Phone numbers, but only where there is a reason to believe it is one.
 *
 * A bare run of digits is NOT accepted. Signatures are full of them, inline
 * image placeholders like `[signature_4149225487]`, certification numbers,
 * tracking ids in link query strings, and treating those as phone numbers put
 * pure noise into the CRM. A number now needs a label ("M:", "Tel"), an
 * international prefix, or human separators before it counts.
 */
function extractPhones(block) {
  const found = { phone_work: null, phone_mobile: null, phone_fax: null, phone_other: null };
  const re = /(\+?\d[\d\s().\-\u2010-\u2015]{6,}\d)/g;

  for (const rawLine of block.split(/\r?\n/)) {
    if (isNoise(rawLine)) continue;
    if (REGISTRATION_LINE.test(rawLine)) continue;   // a legal footer, not a number to call
    // URLs carry timestamps and ids that look exactly like phone numbers.
    const line = cleanLine(rawLine)
      .replace(/<(?:tel|callto):[^>]*>/gi, " ")     // "Mobile: +45 2213 6113<tel:+45%202213%206113>"
      .replace(/<mailto:[^>]*>/gi, " ")
      .replace(/https?:\/\/\S+/g, " ");
    if (!line) continue;

    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const raw = m[1].trim();
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) continue;
      if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(raw)) continue;          // a date
      if (/^(19|20)\d{2}$/.test(digits)) continue;                   // a year

      const before = line.slice(0, m.index);
      let slot = null;
      if (PHONE_LABEL.mobile.test(before)) slot = "phone_mobile";
      else if (PHONE_LABEL.fax.test(before)) slot = "phone_fax";
      else if (PHONE_LABEL.other.test(before)) slot = "phone_other";
      else if (PHONE_LABEL.work.test(before)) slot = "phone_work";
      else if (raw.startsWith("+")) slot = "phone_work";              // international
      else if (/\d[\s().-]+\d/.test(raw)) slot = "phone_work";       // humanly grouped
      else continue;                                                  // unlabelled digit run

      // Swedish and Norwegian mobile ranges, when nothing else said otherwise.
      if (slot === "phone_work" && (/^\+?4[067]7\d/.test(digits) || /^07\d/.test(digits))) {
        slot = "phone_mobile";
      }
      if (!found[slot]) found[slot] = normalisePhone(raw);
    }
  }
  return found;
}

const normalisePhone = (s) => s.replace(/[\u2010-\u2015]/g, "-").replace(/\s{2,}/g, " ").trim();

function extractWebsite(block) {
  for (const rawLine of block.split(/\r?\n/)) {
    if (isNoise(rawLine)) continue;
    const line = cleanLine(rawLine);
    const m = line.match(/\b((?:https?:\/\/|www\.)[^\s<>"')\]]+)/i);
    if (!m) continue;
    let url = m[1].replace(/[.,;:]$/, "");
    if (SOCIAL_HOST.test(url)) continue;
    // Unwrap a tracking redirect and use the destination it names.
    const wrapped = url.match(/[?&](?:q|url|u)=([^&]+)/);
    if (wrapped) {
      try {
        const inner = decodeURIComponent(wrapped[1]);
        if (/^https?:\/\//i.test(inner)) url = inner.replace(/\/$/, "");
      } catch { /* keep the outer URL */ }
    }
    if (SOCIAL_HOST.test(url)) continue;
    return url.startsWith("http") ? url : "https://" + url;
  }
  return null;
}

function extractSocial(block) {
  const m = cleanLine(block.replace(/\n/g, " "))
    .match(/\b(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s<>"')\]]+/i);
  return m ? (m[0].startsWith("http") ? m[0] : "https://" + m[0]) : null;
}

/**
 * Hosts whose registrable domain is two labels deep, so the label before them is
 * part of the domain rather than a subdomain. Not exhaustive, and does not need
 * to be: a miss leaves the address as it was rather than making it wrong.
 */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz", "co.za", "org.za",
  "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.sg", "com.hk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "co.in", "co.il", "co.kr",
]);

/**
 * A homepage guessed from an email domain.
 *
 * Companies overwhelmingly serve their site at www, so www.example.com is the
 * better guess for a bare domain and the one a person would type. But the prefix
 * only makes sense on a registrable domain: mail from a subdomained host such as
 * oe.example.com would become www.oe.example.com, which is almost certainly
 * nothing at all. So www is added only where no subdomain is present already,
 * counting a two-part suffix as one label.
 *
 * Guessed either way, so the form marks it and the user confirms before saving.
 */
export function homepageFromDomain(domain) {
  const host = String(domain || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!host || !host.includes(".")) return null;

  if (host.startsWith("www.")) return `https://${host}`;

  const labels = host.split(".");
  const registrableLabels = TWO_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;

  // More labels than the registrable domain needs means a subdomain is already
  // there, and prefixing www would invent a host nobody serves.
  if (labels.length > registrableLabels) return `https://${host}`;

  return `https://www.${host}`;
}

/** Turn a domain into a plausible company name when nothing better exists. */
/**
 * Labels that are part of the mail plumbing or a region, never the company.
 *
 * nl.verizon.com was becoming the company "Nl". A country or a mail host in
 * front of the real name is common in large organisations, so those labels are
 * stepped over.
 */
const NON_COMPANY_LABEL =
  /^(www|mail|smtp|mx|email|e?mailer|corp|corporate|group|emea|apac|amer|latam|eu|us|uk|nl|de|fr|se|no|dk|fi|es|it|pl|br|ch|at|be|ie|cz|pt|in|cn|jp|au|ca)$/i;

function companyFromDomain(domain) {
  if (!domain || isConsumerDomain(domain)) return null;

  const labels = domain.toLowerCase().split(".").filter(Boolean);
  // Drop the public suffix, roughly: the last label, and the one before it when
  // it is itself a suffix piece such as co.uk or com.br.
  const trimmed = labels.slice(0, /^(co|com|org|net|gov|ac|edu)$/i.test(labels.at(-2) || "")
    ? -2 : -1);

  const core = trimmed.find((label) => !NON_COMPANY_LABEL.test(label)) || trimmed[0];
  if (!core || core.length < 2) return null;
  return core.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The organisation name.
 *
 * A legal form must sit at the END of a line on a line that reads like a company
 * name. Matching it anywhere turned the greeting "Hi KB," into a company, KB
 * being a Swedish kommanditbolag as well as somebody's initials.
 */
function extractOrganisation(block, domain) {
  const lines = block.split(/\r?\n/)
    .filter((l) => !isNoise(l))
    .map(cleanLine)
    .filter(Boolean);

  const plausible = (line) =>
    line.length <= 70 &&
    !line.includes("@") &&
    !/https?:\/\//i.test(line) &&
    !GREETING.test(line) &&
    !/[?!]/.test(line) &&
    /[A-Za-zÀ-ÿ]/.test(line);

  // A company line often carries something else after it: "Dell Technologies |
  // Sweden", "Acme AB • Stockholm". Each segment is considered on its own, so
  // the suffix does not have to be the last thing on the line.
  const segments = (line) =>
    line.split(/\s*[|•·]\s*/).map((part) => part.replace(/^[|•·\-\s]+/, "").trim()).filter(Boolean);

  for (const line of lines) {
    if (!plausible(line)) continue;
    for (const part of segments(line)) {
      if (LEGAL_SUFFIX_END.test(part)) return { value: part, confidence: HIGH };
    }
  }

  // A line echoing the sender's domain, e.g. "Northwind Traders" for northwind.example.
  const core = domain ? domain.replace(/^www\./, "").split(".")[0].toLowerCase() : "";
  // A line echoing the sender's domain. Two forms are worth having: the name on
  // its own ("Northwind Traders" for northwind.example), and the name the
  // company actually writes, which is usually the domain plus a word or two
  // ("Dell Technologies" for dell.com, "7N A/S" for 7n.com). The domain core
  // can be as short as two characters, which is why this no longer insists on
  // four: 7n.com was getting "7n" while the signature said "7N A/S".
  if (core.length >= 2) {
    for (const line of lines) {
      if (!plausible(line) || line.split(/\s+/).length > 6) continue;
      for (const part of segments(line)) {
        const flat = part.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (flat === core) return { value: part, confidence: HIGH };

        // The expanded form, but not a postal address that happens to start
        // with the company name: those run long and carry a street number.
        if (flat.startsWith(core) && part.split(/\s+/).length <= 4 && !/\d{2,}/.test(part)) {
          return { value: part, confidence: MEDIUM };
        }
      }
    }
  }

  const fromDomain = companyFromDomain(domain);
  return fromDomain ? { value: fromDomain, confidence: LOW } : null;
}

function looksLikePersonName(line) {
  const s = line.trim();
  if (!s || s.length > 45) return false;
  if (/[@\d|]/.test(s)) return false;
  if (/^https?:/i.test(s)) return false;
  if (LEGAL_SUFFIX_END.test(s)) return false;
  if (GREETING.test(s) || isNoise(s)) return false;
  if (TITLE_WORDS.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[\p{Lu}\p{Lo}][\p{L}'’\-.]*$/u.test(w) || /^[a-z]{2,3}$/.test(w));
}

function extractTitle(block, nameLineIdx) {
  const lines = block.split(/\r?\n/).map((l) => l.trim());
  // A title usually sits immediately under the name.
  if (nameLineIdx >= 0) {
    for (let i = nameLineIdx + 1; i < Math.min(nameLineIdx + 3, lines.length); i++) {
      const l = lines[i];
      if (l && l.length <= 70 && !l.includes("@") && (TITLE_WORDS.test(l) || TITLE_COMPOUND.test(l))) {
        return { value: l.replace(/^[|•·\-\s]+/, "").split(/\s*[|•·]\s*/)[0].trim(), confidence: HIGH };
      }
    }
  }
  for (const l of lines) {
    if (l && l.length <= 70 && !l.includes("@") && (TITLE_WORDS.test(l) || TITLE_COMPOUND.test(l)) && !LEGAL_SUFFIX_END.test(l)) {
      return { value: l.replace(/^[|•·\-\s]+/, "").split(/\s*[|•·]\s*/)[0].trim(), confidence: MEDIUM };
    }
  }
  return null;
}

/**
 * A postal address, only when a street line and a postcode line sit together.
 *
 * Requiring both is the point. A lone "number followed by words" pattern matched
 * "ISO/IEC 27001 Lead Auditor" and filed 27001 as a postcode in the city of
 * "Lead Auditor". An address that is not clearly an address is not worth having.
 */
function extractAddress(block) {
  const lines = block.split(/\r?\n/)
    .filter((l) => !isNoise(l))
    .map(cleanLine)
    .filter((l) => l && !l.includes("@") && !/https?:\/\//i.test(l) && !GREETING.test(l));

  // "Street 3B, 123 45 City" on a single line, which is the Swedish norm.
  for (const line of lines) {
    const m = line.match(/^(\p{L}[\p{L}\s.\-]{2,40}\s+\d{1,4}\s*[A-Za-z]?)\s*,\s*(\d{3}\s?\d{2}|\d{4,6})\s+(\p{L}[\p{L}\s\-]{1,40})$/u);
    if (m) {
      return {
        primary_address_street: m[1].trim(),
        primary_address_postalcode: m[2].trim(),
        primary_address_city: m[3].trim(),
      };
    }
  }

  const streetAt = [], postcodeAt = [];

  lines.forEach((line, i) => {
    // "Storgatan 12", "12 Baker Street", words plus a house number.
    if (/^[\p{L}][\p{L}\s.\-]{2,40}\s+\d{1,4}\s*[A-Za-z]?$/u.test(line) ||
        /^\d{1,4}\s+[\p{L}][\p{L}\s.\-]{2,40}$/u.test(line)) {
      streetAt.push(i);
    }
    // "114 55 Stockholm" or "12345 Springfield", a postcode then a place.
    if (/^(\d{3}\s?\d{2}|\d{4,6})\s+[\p{L}][\p{L}\s\-]{1,40}$/u.test(line)) {
      postcodeAt.push(i);
    }
  });

  // Adjacent, in that order, within a couple of lines of each other.
  for (const si of streetAt) {
    const pi = postcodeAt.find((x) => x > si && x - si <= 2);
    if (pi === undefined) continue;

    const m = lines[pi].match(/^(\d{3}\s?\d{2}|\d{4,6})\s+(.+)$/u);
    const out = { primary_address_street: lines[si] };
    if (m) {
      out.primary_address_postalcode = m[1].trim();
      out.primary_address_city = m[2].trim();
    }
    // A short line straight after the postcode is usually the country.
    const next = lines[pi + 1];
    if (next && next.length <= 30 && /^[\p{L}][\p{L}\s\-]+$/u.test(next)) {
      out.primary_address_country = next;
    }
    return out;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.author        the mailbox we are building a record for
 * @param {string} input.bodyText      plain-text body (or converted HTML)
 * @param {string} [input.vcard]       raw vCard text, if the message carried one
 * @param {boolean} [input.isAuthor]   false when `author` is a CC'd colleague rather
 *                                     than the person who wrote the message. The
 *                                     signature belongs to the *writer*, so their job
 *                                     title, phone numbers and postal address must not
 *                                     be copied onto somebody else. Only company-level
 *                                     details, which the whole domain shares, carry over.
 * @returns {{fields: object, confidence: object, signatureBlock: string, source: string}}
 */
export function parseContact({ author, bodyText = "", vcard = null, isAuthor = true }) {
  const mailbox = parseMailbox(author) || { name: "", email: "" };
  const domain = domainOf(mailbox.email);

  const fields = {};
  const confidence = {};
  const put = (k, v, c) => {
    if (v === null || v === undefined || v === "" || fields[k]) return;
    fields[k] = typeof v === "string" ? v.trim() : v;
    confidence[k] = c;
  };

  // 1. The header address is ground truth.
  put("email1", mailbox.email, HIGH);

  // 2. A vCard, if attached, beats every heuristic below, but it describes the
  //    sender. For a colleague, take only the company-level fields from it.
  const card = vcard ? parseVCard(vcard) : null;
  if (card) {
    for (const [k, v] of Object.entries(card)) {
      if (!isAuthor && !ORG_LEVEL_FIELDS.has(k)) continue;
      put(k, v, isAuthor ? HIGH : MEDIUM);
    }
  }

  // 3. The display name is a reliable name source.
  let nameLineIdx = -1;
  if (mailbox.name && !/^[\w.+-]+@/.test(mailbox.name)) {
    const n = splitPersonName(mailbox.name);
    put("first_name", n.first_name, HIGH);
    put("last_name", n.last_name, HIGH);
  }

  let { block, delimited, signOff } = extractSignatureBlock(bodyText, mailbox.name);

  // Does this block actually belong to the sender?
  //
  // In a reply chain the last sign-off is often the *recipient's* own signature,
  // quoted back. Harvesting it files your own job title, phone number and
  // LinkedIn onto someone else's CRM record. If the block names email addresses
  // and none of them is on the sender's domain, it is somebody else's signature.
  if (block && domain) {
    const inBlock = [...block.matchAll(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());
    if (inBlock.length && !inBlock.some((a) => domainOf(a) === domain)) {
      block = "";
      delimited = false;
      signOff = false;
    }
  }

  block = normaliseBlock(block);
  const sigLines = block.split(/\r?\n/).map((l) => l.trim());

  // 4. Name from the signature, when the header gave us nothing. Skipped for a
  //    colleague, the name in the signature is the writer's.
  if (!fields.first_name && !fields.last_name && isAuthor) {
    for (let i = 0; i < sigLines.length; i++) {
      if (looksLikePersonName(sigLines[i])) {
        const n = splitPersonName(sigLines[i]);
        put("first_name", n.first_name, delimited ? MEDIUM : LOW);
        put("last_name", n.last_name, delimited ? MEDIUM : LOW);
        nameLineIdx = i;
        break;
      }
    }
  } else {
    const target = [fields.first_name, fields.last_name].filter(Boolean).join(" ").toLowerCase();
    nameLineIdx = sigLines.findIndex((l) => l.toLowerCase() === target);
  }

  // 5. Everything else out of the signature block.
  // A `-- ` delimiter is certain; a sign-off is good; anything else is a guess.
  const sigConf = delimited ? HIGH : signOff ? MEDIUM : LOW;

  // Company and website belong to the organisation, so they apply to anyone on
  // the domain. Everything else in the signature belongs to whoever wrote it.
  const org = extractOrganisation(block, domain);
  if (org) {
    const c = delimited ? org.confidence : downgrade(org.confidence);
    put("account_name", org.value, isAuthor ? c : downgrade(c));
  }
  put("website", extractWebsite(block), isAuthor ? sigConf : downgrade(sigConf));

  if (isAuthor) {
    const title = extractTitle(block, nameLineIdx);
    if (title) put("title", title.value, delimited ? title.confidence : downgrade(title.confidence));

    const phones = extractPhones(block);
    put("phone_work", phones.phone_work, sigConf);
    put("phone_mobile", phones.phone_mobile, sigConf);
    put("phone_fax", phones.phone_fax, sigConf);
    put("phone_other", phones.phone_other, sigConf);

    const linkedin = extractSocial(block);
    if (linkedin) put("linkedin_c", linkedin, LOW);

    for (const [k, v] of Object.entries(extractAddress(block))) put(k, v, downgrade(sigConf));
  }

  // 6a. No website in the signature is common, but the email domain is almost
  //     always the company's site. Derive it, low confidence, so the form
  //     highlights it, and the user can have it checked before saving.
  if (!fields.website && domain && !isConsumerDomain(domain)) {
    const guessed = homepageFromDomain(domain);
    if (guessed) put("website", guessed, LOW);
  }

  // 6. Last resort for the company: derive it from the domain.
  if (!fields.account_name) {
    const guess = companyFromDomain(domain);
    if (guess) put("account_name", guess, LOW);
  }

  // 7. And a last-resort name from the local part: "jane.doe@" -> Jane Doe.
  if (!fields.first_name && !fields.last_name) {
    const lp = localPartOf(mailbox.email);
    if (/^[a-z]+[._][a-z]+$/i.test(lp)) {
      const n = splitPersonName(lp.split(/[._]/).map(cap).join(" "));
      put("first_name", n.first_name, LOW);
      put("last_name", n.last_name, LOW);
    }
  }

  return {
    fields,
    confidence,
    signatureBlock: block,
    source: !isAuthor
      ? "colleague-of-sender"
      : card ? "vcard"
      : delimited ? "signature-delimited"
      : signOff ? "signature-after-signoff"
      : "headers-only",
    needsReview: Object.entries(confidence).filter(([, c]) => c !== HIGH).map(([k]) => k),
  };
}

/** Fields that describe the organisation, so they hold for anyone on the domain. */
const ORG_LEVEL_FIELDS = new Set(["account_name", "website"]);

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const downgrade = (c) => (c === HIGH ? MEDIUM : LOW);

