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
import { isCancellation } from '../../../src/utils/cancellation.ts';

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
