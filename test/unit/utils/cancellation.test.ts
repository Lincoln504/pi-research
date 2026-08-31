/**
 * isCancellation — the predicate every tool wrapper uses to tell "the user stopped
 * this" apart from "this failed".
 *
 * The distinction matters because the tools are built to never throw: a failure
 * becomes prose the agent reads and acts on, and that prose is written to explain a
 * FAULT. On a Ctrl-C those sentences are fabrications — a rate limit that was never
 * hit, bot-protection that never triggered, databases that were never unreachable —
 * and the agent acts on them, retrying work the user just cancelled and carrying the
 * invented cause into its report.
 */

import { describe, it, expect } from 'vitest';
import { getEventListeners } from 'node:events';
import { isCancellation, raceWithSignal } from '../../../src/utils/cancellation.ts';

describe('isCancellation', () => {
  it('recognises an aborted signal regardless of the error', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isCancellation(new Error('some transport noise'), controller.signal)).toBe(true);
  });

  it('recognises a DOMException-style AbortError with no signal in hand', () => {
    // The abort frequently crosses a worker or HTTP boundary before reaching the
    // tool, and the tool may not have been handed the signal at all.
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isCancellation(err)).toBe(true);
  });

  it.each([
    'Aborted',
    'aborted',
    'The operation was aborted',
    // DOMException's canonical message form — the variant that motivated the
    // (?:the|this) alternation; without its own entry here the branch it added
    // is untested and can silently regress.
    'This operation was aborted',
    'Research aborted',
    'research cancelled',
    'Research canceled',
    'Operation cancelled.',
  ])('recognises the reason string %o that survived a layer that dropped the error name', (msg) => {
    expect(isCancellation(new Error(msg))).toBe(true);
  });

  it('does not treat a genuine failure as a cancellation', () => {
    // Over-matching is the dangerous direction: a real fault swallowed as a
    // cancellation propagates as a throw and kills a run that should have degraded.
    for (const msg of [
      'Worker exited unexpectedly',
      'Search task timed out after 55000ms',
      'HTTP 429 rate limited',
      'Failed to abort the previous request',
      'Request aborted by the server after 3 retries',
      'ECONNRESET',
    ]) {
      expect(isCancellation(new Error(msg)), msg).toBe(false);
    }
  });

  it('does not treat a merely-present, un-aborted signal as a cancellation', () => {
    expect(isCancellation(new Error('boom'), new AbortController().signal)).toBe(false);
  });

  it('handles a non-Error rejection value', () => {
    expect(isCancellation('Aborted')).toBe(true);
    expect(isCancellation({ nope: true })).toBe(false);
  });
});

describe('raceWithSignal', () => {
  it('passes the op straight through when no signal is handed in', async () => {
    await expect(raceWithSignal(Promise.resolve('v'))).resolves.toBe('v');
  });

  it('resolves undefined immediately when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort();
    let ran = false;
    const op = (async () => { ran = true; return 'v'; })();
    await expect(raceWithSignal(op, c.signal)).resolves.toBeUndefined();
    // Abandon semantics: the loser keeps draining in the background.
    await op;
    expect(ran).toBe(true);
  });

  it('resolves the op value when the op settles first', async () => {
    const c = new AbortController();
    await expect(raceWithSignal(Promise.resolve('v'), c.signal)).resolves.toBe('v');
    expect(getEventListeners(c.signal, 'abort').length).toBe(0);
  });

  it('resolves undefined when the signal fires while the op is pending, and leaks no listener', async () => {
    const c = new AbortController();
    let release!: (v: string) => void;
    const op = new Promise<string>((resolve) => { release = resolve; });
    const raced = raceWithSignal(op, c.signal);
    c.abort();
    await expect(raced).resolves.toBeUndefined();
    release('late');
    await expect(op).resolves.toBe('late');
    expect(getEventListeners(c.signal, 'abort').length).toBe(0);
  });

  it('already-aborted signal: a later rejection of the eager op is swallowed, not unhandled', async () => {
    const c = new AbortController();
    c.abort();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const op = Promise.reject(new Error('probe exploded post-abort'));
      await expect(raceWithSignal(op, c.signal)).resolves.toBeUndefined();
      // Give the rejected op's handler dispatch a few macrotasks to fire —
      // unhandledRejection lands on a later tick than the race resolution.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
