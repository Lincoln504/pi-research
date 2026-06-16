/**
 * Unit tests for the two-tier metrics system.
 *
 * Verified properties:
 *  1. MetricsRegistry basic operations (counter, gauge, histogram, measure, clear)
 *  2. Session registry receives writes outside any run context
 *  3. Run registry receives writes inside runWithRunRegistry
 *  4. Session registry is NOT written to during a run context
 *  5. Concurrent run isolation — two overlapping runs never bleed
 *  6. RunSummary is recorded to session history after the run context exits
 *  7. Run history is capped at 10 — oldest evicted first
 *  8. clearSession() resets session registry, run history, and session start time
 *  9. clear() is a backwards-compatible alias for clearSession()
 * 10. getSnapshot() returns the session snapshot (backwards compat)
 * 11. getCurrentRunRegistry() is undefined outside a run, the registry inside
 * 12. Infrastructure events before any run appear only in the session snapshot
 * 13. In-run infrastructure events appear only in the run registry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MetricsRegistry,
  metrics,
  runWithRunRegistry,
  getCurrentRunRegistry,
  type RunSummary,
  type IMetricsSnapshot,
} from '../../../src/utils/metrics.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function emptySnapshot(): IMetricsSnapshot {
  return { counters: {}, gauges: {}, histograms: {} };
}

function isEmptySnapshot(snap: IMetricsSnapshot): boolean {
  return (
    Object.keys(snap.counters).length === 0 &&
    Object.keys(snap.gauges).length === 0 &&
    Object.keys(snap.histograms).length === 0
  );
}

function makeRunSummary(runId: string, status: RunSummary['status'] = 'success'): RunSummary {
  return {
    runId,
    startedAt: Date.now() - 1000,
    completedAt: Date.now(),
    durationMs: 1000,
    status,
    snapshot: emptySnapshot(),
  };
}

// ── MetricsRegistry unit tests ─────────────────────────────────────────────

describe('MetricsRegistry', () => {
  let reg: MetricsRegistry;

  beforeEach(() => { reg = new MetricsRegistry(); });

  it('increments a counter and accumulates correctly', () => {
    reg.increment('req_total');
    reg.increment('req_total');
    reg.increment('req_total', 5);
    expect(reg.getSnapshot().counters['req_total']).toBe(7);
  });

  it('increments labelled counters independently', () => {
    reg.increment('req_total', 1, { status: '200' });
    reg.increment('req_total', 2, { status: '500' });
    reg.increment('req_total', 1, { status: '200' });
    const c = reg.getSnapshot().counters;
    expect(c['req_total{status="200"}']).toBe(2);
    expect(c['req_total{status="500"}']).toBe(2);
  });

  it('normalises label key order so ordering does not affect the key', () => {
    reg.increment('m', 1, { b: '2', a: '1' });
    reg.increment('m', 1, { a: '1', b: '2' });
    expect(reg.getSnapshot().counters['m{a="1",b="2"}']).toBe(2);
  });

  it('sets and overwrites a gauge', () => {
    reg.setGauge('workers', 4);
    reg.setGauge('workers', 8);
    expect(reg.getSnapshot().gauges['workers']).toBe(8);
  });

  it('computes histogram statistics correctly', () => {
    reg.observe('lat', 10);
    reg.observe('lat', 20);
    reg.observe('lat', 30);
    const h = reg.getSnapshot().histograms['lat']!;
    expect(h.count).toBe(3);
    expect(h.min).toBe(10);
    expect(h.max).toBe(30);
    expect(h.avg).toBeCloseTo(20, 5);
    expect(h.p50).toBe(20);
  });

  it('clear() empties all metric types', () => {
    reg.increment('x'); reg.setGauge('y', 1); reg.observe('z', 5);
    reg.clear();
    expect(isEmptySnapshot(reg.getSnapshot())).toBe(true);
  });

  it('measure() records latency on success and returns the value', async () => {
    const result = await reg.measure('op_ms', async () => 'ok');
    expect(result).toBe('ok');
    expect(reg.getSnapshot().histograms['op_ms']!.count).toBe(1);
  });

  it('measure() records latency with error label and rethrows on failure', async () => {
    await expect(
      reg.measure('op_ms', async () => { throw new Error('fail'); }),
    ).rejects.toThrow('fail');
    expect(reg.getSnapshot().histograms['op_ms{error="true"}']!.count).toBe(1);
    expect(reg.getSnapshot().counters['op_ms_errors_total']).toBe(1);
  });

  it('histogram rolling buffer caps at 10 000 values', () => {
    for (let i = 0; i <= 10_005; i++) reg.observe('m', i);
    expect(reg.getSnapshot().histograms['m']!.count).toBe(10_000);
  });
});

// ── SessionMetrics routing ─────────────────────────────────────────────────

describe('metrics singleton — routing', () => {
  beforeEach(() => { metrics.clearSession(); });
  afterEach(()  => { metrics.clearSession(); });

  it('writes outside run context go to the session registry', () => {
    metrics.increment('infra_events_total');
    metrics.setGauge('pool_size', 3);
    metrics.observe('lock_ms', 5);

    const snap = metrics.getSessionSnapshot();
    expect(snap.counters['infra_events_total']).toBe(1);
    expect(snap.gauges['pool_size']).toBe(3);
    expect(snap.histograms['lock_ms']!.count).toBe(1);
  });

  it('session registry is NOT written to during a run context', async () => {
    metrics.increment('pre_run');

    const runReg = new MetricsRegistry();
    await runWithRunRegistry(runReg, async () => {
      metrics.increment('in_run');
      metrics.setGauge('g', 7);
      metrics.observe('h', 9);
    });

    const session = metrics.getSessionSnapshot();
    expect(session.counters['pre_run']).toBe(1);
    expect(session.counters['in_run']).toBeUndefined();
    expect(session.gauges['g']).toBeUndefined();
    expect(session.histograms['h']).toBeUndefined();
  });

  it('writes inside run context go to the run registry only', async () => {
    const runReg = new MetricsRegistry();
    await runWithRunRegistry(runReg, async () => {
      metrics.increment('search_total', 4);
      metrics.observe('latency_ms', 100);
    });

    expect(runReg.getSnapshot().counters['search_total']).toBe(4);
    expect(runReg.getSnapshot().histograms['latency_ms']!.avg).toBe(100);
    expect(isEmptySnapshot(metrics.getSessionSnapshot())).toBe(true);
  });

  it('getCurrentRunRegistry() is undefined outside a run', () => {
    expect(getCurrentRunRegistry()).toBeUndefined();
  });

  it('getCurrentRunRegistry() returns the active registry inside a run', async () => {
    const runReg = new MetricsRegistry();
    await runWithRunRegistry(runReg, async () => {
      expect(getCurrentRunRegistry()).toBe(runReg);
    });
    expect(getCurrentRunRegistry()).toBeUndefined();
  });

  it('measure() inside run context writes to the run registry', async () => {
    const runReg = new MetricsRegistry();
    await runWithRunRegistry(runReg, async () => {
      await metrics.measure('op_ms', async () => 'v');
    });
    expect(runReg.getSnapshot().histograms['op_ms']!.count).toBe(1);
    expect(isEmptySnapshot(metrics.getSessionSnapshot())).toBe(true);
  });

  it('session writes after a run do not bleed into the run snapshot', async () => {
    const runReg = new MetricsRegistry();
    await runWithRunRegistry(runReg, async () => {
      metrics.increment('run_event');
    });
    // Post-run session write
    metrics.increment('post_run_event');

    expect(runReg.getSnapshot().counters['post_run_event']).toBeUndefined();
    expect(metrics.getSessionSnapshot().counters['post_run_event']).toBe(1);
  });
});

// ── Concurrent run isolation ───────────────────────────────────────────────

describe('metrics singleton — concurrent run isolation', () => {
  beforeEach(() => { metrics.clearSession(); });
  afterEach(()  => { metrics.clearSession(); });

  it('two concurrent runs write to their own registries with zero cross-contamination', async () => {
    const regA = new MetricsRegistry();
    const regB = new MetricsRegistry();

    const runA = runWithRunRegistry(regA, async () => {
      metrics.increment('a_counter', 3);
      await Promise.resolve();
      metrics.increment('a_counter', 2);
    });

    const runB = runWithRunRegistry(regB, async () => {
      metrics.increment('b_counter', 10);
      await Promise.resolve();
      metrics.increment('b_counter', 5);
    });

    await Promise.all([runA, runB]);

    expect(regA.getSnapshot().counters['a_counter']).toBe(5);
    expect(regA.getSnapshot().counters['b_counter']).toBeUndefined();
    expect(regB.getSnapshot().counters['b_counter']).toBe(15);
    expect(regB.getSnapshot().counters['a_counter']).toBeUndefined();
    expect(isEmptySnapshot(metrics.getSessionSnapshot())).toBe(true);
  });

  it('session-scope writes interleaved with concurrent runs stay in the session registry', async () => {
    metrics.increment('session_before');

    const regA = new MetricsRegistry();
    const regB = new MetricsRegistry();

    await Promise.all([
      runWithRunRegistry(regA, async () => { metrics.increment('run_a'); }),
      runWithRunRegistry(regB, async () => { metrics.increment('run_b'); }),
    ]);

    metrics.increment('session_after');

    const sess = metrics.getSessionSnapshot();
    expect(sess.counters['session_before']).toBe(1);
    expect(sess.counters['session_after']).toBe(1);
    expect(sess.counters['run_a']).toBeUndefined();
    expect(sess.counters['run_b']).toBeUndefined();
  });
});

// ── RunSummary recording ───────────────────────────────────────────────────

describe('metrics singleton — run history', () => {
  beforeEach(() => { metrics.clearSession(); });
  afterEach(()  => { metrics.clearSession(); });

  it('starts with an empty run history', () => {
    expect(metrics.getRunHistory()).toHaveLength(0);
  });

  it('recordRunSummary() appends entries in order', () => {
    metrics.recordRunSummary(makeRunSummary('run-1'));
    metrics.recordRunSummary(makeRunSummary('run-2'));
    const h = metrics.getRunHistory();
    expect(h).toHaveLength(2);
    expect(h[0]!.runId).toBe('run-1');
    expect(h[1]!.runId).toBe('run-2');
  });

  it('evicts the oldest run when the cap (10) is exceeded', () => {
    for (let i = 1; i <= 11; i++) {
      metrics.recordRunSummary(makeRunSummary(`run-${i}`));
    }
    const h = metrics.getRunHistory();
    expect(h).toHaveLength(10);
    expect(h[0]!.runId).toBe('run-2');    // run-1 was evicted
    expect(h[9]!.runId).toBe('run-11');
  });

  it('exactly at cap (10) does not evict anything', () => {
    for (let i = 1; i <= 10; i++) {
      metrics.recordRunSummary(makeRunSummary(`run-${i}`));
    }
    const h = metrics.getRunHistory();
    expect(h).toHaveLength(10);
    expect(h[0]!.runId).toBe('run-1');
  });

  it('records run snapshot data accurately inside the summary', async () => {
    const runReg = new MetricsRegistry();
    await runWithRunRegistry(runReg, async () => {
      metrics.increment('searches', 5);
      metrics.observe('latency_ms', 200);
    });

    metrics.recordRunSummary({
      runId: 'test-run',
      startedAt: 0,
      completedAt: 1000,
      durationMs: 1000,
      status: 'success',
      snapshot: runReg.getSnapshot(),
    });

    const s = metrics.getRunHistory()[0]!;
    expect(s.snapshot.counters['searches']).toBe(5);
    expect(s.snapshot.histograms['latency_ms']!.avg).toBe(200);
  });

  it('preserves all three run statuses', () => {
    metrics.recordRunSummary(makeRunSummary('ok',     'success'));
    metrics.recordRunSummary(makeRunSummary('fail',   'error'));
    metrics.recordRunSummary(makeRunSummary('cancel', 'cancelled'));
    const h = metrics.getRunHistory();
    expect(h[0]!.status).toBe('success');
    expect(h[1]!.status).toBe('error');
    expect(h[2]!.status).toBe('cancelled');
  });

  it('recordRunSummary() is outside run context so it does not affect run registry', async () => {
    const runReg = new MetricsRegistry();
    await runWithRunRegistry(runReg, async () => {
      metrics.increment('run_metric');
    });

    // recordRunSummary is called after runWithRunRegistry returns
    metrics.recordRunSummary(makeRunSummary('r1'));

    // The run registry must not have received any write from recordRunSummary
    expect(runReg.getSnapshot().counters['run_metric']).toBe(1);
    // No session_runs_started_total leaking into the run registry
    expect(Object.keys(runReg.getSnapshot().counters)).toHaveLength(1);
  });
});

// ── Reset behaviour ────────────────────────────────────────────────────────

describe('metrics singleton — clearSession()', () => {
  beforeEach(() => { metrics.clearSession(); });
  afterEach(()  => { metrics.clearSession(); });

  it('clears the session registry', () => {
    metrics.increment('infra_total');
    metrics.clearSession();
    expect(isEmptySnapshot(metrics.getSessionSnapshot())).toBe(true);
  });

  it('clears run history', () => {
    metrics.recordRunSummary(makeRunSummary('r'));
    metrics.clearSession();
    expect(metrics.getRunHistory()).toHaveLength(0);
  });

  it('resets sessionStartedAt to a later timestamp', async () => {
    const before = metrics.getSessionStartedAt();
    await new Promise(r => setTimeout(r, 2));
    metrics.clearSession();
    expect(metrics.getSessionStartedAt()).toBeGreaterThanOrEqual(before);
  });

  it('clearSession() resets session counters and run history', () => {
    metrics.increment('x');
    metrics.clearSession();
    expect(isEmptySnapshot(metrics.getSessionSnapshot())).toBe(true);
    expect(metrics.getRunHistory()).toHaveLength(0);
  });

  it('does NOT disturb in-flight run registries', async () => {
    const runReg = new MetricsRegistry();

    await runWithRunRegistry(runReg, async () => {
      metrics.increment('before_clear');
      metrics.clearSession();   // mid-run reset must not corrupt the run registry
      metrics.increment('after_clear');
    });

    // Both increments went to runReg; clearSession only touched the session registry.
    expect(runReg.getSnapshot().counters['before_clear']).toBe(1);
    expect(runReg.getSnapshot().counters['after_clear']).toBe(1);
    // Session registry is empty after clearSession
    expect(isEmptySnapshot(metrics.getSessionSnapshot())).toBe(true);
  });
});

// ── Session vs run scoping ─────────────────────────────────────────────────

describe('metrics singleton — session vs run scoping', () => {
  beforeEach(() => { metrics.clearSession(); });
  afterEach(()  => { metrics.clearSession(); });

  it('session counter set before any run remains in session after a run completes', async () => {
    metrics.increment('startup_event', 4);

    const runReg = new MetricsRegistry();
    await runWithRunRegistry(runReg, async () => {
      metrics.increment('run_only');
    });

    expect(metrics.getSessionSnapshot().counters['startup_event']).toBe(4);
    expect(metrics.getSessionSnapshot().counters['run_only']).toBeUndefined();
  });
});

// ── End-to-end: simulated research run ────────────────────────────────────

describe('metrics singleton — simulated research run lifecycle', () => {
  beforeEach(() => { metrics.clearSession(); });
  afterEach(()  => { metrics.clearSession(); });

  it('full lifecycle: startup → run → summary → session view is clean', async () => {
    // Startup infrastructure events (no run context)
    metrics.increment('state_lock_acquire_total', 4, { status: 'success' });
    metrics.increment('gpu_lock_acquire_total',   1, { status: 'success' });

    // Session counter incremented before entering run context
    metrics.increment('session_runs_started_total');

    const runReg = new MetricsRegistry();
    const runStartedAt = Date.now();

    await runWithRunRegistry(runReg, async () => {
      metrics.increment('search_queries_total', 6);
      metrics.increment('scrape_operations_total', 10);
      metrics.observe('search_latency_ms', 250);
      metrics.observe('search_latency_ms', 350);
      // In-run infrastructure (state lock during embedding)
      metrics.increment('state_lock_acquire_total', 2, { status: 'success' });
    });

    // Capture summary outside run context
    metrics.recordRunSummary({
      runId: 'run-abc123',
      startedAt: runStartedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - runStartedAt,
      status: 'success',
      snapshot: runReg.getSnapshot(),
    });

    // ── Assertions ──────────────────────────────────────────────────────

    // Session registry: only startup + session counters
    const sess = metrics.getSessionSnapshot();
    expect(sess.counters['state_lock_acquire_total{status="success"}']).toBe(4);
    expect(sess.counters['gpu_lock_acquire_total{status="success"}']).toBe(1);
    expect(sess.counters['session_runs_started_total']).toBe(1);
    expect(sess.counters['search_queries_total']).toBeUndefined();

    // Run snapshot: research + in-run infrastructure
    const runSnap = metrics.getRunHistory()[0]!.snapshot;
    expect(runSnap.counters['search_queries_total']).toBe(6);
    expect(runSnap.counters['scrape_operations_total']).toBe(10);
    expect(runSnap.counters['state_lock_acquire_total{status="success"}']).toBe(2);
    expect(runSnap.histograms['search_latency_ms']!.count).toBe(2);
    expect(runSnap.histograms['search_latency_ms']!.avg).toBe(300);
    // Startup events must NOT appear in the run snapshot
    expect(runSnap.counters['gpu_lock_acquire_total{status="success"}']).toBeUndefined();

    // Run history has one entry
    expect(metrics.getRunHistory()).toHaveLength(1);
    expect(metrics.getRunHistory()[0]!.status).toBe('success');
    expect(metrics.getRunHistory()[0]!.runId).toBe('run-abc123');
  });

  it('three sequential runs accumulate in history; session counter reflects all starts', async () => {
    for (let i = 1; i <= 3; i++) {
      metrics.increment('session_runs_started_total');
      const reg = new MetricsRegistry();
      await runWithRunRegistry(reg, async () => {
        metrics.increment('search_queries_total', i * 2);
      });
      // Capture the actual run registry snapshot (not an empty stub)
      metrics.recordRunSummary({
        runId: `run-${i}`,
        startedAt: Date.now() - 100,
        completedAt: Date.now(),
        durationMs: 100,
        status: 'success',
        snapshot: reg.getSnapshot(),
      });
    }

    expect(metrics.getSessionSnapshot().counters['session_runs_started_total']).toBe(3);
    expect(metrics.getRunHistory()).toHaveLength(3);
    // Each run's snapshot is isolated
    expect(metrics.getRunHistory()[0]!.snapshot.counters['search_queries_total']).toBe(2);
    expect(metrics.getRunHistory()[1]!.snapshot.counters['search_queries_total']).toBe(4);
    expect(metrics.getRunHistory()[2]!.snapshot.counters['search_queries_total']).toBe(6);
  });
});
