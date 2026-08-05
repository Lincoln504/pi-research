import { describe, it, expect } from 'vitest';
import { extractRunStats, buildResearchSummary } from '../../../src/utils/metrics-summary.ts';
import { MetricsRegistry } from '../../../src/utils/metrics.ts';
import type { IMetricsSnapshot } from '../../../src/utils/metrics.ts';

function snapshot(counters: Record<string, number>): IMetricsSnapshot {
  return {
    counters,
    histograms: {
      'research_session_duration_ms{mode="deep",complexity="1",status="success"}': {
        count: 1, min: 1000, max: 1000, avg: 1000, p99: 1000,
      },
    },
  } as unknown as IMetricsSnapshot;
}

describe('extractRunStats — error accounting', () => {
  it('EXCLUDES scrape_errors_total from the error count (blocked/unavailable sources are not engine errors)', () => {
    // A run where every scrape was blocked: scrape_errors_total is inflated (multiple
    // increments per URL along the fetch→browser chain) and total_failure counts the URLs.
    const stats = extractRunStats(snapshot({
      'researchers_launched_total{mode="deep",complexity="1",round="1"}': 1,
      'scrape_results_total{outcome="total_failure"}': 4,
      'scrape_errors_total{error_type="bot_protection"}': 8,
      'scrape_errors_total{error_type="fallback_failed",layer="playwright"}': 4,
      'llm_tokens_total{component="researcher",complexity="1"}': 100,
    }))!;

    expect(stats).not.toBeNull();
    expect(stats.urlsFailed).toBe(4);   // surfaced to the user as "not scraped"
    expect(stats.errors).toBe(0);       // NOT counted as errors
  });

  it('counts researcher_errors_total as genuine engine errors', () => {
    const stats = extractRunStats(snapshot({
      'researchers_launched_total{mode="deep",complexity="1",round="1"}': 2,
      'researcher_errors_total{mode="deep",complexity="1",round="1"}': 2,
      'scrape_errors_total{error_type="bot_protection"}': 5,
      'llm_tokens_total{component="researcher",complexity="1"}': 100,
    }))!;

    expect(stats.errors).toBe(2); // researcher errors only, scrape blocks excluded
  });
});

describe('extractRunStats — real registry key shapes', () => {
  it('finds the duration histogram under the registry-sorted label order and any complexity value', () => {
    const reg = new MetricsRegistry();
    // Label insertion order here is deliberately NON-alphabetical: the registry
    // sorts keys, so the emitted histogram key is
    // research_session_duration_ms{complexity="4",mode="deep",status="success"} —
    // a hardcoded {mode,complexity,status} lookup can never match it, and
    // complexity="4" is outside any fixed 0-3 enumeration.
    reg.observe('research_session_duration_ms', 42_000, { mode: 'deep', complexity: '4', status: 'success' });
    reg.increment('researchers_launched_total', 1, { mode: 'deep', complexity: '4', round: '1' });
    reg.increment('llm_tokens_total', 100, { component: 'researcher' });

    const stats = extractRunStats(reg.getSnapshot())!;
    expect(stats).not.toBeNull();
    expect(stats.durationMs).toBe(42_000);
  });

  it('reports the deduped unique-URL count, not raw + unique summed', () => {
    const reg = new MetricsRegistry();
    // browser_search_unique_urls_total is the cross-query deduped subset of the
    // same batch counted by browser_search_results_total — summing both would
    // report 32 discovered URLs for 12 real ones.
    reg.increment('browser_search_results_total', 20, { engine: 'ddg' });
    reg.increment('browser_search_unique_urls_total', 12);
    reg.increment('researchers_launched_total', 1, { mode: 'deep', complexity: '1', round: '1' });

    const stats = extractRunStats(reg.getSnapshot())!;
    expect(stats).not.toBeNull();
    expect(stats.urlsDiscovered).toBe(12);
  });

  it('falls back to the raw results counter when a search died before emitting the unique count', () => {
    const reg = new MetricsRegistry();
    reg.increment('browser_search_results_total', 7, { engine: 'ddg' });
    reg.increment('researchers_launched_total', 1, { mode: 'deep', complexity: '1', round: '1' });

    const stats = extractRunStats(reg.getSnapshot())!;
    expect(stats).not.toBeNull();
    expect(stats.urlsDiscovered).toBe(7);
  });
});

describe('buildResearchSummary — footnote', () => {
  it('shows "not scraped" for blocked sources and NO error footnote when there are no engine errors', () => {
    const stats = extractRunStats(snapshot({
      'researchers_launched_total{mode="deep",complexity="1",round="1"}': 1,
      'scrape_results_total{outcome="fetch_success"}': 2,
      'scrape_results_total{outcome="total_failure"}': 3,
      'scrape_errors_total{error_type="bot_protection"}': 6,
      'llm_tokens_total{component="researcher",complexity="1"}': 100,
    }))!;

    const summary = buildResearchSummary(stats);
    expect(summary).toContain('3 not scraped');
    expect(summary).not.toContain('error');
  });

  it('emits an error footnote only for genuine engine errors', () => {
    const stats = extractRunStats(snapshot({
      'researchers_launched_total{mode="deep",complexity="1",round="1"}': 1,
      'scrape_results_total{outcome="fetch_success"}': 1,
      'researcher_errors_total{mode="deep",complexity="1",round="1"}': 1,
      'llm_tokens_total{component="researcher",complexity="1"}': 100,
    }))!;

    const summary = buildResearchSummary(stats);
    expect(summary).toContain('1 error encountered');
  });
});
