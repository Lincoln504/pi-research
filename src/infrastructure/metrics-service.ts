/**
 * Metrics Service
 *
 * Service wrapper that exposes the session-scoped metrics singleton through
 * the service registry. All methods delegate to the global `metrics` export.
 * The service owns no state of its own; metrics belong to the process lifetime
 * and are managed by the SessionMetrics class in utils/metrics.ts.
 */

import type { IService } from '../core/service-registry.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import type { Labels, IMetricHistogram, IMetricsSnapshot } from '../utils/metrics.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';

export class MetricsService implements IService {
  readonly name = ServiceNames.METRICS;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) return;
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[MetricsService] Initializing...');
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[MetricsService] Initialized');
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) return;
    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[MetricsService] Disposing...');
    // Session metrics belong to the process lifetime, not this service.
    // Nothing to clean up — the process is exiting and memory is freed.
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[MetricsService] Disposed');
  }

  increment(name: string, value: number = 1, labels?: Labels): void {
    metrics.increment(name, value, labels);
  }

  setGauge(name: string, value: number, labels?: Labels): void {
    metrics.setGauge(name, value, labels);
  }

  observe(name: string, value: number, labels?: Labels): void {
    metrics.observe(name, value, labels);
  }

  async measure<T>(name: string, action: () => Promise<T>, labels?: Labels): Promise<T> {
    return metrics.measure(name, action, labels);
  }

  getSnapshot(): IMetricsSnapshot {
    return metrics.getSessionSnapshot();
  }

  clear(): void {
    metrics.clearSession();
  }

  getCounters(): Record<string, number> {
    return metrics.getSessionSnapshot().counters ?? {};
  }

  getGauges(): Record<string, number> {
    return metrics.getSessionSnapshot().gauges ?? {};
  }

  getHistograms(): Record<string, IMetricHistogram> {
    return metrics.getSessionSnapshot().histograms ?? {};
  }

  getCounter(name: string, labels?: Labels): number {
    const counters = this.getCounters();
    if (!labels) return counters[name] ?? 0;
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map(k => `${k}="${labels[k]}"`).join(',');
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return counters[key] ?? 0;
  }

  getGauge(name: string, labels?: Labels): number {
    const gauges = this.getGauges();
    if (!labels) return gauges[name] ?? 0;
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map(k => `${k}="${labels[k]}"`).join(',');
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return gauges[key] ?? 0;
  }

  getHistogramStats(name: string, labels?: Labels): IMetricHistogram | null {
    const histograms = this.getHistograms();
    if (!labels) return histograms[name] ?? null;
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map(k => `${k}="${labels[k]}"`).join(',');
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return histograms[key] ?? null;
  }

  exportPrometheus(): string {
    const snapshot = metrics.getSessionSnapshot();
    const lines: string[] = [];

    for (const [key, value] of Object.entries(snapshot.counters ?? {})) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of Object.entries(snapshot.gauges ?? {})) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, s] of Object.entries(snapshot.histograms ?? {})) {
      lines.push(`${key}_count ${s.count}`);
      lines.push(`${key}_sum ${(s.avg * s.count).toFixed(2)}`);
      lines.push(`${key}_min ${s.min}`);
      lines.push(`${key}_max ${s.max}`);
      lines.push(`${key}_avg ${s.avg.toFixed(2)}`);
      lines.push(`${key}_p50 ${s.p50.toFixed(2)}`);
      lines.push(`${key}_p90 ${s.p90.toFixed(2)}`);
      lines.push(`${key}_p95 ${s.p95.toFixed(2)}`);
      lines.push(`${key}_p99 ${s.p99.toFixed(2)}`);
    }

    return lines.join('\n');
  }
}

// Re-export for consumers that import from this module
export { type Labels, MetricsRegistry } from '../utils/metrics.ts';
