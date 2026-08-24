/**
 * A broken install must not be reported as a network or load problem.
 *
 * Observed in the wild: a scripts-blocked install (npm 12 defaults `allowScripts`
 * to off) leaves camoufox-js's `better-sqlite3` dependency without its native
 * binding, so every browser worker dies with "Could not locate the bindings file".
 * The run then reported "Browser workers may be unavailable, DuckDuckGo is
 * unreachable, or the system is under extreme load" — three things that were all
 * false, and none of which the reader could act on. A calling agent read that
 * message and concluded it had hit a persistent environment issue, which was true
 * but useless: the actual fix is a one-line reinstall.
 */

import { describe, it, expect } from 'vitest';
import { isNativeBindingError } from '../../../src/infrastructure/browser/browser-error-utils.ts';

describe('isNativeBindingError — recognises a broken install', () => {
  it.each([
    ['node-bindings lookup (better-sqlite3, the observed case)',
     'Could not locate the bindings file. Tried:\n → /app/node_modules/better-sqlite3/build/better_sqlite3.node'],
    ['dlopen failure', 'Error [ERR_DLOPEN_FAILED]: libonnxruntime.so.1: cannot open shared object file'],
    ['ABI mismatch', 'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115.'],
    ['wrong-arch binary', "Error: /app/node_modules/x/build/Release/x.node: invalid ELF header"],
    ['missing .node file', "Cannot find module '/app/node_modules/x/build/Release/x.node'"],
  ])('flags %s', (_label, msg) => {
    expect(isNativeBindingError(new Error(msg))).toBe(true);
  });

  it.each([
    ['a real network failure', 'page.goto: net::ERR_NAME_NOT_RESOLVED'],
    ['a timeout', 'page.goto: Timeout 15000ms exceeded'],
    ['a bot block', 'Fetch blocked: challenge interstitial'],
    ['an ordinary missing JS module', "Cannot find module './helper.js'"],
    ['an HTTP error', 'HTTP 503 Service Unavailable'],
  ])('does NOT flag %s', (_label, msg) => {
    expect(isNativeBindingError(new Error(msg))).toBe(false);
  });

  it('accepts a bare string as well as an Error', () => {
    expect(isNativeBindingError('Could not locate the bindings file. Tried:')).toBe(true);
    expect(isNativeBindingError(null)).toBe(false);
  });
});
