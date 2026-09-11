/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { pickLocale, LOCALES, FALLBACK_LOCALE } from "../src/lib/i18n.js";

const dir = new URL("../_locales/", import.meta.url);
const codes = readdirSync(dir).sort();
const read = (code) => JSON.parse(readFileSync(new URL(`${code}/messages.json`, dir), "utf8"));
const base = read(FALLBACK_LOCALE);

/** $1, $2 … in a string, as a sorted list. */
const placeholders = (text) => [...new Set(text.match(/\$\d/g) || [])].sort();

test("every locale the code offers is actually packaged", () => {
  for (const code of Object.keys(LOCALES)) {
    assert.ok(codes.includes(code), `${code} is offered in the settings but has no catalogue`);
  }
});

test("every packaged locale is offered in the settings", () => {
  for (const code of codes) {
    assert.ok(LOCALES[code], `${code} ships but the language menu never lists it`);
  }
});

test("English is the fallback, and it is complete", () => {
  assert.ok(codes.includes(FALLBACK_LOCALE));
  for (const [key, entry] of Object.entries(base)) {
    assert.equal(typeof entry.message, "string", `${key} has no message`);
    assert.ok(entry.message.trim(), `${key} is empty in the fallback catalogue`);
  }
});

for (const code of codes) {
  test(`${code}: same keys as the fallback, nothing missing or invented`, () => {
    const catalogue = read(code);
    const missing = Object.keys(base).filter((k) => !(k in catalogue));
    const extra = Object.keys(catalogue).filter((k) => !(k in base));
    assert.deepEqual(missing, [], `keys missing from ${code}`);
    assert.deepEqual(extra, [], `keys in ${code} that the fallback does not have`);
  });

  test(`${code}: every string is present and non-empty`, () => {
    for (const [key, entry] of Object.entries(read(code))) {
      assert.equal(typeof entry?.message, "string", `${code}/${key} is not a string`);
      assert.ok(entry.message.trim(), `${code}/${key} is empty`);
    }
  });

  // A translation that drops $1 silently loses the record name, the address or
  // the count it was supposed to show.
  test(`${code}: placeholders survive translation`, () => {
    const catalogue = read(code);
    for (const [key, entry] of Object.entries(base)) {
      assert.deepEqual(
        placeholders(catalogue[key].message), placeholders(entry.message),
        `${code}/${key} does not use the same $n placeholders as English`
      );
    }
  });
}

test("the manifest's __MSG__ keys all exist in the fallback catalogue", () => {
  const manifest = readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
  const used = [...manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]);
  assert.ok(used.length, "the manifest uses no localised strings, so this test proves nothing");
  for (const key of used) {
    assert.ok(base[key], `the manifest asks for __MSG_${key}__, which no catalogue defines`);
  }
});

test("a Thunderbird locale tag resolves to something we ship", () => {
  const cases = {
    "sv-SE": "sv", sv: "sv", "nb-NO": "nb", "da-DK": "da", "fi-FI": "fi",
    "de-AT": "de", "de": "de", "es-MX": "es", "fr-CA": "fr", "it-CH": "it",
    "nl-BE": "nl", "pl-PL": "pl", "pt-PT": "pt_BR", "pt-BR": "pt_BR",
    "en-GB": "en_GB", "en-US": "en_US",
  };
  for (const [tag, expected] of Object.entries(cases)) {
    assert.equal(pickLocale(tag), expected, `${tag} resolved wrongly`);
  }
});

test("a language we do not ship falls back to English rather than failing", () => {
  for (const tag of ["zh-CN", "ja", "tr", "uk", "xx-YY", "", null, undefined]) {
    assert.equal(pickLocale(tag), FALLBACK_LOCALE, `${tag} should fall back`);
  }
});

test("no catalogue smuggles in an em dash", () => {
  for (const code of codes) {
    const text = readFileSync(new URL(`${code}/messages.json`, dir), "utf8");
    assert.ok(!text.includes("—"), `${code} contains an em dash`);
  }
});
