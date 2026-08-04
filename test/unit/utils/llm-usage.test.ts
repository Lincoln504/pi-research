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

  /**
   * Regression guard for a real, weeks-long silent failure: a model whose price
   * table is all zeros bills tokens but reports $0.00 forever, because cost is
   * computed locally as tokens x price rather than read off the wire. Every display
   * site suppressed the zero, so the misconfiguration was invisible. The tests above
   * deliberately supply an explicit cost (see the comment on `usage`), which is
   * exactly why they never exercised this path.
   */
  describe('unpriced-model warning', () => {
    // No `cost.total`, so extractUsage must fall back to the model's price table.
    const usageNoCost = { input: 100, output: 50, totalTokens: 150 };
    const unpriced = {
      provider: 'openrouter',
      id: 'unpriced-model',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as any;

    it('warns once per model when tokens are billed against an all-zero price table', async () => {
      const { logger } = await import('../../../src/logger');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const reg = new MetricsRegistry();
      await runWithRunRegistry(reg, async () => {
        recordLlmUsage(unpriced, usageNoCost, { component: 'researcher' });
        recordLlmUsage(unpriced, usageNoCost, { component: 'researcher' });
      });

      const hits = warn.mock.calls.filter((c) => String(c[0]).includes('price table is all zeros'));
      expect(hits).toHaveLength(1);
      expect(String(hits[0]?.[0])).toContain('openrouter/unpriced-model');
      // Tokens must still be recorded — the warning is diagnostic, not a bail-out.
      expect(sumCounter(reg.getSnapshot().counters, 'llm_tokens_total')).toBe(300);
      warn.mockRestore();
    });

    it('does not warn when the model carries real pricing', async () => {
      const { logger } = await import('../../../src/logger');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const priced = {
        provider: 'openrouter',
        id: 'priced-model',
        cost: { input: 0.07, output: 0.34, cacheRead: 0, cacheWrite: 0 },
      } as any;
      const reg = new MetricsRegistry();
      await runWithRunRegistry(reg, async () => {
        recordLlmUsage(priced, { ...usageNoCost, cost: { total: 0.0002 } }, { component: 'researcher' });
      });
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('price table is all zeros'))).toHaveLength(0);
      warn.mockRestore();
    });

    it('does not warn when no tokens were consumed', async () => {
      const { logger } = await import('../../../src/logger');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const reg = new MetricsRegistry();
      await runWithRunRegistry(reg, async () => {
        recordLlmUsage(unpriced, { input: 0, output: 0, totalTokens: 0 }, { component: 'researcher' });
      });
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('price table is all zeros'))).toHaveLength(0);
      warn.mockRestore();
    });
  });
});
