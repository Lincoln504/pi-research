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
  completeSimple: vi.fn(),
  calculateCost: vi.fn(() => ({ total: 0 })),
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

import { completeSimple } from '@earendil-works/pi-ai';
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
      // In generatePlan, it's actually handled by internal try-catch or agentic repair.
      // But if stopReason is 'error', it throws.
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

    it('populates prompts correctly with query and uses maxTokens', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(1)));
      await service.generatePlan(BASE_OPTIONS);
      
      const lastCall = vi.mocked(completeSimple).mock.calls[0];
      const callContext = lastCall![1] as { systemPrompt: string };
      const callOptions = lastCall![2] as { maxTokens: number };
      
      expect(callContext.systemPrompt).toContain('test query');
      expect(callOptions.maxTokens).toBe(4096);
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
      expect(plan.content).toBeTruthy();
    });

    it('updates currentPlan after a successful call', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson()));
      await service.updatePlanForRound(BASE_OPTIONS);
      expect(service.getCurrentPlan('test-session')).not.toBeNull();
    });
  });
});
