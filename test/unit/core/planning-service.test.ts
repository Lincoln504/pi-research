/**
 * PlanningService Unit Tests
 *
 * Tests the planning service's state management, lifecycle, and the real
 * plan-processing logic that sits around the LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanningService } from '../../../src/core/planning-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@earendil-works/pi-ai', () => ({
  calculateCost: vi.fn(() => ({ total: 0 })),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  completeSimple: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn() },
}));

vi.mock('../../../src/core/llm/prompts.ts', () => ({
  loadPrompt: vi.fn(() => 'system prompt {{root_query}}'),
}));

vi.mock('../../../src/core/llm/inject-date.ts', () => ({
  injectCurrentDate: vi.fn((_prompt: string, _tag: string) => _prompt),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { completeSimple } from '@earendil-works/pi-ai/compat';
import { loadPrompt } from '../../../src/core/llm/prompts.ts';
import { getConfig } from '../../../src/config.ts';
import type { StopReason } from '@earendil-works/pi-ai';

const STUB_MODEL = { id: 'test-model' } as any;

const MOCK_MODEL_REGISTRY = {
  getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} }),
} as any;

/** Build a mock `completeSimple()` response with text content. */
function makeCompleteResponse(text: string, stopReason: StopReason = 'stop') {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 100, output: 50,
      cacheRead: 0, cacheWrite: 0, totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

/** A minimal valid JSON plan string for a delegate action. */
function validDelegatePlanJson(numResearchers = 1) {
  const researchers = Array.from({ length: numResearchers }, (_, i) => ({
    id: String(i + 1),
    name: `Researcher ${i + 1}`,
    goal: `Research goal ${i + 1}`,
    queries: [`query ${i + 1}a`, `query ${i + 1}b`],
  }));
  return JSON.stringify({
    action: 'delegate',
    researchers,
    allQueries: researchers.flatMap(r => r.queries),
  });
}

/** A valid synthesize plan JSON. */
function validSynthesizePlanJson(content = 'Final synthesis content') {
  return JSON.stringify({ action: 'synthesize', content, researchers: [], allQueries: [] });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PlanningService', () => {
  let service: PlanningService;

  beforeEach(() => {
    service = new PlanningService();
    vi.mocked(MOCK_MODEL_REGISTRY.getApiKeyAndHeaders).mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} });
    vi.mocked(completeSimple).mockClear();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('starts in UNINITIALIZED state', () => {
      expect(service.lifecycle).toBe(ServiceLifecycle.UNINITIALIZED);
    });

    it('transitions to INITIALIZED after initialize()', async () => {
      await service.initialize();
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('isReady() is true after initialization', async () => {
      await service.initialize();
      expect(service.isReady()).toBe(true);
    });

    it('isReady() is false before initialization', () => {
      expect(service.isReady()).toBe(false);
    });

    it('transitions to DISPOSED after dispose()', async () => {
      await service.initialize();
      await service.dispose();
      expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
    });

    it('dispose() clears all planning state', async () => {
      await service.initialize();
      service.addToQueryHistory('test-session', ['q1', 'q2']);
      service.incrementTotalResearchersPlanned('test-session', 3);
      await service.dispose();
      expect(service.getTotalResearchersPlanned('test-session')).toBe(0);
      expect(service.getQueryHistory('test-session')).toHaveLength(0);
      expect(service.getCurrentPlan('test-session')).toBeNull();
    });
  });

  // ── State management ────────────────────────────────────────────────────────

  describe('query history', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('starts with an empty history', () => {
      expect(service.getQueryHistory('test-session')).toEqual([]);
    });

    it('accumulates queries across multiple calls', () => {
      service.addToQueryHistory('test-session', ['q1', 'q2']);
      service.addToQueryHistory('test-session', ['q3']);
      expect(service.getQueryHistory('test-session')).toEqual(['q1', 'q2', 'q3']);
    });

    it('returns a copy — mutations do not affect internal state', () => {
      service.addToQueryHistory('test-session', ['q1']);
      const history = service.getQueryHistory('test-session');
      history.push('q_injected');
      expect(service.getQueryHistory('test-session')).toHaveLength(1);
    });
  });

  describe('totalResearchersPlanned', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('starts at 0', () => {
      expect(service.getTotalResearchersPlanned('test-session')).toBe(0);
    });

    it('increments correctly', () => {
      service.incrementTotalResearchersPlanned('test-session', 2);
      service.incrementTotalResearchersPlanned('test-session', 3);
      expect(service.getTotalResearchersPlanned('test-session')).toBe(5);
    });
  });

  describe('clearPlanningState', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('resets queryHistory, currentPlan, and totalResearchersPlanned', () => {
      service.addToQueryHistory('test-session', ['q1', 'q2']);
      service.incrementTotalResearchersPlanned('test-session', 4);
      service.clearPlanningState();
      expect(service.getQueryHistory('test-session')).toEqual([]);
      expect(service.getTotalResearchersPlanned('test-session')).toBe(0);
      expect(service.getCurrentPlan('test-session')).toBeNull();
    });
  });

  // ── Delegation to planning-utils ────────────────────────────────────────────

  describe('getTeamSize / getQueryBudget pass-through', () => {
    it('getTeamSize returns correct size for each complexity level', () => {
      const s1 = service.getTeamSize(1);
      const s2 = service.getTeamSize(2);
      const s3 = service.getTeamSize(3);
      expect(s1).toBeGreaterThan(0);
      expect(s2).toBeGreaterThanOrEqual(s1);
      expect(s3).toBeGreaterThanOrEqual(s2);
    });

    it('getQueryBudget increases with complexity', () => {
      expect(service.getQueryBudget(1)).toBeLessThanOrEqual(service.getQueryBudget(2));
      expect(service.getQueryBudget(2)).toBeLessThanOrEqual(service.getQueryBudget(3));
    });
  });

  // ── generatePlan (LLM path) ─────────────────────────────────────────────────

  describe('generatePlan', () => {
    const BASE_OPTIONS = {
      sessionId: 'test-session',
      query: 'test query',
      complexity: 1 as const,
      model: STUB_MODEL,
      modelRegistry: MOCK_MODEL_REGISTRY,
      cwd: '/test/cwd',
    };

    beforeEach(async () => {
      await service.initialize();
    });

    it('throws if model auth fails', async () => {
      vi.mocked(MOCK_MODEL_REGISTRY.getApiKeyAndHeaders).mockResolvedValueOnce({ ok: false, error: 'unauthorized' });
      await expect(service.generatePlan(BASE_OPTIONS)).rejects.toThrow('unauthorized');
    });

    it('returns a valid plan when LLM returns well-formed JSON', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(2)));
      const plan = await service.generatePlan(BASE_OPTIONS);
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.length).toBeGreaterThan(0);
    });

    it('sets the currentPlan after a successful generatePlan call', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(1)));
      await service.generatePlan(BASE_OPTIONS);
      expect(service.getCurrentPlan('test-session')).not.toBeNull();
      expect(service.getCurrentPlan('test-session')!.action).toBe('delegate');
    });

    it('falls back to a single-researcher plan after failed JSON parse', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse('not valid json at all'));
      const plan = await service.generatePlan(BASE_OPTIONS);
      expect(plan.action).toBe('delegate');
      expect(plan.researchers).toHaveLength(1);
    });

    it('throws immediately when the model returns an error stop reason', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse('', 'error'));
      // A provider error is fatal — a fallback plan can't run without a working model.
      await expect(service.generatePlan(BASE_OPTIONS)).rejects.toThrow();
    });

    it('falls back to a single-researcher plan when the coordinator call fails transiently', async () => {
      // A timeout / transient failure on the very first coordinator call must not abort
      // the whole run — it degrades to the deterministic single-researcher plan.
      vi.mocked(completeSimple).mockRejectedValueOnce(new Error('coordinator-generatePlan timed out after 300000ms'));
      const plan = await service.generatePlan(BASE_OPTIONS);
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.length).toBeGreaterThan(0);
    });

    it('still throws if the coordinator fails for a non-transient reason', async () => {
      vi.mocked(completeSimple).mockRejectedValueOnce(new Error('500 Internal Server Error from provider'));
      await expect(service.generatePlan(BASE_OPTIONS)).rejects.toThrow();
    });

    it('caps researchers to the maxTeamSize for the complexity level', async () => {
      const maxSize = service.getTeamSize(1);
      const tooManyResearchers = Array.from({ length: maxSize + 3 }, (_, i) => ({
        id: String(i + 1), name: `R${i + 1}`, goal: `goal ${i + 1}`, queries: ['q'],
      }));
      const planJson = JSON.stringify({
        action: 'delegate',
        researchers: tooManyResearchers,
        allQueries: ['q'],
      });
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(planJson));
      const plan = await service.generatePlan(BASE_OPTIONS);
      expect(plan.researchers!.length).toBeLessThanOrEqual(maxSize);
    });

    it('populates prompts correctly with query, uses the planning token budget, and disables thinking', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(1)));
      await service.generatePlan(BASE_OPTIONS);

      const lastCall = vi.mocked(completeSimple).mock.calls[0];
      const callContext = lastCall![1] as { systemPrompt: string };
      const callOptions = lastCall![2] as { maxTokens: number; reasoning?: string };

      expect(callContext.systemPrompt).toContain('test query');
      // Coordinator uses PLANNING_MAX_TOKENS (default 16384), clamped to the model ceiling
      // (STUB_MODEL has no maxTokens so the default is the binding cap) — no longer the old 4096.
      expect(callOptions.maxTokens).toBe(16384);
      // Thinking is off by default for the engine's structured-JSON calls.
      expect(callOptions.reasoning).toBe('off');
    });
  });

  // ── updatePlanForRound (LLM path) ───────────────────────────────────────────

  describe('updatePlanForRound', () => {
    const BASE_OPTIONS = {
      sessionId: 'test-session',
      reports: new Map([['1.1', 'Report text about the topic.']]),
      round: 1,
      query: 'test query',
      complexity: 1 as const,
      model: STUB_MODEL,
      modelRegistry: MOCK_MODEL_REGISTRY,
      cwd: '/test/cwd',
      previousPlan: { action: 'delegate' as const, researchers: [], allQueries: ['q1'] },
      totalResearchersPlanned: 1,
    };

    beforeEach(async () => {
      await service.initialize();
    });

    it('returns a synthesize plan when the LLM returns a synthesize action', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('Final answer')));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
    });

    it('returns a delegate plan when the LLM returns a valid delegate action', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(1)));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.length).toBeGreaterThan(0);
    });

    it('does NOT throw when the evaluator LLM call fails mid-run — continues the prior agenda', async () => {
      vi.mocked(completeSimple).mockRejectedValue(new Error('LLM call timed out'));
      const plan = await service.updatePlanForRound({
        ...BASE_OPTIONS,
        previousPlan: { action: 'delegate', researchers: [{ id: '1.1', name: 'R', goal: 'g', queries: ['q1'] }], allQueries: ['q1'] },
      });
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.length).toBeGreaterThan(0);
    });

    it('synthesizes (does not throw) when the evaluator LLM call fails and there is no prior agenda', async () => {
      vi.mocked(completeSimple).mockRejectedValue(new Error('empty response'));
      const plan = await service.updatePlanForRound({
        ...BASE_OPTIONS,
        previousPlan: { action: 'delegate', researchers: [], allQueries: [] },
      });
      expect(plan.action).toBe('synthesize');
    });

    it('normalizes citations across reports and injects a GLOBAL SOURCE LIST into the synthesis input', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('done')));
      const reports = new Map([
        ['1.1', 'Alpha point [1] and beta [2].\n\nCITED LINKS\n[1] https://alpha.example.com — Alpha\n[2] https://beta.example.com — Beta'],
        ['1.2', 'Gamma [1], alpha again [2].\n\nCITED LINKS\n[1] https://gamma.example.com — Gamma\n[2] https://alpha.example.com — Alpha'],
      ]);

      await service.updatePlanForRound({ ...BASE_OPTIONS, reports, mustSynthesize: true });

      const call = vi.mocked(completeSimple).mock.calls.at(-1)!;
      const ctx = call[1] as { messages: Array<{ content: Array<{ text: string }> }> };
      const userMsg = ctx.messages[0]!.content[0]!.text;

      // A Global Source List is present (the evaluator prompt promises this).
      expect(userMsg).toContain('GLOBAL SOURCE LIST');
      // Dedup: alpha is cited in BOTH reports but gets exactly ONE global id.
      expect(userMsg).toContain('[1] https://alpha.example.com');
      expect(userMsg).toContain('[2] https://beta.example.com');
      expect(userMsg).toContain('[3] https://gamma.example.com');
      // Report 1.2's local [1] (gamma) is renumbered to global [3]...
      expect(userMsg).toMatch(/Gamma \[3\]/);
      // ...and its local [2] (alpha) to global [1] — bodies now share one numbering.
      expect(userMsg).toMatch(/alpha again \[1\]/);
    });

    it('drops a malformed URL fragment without shifting global ids (no-shift, through the synthesis layer)', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('done')));
      const reports = new Map([
        ['1.1', 'Point [1] and real [2].\n\nCITED LINKS\n[1] https://www\n[2] https://real.example.com — Real'],
      ]);

      await service.updatePlanForRound({ ...BASE_OPTIONS, reports, mustSynthesize: true });

      const call = vi.mocked(completeSimple).mock.calls.at(-1)!;
      const ctx = call[1] as { messages: Array<{ content: Array<{ text: string }> }> };
      const userMsg = ctx.messages[0]!.content[0]!.text;

      // The garbage fragment never appears; the real source holds global id 1.
      expect(userMsg).not.toContain('https://www\n');
      expect(userMsg).toContain('[1] https://real.example.com');
    });

    it('substitutes {{youtube_query_every_n}} into the evaluator prompt from config', async () => {
      vi.mocked(loadPrompt).mockReturnValueOnce('eval {{root_query}} — youtube every {{youtube_query_every_n}}');
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(1)));

      await service.updatePlanForRound({
        ...BASE_OPTIONS,
        config: { ...getConfig('/test/cwd'), YOUTUBE_QUERY_EVERY_N: 9 } as any,
      });

      const call = vi.mocked(completeSimple).mock.calls.at(-1)!;
      const ctx = call[1] as { systemPrompt: string };
      expect(ctx.systemPrompt).toContain('youtube every 9');
      expect(ctx.systemPrompt).not.toContain('{{youtube_query_every_n}}');
    });

    it('forces synthesize when mustSynthesize is true, regardless of LLM response', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(2)));
      const plan = await service.updatePlanForRound({ ...BASE_OPTIONS, mustSynthesize: true });
      expect(plan.action).toBe('synthesize');
    });

    it('forces synthesize when delegate plan has an empty researchers array', async () => {
      const emptyDelegatePlan = JSON.stringify({ action: 'delegate', researchers: [], allQueries: [] });
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(emptyDelegatePlan));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
    });

    it('falls back to a synthesize plan wrapping the raw text when JSON parsing completely fails', async () => {
      const longFallbackText = 'This is completely unparseable text that cannot be parsed as valid JSON by any means whatsoever.';
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(longFallbackText));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
      // The contract is that the unparseable raw text is PRESERVED in content
      // (not replaced by a placeholder), so the synthesis step still has it.
      expect(plan.content).toBe(longFallbackText);
    });

    it('drops too-short unparseable text rather than wrapping noise into content', async () => {
      // Below the 50-char floor the raw text is discarded (empty content), so a
      // stray token never becomes the synthesis basis.
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse('nope'));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
      expect(plan.content).toBe('');
    });

    it('continues the prior agenda (delegate) instead of synthesizing early when a mid-round evaluation is unparseable and rounds remain', async () => {
      // A transient/garbled evaluator response mid-research must NOT prematurely end the run.
      // With a non-empty prior agenda and mustSynthesize unset, it re-delegates that agenda.
      const priorResearchers = [{ id: '1', name: 'R1', goal: 'cover topic A', queries: ['qa'] }];
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse('garbled non-json'));
      const plan = await service.updatePlanForRound({
        ...BASE_OPTIONS,
        mustSynthesize: false,
        previousPlan: { action: 'delegate' as const, researchers: priorResearchers, allQueries: ['qa'] },
      });
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.map((r) => r.name)).toContain('R1');
    });

    it('updates currentPlan after a successful call', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson()));
      await service.updatePlanForRound(BASE_OPTIONS);
      expect(service.getCurrentPlan('test-session')).not.toBeNull();
    });
  });
});
