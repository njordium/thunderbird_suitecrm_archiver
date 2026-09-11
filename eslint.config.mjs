/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import globals from "globals";

/**
 * Lint configuration for the add-on.
 *
 * `browser` is Thunderbird's WebExtension namespace, and `messenger` is its
 * alias, both are provided by the host, not imported, so they are declared as
 * readonly globals rather than being flagged as undefined on every line.
 */
const webextensionGlobals = {
  ...globals.browser,
  ...globals.webextensions,
  browser: "readonly",
  messenger: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", "dist/**", "reference/**", "docs/**"],
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: webextensionGlobals,
    },
    rules: {
      // Correctness, these catch real bugs.
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-const-assign": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-fallthrough": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",
      "no-constant-condition": "error",
      "no-sparse-arrays": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-shadow-restricted-names": "error",
      "no-async-promise-executor": "error",
      "require-atomic-updates": "warn",
      "no-await-in-loop": "off",   // sequential CRM writes are deliberate

      // Security-adjacent: these are how extensions get compromised.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-proto": "error",
      "no-extend-native": "error",

      // Consistency.
      "eqeqeq": ["error", "smart"],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "no-throw-literal": "error",
      "no-return-await": "error",
    },
  },
  {
    files: ["tests/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, browser: "writable", File: "readonly" },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-var": "error",
    },
  },
];
