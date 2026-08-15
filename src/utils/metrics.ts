/**
 * Metrics Collection System — two-tier design
 *
 * Session registry: accumulates infrastructure and coordination events for the
 * lifetime of one Pi session. Never cleared between research runs; only an
 * explicit clearSession() / "Reset metrics" action resets it.
 *
 * Run registry: one per research invocation. Created fresh at tool entry,
 * discarded after the run. A RunSummary snapshot is kept in the session-level
 * run history (capped at MAX_RUN_HISTORY) for display.
 *
 * All emit callsites use the same `metrics` export — the active registry is
 * resolved from AsyncLocalStorage. Inside runWithRunRegistry() the run
 * registry receives the writes; outside (startup, infrastructure init) the
 * session registry does.
 *
 * Metric types:
 *  - Counter:   monotonically increasing integer (request counts, error counts)
 *  - Gauge:     point-in-time scalar (active workers, lock held flag)
 *  - Histogram: distribution of numeric observations (latency in ms)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../logger.ts';

export type Labels = Record<string, string>;

export interface IMetricHistogram {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface IMetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, IMetricHistogram>;
}

/** Immutable snapshot captured at the end of a single research run. */
export interface RunSummary {
  readonly runId: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly status: 'success' | 'error' | 'cancelled';
  readonly snapshot: IMetricsSnapshot;
}

// ── Core registry ──────────────────────────────────────────────────────────

/**
 * Low-level metrics store. Holds counters, gauges and histograms in memory.
 * Not directly exported as the singleton — use the `metrics` export instead.
 */
export class MetricsRegistry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, { 
    values: number[]; 
    pointer: number; 
    limit: number; 
    dirty: boolean;
    cached: IMetricHistogram | null;
  }>();

  private serializeLabels(labels?: Labels): string {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    return keys.map(k => `${k}="${labels[k]}"`).join(',');
  }

  private getKey(name: string, labels?: Labels): string {
    const labelStr = this.serializeLabels(labels);
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  public increment(name: string, value: number = 1, labels?: Labels): void {
    const key = this.getKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    if (name.startsWith('llm_')) {
      logger.debug(`[Metrics] Incremented ${name} by ${value}${labels ? ` (labels: ${JSON.stringify(labels)})` : ''}`);
    }
  }

  public setGauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(this.getKey(name, labels), value);
  }

  public observe(name: string, value: number, labels?: Labels): void {
    // FIX (#15): Guard against NaN/Infinity which would corrupt histogram calculations
    if (!Number.isFinite(value)) return;
    const key = this.getKey(name, labels);
    let entry = this.histograms.get(key);
    if (!entry) {
      entry = { values: [], pointer: 0, limit: 10_000, dirty: true, cached: null };
      this.histograms.set(key, entry);
    }
    entry.dirty = true;
    if (entry.values.length < entry.limit) {
      entry.values.push(value);
    } else {
      entry.values[entry.pointer] = value;
      entry.pointer = (entry.pointer + 1) % entry.limit;
    }
  }

  public async measure<T>(name: string, action: () => Promise<T>, labels?: Labels): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      const result = await action();
      this.observe(name, Number(process.hrtime.bigint() - start) / 1_000_000, labels);
      return result;
    } catch (error) {
      this.observe(name, Number(process.hrtime.bigint() - start) / 1_000_000, { ...labels, error: 'true' });
      this.increment(`${name}_errors_total`, 1, labels);
      throw error;
    }
  }

  private percentile(sorted: number[], pct: number): number {
    const len = sorted.length;
    if (len === 0) return 0;
    if (len === 1) return sorted[0] ?? 0;
    if (pct <= 0) return sorted[0] ?? 0;
    if (pct >= 100) return sorted[len - 1] ?? 0;
    const rank = (pct / 100) * (len - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    const w = rank - lo;
    return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * w;
  }

  public getSnapshot(): IMetricsSnapshot {
    const snap: IMetricsSnapshot = { counters: {}, gauges: {}, histograms: {} };

    for (const [k, v] of this.counters) snap.counters[k] = v;
    for (const [k, v] of this.gauges)   snap.gauges[k]   = v;

    for (const [k, entry] of this.histograms) {
      if (entry.values.length === 0) continue;
      
      if (!entry.dirty && entry.cached) {
        snap.histograms[k] = entry.cached;
        continue;
      }

      const vals = entry.values;
      const sorted = vals.slice().sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      
      const histogram = {
        count: sorted.length,
        min:   sorted[0] ?? 0,
        max:   sorted[sorted.length - 1] ?? 0,
        avg:   sum / sorted.length,
        p50:   this.percentile(sorted, 50),
        p90:   this.percentile(sorted, 90),
        p95:   this.percentile(sorted, 95),
        p99:   this.percentile(sorted, 99),
      };

      entry.cached = histogram;
      entry.dirty = false;
      snap.histograms[k] = histogram;
    }
    return snap;
  }

  public clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

// ── Run-registry routing ───────────────────────────────────────────────────

/** AsyncLocalStorage slot that holds the active run-scoped MetricsRegistry. */
const runRegistryStorage = new AsyncLocalStorage<MetricsRegistry>();

/**
 * Execute `fn` with `registry` as the active run-scoped metrics target.
 * Every `metrics.*` call inside `fn` — including all async continuations —
 * will emit into `registry` rather than the session registry.
 * The run context does NOT nest; a second runWithRunRegistry call inside an
 * existing one replaces the active registry for that sub-scope.
 */
export function runWithRunRegistry<T>(
  registry: MetricsRegistry,
  fn: () => Promise<T>,
): Promise<T> {
  return runRegistryStorage.run(registry, fn);
}

// ── Session-level manager ──────────────────────────────────────────────────

const MAX_RUN_HISTORY = 10;

/**
 * Two-tier session-scoped metrics manager (the exported `metrics` singleton).
 *
 * Emit methods route to the run registry when inside a runWithRunRegistry
 * context, falling back to the session registry otherwise:
 *
 *   • Infrastructure events at startup / health-check time  → session registry
 *   • Everything emitted during a research invocation        → run registry
 *
 * Run registries are created by the research tool, passed to runWithRunRegistry,
 * and discarded after the run. A RunSummary snapshot is appended to _runHistory
 * by calling recordRunSummary() after the runWithRunRegistry call returns
 * (i.e. outside the run context, so the write goes to session scope).
 */
class SessionMetrics {
  private readonly _session = new MetricsRegistry();
  private _sessionStartedAt = Date.now();
  private _runHistory: RunSummary[] = [];

  private getActive(): MetricsRegistry {
    return runRegistryStorage.getStore() ?? this._session;
  }

  // ── Emit API (routes to active registry) ──────────────────────────────

  public increment(name: string, value: number = 1, labels?: Labels): void {
    this.getActive().increment(name, value, labels);
  }

  public setGauge(name: string, value: number, labels?: Labels): void {
    this.getActive().setGauge(name, value, labels);
  }

  public observe(name: string, value: number, labels?: Labels): void {
    this.getActive().observe(name, value, labels);
  }

  public async measure<T>(name: string, action: () => Promise<T>, labels?: Labels): Promise<T> {
    return this.getActive().measure(name, action, labels);
  }

  // ── Session-level read API ─────────────────────────────────────────────

  /** Snapshot of the session registry (infrastructure / cross-run metrics). */
  public getSessionSnapshot(): IMetricsSnapshot {
    return this._session.getSnapshot();
  }

  /** Millisecond timestamp when this session started or was last reset. */
  public getSessionStartedAt(): number {
    return this._sessionStartedAt;
  }

  /**
   * Ordered run summaries, oldest first. Capped at MAX_RUN_HISTORY entries.
   * Returns a shallow copy so callers cannot mutate the internal list.
   */
  public getRunHistory(): readonly RunSummary[] {
    return [...this._runHistory];
  }

  // ── Run lifecycle API ──────────────────────────────────────────────────

  /**
   * Append a completed run's snapshot to the history.
   * Call this AFTER runWithRunRegistry returns so the write lands in session
   * scope. Automatically evicts the oldest entry when the cap is reached.
   */
  public recordRunSummary(summary: RunSummary): void {
    this._runHistory.push(summary);
    if (this._runHistory.length > MAX_RUN_HISTORY) {
      this._runHistory.shift();
    }
  }

  // ── Reset API ──────────────────────────────────────────────────────────

  /**
   * Clear the session registry, run history, and session start timestamp.
   * In-flight run registries are NOT affected.
   */
  public clearSession(): void {
    this._session.clear();
    this._runHistory = [];
    this._sessionStartedAt = Date.now();
  }
}

/** Global session-scoped metrics instance. */
export const metrics = new SessionMetrics();
