/**
 * PlanningService Unit Tests
 *
 * Tests the planning service's state management, lifecycle, and the real
 * plan-processing logic that sits around the LLM calls.  The `complete` and
 * `completeSimple` functions from @earendil-works/pi-ai are the only things
 * mocked — everything else (JSON parsing, query capping, fallback plans,
 * retry gates) runs real implementation code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanningService } from '../../../src/core/planning-service.ts';
import { ServiceLifecycle } from '../../../src/core/service-registry.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@earendil-works/pi-ai', () => ({
  complete: vi.fn(),
  completeSimple: vi.fn(),
  calculateCost: vi.fn(() => ({ total: 0 })),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn() },
}));

vi.mock('../../../src/utils/prompts.ts', () => ({
  loadPrompt: vi.fn(() => 'system prompt {ROOT_QUERY} {MAX_TEAM_SIZE} {QUERY_BUDGET} {COMPLEXITY_LABEL} {COMPLEXITY_GUIDANCE} {{historical_links_section}} {ROUND_NUMBER} {MAX_ROUNDS} {ROUND_PHASE_GUIDANCE} {COMPLEXITY_GUIDANCE} {{previous_queries_section}} {{historical_links_section}}'),
}));

vi.mock('../../../src/utils/inject-date.ts', () => ({
  injectCurrentDate: vi.fn((_prompt: string, _tag: string) => _prompt),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { complete, completeSimple } from '@earendil-works/pi-ai';
import type { StopReason } from '@earendil-works/pi-ai';

const STUB_MODEL = { id: 'test-model' } as any;

const MOCK_CTX = {
  modelRegistry: {
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} }),
  },
};

/** Build a mock `complete()` response with text content. */
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
    vi.mocked(MOCK_CTX.modelRegistry.getApiKeyAndHeaders).mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} });
    vi.mocked(complete).mockClear();
    vi.mocked(completeSimple).mockClear();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('starts in UNINITIALIZED state', () => {
      expect(service.lifecycle).toBe(ServiceLifecycle.UNINITIALIZED);
    });

    it('transitions to INITIALIZED after initialize()', async () => {
      await service.initialize(MOCK_CTX);
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('isReady() is true after initialization', async () => {
      await service.initialize(MOCK_CTX);
      expect(service.isReady()).toBe(true);
    });

    it('isReady() is false before initialization', () => {
      expect(service.isReady()).toBe(false);
    });

    it('initializing twice without ctx does not reinitialize', async () => {
      await service.initialize(MOCK_CTX);
      // Second call without ctx should be a no-op
      await service.initialize();
      expect(service.lifecycle).toBe(ServiceLifecycle.INITIALIZED);
    });

    it('initializing with a new ctx updates the context', async () => {
      await service.initialize(MOCK_CTX);
      const newCtx = { ...MOCK_CTX };
      await service.initialize(newCtx); // should not throw
      expect(service.isReady()).toBe(true);
    });

    it('transitions to DISPOSED after dispose()', async () => {
      await service.initialize(MOCK_CTX);
      await service.dispose();
      expect(service.lifecycle).toBe(ServiceLifecycle.DISPOSED);
    });

    it('dispose() clears all planning state', async () => {
      await service.initialize(MOCK_CTX);
      service.addToQueryHistory('test-session', ['q1', 'q2']);
      service.incrementTotalResearchersPlanned('test-session', 3);
      await service.dispose();
      // Service is disposed but we can still read the (reset) fields
      expect(service.getTotalResearchersPlanned('test-session')).toBe(0);
      expect(service.getQueryHistory('test-session')).toHaveLength(0);
      expect(service.getCurrentPlan('test-session')).toBeNull();
    });
  });

  // ── State management ────────────────────────────────────────────────────────

  describe('query history', () => {
    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
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

    it('addToQueryHistory with empty array is a no-op', () => {
      service.addToQueryHistory('test-session', ['q1']);
      service.addToQueryHistory('test-session', []);
      expect(service.getQueryHistory('test-session')).toHaveLength(1);
    });
  });

  describe('totalResearchersPlanned', () => {
    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
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
      await service.initialize(MOCK_CTX);
    });

    it('resets queryHistory, currentPlan, and totalResearchersPlanned', () => {
      service.addToQueryHistory('test-session', ['q1', 'q2']);
      service.incrementTotalResearchersPlanned('test-session', 4);
      service.clearPlanningState();
      expect(service.getQueryHistory('test-session')).toEqual([]);
      expect(service.getTotalResearchersPlanned('test-session')).toBe(0);
      expect(service.getCurrentPlan('test-session')).toBeNull();
    });

    it('is idempotent — calling twice does not throw', () => {
      service.clearPlanningState();
      expect(() => service.clearPlanningState()).not.toThrow();
    });
  });

  describe('getCurrentPlan', () => {
    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
    });

    it('returns null before any plan is generated', () => {
      expect(service.getCurrentPlan('test-session')).toBeNull();
    });
  });

  // ── Delegation to planning-utils ────────────────────────────────────────────

  describe('getTeamSize / getQueryBudget / getMaxRounds pass-through', () => {
    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
    });

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

  // ── parseJsonPlan / buildFallbackCoordinatorPlan ────────────────────────────

  describe('parseJsonPlan', () => {
    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
    });

    it('parses a well-formed delegate plan', () => {
      const json = validDelegatePlanJson(2);
      const plan = service.parseJsonPlan(json);
      expect(plan.action).toBe('delegate');
      expect(plan.researchers).toHaveLength(2);
    });

    it('throws on invalid JSON', () => {
      expect(() => service.parseJsonPlan('not json at all')).toThrow();
    });

    it('throws on JSON that lacks a researchers array', () => {
      expect(() => service.parseJsonPlan(JSON.stringify({ action: 'delegate' }))).toThrow();
    });
  });

  describe('buildFallbackCoordinatorPlan', () => {
    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
    });

    it('always returns a delegate plan with exactly one researcher', () => {
      const plan = service.buildFallbackCoordinatorPlan('', 'What is quantum computing?');
      expect(plan.action).toBe('delegate');
      expect(plan.researchers).toHaveLength(1);
    });

    it('fallback researcher includes the original query in its queries list', () => {
      const query = 'What is the capital of France?';
      const plan = service.buildFallbackCoordinatorPlan('', query);
      const allQueries = plan.researchers![0]!.queries;
      expect(allQueries.some(q => q.includes('France'))).toBe(true);
    });

    it('fallback researcher has a non-empty goal', () => {
      const plan = service.buildFallbackCoordinatorPlan('', 'test query');
      expect(plan.researchers![0]!.goal.length).toBeGreaterThan(0);
    });
  });

  // ── capResearcherQueries ────────────────────────────────────────────────────

  describe('capResearcherQueries', () => {
    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
    });

    it('removes researchers with no queries', () => {
      const plan = {
        action: 'delegate' as const,
        researchers: [
          { id: '1', name: 'R1', goal: 'g', queries: ['q1'] },
          { id: '2', name: 'R2', goal: 'g', queries: [] },
        ],
        allQueries: ['q1'],
      };
      const capped = service.capResearcherQueries(plan, 1);
      expect(capped.researchers!.every(r => r.queries.length > 0)).toBe(true);
    });

    it('caps individual researcher queries to the budget for the complexity level', () => {
      const budget = service.getQueryBudget(1);
      const tooManyQueries = Array.from({ length: budget + 5 }, (_, i) => `q${i}`);
      const plan = {
        action: 'delegate' as const,
        researchers: [{ id: '1', name: 'R1', goal: 'g', queries: tooManyQueries }],
        allQueries: tooManyQueries,
      };
      const capped = service.capResearcherQueries(plan, 1);
      expect(capped.researchers![0]!.queries.length).toBeLessThanOrEqual(budget);
    });

    it('rebuilds allQueries from the capped researchers', () => {
      const plan = {
        action: 'delegate' as const,
        researchers: [
          { id: '1', name: 'R1', goal: 'g', queries: ['a', 'b'] },
          { id: '2', name: 'R2', goal: 'g', queries: ['c'] },
        ],
        allQueries: ['a', 'b', 'c', 'stale'],
      };
      const capped = service.capResearcherQueries(plan, 1);
      expect(capped.allQueries).toEqual(['a', 'b', 'c']);
    });
  });

  // ── generatePlan (LLM path) ─────────────────────────────────────────────────

  describe('generatePlan', () => {
    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
    });

    it('throws if not initialized with a ctx', async () => {
      const bare = new PlanningService();
      await bare.initialize(); // no ctx
      await expect(bare.generatePlan({
        sessionId: 'test-session', query: 'test', complexity: 1, model: STUB_MODEL,
      })).rejects.toThrow('Not initialized with ctx');
    });

    it('throws if model auth fails', async () => {
      vi.mocked(MOCK_CTX.modelRegistry.getApiKeyAndHeaders).mockResolvedValueOnce({ ok: false, error: 'unauthorized' });
      await expect(service.generatePlan({
        sessionId: 'test-session', query: 'test', complexity: 1, model: STUB_MODEL,
      })).rejects.toThrow('auth failed');
    });

    it('returns a valid plan when LLM returns well-formed JSON', async () => {
      vi.mocked(complete).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(2)));
      const plan = await service.generatePlan({ sessionId: 'test-session', query: 'test query', complexity: 1, model: STUB_MODEL });
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.length).toBeGreaterThan(0);
    });

    it('sets the currentPlan after a successful generatePlan call', async () => {
      vi.mocked(complete).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(1)));
      await service.generatePlan({ sessionId: 'test-session', query: 'test', complexity: 1, model: STUB_MODEL });
      expect(service.getCurrentPlan('test-session')).not.toBeNull();
      expect(service.getCurrentPlan('test-session')!.action).toBe('delegate');
    });

    it('increments totalResearchersPlanned by the number of researchers in the plan', async () => {
      vi.mocked(complete).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(2)));
      await service.generatePlan({ sessionId: 'test-session', query: 'test', complexity: 1, model: STUB_MODEL });
      expect(service.getTotalResearchersPlanned('test-session')).toBe(2);
    });

    it('falls back to a single-researcher plan after 3 failed JSON parse attempts', async () => {
      vi.mocked(complete).mockResolvedValue(makeCompleteResponse('not valid json at all'));
      const plan = await service.generatePlan({ sessionId: 'test-session', query: 'what is rust', complexity: 1, model: STUB_MODEL });
      // Fallback is always a 1-researcher delegate plan
      expect(plan.action).toBe('delegate');
      expect(plan.researchers).toHaveLength(1);
    });

    it('calls complete() up to 3 times before falling back', async () => {
      vi.mocked(complete).mockResolvedValue(makeCompleteResponse('invalid json'));
      await service.generatePlan({ sessionId: 'test-session', query: 'q', complexity: 1, model: STUB_MODEL });
      expect(vi.mocked(complete)).toHaveBeenCalledTimes(3);
    });

    it('succeeds on the second attempt after one JSON failure', async () => {
      vi.mocked(complete)
        .mockResolvedValueOnce(makeCompleteResponse('bad json'))
        .mockResolvedValueOnce(makeCompleteResponse(validDelegatePlanJson(1)));
      const plan = await service.generatePlan({ sessionId: 'test-session', query: 'q', complexity: 1, model: STUB_MODEL });
      expect(plan.action).toBe('delegate');
      expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
    });

    it('throws immediately when the model returns an error stop reason', async () => {
      vi.mocked(complete).mockResolvedValue(makeCompleteResponse('', 'error'));
      await expect(service.generatePlan({ sessionId: 'test-session', query: 'q', complexity: 1, model: STUB_MODEL }))
        .rejects.toThrow('Coordinator model API error');
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
      vi.mocked(complete).mockResolvedValue(makeCompleteResponse(planJson));
      const plan = await service.generatePlan({ sessionId: 'test-session', query: 'q', complexity: 1, model: STUB_MODEL });
      expect(plan.researchers!.length).toBeLessThanOrEqual(maxSize);
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
      previousPlan: { action: 'delegate' as const, researchers: [], allQueries: ['q1'] },
      totalResearchersPlanned: 1,
    };

    beforeEach(async () => {
      await service.initialize(MOCK_CTX);
    });

    it('throws if not initialized with a ctx', async () => {
      const bare = new PlanningService();
      await bare.initialize();
      await expect(bare.updatePlanForRound(BASE_OPTIONS)).rejects.toThrow('Not initialized with ctx');
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

    it('forces synthesize when delegate plan has no researchers array', async () => {
      const delegateNoResearchers = JSON.stringify({ action: 'delegate' });
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(delegateNoResearchers));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
    });

    it('forces synthesize when delegate plan has an empty researchers array', async () => {
      const emptyDelegatePlan = JSON.stringify({ action: 'delegate', researchers: [], allQueries: [] });
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(emptyDelegatePlan));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
    });

    it('falls back to a synthesize plan wrapping the raw text when JSON parsing completely fails', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse('completely unparseable text'));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
      expect(plan.content).toBeTruthy();
    });

    it('calls the observer onEvaluationProgress callback', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson()));
      const onEvaluationProgress = vi.fn();
      await service.updatePlanForRound({ ...BASE_OPTIONS, observer: { onEvaluationProgress } as any });
      expect(onEvaluationProgress).toHaveBeenCalled();
    });

    it('throws when the model returns an error stop reason', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse('', 'error'));
      await expect(service.updatePlanForRound(BASE_OPTIONS)).rejects.toThrow('Evaluator model API error');
    });

    it('updates currentPlan after a successful call', async () => {
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson()));
      await service.updatePlanForRound(BASE_OPTIONS);
      expect(service.getCurrentPlan('test-session')).not.toBeNull();
    });

    it('includes reports from multiple researchers in the prompt (verifiable via completeSimple call)', async () => {
      const reports = new Map([
        ['1.1', 'Report A'],
        ['1.2', 'Report B'],
      ]);
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson()));
      await service.updatePlanForRound({ ...BASE_OPTIONS, reports });
      const callArg = vi.mocked(completeSimple).mock.calls[0]![1] as any;
      const msgText = callArg.messages[0].content[0].text as string;
      expect(msgText).toContain('Report A');
      expect(msgText).toContain('Report B');
    });
  });
});
