/**
 * Metrics Utility Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { metrics } from '../../../src/utils/metrics.ts';

describe('Metrics Utility', () => {
  beforeEach(() => {
    metrics.clear();
  });

  it('increments counters correctly', () => {
    metrics.increment('test_counter', 1);
    metrics.increment('test_counter', 5, { status: 'success' });
    
    const snapshot = metrics.getSnapshot();
    expect(snapshot.counters['test_counter']).toBe(1);
    expect(snapshot.counters['test_counter{status="success"}']).toBe(5);
  });

  it('sets gauges correctly', () => {
    metrics.setGauge('test_gauge', 42);
    metrics.setGauge('test_gauge', 100, { type: 'memory' });
    
    const snapshot = metrics.getSnapshot();
    expect(snapshot.gauges['test_gauge']).toBe(42);
    expect(snapshot.gauges['test_gauge{type="memory"}']).toBe(100);
  });

  it('observes values correctly', () => {
    metrics.observe('test_histogram', 10.5);
    metrics.observe('test_histogram', 20, { op: 'read' });
    
    const snapshot = metrics.getSnapshot();
    expect(snapshot.histograms['test_histogram'].count).toBe(1);
    expect(snapshot.histograms['test_histogram'].avg).toBe(10.5);
    expect(snapshot.histograms['test_histogram{op="read"}'].count).toBe(1);
  });

  it('measures async tasks correctly', async () => {
    const result = await metrics.measure('test_measure', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'done';
    });
    
    expect(result).toBe('done');
    const snapshot = metrics.getSnapshot();
    expect(snapshot.histograms['test_measure']).toBeDefined();
    expect(snapshot.histograms['test_measure'].count).toBe(1);
  });

  it('handles labels correctly', () => {
    metrics.increment('labeled_counter', 1, { label1: 'a', label2: 'b' });
    const snapshot = metrics.getSnapshot();
    expect(snapshot.counters['labeled_counter{label1="a",label2="b"}']).toBe(1);
  });
});
