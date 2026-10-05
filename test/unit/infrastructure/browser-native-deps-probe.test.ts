/**
 * `pi-research status` must not report a build that cannot search as ready.
 *
 * npm 12 turns dependency install scripts off by default, and npm can drop a native
 * dependency's platform package (npm/cli#4828). The old launcher (camoufox-js) needed
 * better-sqlite3, whose binding came from such a script; the current one
 * (@camoufox/camoufox) has no better-sqlite3 and its one native module is `impit`.
 * Either way the module imports fine and throws only at FIRST USE, with "Could not locate the bindings file". Nothing noticed:
 * `status` derived `ready` from credentials alone and said yes, `isBrowserAvailable()`
 * only stats the camoufox binary, and the first real symptom was every browser worker
 * dying mid-run behind an error blaming the network.
 *
 * Measured on the camoufox-js stack: better-sqlite3 was the only one that failed that
 * way. onnxruntime-node ships its binding inside its own tarball, and
 * lancedb, impit and html-to-markdown resolve prebuilt platform packages — which is why
 * the knowledge store kept answering while search was dead.
 */

import { describe, it, expect } from 'vitest';
import { probeBrowserNativeDeps } from '../../../src/infrastructure/browser/config.ts';

describe('probeBrowserNativeDeps', () => {
  it('reports ok on a correctly built install', () => {
    // No injection: this exercises the REAL impit load in this repo, which is
    // correctly built. If this ever fails here, the repo's own install is broken.
    expect(probeBrowserNativeDeps()).toEqual({ ok: true });
  });

  it('reports the underlying error when the binding is missing', () => {
    // Exactly what a scripts-blocked install produces at first use.
    const r = probeBrowserNativeDeps(() => {
      throw new Error('Could not locate the bindings file. Tried:\n \u2192 /x/better_sqlite3.node');
    });

    expect(r.ok).toBe(false);
    // First line only — the raw error lists every path it tried.
    expect(r.ok === false && r.error).toBe('Could not locate the bindings file. Tried:');
  });

  it('does not throw when the module is absent entirely', () => {
    const r = probeBrowserNativeDeps(() => { throw new Error("Cannot find module 'better-sqlite3'"); });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('Cannot find module');
  });

  it('survives a non-Error throw', () => {
    const r = probeBrowserNativeDeps(() => { throw 'boom'; });
    expect(r).toEqual({ ok: false, error: 'boom' });
  });
});
