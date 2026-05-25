/**
 * Metrics Service
 *
 * Service wrapper for the metrics functionality.
 * Provides clean interface for metrics collection and management.
 */

import type { IService } from '../core/service-registry.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { logger } from '../logger.ts';
import type { Labels, IMetricHistogram, IMetricsSnapshot } from '../utils/metrics.ts';
import { MetricsRegistry, metrics } from '../utils/metrics.ts';

/**
 * Metrics Service Implementation
 */
export class MetricsService implements IService {
  readonly name = 'metrics';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // The metrics registry
  private _registry: MetricsRegistry | null = null;

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[MetricsService] Initializing...');

    // Use the existing global metrics registry
    this._registry = metrics;

    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[MetricsService] Initialized');
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[MetricsService] Disposing...');

    // Clear the registry
    if (this._registry) {
      this._registry.clear();
      this._registry = null;
    }

    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[MetricsService] Disposed');
  }

  /**
   * Get the metrics registry
   */
  getRegistry(): MetricsRegistry {
    if (!this._registry) {
      throw new Error('[MetricsService] Metrics registry not initialized');
    }
    return this._registry;
  }

  /**
   * Increment a monotonically increasing counter
   */
  increment(name: string, value: number = 1, labels?: Labels): void {
    this.getRegistry().increment(name, value, labels);
  }

  /**
   * Set a point-in-time gauge value
   */
  setGauge(name: string, value: number, labels?: Labels): void {
    this.getRegistry().setGauge(name, value, labels);
  }

  /**
   * Record a value in a histogram distribution (e.g., latency)
   */
  observe(name: string, value: number, labels?: Labels): void {
    this.getRegistry().observe(name, value, labels);
  }

  /**
   * Utility to measure latency of an async operation
   */
  async measure<T>(name: string, action: () => Promise<T>, labels?: Labels): Promise<T> {
    return this.getRegistry().measure(name, action, labels);
  }

  /**
   * Retrieve a snapshot of all metrics
   */
  getSnapshot(): IMetricsSnapshot {
    return this.getRegistry().getSnapshot();
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.getRegistry().clear();
  }

  /**
   * Get counters snapshot
   */
  getCounters(): Record<string, number> {
    return this.getSnapshot()['counters'] ?? {};
  }

  /**
   * Get gauges snapshot
   */
  getGauges(): Record<string, number> {
    return this.getSnapshot()['gauges'] ?? {};
  }

  /**
   * Get histograms snapshot
   */
  getHistograms(): Record<string, any> {
    return this.getSnapshot()['histograms'] ?? {};
  }

  /**
   * Get a specific counter value
   */
  getCounter(name: string, labels?: Labels): number {
    const counters = this.getCounters();
    if (!labels) {
      return counters[name] ?? 0;
    }
    // Serialize labels to match key format
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map(k => `${k}="${labels[k]}"`).join(',');
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return counters[key] ?? 0;
  }

  /**
   * Get a specific gauge value
   */
  getGauge(name: string, labels?: Labels): number {
    const gauges = this.getGauges();
    if (!labels) {
      return gauges[name] ?? 0;
    }
    // Serialize labels to match key format
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map(k => `${k}="${labels[k]}"`).join(',');
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return gauges[key] ?? 0;
  }

  /**
   * Get histogram statistics for a specific metric
   */
  getHistogramStats(name: string, labels?: Labels): IMetricHistogram | null {
    const histograms = this.getHistograms();
    if (!labels) {
      return histograms[name] ?? null;
    }
    // Serialize labels to match key format
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map(k => `${k}="${labels[k]}"`).join(',');
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return histograms[key] ?? null;
  }

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus(): string {
    const snapshot = this.getSnapshot();
    const lines: string[] = [];

    // Export counters
    for (const [key, value] of Object.entries(snapshot['counters'] ?? {})) {
      lines.push(`${key} ${value}`);
    }

    // Export gauges
    for (const [key, value] of Object.entries(snapshot['gauges'] ?? {})) {
      lines.push(`${key} ${value}`);
    }

    // Export histogram summaries
    for (const [key, stats] of Object.entries(snapshot['histograms'] ?? {})) {
      const s = stats as any;
      lines.push(`${key}_count ${s['count']}`);
      lines.push(`${key}_sum ${(s['avg'] * s['count']).toFixed(2)}`);
      lines.push(`${key}_min ${s['min']}`);
      lines.push(`${key}_max ${s['max']}`);
      lines.push(`${key}_avg ${s['avg'].toFixed(2)}`);
      lines.push(`${key}_p50 ${s['p50'].toFixed(2)}`);
      lines.push(`${key}_p90 ${s['p90'].toFixed(2)}`);
      lines.push(`${key}_p95 ${s['p95'].toFixed(2)}`);
      lines.push(`${key}_p99 ${s['p99'].toFixed(2)}`);
    }

    return lines.join('\n');
  }
}

    // Re-export convenience functions from utils/metrics.ts
    export { type Labels, MetricsRegistry } from '../utils/metrics.ts';