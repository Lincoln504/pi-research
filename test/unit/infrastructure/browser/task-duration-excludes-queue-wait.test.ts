/**
 * A task's reported duration is what it RAN for, not what it waited.
 *
 * The deadline stopped charging queue wait; the measurement did not. Those are the
 * same variable used twice, and fixing one while leaving the other reports a system
 * that is now behaving correctly as though it were behaving terribly.
 *
 * Concretely: on 2026-08-16, `Search completed ... in Nms` and
 * `browser_search_duration_ms` reported a 51s median across a saturated burst whose
 * true execution median was 5.8s. An evening went into explaining an eightfold
 * latency regression that had never occurred — the queue was deep, the searches
 * were normal, and the number could not tell those apart.
 */

import { describe, it, expect } from 'vitest';

import { executionMs, queueWaitMs } from '../../../../src/infrastructure/browser/browser-task-scheduler.ts';

describe('task duration measures execution, not queue wait', () => {
  it('a task queued 45s and run for 6s reports 6s, not 51s', () => {
    const submitted = 1_000_000;
    const dispatched = submitted + 45_000;
    const now = dispatched + 6_000;

    expect(executionMs(dispatched, submitted, now)).toBe(6_000);
    expect(queueWaitMs(dispatched, submitted)).toBe(45_000);
  });

  it('an uncontended task reports the same either way, which is why this hid for so long', () => {
    // When nothing queues, wait is zero and the two definitions coincide exactly.
    // Every quiet day in the logs therefore looked correct.
    const submitted = 1_000_000;
    const dispatched = submitted;
    const now = submitted + 5_800;

    expect(executionMs(dispatched, submitted, now)).toBe(5_800);
    expect(queueWaitMs(dispatched, submitted)).toBe(0);
  });

  it('a task that never reached a worker reports its whole elapsed span, not zero', () => {
    // Cancelled or rejected while queued. Reporting zero execution would record the
    // failure as instantaneous and pull every latency percentile down with it.
    const submitted = 1_000_000;
    const now = submitted + 90_000;

    expect(executionMs(0, submitted, now)).toBe(90_000);
    expect(queueWaitMs(0, submitted)).toBe(0);
  });
});
