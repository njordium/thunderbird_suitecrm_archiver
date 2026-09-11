/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Interface text, in the reader's language.
 *
 * Not browser.i18n. That API resolves against Thunderbird's own UI locale and
 * offers no way to ask for a different one, so "follow Thunderbird, with an
 * override" cannot be built on it. The catalogues are ordinary packaged JSON
 * in the same _locales layout, read with fetch, which keeps them in the format
 * ATN expects and still lets the user pick a language.
 *
 * Manifest strings (the description, the command descriptions, the button
 * titles) are a separate matter: Thunderbird reads those itself, through
 * default_locale, and they follow its language whatever is chosen here.
 */
import { log } from "./log.js";

export const LOCALES = {
  en_US: "English (US)",
  en_GB: "English (UK)",
  da: "Dansk",
  sv: "Svenska",
  nb: "Norsk bokmål",
  fi: "Suomi",
  de: "Deutsch",
  es: "Español",
  nl: "Nederlands",
  fr: "Français",
  it: "Italiano",
  pl: "Polski",
  pt_BR: "Português (Brasil)",
};

export const FALLBACK_LOCALE = "en_US";

/**
 * Turn what Thunderbird reports into a locale we ship.
 *
 * Thunderbird gives tags like "sv-SE", "nb-NO" or "pt-PT". Match the exact tag
 * first, then the language alone, so sv-FI still gets Swedish and pt-PT gets
 * the Brazilian catalogue rather than English.
 */
export function pickLocale(tag, available = Object.keys(LOCALES)) {
  const wanted = String(tag || "").replace("-", "_");
  if (available.includes(wanted)) return wanted;

  const language = wanted.split("_")[0].toLowerCase();
  if (available.includes(language)) return language;

  const sameLanguage = available.find((code) => code.split("_")[0].toLowerCase() === language);
  return sameLanguage || FALLBACK_LOCALE;
}

const catalogues = new Map();

async function load(locale) {
  if (catalogues.has(locale)) return catalogues.get(locale);
  try {
    // A packaged file, not a network request: getURL() yields moz-extension://,
    // and this is the add-on reading its own catalogue. Review tooling flags
    // any fetch(), so it is worth being explicit about which kind this is.
    const url = globalThis.browser?.runtime?.getURL(`_locales/${locale}/messages.json`);
    const res = await fetch(url);
    const parsed = await res.json();
    catalogues.set(locale, parsed);
    return parsed;
  } catch (e) {
    log.warn(`No catalogue for ${locale}:`, e.message);
    catalogues.set(locale, {});
    return {};
  }
}

let active = FALLBACK_LOCALE;
let messages = {};
let fallback = {};

/**
 * Choose the language. `"auto"` follows Thunderbird.
 *
 * The fallback catalogue is loaded alongside, so a key a translator has not
 * reached yet shows English rather than its own name.
 */
export async function useLocale(choice) {
  const tag = !choice || choice === "auto"
    ? (globalThis.browser?.i18n?.getUILanguage?.() || FALLBACK_LOCALE)
    : choice;

  active = pickLocale(tag);
  messages = await load(active);
  fallback = active === FALLBACK_LOCALE ? messages : await load(FALLBACK_LOCALE);
  return active;
}

export const activeLocale = () => active;

/** Look up a string, substituting $1, $2 … positionally. */
export function t(key, ...subs) {
  const entry = messages[key] ?? fallback[key];
  let text = entry?.message;
  if (typeof text !== "string") {
    log.debug(`Untranslated key: ${key}`);
    return key;
  }
  subs.forEach((value, i) => {
    text = text.replaceAll(`$${i + 1}`, String(value));
  });
  return text;
}

/**
 * Translate a page in place.
 *
 * `data-i18n` sets the text, `data-i18n-title` the tooltip and
 * `data-i18n-placeholder` the placeholder, so the markup stays readable and
 * the English in it keeps working if a catalogue fails to load.
 */
export function localise(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const text = t(el.dataset.i18n);
    if (text !== el.dataset.i18n) el.textContent = text;
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const text = t(el.dataset.i18nTitle);
    if (text !== el.dataset.i18nTitle) el.title = text;
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    const text = t(el.dataset.i18nPlaceholder);
    if (text !== el.dataset.i18nPlaceholder) el.placeholder = text;
  }
}
