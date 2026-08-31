/**
 * pi-ai module-graph skew policy (src/core/pi-ai-skew.ts).
 *
 * Pure classification is tested with literal version inputs; the live
 * checkPiAiSkew() walk is only smoke-tested for shape — its inputs depend on
 * the executing process's layout (under vitest there is no pi host above us,
 * so it must classify as 'standalone' and never throw).
 */

import { describe, it, expect } from 'vitest';
import { classifyPiAiSkew, checkPiAiSkew } from '../../../src/core/pi-ai-skew.ts';

describe('classifyPiAiSkew', () => {
  it('no host → standalone, silent', () => {
    const r = classifyPiAiSkew({ hostVersion: null, extPiAi: '0.84.2', extPiCodingAgent: '0.84.2' });
    expect(r).toEqual({ level: 'standalone', fatal: false, message: null });
  });

  it('extension copies match host → ok', () => {
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.4', extPiCodingAgent: '0.84.4' });
    expect(r).toEqual({ level: 'ok', fatal: false, message: null });
  });

  it('stale extension pi-ai → FATAL, message names both versions and the remedy', () => {
    // The exact 2026-08-30 incident state.
    const r = classifyPiAiSkew(
      { hostVersion: '0.84.4', extPiAi: '0.84.2', extPiCodingAgent: '0.84.2' },
      '/ext/root',
    );
    expect(r.level).toBe('stale');
    expect(r.fatal).toBe(true);
    expect(r.message).toContain('host pi 0.84.4');
    expect(r.message).toContain('pi-ai 0.84.2');
    expect(r.message).toContain('clampThinkingBudgetToAnswerRoom');
    expect(r.message).toContain('cd /ext/root && npm install');
  });

  it('a copy lagging the host is fatal however it is labeled (stale or internal)', () => {
    // Half-updated tree: copies disagree AND one lags the host.
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.4', extPiCodingAgent: '0.84.3' });
    expect(r.level).toBe('internal');
    expect(r.fatal).toBe(true);
    // Consistent-but-stale tree.
    const r2 = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.3', extPiCodingAgent: '0.84.3' });
    expect(r2.level).toBe('stale');
    expect(r2.fatal).toBe(true);
  });

  it('patch-level staleness within the same minor is still skew (the export appeared in 0.84.3)', () => {
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.3', extPiCodingAgent: '0.84.3' });
    expect(r.level).toBe('stale');
    expect(r.fatal).toBe(true);
  });

  it('extension newer than host → warn, not fatal (untested direction, no known failure)', () => {
    const r = classifyPiAiSkew({ hostVersion: '0.84.2', extPiAi: '0.84.4', extPiCodingAgent: '0.84.4' });
    expect(r.level).toBe('newer');
    expect(r.fatal).toBe(false);
    expect(r.message).toContain('newer than host pi 0.84.2');
  });

  it('internal disagreement between extension copies → fatal when a copy lags the host, warn otherwise', () => {
    // One copy stale vs host, copies disagree: root cause named, still fatal.
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.4', extPiCodingAgent: '0.84.3' });
    expect(r.level).toBe('internal');
    expect(r.fatal).toBe(true);
    expect(r.message).toContain('internally inconsistent');
    // Copies disagree but neither lags the host: warn only.
    const r2 = classifyPiAiSkew({ hostVersion: '0.84.2', extPiAi: '0.84.2', extPiCodingAgent: '0.84.4' });
    expect(r2.level).toBe('internal');
    expect(r2.fatal).toBe(false);
    expect(r2.message).toContain('internally inconsistent');
  });

  it('missing extension copy → incomplete warn, never fatal', () => {
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: null, extPiCodingAgent: '0.84.4' });
    expect(r).toMatchObject({ level: 'incomplete', fatal: false });
    expect(r.message).toContain('pi-ai');
  });

  it('half-hoisted layout: a PRESENT copy that lags the host is fatal stale, not an incomplete warn', () => {
    // The 2026-08-30 crash shape: a stale nested pi-ai beside a hoisted
    // (absent) pi-coding-agent — there is no second copy to compare against,
    // but the present copy lags the host, which is the proven crash direction.
    const r = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: '0.84.2', extPiCodingAgent: null });
    expect(r.level).toBe('stale');
    expect(r.fatal).toBe(true);
    expect(r.message).toContain('pi-ai');
    expect(r.message).toContain('LAGS host pi 0.84.4');
    // Mirror: a stale nested pi-coding-agent with no nested pi-ai.
    const r2 = classifyPiAiSkew({ hostVersion: '0.84.4', extPiAi: null, extPiCodingAgent: '0.84.3' });
    expect(r2.level).toBe('stale');
    expect(r2.fatal).toBe(true);
  });

  it('unparseable versions → incomplete warn (the guard must not invent startup failures)', () => {
    const r = classifyPiAiSkew({ hostVersion: 'banana', extPiAi: '0.84.4', extPiCodingAgent: '0.84.4' });
    expect(r).toMatchObject({ level: 'incomplete', fatal: false });
  });
});

describe('checkPiAiSkew (live walk)', () => {
  it('never throws and returns a well-formed result', () => {
    const r = checkPiAiSkew();
    expect(typeof r.fatal).toBe('boolean');
    expect(r.level).toMatch(/^(ok|standalone|incomplete|stale|newer|internal)$/);
    expect(r.message === null || typeof r.message === 'string').toBe(true);
  });

  it('classifies as standalone under vitest (no pi host package above the test runner)', () => {
    // argv[1] is the vitest binary; the named walk for pi-coding-agent must
    // fail, degrading to standalone rather than guessing. If this ever flips
    // to 'ok' because CI grows a pi install, that is fine too — the assertion
    // is that it does NOT produce a false fatal.
    const r = checkPiAiSkew();
    expect(r.fatal).toBe(false);
  });

  it('accepts a real-path anchor as well as a file:// URL', () => {
    // Same module, two spellings of the same location: the URL form is what
    // jiti produces, the plain path is what a bundler may inline.
    const viaUrl = checkPiAiSkew(import.meta.url);
    const viaPath = checkPiAiSkew(
      new URL('.', import.meta.url).pathname + 'pi-ai-skew.ts',
    );
    expect(viaUrl.level).toBe(viaPath.level);
  });
});
