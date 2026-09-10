/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const PREFIX = "[suitecrm-archiver]";
let level = "info";
const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Diagnostics sink, installed by the background page. Kept as a hook rather than
 * a direct import so log.js stays dependency-free and importable from anywhere.
 */
let sink = null;
export function setLogSink(fn) { sink = fn; }

export function setLogLevel(l) { if (ORDER[l]) level = l; }
const at = (l) => ORDER[l] >= ORDER[level];

function emit(l, args, consoleFn) {
  // The debug report should capture everything the user reproduced, regardless
  // of the console verbosity they happen to have set.
  if (sink) { try { sink(l, args); } catch { /* never let logging break the app */ } }
  if (at(l)) consoleFn(PREFIX, ...args);
}

export const log = {
  debug: (...a) => emit("debug", a, console.debug),
  info:  (...a) => emit("info",  a, console.info),
  warn:  (...a) => emit("warn",  a, console.warn),
  error: (...a) => emit("error", a, console.error),
};
