import { describe, it, expect } from 'vitest';
import { formatErrorWithCause } from '../../../src/web-research/scraper-utils.ts';

/**
 * formatErrorWithCause() walks the `cause` chain so the swallowed underlying
 * transport reason is visible in logs / scrape results. Node's fetch() wraps the
 * real socket error under `error.cause` and surfaces only the uninformative
 * "TypeError: fetch failed"; this helper surfaces the cause (ECONNRESET,
 * UND_ERR_*, ENOTFOUND, AbortError, …) that the bare `String(err)` discarded.
 */
describe('formatErrorWithCause', () => {
  it('surfaces a single-level undici cause (the production "fetch failed" case)', () => {
    // Mirrors what undici produces: TypeError: fetch failed { cause: Error: connect ECONNRESET }
    const cause = new Error('connect ECONNRESET 1.2.3.4:443');
    (cause as Error & { code?: string }).code = 'ECONNRESET';
    const err = new TypeError('fetch failed', { cause });
    const out = formatErrorWithCause(err);
    expect(out).toContain('fetch failed');
    expect(out).toContain('connect ECONNRESET');
    expect(out).not.toBe('fetch failed'); // the whole point: not just the wrapper
  });

  it('walks a multi-link cause chain and joins with arrows', () => {
    const root = new Error('getaddrinfo ENOTFOUND example.com');
    const mid = new Error('connect failed', { cause: root });
    const top = new TypeError('fetch failed', { cause: mid });
    const out = formatErrorWithCause(top);
    expect(out).toBe('fetch failed ← connect failed ← getaddrinfo ENOTFOUND example.com');
  });

  it('folds a Node/undici .code into the segment', () => {
    const cause = new Error('other side closed');
    (cause as Error & { code?: string }).code = 'UND_ERR_SOCKET';
    const err = new TypeError('fetch failed', { cause });
    const out = formatErrorWithCause(err);
    expect(out).toContain('[UND_ERR_SOCKET]');
    expect(out).toContain('other side closed');
  });

  it('appends the .code when the message does not already contain it (undici UND_ERR_*)', () => {
    const cause = new Error('connect ECONNRESET 1.2.3.4:443');
    (cause as Error & { code?: string }).code = 'ECONNRESET';
    const err = new TypeError('fetch failed', { cause });
    const out = formatErrorWithCause(err);
    // ECONNRESET already in the message → not duplicated as [ECONNRESET]
    expect(out).not.toContain('[ECONNRESET]');
    expect(out).toContain('connect ECONNRESET');
  });

  it('stops after a bounded depth (no infinite loop on a self-referential cause)', () => {
    const err: Error & { cause?: unknown } = new Error('top');
    err.cause = err; // pathological: self-referential
    const out = formatErrorWithCause(err);
    expect(out).toBe('top'); // does not hang, does not repeat
  });

  it('deduplicates repeated identical segments', () => {
    const root = new Error('fetch failed');
    const top = new TypeError('fetch failed', { cause: root });
    const out = formatErrorWithCause(top);
    expect(out).toBe('fetch failed'); // not "fetch failed ← fetch failed"
  });

  it('handles a plain string cause and non-Error inputs without throwing', () => {
    expect(formatErrorWithCause('boom')).toBe('boom');
    expect(formatErrorWithCause(new TypeError('fetch failed', { cause: 'string reason' }))).toBe(
      'fetch failed ← string reason',
    );
    expect(formatErrorWithCause(null)).toBe('null');
    expect(formatErrorWithCause(undefined)).toBe('undefined');
    expect(formatErrorWithCause(42)).toBe('42');
  });

  it('returns a useful string for an Error with an empty message (falls back to name)', () => {
    const err = new TypeError('fetch failed', { cause: new Error('') });
    const out = formatErrorWithCause(err);
    expect(out).toContain('fetch failed');
    expect(out).toContain('Error'); // name fallback for the empty-message cause
  });

  it('never throws even if .message / .code getters throw', () => {
    const evil = {
      get message() { throw new Error('getter boom'); },
      get cause() { throw new Error('getter boom'); },
    };
    // Must not throw — returns some string.
    const out = formatErrorWithCause(evil);
    expect(typeof out).toBe('string');
  });
});
