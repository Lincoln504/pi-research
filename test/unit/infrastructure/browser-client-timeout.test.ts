/**
 * Follower request-timeout derivation.
 *
 * The follower's old flat 60s timeout undercut the leader's own task budgets
 * (healthcheck 45s+60s=105s; search/scrape config-driven up to 240s within
 * schema bounds), and its timeout text matches isTaskTimeoutError, so the retry
 * gates skipped it — long tasks failed client-side, unretried, while the leader
 * was still working. Invariant pinned here: for every task kind the follower is
 * at least as patient as the leader, under an absolute cap so a wedged leader
 * still fails in bounded time.
 *
 * Search and scrape no longer derive from the leader budget at all. That budget
 * bounds execution only — armed at dispatch, not at request arrival — so leader
 * turnaround is queue wait plus budget and nothing derived from the budget can
 * out-wait it. Those two are wedge detectors now; only the healthcheck, whose
 * leader side bounds the whole call, stays budget-derived.
 */

import { describe, it, expect } from 'vitest';

import { resolveClientRequestTimeoutMs } from '../../../src/infrastructure/browser/browser-client.ts';

const cfg = (overrides: Record<string, number>) => ({
  SEARCH_TIMEOUT_MS: 45_000,
  SCRAPE_TIMEOUT_MS: 15_000,
  BROWSER_TASK_TIMEOUT_MS: 10_000,
  ...overrides,
}) as any;

// Leader budgets mirrored from BrowserTaskScheduler.
const searchBudget = (c: any) => c.SEARCH_TIMEOUT_MS + c.BROWSER_TASK_TIMEOUT_MS;
const scrapeBudget = (c: any) => c.SCRAPE_TIMEOUT_MS + c.BROWSER_TASK_TIMEOUT_MS;
const HEALTHCHECK_BUDGET = 45_000 + 60_000;
const CAP = 300_000;

describe('resolveClientRequestTimeoutMs', () => {
  it('search: strictly more patient than the leader search budget', () => {
    const c = cfg({});
    expect(resolveClientRequestTimeoutMs('search', c)).toBeGreaterThan(searchBudget(c));
  });

  it('scrape: strictly more patient than the leader scrape budget', () => {
    const c = cfg({});
    expect(resolveClientRequestTimeoutMs('browser-task', c)).toBeGreaterThan(scrapeBudget(c));
  });

  it('healthcheck: strictly more patient than the leader 105s budget (the old 60s undercut it)', () => {
    const t = resolveClientRequestTimeoutMs('healthcheck', cfg({}));
    expect(t).toBeGreaterThan(HEALTHCHECK_BUDGET);
    expect(t).toBeGreaterThan(60_000); // the exact regression: flat 60s < 105s
  });

  it('maxed schema values (120s+120s) stay under the cap and still out-wait the leader', () => {
    const c = cfg({ SEARCH_TIMEOUT_MS: 120_000, SCRAPE_TIMEOUT_MS: 120_000, BROWSER_TASK_TIMEOUT_MS: 120_000 });
    const t = resolveClientRequestTimeoutMs('search', c);
    expect(t).toBeGreaterThan(searchBudget(c));
    expect(t).toBeLessThanOrEqual(CAP);
  });

  it('absolute cap binds on out-of-range config, so a wedged leader fails in bounded time', () => {
    const c = cfg({ SEARCH_TIMEOUT_MS: 10_000_000, BROWSER_TASK_TIMEOUT_MS: 10_000_000 });
    expect(resolveClientRequestTimeoutMs('search', c)).toBe(CAP);
  });

  it('search/scrape out-wait leader queue wait, which no budget-derived value can', () => {
    // The leader's task budget bounds EXECUTION only — it is armed at dispatch, not
    // when the request lands — so leader turnaround is queue wait plus that budget.
    // A follower timer derived from the budget alone therefore abandons requests the
    // leader is still queueing: the same defect the leader-side deadline had. These
    // two are wedge detectors instead, and must not track the budget at all.
    const small = cfg({ SEARCH_TIMEOUT_MS: 1_000, SCRAPE_TIMEOUT_MS: 1_000, BROWSER_TASK_TIMEOUT_MS: 1_000 });
    const large = cfg({ SEARCH_TIMEOUT_MS: 120_000, SCRAPE_TIMEOUT_MS: 120_000, BROWSER_TASK_TIMEOUT_MS: 120_000 });

    expect(resolveClientRequestTimeoutMs('search', small)).toBe(resolveClientRequestTimeoutMs('search', large));
    expect(resolveClientRequestTimeoutMs('browser-task', small)).toBe(resolveClientRequestTimeoutMs('browser-task', large));

    // Concretely: a query behind a full pool of 90s tasks needs more patience than
    // one 90s budget plus a margin ever granted it.
    expect(resolveClientRequestTimeoutMs('search', cfg({}))).toBeGreaterThan(searchBudget(cfg({})) * 2);
  });

  it('healthcheck stays budget-derived, because its leader side bounds the whole call', () => {
    // It answers "healthy, saturated" rather than queueing indefinitely, so a
    // liveness probe stays as impatient as a liveness probe should be.
    expect(resolveClientRequestTimeoutMs('healthcheck', cfg({}))).toBeLessThan(CAP);
  });

  it('unknown operation falls back to the largest fixed budget rather than something shorter', () => {
    expect(resolveClientRequestTimeoutMs('network', cfg({}))).toBeGreaterThanOrEqual(
      resolveClientRequestTimeoutMs('healthcheck', cfg({})),
    );
  });
});
