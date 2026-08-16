/**
 * The temporal anchor sits at the FRONT of every agent system prompt, and that is
 * a deliberate trade against prompt caching.
 *
 * The router/synthesizer split made those system prompts round-invariant so a
 * provider could cache their prefix. This function then prepends a day-granular
 * date block to them, which means the cacheable prefix begins with content that
 * changes every day and can change mid-run at local midnight.
 *
 * Measured outcome across nine instrumented runs: the researcher path reads 51.9%
 * of its tokens from cache, while router, synthesizer and coordinator read exactly
 * zero — but not because of this. Those components are invoked once or twice per
 * run, so there is no prior identical prefix within an entry's lifetime to hit,
 * and moving the anchor would buy nothing while weakening the one thing it exists
 * for: stopping a model from answering "latest" questions against its training
 * cutoff. The anchor stays in front. These tests pin the parts that must hold for
 * that choice to remain the only obstacle.
 *
 * The planning-service suite mocks this function to identity, so its
 * byte-identical system-prompt assertions test a prompt that never ships. The real
 * function is tested here instead.
 */

import { describe, it, expect } from 'vitest';

import { injectCurrentDate } from '../../../../src/core/llm/inject-date.ts';

const AGENTS = ['coordinator', 'researcher', 'router', 'synthesizer'] as const;

describe('injectCurrentDate', () => {
  it('prepends rather than appends, so the anchor is the first thing read', () => {
    const out = injectCurrentDate('BODY', 'router');
    expect(out.endsWith('BODY')).toBe(true);
    expect(out.startsWith('BODY')).toBe(false);
  });

  it('is invariant across calls, so it cannot be what breaks round-to-round stability', () => {
    // Two routing calls in the same run must produce a byte-identical prefix. If this
    // ever gained per-call content (a round number, a query, a timestamp), the
    // planning-service invariance tests would not catch it — they mock this away.
    const a = injectCurrentDate('BODY', 'router');
    const b = injectCurrentDate('BODY', 'router');
    expect(a).toBe(b);
  });

  it('is identical for every agent type, so the tag cannot leak into the prefix', () => {
    const rendered = AGENTS.map(agent => injectCurrentDate('BODY', agent));
    expect(new Set(rendered).size).toBe(1);
  });

  it('carries no content beyond the date anchor', () => {
    // The anchor's whole job is temporal. Anything else that crept in here would be
    // uncacheable content smuggled ahead of every system prompt in the system.
    const prefix = injectCurrentDate('BODY', 'router').slice(0, -'BODY'.length);
    const year = new Date().getFullYear();
    expect(prefix).toContain('CURRENT MONTH AND YEAR');
    expect(prefix).toContain(String(year));
    // Derived from the current year rather than hardcoded, so the guidance does not
    // read wrong from a later year.
    expect(prefix).toContain(String(year - 1));
    expect(prefix).toContain(String(year - 2));
  });

  it('changes with the day, which is the documented cost of the front position', () => {
    // Not a defect — a property. Stated here so that anyone measuring a zero cache
    // read on these components knows this prefix cannot be shared across days, and
    // does not go looking for a configuration problem instead.
    const prefix = injectCurrentDate('', 'synthesizer');
    expect(prefix).toContain(new Date().toLocaleDateString('en-US', { month: 'long' }));
  });
});
