/**
 * The health probe's budget has to out-wait the work it competes with.
 *
 * The wait-phase verdict is built on an arithmetic claim: healthcheck tasks have strict
 * queue priority, so a slot frees inside the budget unless the pool has genuinely
 * stopped — therefore a probe that never reached a worker has found a wedge. That claim
 * held for a hardcoded 105s and the DEFAULT timeouts, and for no other configuration.
 *
 * `SEARCH_TIMEOUT_MS` and `BROWSER_TASK_TIMEOUT_MS` are each settable to 120 000, so a
 * single search may legally hold a slot for 240s. A user who merely raised the search
 * timeout would have seen a healthy pool reported as wedged — and that verdict aborts
 * the run at the readiness gate, so the cost is a refused run rather than a bad log line.
 *
 * The second half is the probe's own work. The worker runs up to three navigation
 * attempts (primary, retry, neutral-endpoint fallback) at `max(10s,
 * HEALTH_CHECK_TIMEOUT_MS)` each, and a budget below that sum makes the fallback ladder
 * unreachable — so raising HEALTH_CHECK_TIMEOUT_MS made the health check strictly worse:
 * past ~35s the ladder could not finish, and past 105s even one attempt overran.
 */

import { describe, it, expect } from 'vitest';

import {
  getHealthCheckBudgetMs,
  HEALTHCHECK_MIN_BUDGET_MS,
} from '../../../../src/infrastructure/browser/config.ts';

/** The longest a single task may legally hold a worker slot. */
const longestSlotHold = (c: { SEARCH_TIMEOUT_MS: number; SCRAPE_TIMEOUT_MS: number; BROWSER_TASK_TIMEOUT_MS: number }) =>
  Math.max(c.SEARCH_TIMEOUT_MS, c.SCRAPE_TIMEOUT_MS) + c.BROWSER_TASK_TIMEOUT_MS;

const DEFAULTS = {
  SEARCH_TIMEOUT_MS: 45_000,
  SCRAPE_TIMEOUT_MS: 15_000,
  BROWSER_TASK_TIMEOUT_MS: 10_000,
  HEALTH_CHECK_TIMEOUT_MS: 10_000,
};

describe('health probe budget', () => {
  it('is unchanged from the historical constant on a default install', () => {
    expect(getHealthCheckBudgetMs(DEFAULTS as any)).toBe(HEALTHCHECK_MIN_BUDGET_MS);
  });

  it('out-waits the longest slot hold at the schema maximum, where the fixed value did not', () => {
    // Every timeout at its documented ceiling: a task can hold a slot for 240s.
    const maxed = {
      SEARCH_TIMEOUT_MS: 120_000,
      SCRAPE_TIMEOUT_MS: 120_000,
      BROWSER_TASK_TIMEOUT_MS: 120_000,
      HEALTH_CHECK_TIMEOUT_MS: 120_000,
    };
    const budget = getHealthCheckBudgetMs(maxed as any);

    expect(budget).toBeGreaterThan(longestSlotHold(maxed));
    expect(HEALTHCHECK_MIN_BUDGET_MS).toBeLessThan(longestSlotHold(maxed)); // the old value did not
  });

  it('out-waits the slot hold for raising the search timeout alone', () => {
    // The single-knob case, which is the realistic one: 130s of slot hold against a
    // fixed 105s budget.
    const cfg = { ...DEFAULTS, SEARCH_TIMEOUT_MS: 120_000 };
    expect(getHealthCheckBudgetMs(cfg as any)).toBeGreaterThan(longestSlotHold(cfg));
  });

  it('leaves room for all three of the worker probe attempts it may make', () => {
    // Raising this knob used to shrink the usable ladder rather than extend it: the
    // retry and the neutral-endpoint fallback that distinguish bot-blocking from a real
    // outage could not run inside a fixed outer deadline.
    for (const navMs of [10_000, 30_000, 60_000, 120_000]) {
      const cfg = { ...DEFAULTS, HEALTH_CHECK_TIMEOUT_MS: navMs };
      expect(getHealthCheckBudgetMs(cfg as any)).toBeGreaterThanOrEqual(3 * navMs);
    }
  });

  it('falls back to defaults rather than producing NaN from a partial config', () => {
    // setTimeout coerces NaN to 1ms, which would invert the bound into an instant
    // failure — the one outcome worse than a budget that is too short.
    expect(getHealthCheckBudgetMs({} as any)).toBe(HEALTHCHECK_MIN_BUDGET_MS);
    expect(Number.isFinite(getHealthCheckBudgetMs({ SEARCH_TIMEOUT_MS: undefined } as any))).toBe(true);
  });
});
