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
 * Search and scrape no longer derive from the leader TASK budget at all. That budget
 * bounds execution only — armed at dispatch, not at request arrival — so leader
 * turnaround is queue wait plus budget and nothing derived from it can out-wait it.
 * Those two are wedge detectors, derived instead from the budget of whatever owns
 * the request: a detector that fires after its caller is already dead detects
 * nothing, and a flat 300s cap against a researcher timeout that defaults to 300s
 * and bottoms out at 180s was exactly that. Only the healthcheck, whose leader side
 * bounds the whole call, stays leader-budget-derived.
 */

import { describe, it, expect } from 'vitest';

import { resolveClientRequestTimeoutMs } from '../../../src/infrastructure/browser/browser-client.ts';

const cfg = (overrides: Record<string, number>) => ({
  SEARCH_TIMEOUT_MS: 45_000,
  SCRAPE_TIMEOUT_MS: 15_000,
  BROWSER_TASK_TIMEOUT_MS: 10_000,
  // The budget of whatever OWNS a search/scrape request. Schema: min 180s, default 300s.
  RESEARCHER_TIMEOUT_MS: 300_000,
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

  it('out-waits the leader whenever the configuration leaves room to', () => {
    // With default leader budgets there is plenty of room.
    const c = cfg({});
    expect(resolveClientRequestTimeoutMs('search', c)).toBeGreaterThan(searchBudget(c));
    expect(resolveClientRequestTimeoutMs('browser-task', c)).toBeGreaterThan(scrapeBudget(c));
  });

  it('cannot out-wait a leader budget the owning caller does not itself allow for', () => {
    // Schema maxima: a 240s leader task budget under a 300s researcher timeout. No
    // follower value can both out-wait the leader and fire before the researcher
    // dies, because the researcher would outlive the task by only 60s. That is a
    // property of the configuration, not of this function — and the resolution has
    // to favour firing first, since a detector that never fires reports nothing.
    // Documented here so the collision is a known state rather than a surprise.
    const maxed = cfg({ SEARCH_TIMEOUT_MS: 120_000, BROWSER_TASK_TIMEOUT_MS: 120_000 });
    const t = resolveClientRequestTimeoutMs('search', maxed);
    expect(t).toBeLessThanOrEqual(CAP);
    expect(t).toBeLessThan(maxed.RESEARCHER_TIMEOUT_MS);
    expect(t).toBe(searchBudget(maxed)); // exactly collides, does not undercut
  });

  it('fires before the researcher that owns the request is killed', () => {
    // The whole point of a wedge detector. At the schema minimum and at the default,
    // the flat 300s cap could never fire first, so a wedged-but-listening leader
    // surfaced as a bare researcher timeout with nothing said about the browser.
    for (const owner of [180_000, 300_000, 900_000, 1_800_000]) {
      const t = resolveClientRequestTimeoutMs('search', cfg({ RESEARCHER_TIMEOUT_MS: owner }));
      expect(t, `owner budget ${owner}`).toBeLessThan(owner);
      expect(resolveClientRequestTimeoutMs('browser-task', cfg({ RESEARCHER_TIMEOUT_MS: owner }))).toBeLessThan(owner);
    }
  });

  it('absolute cap still binds on an out-of-range owner budget', () => {
    expect(resolveClientRequestTimeoutMs('search', cfg({ RESEARCHER_TIMEOUT_MS: 10_000_000 }))).toBe(CAP);
  });

  it('search/scrape out-wait leader queue wait, which no budget-derived value can', () => {
    // The leader's task budget bounds EXECUTION only — it is armed at dispatch, not
    // when the request lands — so leader turnaround is queue wait plus that budget.
    // A follower timer derived from the budget alone therefore abandons requests the
    // leader is still queueing: the same defect the leader-side deadline had. These
    // two are wedge detectors instead, and must not track the budget at all.
    // Changing the leader's TASK budget must not move these at all — only the owning
    // caller's budget may.
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
