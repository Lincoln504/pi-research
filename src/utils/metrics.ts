/**
 * Metrics Collection System
 * 
 * Supports three primary metric types:
 * - Counters: Monotonically increasing values (e.g. error counts, request counts)
 * - Gauges: Point-in-time values (e.g. active workers, queue depth)
 * - Histograms: Distributions of values (e.g. operation latency)
 */

export type Labels = Record<string, string>;

/**
 * Metric histogram statistics interface
 */
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

/**
 * Metrics snapshot interface
 */
export interface IMetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, IMetricHistogram>;
}

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  // Histograms store arrays of values for percentile calculation
  private histograms = new Map<string, number[]>();

  private serializeLabels(labels?: Labels): string {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    return keys.map(k => `${k}="${labels[k]}"`).join(',');
  }

  private getKey(name: string, labels?: Labels): string {
    const labelStr = this.serializeLabels(labels);
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  /** Increment a monotonically increasing counter */
  public increment(name: string, value: number = 1, labels?: Labels): void {
    const key = this.getKey(name, labels);
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);
  }

  /** Set a point-in-time gauge value */
  public setGauge(name: string, value: number, labels?: Labels): void {
    const key = this.getKey(name, labels);
    this.gauges.set(key, value);
  }

  /** Record a value in a histogram distribution (e.g., latency) */
  public observe(name: string, value: number, labels?: Labels): void {
    const key = this.getKey(name, labels);
    let values = this.histograms.get(key);
    if (!values) {
      values = [];
      this.histograms.set(key, values);
    }
    values.push(value);
    
    // Prevent unbounded memory growth
    if (values.length > 10000) {
      values.splice(0, 5000); // Remove oldest half
    }
  }

  /** Utility to measure latency of an async operation */
  public async measure<T>(name: string, action: () => Promise<T>, labels?: Labels): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      const result = await action();
      const end = process.hrtime.bigint();
      this.observe(name, Number(end - start) / 1_000_000, labels); // Record in milliseconds
      return result;
    } catch (error) {
      const end = process.hrtime.bigint();
      this.observe(name, Number(end - start) / 1_000_000, { ...labels, error: 'true' });
      this.increment(`${name}_errors_total`, 1, labels);
      throw error;
    }
  }

  /** Calculate a percentile from a sorted array of numbers */
  private percentile(sortedValues: number[], pct: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil((pct / 100) * sortedValues.length) - 1;
    return sortedValues[index] ?? 0;
  }

  /** Retrieve a snapshot of all metrics */
  public getSnapshot(): IMetricsSnapshot {
    const snapshot: IMetricsSnapshot = {
      counters: {},
      gauges: {},
      histograms: {}
    };

    for (const [key, value] of this.counters.entries()) {
      snapshot['counters'][key] = value;
    }

    for (const [key, value] of this.gauges.entries()) {
      snapshot['gauges'][key] = value;
    }

    for (const [key, values] of this.histograms.entries()) {
      if (values.length === 0) continue;
      // Note: slice and sort can be expensive on huge arrays,
      // but bounded by the 10000 max size
      const sorted = values.slice().sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      
      snapshot['histograms'][key] = {
        count: sorted.length,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        avg: sum / sorted.length,
        p50: this.percentile(sorted, 50),
        p90: this.percentile(sorted, 90),
        p95: this.percentile(sorted, 95),
        p99: this.percentile(sorted, 99)
      };
    }

    return snapshot;
  }

  /** Clear all metrics */
  public clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

// Global default registry
export const metrics = new MetricsRegistry();
