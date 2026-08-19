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
  COLD_START_ALLOWANCE_MS,
} from '../../../../src/infrastructure/browser/config.ts';

/**
 * The longest a single task may legally hold a worker slot: its own nav budget plus
 * overhead, plus COLD_START_ALLOWANCE_MS — a task dispatched to a freshly created or
 * just-reset worker pays a real browser launch + context creation inline before any
 * navigation starts (eager warmup is deliberately disabled), so that cost is part of
 * "how long a task may legitimately hold a slot" too, not just its own timeout knobs.
 */
const longestSlotHold = (c: { SEARCH_TIMEOUT_MS: number; SCRAPE_TIMEOUT_MS: number; BROWSER_TASK_TIMEOUT_MS: number }) =>
  Math.max(c.SEARCH_TIMEOUT_MS, c.SCRAPE_TIMEOUT_MS) + c.BROWSER_TASK_TIMEOUT_MS + COLD_START_ALLOWANCE_MS;

const DEFAULTS = {
  SEARCH_TIMEOUT_MS: 45_000,
  SCRAPE_TIMEOUT_MS: 15_000,
  BROWSER_TASK_TIMEOUT_MS: 10_000,
  HEALTH_CHECK_TIMEOUT_MS: 10_000,
};

describe('health probe budget', () => {
  it('exceeds the historical floor at default settings, once cold-start is accounted for', () => {
    // A cold Firefox launch was always able to hold a slot for close to the historical
    // 105s floor on its own — the floor just did not know it. Folding
    // COLD_START_ALLOWANCE_MS into longestSlotHold makes the derived budget the binding
    // constraint even at default timeouts; the floor now only matters for a
    // hypothetical config where the derived value would land below it.
    const budget = getHealthCheckBudgetMs(DEFAULTS as any);
    expect(budget).toBeGreaterThan(HEALTHCHECK_MIN_BUDGET_MS);
    expect(budget).toBeGreaterThan(longestSlotHold(DEFAULTS));
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
    // failure — the one outcome worse than a budget that is too short. An empty
    // config falls back to the same schema defaults as DEFAULTS above, so it produces
    // the same (floor-exceeding) budget, not the historical floor itself.
    expect(getHealthCheckBudgetMs({} as any)).toBe(getHealthCheckBudgetMs(DEFAULTS as any));
    expect(Number.isFinite(getHealthCheckBudgetMs({ SEARCH_TIMEOUT_MS: undefined } as any))).toBe(true);
  });
});
