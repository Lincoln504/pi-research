/**
 * Unit tests for the unified LLM usage accounting helper.
 *
 * recordLlmUsage is the single primitive every billed LLM call routes through so the
 * run-scoped metrics registry (the source of truth the tool layer reports) and the live
 * observer stay in lock-step. These tests pin: (1) tokens+cost land in the ACTIVE run
 * registry with the given component label, (2) the observer is notified once per call,
 * (3) repeated calls accumulate (per-turn emission, not cumulative), (4) zero/absent
 * usage is a no-op.
 */
import { describe, it, expect, vi } from 'vitest';
import { recordLlmUsage } from '../../../src/utils/llm-usage';
import { MetricsRegistry, runWithRunRegistry } from '../../../src/utils/metrics';
import { sumCounter } from '../../../src/utils/metrics-summary';

const model = { id: 'test/model' } as any;
// Provide an explicit cost so extractUsage never needs the pi-ai cost table.
const usage = { input: 100, output: 50, totalTokens: 150, cost: { total: 0.03 } };

describe('recordLlmUsage', () => {
  it('records tokens+cost into the active run registry and notifies the observer', async () => {
    const observer = { onTokensConsumed: vi.fn() };
    const reg = new MetricsRegistry();
    await runWithRunRegistry(reg, async () => {
      const out = recordLlmUsage(model, usage, { component: 'coordinator', complexity: 2, observer });
      expect(out).toEqual({ tokens: 150, cost: 0.03 });
    });
    const counters = reg.getSnapshot().counters;
    expect(sumCounter(counters, 'llm_tokens_total')).toBe(150);
    expect(sumCounter(counters, 'llm_cost_total')).toBeCloseTo(0.03, 6);
    // Component label is applied so metrics-summary can attribute spend.
    expect(Object.keys(counters).some((k) => k.includes('component="coordinator"'))).toBe(true);
    expect(observer.onTokensConsumed).toHaveBeenCalledTimes(1);
    expect(observer.onTokensConsumed).toHaveBeenCalledWith(150, 0.03);
  });

  it('accumulates across calls (per-turn emission is summed, not treated as cumulative)', async () => {
    const observer = { onTokensConsumed: vi.fn() };
    const reg = new MetricsRegistry();
    await runWithRunRegistry(reg, async () => {
      recordLlmUsage(model, usage, { component: 'researcher', observer });
      recordLlmUsage(model, usage, { component: 'researcher', observer });
    });
    expect(sumCounter(reg.getSnapshot().counters, 'llm_tokens_total')).toBe(300);
    expect(observer.onTokensConsumed).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for zero or absent usage', async () => {
    const observer = { onTokensConsumed: vi.fn() };
    const reg = new MetricsRegistry();
    await runWithRunRegistry(reg, async () => {
      expect(recordLlmUsage(model, null, { component: 'coordinator', observer })).toEqual({ tokens: 0, cost: 0 });
      recordLlmUsage(model, { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } }, { component: 'coordinator', observer });
    });
    expect(sumCounter(reg.getSnapshot().counters, 'llm_tokens_total')).toBe(0);
    expect(observer.onTokensConsumed).not.toHaveBeenCalled();
  });

  it('works with no observer (headless) — records to metrics only', async () => {
    const reg = new MetricsRegistry();
    await runWithRunRegistry(reg, async () => {
      recordLlmUsage(model, usage, { component: 'evaluator' });
    });
    expect(sumCounter(reg.getSnapshot().counters, 'llm_tokens_total')).toBe(150);
  });
});
