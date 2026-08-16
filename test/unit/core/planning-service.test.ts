/**
 * PlanningService Unit Tests
 *
 * Tests the planning service's state management, lifecycle, and the real
 * plan-processing logic that sits around the LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PlanningService,
  isRetriableLlmError,
  salvageReportText,
  synthesisCorpusBudgetChars,
  partitionCorpus,
} from '../../../src/core/planning-service.ts';
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
import { metrics } from '../../../src/utils/metrics.ts';
import { logger } from '../../../src/logger.ts';
import { getConfig } from '../../../src/config.ts';
import { MAX_ROUNDS_LEVEL_3, MAX_EXTRA_ROUNDS_WITH_STEERING } from '../../../src/constants.ts';
import type { StopReason } from '@earendil-works/pi-ai';

const STUB_MODEL = { id: 'test-model' } as any;

const MOCK_MODEL_REGISTRY = {
  getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} }),
} as any;

/**
 * Build a mock `completeSimple()` response with text content. Pass `errorMessage` to
 * model a provider/transport failure the way undici actually surfaces it: completeSimple
 * RESOLVES an AssistantMessage with stopReason:'error' + errorMessage (e.g. 'terminated'),
 * and the throw happens later inside validateAndExtractText — so a retry layer must wrap
 * validation, not just the network call.
 */
function makeCompleteResponse(text: string, stopReason: StopReason = 'stop', errorMessage?: string) {
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
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 0,
  };
}

/**
 * Text of the user message from the most recent completeSimple call.
 *
 * The evaluator's run-varying context (round number, agenda, executed queries, steering,
 * round-phase guidance) is deliberately carried in the USER message rather than the
 * system prompt, so the system prompt stays byte-identical across rounds and the prompt
 * cache can hold it. Assertions about that context therefore read from here.
 */
function lastEvaluatorUserMessage(): string {
  const ctx = vi.mocked(completeSimple).mock.calls.at(-1)![1] as {
    messages: Array<{ content: Array<{ type: string; text: string }> }>;
  };
  return ctx.messages.map(m => m.content.map(c => c.text ?? '').join('')).join('\n');
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

describe('isRetriableLlmError — retry classification for the planning LLM calls', () => {
  it('retries fast transient transport failures', () => {
    expect(isRetriableLlmError(new Error('terminated'))).toBe(true);
    expect(isRetriableLlmError(new Error('Coordinator failed: terminated'))).toBe(true);
    expect(isRetriableLlmError(new Error('read ECONNRESET'))).toBe(true);
    expect(isRetriableLlmError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRetriableLlmError(new Error('Evaluator returned no text content from LLM'))).toBe(true);
  });

  it('does NOT retry an app-level LLM timeout (it degrades instead of orphaning a stream)', () => {
    expect(isRetriableLlmError(new Error('LLM call timed out after 300000ms (coordinator-generatePlan)'))).toBe(false);
  });

  it('does NOT retry a non-transient error', () => {
    expect(isRetriableLlmError(new Error('invalid_request_error: unsupported model id'))).toBe(false);
    expect(isRetriableLlmError(new Error('401 unauthorized'))).toBe(false);
  });

  it('never retries once the caller signal is aborted, regardless of message', () => {
    const ac = new AbortController();
    ac.abort();
    // A "terminated"/transient message that would normally retry must NOT once cancelled.
    expect(isRetriableLlmError(new Error('terminated'), ac.signal)).toBe(false);
    expect(isRetriableLlmError(new Error('coordinator-generatePlan cancelled or timed out'), ac.signal)).toBe(false);
  });

  it('never retries an AbortError by name even if the signal is not (yet) observed', () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(isRetriableLlmError(err)).toBe(false);
  });
});

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

    it('degrades to the single-researcher fallback on a timeout WITHOUT retrying (no orphaned streams)', async () => {
      // An app-level LLM timeout already burned the full budget; re-running it would only
      // orphan the prior stream and multiply the wait — so it degrades in a single attempt.
      vi.mocked(completeSimple).mockRejectedValue(new Error('LLM call timed out after 300000ms (coordinator-generatePlan)'));
      const plan = await service.generatePlan(BASE_OPTIONS);
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.length).toBeGreaterThan(0);
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1); // timeout is NOT retried
    });

    it('retries a persistent transient transport abort, then degrades to the fallback after exhausting retries', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(completeSimple).mockRejectedValue(new Error('terminated'));
        const p = service.generatePlan(BASE_OPTIONS);
        await vi.runAllTimersAsync(); // fast-forward the inter-attempt backoff
        const plan = await p;
        expect(plan.action).toBe('delegate');
        expect(plan.researchers!.length).toBeGreaterThan(0);
        // 1 initial attempt + LLM_MAX_RETRIES(2) retries = 3 calls before degrading.
        expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries a transient "terminated" stream abort, then succeeds (no fallback needed)', async () => {
      // undici drops the streaming response mid-flight → completeSimple RESOLVES a
      // stopReason:'error' message with errorMessage 'terminated'; the retry must recover it.
      vi.useFakeTimers();
      try {
        vi.mocked(completeSimple)
          .mockResolvedValueOnce(makeCompleteResponse('', 'error', 'terminated'))
          .mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(2)));
        const p = service.generatePlan(BASE_OPTIONS);
        await vi.runAllTimersAsync();
        const plan = await p;
        expect(plan.action).toBe('delegate');
        expect(plan.researchers!.length).toBeGreaterThan(0);
        expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(2); // failed once, succeeded on retry
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits token metrics exactly once — for the successful attempt, not the failed retry', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(metrics.increment).mockClear(); // isolate from prior tests' accumulated calls
        vi.mocked(completeSimple)
          .mockResolvedValueOnce(makeCompleteResponse('', 'error', 'terminated'))
          .mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(1)));
        const p = service.generatePlan(BASE_OPTIONS);
        await vi.runAllTimersAsync();
        await p;
        const tokenCalls = vi.mocked(metrics.increment).mock.calls.filter(c => c[0] === 'llm_tokens_total');
        expect(tokenCalls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still throws if the coordinator fails for a non-transient reason', async () => {
      // A non-transient provider rejection (bad request / unsupported model) is not retried
      // and stays fatal — a fallback plan can't run without a working model anyway.
      vi.mocked(completeSimple).mockRejectedValue(new Error('invalid_request_error: unsupported model id'));
      await expect(service.generatePlan(BASE_OPTIONS)).rejects.toThrow();
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1); // no retry on a non-transient error
    });

    it('does not retry a coordinator call cancelled by the caller', async () => {
      const ac = new AbortController();
      ac.abort();
      vi.mocked(completeSimple).mockRejectedValue(new Error('coordinator-generatePlan cancelled or timed out'));
      await expect(service.generatePlan({ ...BASE_OPTIONS, signal: ac.signal })).rejects.toThrow();
      // A deliberate cancel is never transient → no retry, single attempt.
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
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

    it('does NOT throw when the evaluator LLM call times out mid-run — continues the prior agenda (no retry)', async () => {
      vi.mocked(completeSimple).mockRejectedValue(new Error('LLM call timed out'));
      const plan = await service.updatePlanForRound({
        ...BASE_OPTIONS,
        previousPlan: { action: 'delegate', researchers: [{ id: '1.1', name: 'R', goal: 'g', queries: ['q1'] }], allQueries: ['q1'] },
      });
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.length).toBeGreaterThan(0);
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1); // timeout degrades, not retried
    });

    it('retries a transient "terminated" evaluator abort, then succeeds', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(completeSimple)
          .mockResolvedValueOnce(makeCompleteResponse('', 'error', 'terminated'))
          .mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('recovered')));
        const p = service.updatePlanForRound(BASE_OPTIONS);
        await vi.runAllTimersAsync();
        const plan = await p;
        expect(plan.action).toBe('synthesize');
        expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('synthesizes (does not throw) when the evaluator fails transiently and there is no prior agenda', async () => {
      // An app-level timeout is degradable (and deliberately not retried, so this stays
      // a single attempt). A non-degradable failure now rethrows instead — see below.
      vi.mocked(completeSimple).mockRejectedValue(new Error('LLM call timed out after 300000ms (evaluator-updatePlanForRound)'));
      const plan = await service.updatePlanForRound({
        ...BASE_OPTIONS,
        previousPlan: { action: 'delegate', researchers: [], allQueries: [] },
      });
      expect(plan.action).toBe('synthesize');
    });

    it('rethrows a NON-degradable evaluator failure mid-run instead of continuing the prior agenda', async () => {
      // A mid-run credential revocation / provider rejection hits every remaining round
      // identically — degrading would burn each one on doomed search bursts and researcher
      // launches. It must surface the real cause (same isDegradableLlmError gate as
      // generatePlan), even with a runnable prior agenda available.
      vi.mocked(completeSimple).mockRejectedValue(new Error('401 unauthorized'));
      await expect(service.updatePlanForRound({
        ...BASE_OPTIONS,
        previousPlan: { action: 'delegate', researchers: [{ id: '1', name: 'R', goal: 'g', queries: ['q'] }], allQueries: ['q'] },
      })).rejects.toThrow('401 unauthorized');
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1); // non-transient → no retry either
    });

    it('rethrows when evaluation auth lookup fails (no doomed fallback rounds without a working model)', async () => {
      // The auth throw inside the try used to be swallowed by the degrade-on-any-error
      // catch, turning "credentials revoked" into a silent continue-prior-agenda loop.
      vi.mocked(MOCK_MODEL_REGISTRY.getApiKeyAndHeaders).mockResolvedValueOnce({ ok: false, error: 'unauthorized' });
      await expect(service.updatePlanForRound(BASE_OPTIONS)).rejects.toThrow('Failed to get API key for evaluation');
    });

    it('still propagates a cancellation ahead of the degradable/fatal gate', async () => {
      const ac = new AbortController();
      ac.abort();
      vi.mocked(completeSimple).mockRejectedValue(new Error('evaluator-updatePlanForRound cancelled or timed out'));
      await expect(service.updatePlanForRound({ ...BASE_OPTIONS, signal: ac.signal })).rejects.toThrow();
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1); // a deliberate cancel is never retried
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

    // Regression: updatePlanForRound used to always recompute maxRounds internally
    // from the BASE complexity table, blind to any steering-driven extension the
    // orchestrator granted. Once steering pushed currentRound past that base value,
    // the understated denominator both produced an impossible "Round N of base"
    // display AND skewed getRoundPhaseGuidance's roundRatio toward LATE too early —
    // working against what the user spent steering budget to unlock.
    describe('maxRounds option — steering-extended round budget', () => {
      const baseMaxRounds = MAX_ROUNDS_LEVEL_3; // 3
      const steeringExtendedMaxRounds = baseMaxRounds + MAX_EXTRA_ROUNDS_WITH_STEERING; // 3 + 2 = 5
      const currentRound = 4; // only reachable because steering extended the budget past 3

      it('falls back to the base complexity-table maxRounds when no option is supplied (backward compat)', async () => {
        vi.mocked(loadPrompt).mockReturnValueOnce('eval');
        vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('ok')));

        await service.updatePlanForRound({ ...BASE_OPTIONS, complexity: 3, round: currentRound });

        // Round number and round-phase guidance live in the RUN CONTEXT block at the tail
        // of the USER message, not in the system prompt — the system prompt is kept
        // round-invariant so the prompt cache can hold it across rounds.
        const userText = lastEvaluatorUserMessage();
        // No maxRounds passed → falls back to the base value (3). The router is told the
        // RESEARCH budget, which is one less than the iteration budget because the last
        // iteration only synthesizes: "of 2", and a ratio (4/2) that selects LATE.
        expect(userText).toContain(`Round ${currentRound} of ${baseMaxRounds - 1}`);
        expect(userText).toContain('Round Phase: LATE');
      });

      it('uses the caller-supplied maxRounds for round-phase guidance when provided', async () => {
        vi.mocked(loadPrompt).mockReturnValueOnce('eval');
        vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('ok')));

        await service.updatePlanForRound({
          ...BASE_OPTIONS,
          complexity: 3,
          round: currentRound,
          maxRounds: steeringExtendedMaxRounds,
        });

        const userText = lastEvaluatorUserMessage();
        // The steering-extended budget (5) is 5 ITERATIONS, of which 4 can research.
        // Round 4 is therefore the last research round — LATE, not MIDDLE. Passing the
        // raw budget produced MIDDLE here, telling the router to prefer delegation on
        // the one round whose delegation the cap would discard.
        expect(userText).toContain(`Round ${currentRound} of ${steeringExtendedMaxRounds - 1}`);
        expect(userText).toContain('Round Phase: LATE');
        expect(userText).not.toContain('Round Phase: MIDDLE');
      });
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

    it('continues the prior agenda when a mid-run delegate caps to zero runnable researchers', async () => {
      // Regression: a delegate whose researchers ALL had empty query arrays was
      // capResearcherQueries-filtered to zero and force-synthesized — a bogus
      // synthesis decision indistinguishable from a real one, ending the run
      // with rounds remaining. Mirror generatePlan's empty-after-cap guard:
      // with a runnable prior agenda, re-delegate it.
      const bogusDelegate = JSON.stringify({
        action: 'delegate',
        content: 'rationale prose the orchestrator must not ship as the report',
        researchers: [{ id: '1', name: 'Empty', goal: 'g', queries: [] }],
        allQueries: [],
      });
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(bogusDelegate));
      const plan = await service.updatePlanForRound({
        ...BASE_OPTIONS,
        previousPlan: { action: 'delegate' as const, researchers: [{ id: '1', name: 'PriorR', goal: 'g', queries: ['q'] }], allQueries: ['q'] },
      });
      expect(plan.action).toBe('delegate');
      expect(plan.researchers!.map((r) => r.name)).toContain('PriorR');
    });

    it('degrades a zero-runnable delegate to an EMPTY synthesize — never the rationale — when no prior agenda is runnable', async () => {
      // Same failure with nothing to re-delegate: degrade exactly like a
      // transient evaluator failure (empty content), so the orchestrator's
      // reports-based fallback synthesis — not the delegate's rationale prose —
      // produces the report.
      const bogusDelegate = JSON.stringify({
        action: 'delegate',
        content: 'rationale prose the orchestrator must not ship as the report',
        researchers: [{ id: '1', name: 'Empty', goal: 'g', queries: [] }],
        allQueries: [],
      });
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(bogusDelegate));
      const plan = await service.updatePlanForRound({
        ...BASE_OPTIONS,
        previousPlan: { action: 'delegate' as const, researchers: [], allQueries: [] },
      });
      expect(plan.action).toBe('synthesize');
      expect(plan.content ?? '').toBe('');
    });

    it('degrades — not throws — when a NON-degradable error hits the forced FINAL synthesis call', async () => {
      // Regression: the mid-loop hard-throw gate also fired on the one-shot
      // mustSynthesize call, discarding every collected report on e.g. a
      // context-overflow 400. The final call has no rounds left to protect, so
      // it degrades to the empty-synthesize plan and the orchestrator's
      // buildFallbackSynthesis salvages a report.
      vi.mocked(completeSimple).mockRejectedValue(
        new Error("400 This model's maximum context length is 131072 tokens, however you requested 142935 tokens"),
      );
      const plan = await service.updatePlanForRound({ ...BASE_OPTIONS, mustSynthesize: true });
      expect(plan.action).toBe('synthesize');
      expect(plan.content).toBe('');
      expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1); // non-transient → not retried
    });

    it('falls back to a synthesize plan wrapping the raw text when SYNTHESIS JSON parsing completely fails', async () => {
      const longFallbackText = 'This is completely unparseable text that cannot be parsed as valid JSON by any means whatsoever.';
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(longFallbackText));
      const plan = await service.updatePlanForRound({ ...BASE_OPTIONS, mustSynthesize: true });
      expect(plan.action).toBe('synthesize');
      // The contract is that the unparseable raw text is PRESERVED in content
      // (not replaced by a placeholder). The synthesizer HAS read every report, so its
      // prose — even in a broken envelope — is a report, and losing it loses the run.
      expect(plan.content).toBe(longFallbackText);
    });

    it('returns the ROUTER\'s own researchers, not the prior agenda', async () => {
      // The evaluator's ability to ask for MORE research is the decision the split must
      // preserve, and "asked for more" means the researchers IT named. Silently reusing the
      // previous round's agenda would look like a working delegation while re-running work
      // that is already done — so the assertion needs a DISTINCT prior plan present.
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(JSON.stringify({
        action: 'delegate',
        researchers: [{ id: '2.1', name: 'Gap Filler', goal: 'cover the pricing gap', queries: ['pricing q'] }],
        allQueries: ['pricing q'],
      })));
      const plan = await service.updatePlanForRound({
        ...BASE_OPTIONS,
        round: 2,
        previousPlan: {
          action: 'delegate',
          researchers: [{ id: '1.1', name: 'Stale Agenda', goal: 'the previous round', queries: ['stale q'] }],
        },
      } as any);
      expect(plan.action).toBe('delegate');
      expect(plan.researchers).toHaveLength(1);
      expect(plan.researchers![0]!.name).toBe('Gap Filler');
      expect(plan.researchers![0]!.goal).toBe('cover the pricing gap');
      expect(plan.researchers![0]!.queries).toContain('pricing q');
    });

    it('never salvages ROUTER text as report content, however long it is', async () => {
      // The router decides from coverage digests and has never seen a finding, so any
      // prose it emits is ungrounded. Salvaging it (which the single-call evaluator used
      // to do, and which the identical-looking synthesis path still does above) would ship
      // it to the user as the run's output. It must hand back an empty synthesis instead,
      // so the orchestrator's terminal synthesis writes the report from the real reports.
      const longFallbackText = 'This is completely unparseable text that cannot be parsed as valid JSON by any means whatsoever.';
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(longFallbackText));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
      expect(plan.content).toBe('');
    });

    it('discards report content a router returns despite having no findings', async () => {
      // A model that ignores "return a decision, not prose" produces a well-formed
      // synthesize envelope with an invented report in it. Parsing succeeds, so the
      // salvage guard above never runs — this is the second, separate gate.
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(
        '```json\n{"action":"synthesize","content":"An invented report the router could not possibly have grounded."}\n```',
      ));
      const plan = await service.updatePlanForRound(BASE_OPTIONS);
      expect(plan.action).toBe('synthesize');
      expect(plan.content).toBe('');
    });

    it('keeps report content the SYNTHESIZER returns', async () => {
      // Same envelope, opposite verdict — the guard must key on the role, not on the shape
      // of the response, or the real report is thrown away too.
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(
        '```json\n{"action":"synthesize","content":"A grounded report [1].\\n\\nCITED LINKS\\n[1] https://a.example.com"}\n```',
      ));
      const plan = await service.updatePlanForRound({ ...BASE_OPTIONS, mustSynthesize: true });
      expect(plan.action).toBe('synthesize');
      expect(plan.content).toContain('A grounded report [1].');
    });

    it('drops too-short unparseable synthesis text rather than wrapping noise into content', async () => {
      // Below the 50-char floor the raw text is discarded (empty content), so a
      // stray token never becomes the synthesis basis.
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse('nope'));
      const plan = await service.updatePlanForRound({ ...BASE_OPTIONS, mustSynthesize: true });
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

  describe('salvageReportText', () => {
    it('returns "" for too-short scraps so the reports-based fallback takes over', () => {
      expect(salvageReportText('too short')).toBe('');
      expect(salvageReportText('   ')).toBe('');
    });

    it('suppresses a truncated/garbled JSON envelope rather than shipping it as the report', () => {
      const brokenEnvelope = '{"action":"synthesize","content":"The answer is ' + 'x'.repeat(80);
      expect(salvageReportText(brokenEnvelope)).toBe('');
      const brokenWithResearchers = '{"researchers":[{"name":"' + 'y'.repeat(80);
      expect(salvageReportText(brokenWithResearchers)).toBe('');
    });

    it('preserves genuine prose (a model that answered in text instead of JSON)', () => {
      const prose = 'This is a legitimate research report written as prose, well over the fifty character floor.';
      expect(salvageReportText(prose)).toBe(prose);
    });
  });

  /**
   * The REAL prompt files, rendered through the real substitution path.
   *
   * Every other test in this file feeds loadPrompt a short stub, so a
   * `{{placeholder}}` added to src/prompts/*.md and never wired into the
   * populatePrompt() call map is invisible: nothing throws, and the literal
   * braces are simply sent to the model as instructions it cannot act on. Only
   * one such placeholder was covered before, by name. Reading the shipped files
   * means the assertion cannot drift from what actually ships.
   */
  describe('shipped prompt templates render with no placeholder left behind', () => {
    const PROMPT_DIR = path.join(
      path.dirname(fileURLToPath(import.meta.url)), '../../../src/prompts',
    );
    const readPrompt = (name: string) => readFileSync(path.join(PROMPT_DIR, name), 'utf-8');
    const PLACEHOLDER = /\{\{[a-z_0-9]+\}\}/gi;

    let svc: PlanningService;
    beforeEach(async () => {
      svc = new PlanningService();
      await svc.initialize();
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validDelegatePlanJson(1)));
    });

    it('system-coordinator.md leaves none', async () => {
      const real = readPrompt('system-coordinator.md');
      expect(real.match(PLACEHOLDER)?.length ?? 0).toBeGreaterThan(0); // the file really is a template
      vi.mocked(loadPrompt).mockReturnValue(real);

      await svc.generatePlan({
        sessionId: 'test-session',
        query: 'test query',
        complexity: 1 as const,
        model: STUB_MODEL,
        modelRegistry: MOCK_MODEL_REGISTRY,
        cwd: '/test/cwd',
      } as any);

      const ctx = vi.mocked(completeSimple).mock.calls.at(-1)![1] as { systemPrompt: string };
      expect(ctx.systemPrompt.match(PLACEHOLDER) ?? []).toEqual([]);
    });

    it.each([
      ['system-lead-router.md', false],
      ['system-lead-synthesizer.md', true],
    ] as const)('%s leaves none, at every complexity level', async (file, mustSynthesize) => {
      const real = readPrompt(file);
      expect(real.match(PLACEHOLDER)?.length ?? 0).toBeGreaterThan(0);
      vi.mocked(loadPrompt).mockReturnValue(real);

      // Both lead templates branch on complexity (guidance, round phase and team/query
      // budgets differ), so one level passing proves little.
      for (const complexity of [1, 2, 3] as const) {
        await svc.updatePlanForRound({
          sessionId: 'test-session',
          reports: new Map([['1.1', 'Report text about the topic.']]),
          round: 1,
          query: 'test query',
          complexity,
          mustSynthesize,
          model: STUB_MODEL,
          modelRegistry: MOCK_MODEL_REGISTRY,
          cwd: '/test/cwd',
        } as any);

        const ctx = vi.mocked(completeSimple).mock.calls.at(-1)![1] as { systemPrompt: string };
        expect(ctx.systemPrompt.match(PLACEHOLDER) ?? [], `complexity ${complexity}`).toEqual([]);
      }
    });




    it('loads the router template when routing and the synthesizer template when synthesizing', async () => {
      // The two roles are selected by `mustSynthesize` alone. Getting this backwards would
      // hand the router the synthesis instructions — it would dutifully write a report
      // from digests it was told are not findings.
      const base = {
        sessionId: 'test-session',
        reports: new Map([['1.1', 'Report text.']]),
        round: 2,
        query: 'test query',
        complexity: 2 as const,
        model: STUB_MODEL,
        modelRegistry: MOCK_MODEL_REGISTRY,
        cwd: '/test/cwd',
      };
      await svc.updatePlanForRound({ ...base } as any);
      expect(vi.mocked(loadPrompt).mock.calls.at(-1)![0]).toBe('system-lead-router');

      await svc.updatePlanForRound({ ...base, mustSynthesize: true } as any);
      expect(vi.mocked(loadPrompt).mock.calls.at(-1)![0]).toBe('system-lead-synthesizer');
    });
  });

  /**
   * The evaluator context protocol.
   *
   * The research lead is two jobs: a ROUTER that decides each round whether to continue,
   * and a SYNTHESIZER that writes the report once at the end. They were one call that read
   * every report on every round, which made its input grow with the square of the round
   * count, put the final call at risk of exceeding the model's context window, and made the
   * request uncacheable (a fresh single message rebuilt each round).
   *
   * Every invariant below is silent when broken — nothing errors, the run just costs more,
   * or ships an ungrounded report. They need tests, not comments.
   */
  describe('evaluator context protocol — routing reads digests, synthesis reads findings', () => {
    const PROMPT_DIR = path.join(
      path.dirname(fileURLToPath(import.meta.url)), '../../../src/prompts',
    );
    const SEP = '\n\n---\n\n';

    let svc: PlanningService;
    beforeEach(async () => {
      svc = new PlanningService();
      await svc.initialize();
      vi.mocked(loadPrompt).mockImplementation((name: string) =>
        readFileSync(path.join(PROMPT_DIR, `${name}.md`), 'utf-8'),
      );
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('ok')));
    });

    // Reports carry real CITED LINKS blocks so the GLOBAL SOURCE LIST is actually
    // populated — and, crucially, GROWS between the rounds. An empty source list would
    // make its placement unobservable and quietly neuter the prefix assertion below.
    const R1 = 'Round one finding [1].\n\nCITED LINKS\n[1] https://alpha.example.com — Alpha';
    const R2 = 'Round two finding [1].\n\nCITED LINKS\n[1] https://beta.example.com — Beta';
    const round1Reports = new Map([['1.1', R1]]);
    const round2Reports = new Map([['1.1', R1], ['2.1', R2]]);

    const D1 = 'Goal: cover alpha\nCovered: alpha basics\nGaps: none\nSources: 1';
    const D2 = 'Goal: cover beta\nCovered: beta basics\nGaps: beta pricing\nSources: 1';

    const call = async (opts: Record<string, unknown>) => {
      await svc.updatePlanForRound({
        sessionId: 'cache-session',
        maxRounds: 3,
        query: 'test query',
        complexity: 2 as const,
        model: STUB_MODEL,
        modelRegistry: MOCK_MODEL_REGISTRY,
        cwd: '/test/cwd',
        ...opts,
      } as any);
      const last = vi.mocked(completeSimple).mock.calls.at(-1)!;
      return {
        systemPrompt: (last[1] as { systemPrompt: string }).systemPrompt,
        userMessage: lastEvaluatorUserMessage(),
      };
    };

    const route = (round: number, reports: Map<string, string>, digests?: Map<string, string>) =>
      call({ round, reports, digests });

    const synthesize = (round: number, reports: Map<string, string>) =>
      call({ round, reports, mustSynthesize: true });

    describe('routing', () => {
      it('sends the NEW round\'s reports in full, so the decision rests on evidence', async () => {
        // The fidelity half of the contract. A router that never sees prose can only take a
        // researcher's "Gaps: none" on trust; this is what lets it check the claim.
        const { userMessage } = await route(3, round2Reports, new Map([['1.1', D1], ['2.1', D2]]));
        expect(userMessage).toContain('Round two finding');   // round 2 = new at round 3
        expect(userMessage).toContain('Gaps: beta pricing');  // its digest, alongside it
      });

      it('sends EARLIER rounds as digests only, never their bodies again', async () => {
        // The cost half. A report the router already read must never be re-sent, or input is
        // back to growing with the square of the round count.
        const { userMessage } = await route(3, round2Reports, new Map([['1.1', D1], ['2.1', D2]]));
        expect(userMessage).toContain('Covered: alpha basics'); // round 1's digest
        expect(userMessage).not.toContain('Round one finding'); // but not its body
      });

      it('shows each report in full on exactly one round', async () => {
        // Stated as the invariant rather than as two separate round assertions: this is the
        // property that makes routing linear in the corpus instead of quadratic.
        const digests = new Map([['1.1', D1], ['2.1', D2]]);
        const atRound2 = (await route(2, round1Reports, digests)).userMessage;
        const atRound3 = (await route(3, round2Reports, digests)).userMessage;
        expect(atRound2).toContain('Round one finding');
        expect(atRound3).not.toContain('Round one finding');
      });

      it('strips CITED LINKS from the reports it shows', async () => {
        // Routing needs findings, not the bibliography — and the researcher prompt asks for
        // 3-6 dense sentences per source, so it is a large share of a report. The digest
        // already carries the source count, which is all a routing decision uses.
        const { userMessage } = await route(2, round1Reports, new Map([['1.1', D1]]));
        expect(userMessage).toContain('Round one finding');
        expect(userMessage).not.toContain('CITED LINKS');
        expect(userMessage).not.toContain('alpha.example.com');
      });

      it('does not send the global source list — that is synthesis material', async () => {
        const { userMessage } = await route(3, round2Reports, new Map([['1.1', D1], ['2.1', D2]]));
        expect(userMessage).not.toContain('GLOBAL SOURCE LIST');
      });

      it('grows by only the new digest when a round is added', async () => {
        // The load-bearing claim: round n costs what round n-1 cost plus one DIGEST, not
        // plus one report — and it never re-sends earlier rounds' reports at all.
        const one = await route(1, round1Reports, new Map([['1.1', D1]]));
        const two = await route(2, round2Reports, new Map([['1.1', D1], ['2.1', D2]]));
        const growth = two.userMessage.length - one.userMessage.length;
        // Generous ceiling: the digest itself, its `### Researcher` heading and separator,
        // plus the round number changing. Nothing report-sized may pass.
        expect(growth).toBeLessThan(D2.length + 200);
        expect(growth).toBeGreaterThan(0);
      });

      it('derives digests from the reports when the caller supplies none', async () => {
        // A caller that does not track digests must not leave the router blind — a router
        // shown nothing concludes the round produced nothing and re-delegates work already
        // done. It gets a mechanical digest instead, which says so.
        const { userMessage } = await route(2, round2Reports);
        expect(userMessage).toContain('### Researcher 1.1');
        expect(userMessage).toContain('### Researcher 2.1');
        expect(userMessage).toContain('emitted no coverage digest');
        // A derived digest quotes the report's topic line, so it is bounded rather than
        // absent: what must not survive is the rest of the body, here its source list.
        expect(userMessage).not.toContain('alpha.example.com');
        expect(userMessage).not.toContain('CITED LINKS');
      });

      it('fills gaps when the caller supplies digests for only some reports', async () => {
        // A partial map must not hide a researcher. The router reads an absent entry as
        // "that researcher produced nothing", which is the more dangerous error: it argues
        // for re-delegating work that is already done.
        const { userMessage } = await route(2, round2Reports, new Map([['1.1', D1]]));
        expect(userMessage).toContain('Covered: alpha basics');   // supplied
        expect(userMessage).toContain('### Researcher 2.1');       // derived
        expect(userMessage).toContain('emitted no coverage digest');
      });

      it('keeps a digest whose report is no longer present', async () => {
        // Dropping it would remove that researcher from the router's view entirely.
        const { userMessage } = await route(2, round1Reports, new Map([['1.1', D1], ['9.9', D2]]));
        expect(userMessage).toContain('### Researcher 9.9');
        expect(userMessage).toContain('Gaps: beta pricing');
      });

      it('bounds a derived digest to the topic line and a source count', async () => {
        // Checked on an EARLIER-round report, where the digest is all the router gets. If the
        // derivation ever passed more of the body through, routing input would silently
        // start scaling with the whole corpus again.
        const long = `Topic line about alpha.\n\n${'Body sentence with detail. '.repeat(400)}\n\nCITED LINKS\n[1] https://alpha.example.com — Alpha`;
        const { userMessage } = await route(4, new Map([['1.1', long]]));
        expect(userMessage).toContain('Topic line about alpha.');
        expect(userMessage).not.toContain('Body sentence with detail.');
        expect(userMessage).toContain('Sources: 1');
      });

        it('accepts the finish envelope the router prompt asks for, reason field and all', async () => {
        // The router is told to return { action, reason }. `reason` is not in the plan
        // schema — if validation rejected unknown keys, EVERY router finish would fall into
        // the agentic-repair path and burn a second call to arrive at the same decision.
        vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(
          '```json\n{"action":"synthesize","reason":"every agenda item is covered"}\n```',
        ));
        const before = vi.mocked(completeSimple).mock.calls.length;
        const plan = await svc.updatePlanForRound({
          sessionId: 'cache-session',
          reports: round1Reports,
          digests: new Map([['1.1', D1]]),
          round: 2,
          maxRounds: 3,
          query: 'test query',
          complexity: 2 as const,
          model: STUB_MODEL,
          modelRegistry: MOCK_MODEL_REGISTRY,
          cwd: '/test/cwd',
        } as any);
        expect(plan.action).toBe('synthesize');
        // Exactly one call: no repair pass was triggered.
        expect(vi.mocked(completeSimple).mock.calls.length).toBe(before + 1);
      });

    it('caps its output tokens far below the synthesis budget', async () => {
        // The router cannot produce a report, so reserving the full synthesis ceiling for
        // it is dead budget — and on providers that bill reserved output, real money.
        await route(2, round2Reports, new Map([['1.1', D1]]));
        const opts = vi.mocked(completeSimple).mock.calls.at(-1)![2] as { maxTokens?: number };
        expect(opts.maxTokens).toBeLessThanOrEqual(8192);
      });
    });

    describe('synthesis', () => {
      it('sends every report body in full, plus the global source list', async () => {
        const { userMessage } = await synthesize(3, round2Reports);
        expect(userMessage).toContain('Round one finding');
        expect(userMessage).toContain('Round two finding');
        expect(userMessage).toContain('GLOBAL SOURCE LIST');
      });

      it('places the global source list AFTER the findings', async () => {
        // It grows by a line per new URL. In front of the findings it would move every
        // byte after it and make the message uncacheable from the first round onward.
        const { userMessage } = await synthesize(3, round2Reports);
        expect(userMessage.indexOf('GLOBAL SOURCE LIST'))
          .toBeGreaterThan(userMessage.indexOf('Round one finding'));
      });

      it('keeps round 1 findings a verbatim prefix of a later synthesis message', async () => {
        const first = await synthesize(1, round1Reports);
        const second = await synthesize(2, round2Reports);
        const sections = first.userMessage.split(SEP);
        expect(sections[0]).toBe('Findings from the research team follow.');
        const stablePrefix = sections.slice(0, 2).join(SEP);
        expect(stablePrefix).toContain('Round one finding');
        expect(stablePrefix).not.toContain('GLOBAL SOURCE LIST');
        expect(second.userMessage.startsWith(stablePrefix)).toBe(true);
      });
    });

    /**
     * The size claim, measured rather than argued.
     *
     * Before the split, the routing call carried exactly what the synthesizer carries now:
     * every report, every round. So comparing the two messages over an IDENTICAL corpus is
     * the old-vs-new comparison, with none of the confounding a live A/B has (two runs
     * scrape different sources and build different corpora).
     *
     * The property that matters is NOT that routing is tiny — it now carries a full round of
     * reports, deliberately, so the decision rests on evidence. It is that routing is bounded
     * by TEAM SIZE rather than by round count: an extra round of history costs a digest, not
     * a re-send of everything before it. That is what turns quadratic growth into linear.
     */
    describe('routing input size', () => {
      // ~9,500 tokens per report at 4 chars/token — the figure measured from a real run.
      const bigReport = (tag: string) =>
        `${tag} topic line.\n\n${`${tag} finding sentence with detail. `.repeat(1200)}\n\nCITED LINKS\n[1] https://${tag}.example.com — ${tag}`;
      const bigDigest = (tag: string) =>
        `Goal: cover ${tag}\nCovered: ${tag} basics; ${tag} internals; ${tag} tradeoffs\nUnsubstantiated: none\nGaps: ${tag} pricing\nSources: 4`;

      const corpus = (n: number) => {
        const reports = new Map<string, string>();
        const digests = new Map<string, string>();
        for (let i = 1; i <= n; i++) {
          reports.set(`${i}.1`, bigReport(`topic${i}`));
          digests.set(`${i}.1`, bigDigest(`topic${i}`));
        }
        return { reports, digests };
      };

      // A window large enough that synthesis is always a SINGLE pass, so these two tests
      // measure corpus size and not the reduce. With the reduce in play the last call
      // carries partial syntheses rather than the corpus, which is a different quantity.
      const WIDE_MODEL = { id: 'wide-model', contextWindow: 2_000_000 } as any;
      const routeWide = (round: number, reports: Map<string, string>, digests: Map<string, string>) =>
        call({ round, reports, digests, model: WIDE_MODEL });
      const synthWide = (round: number, reports: Map<string, string>) =>
        call({ round, reports, mustSynthesize: true, model: WIDE_MODEL });

      it('carries one round of reports, not the whole corpus', async () => {
        // Nine researchers accumulated; the router sees the newest round in full and the
        // rest as digests, so its input is a small multiple of ONE report rather than nine.
        const { reports, digests } = corpus(9);
        const routed = await routeWide(10, reports, digests);
        const synthesized = await synthWide(10, reports);
        expect(routed.userMessage.length).toBeLessThan(synthesized.userMessage.length * 0.25);
      });

      it('costs a digest per round of HISTORY, not a re-send of it', async () => {
        // The quadratic term, measured. Each corpus is routed at the round right after its
        // last researcher, so exactly one report is fresh in both cases and the twelve extra
        // researchers land entirely in history. Their marginal cost must be digest-sized.
        // Measuring MARGINAL bytes isolates this from the fixed overhead (system prompt, run
        // context) that dominates a small corpus and would distort a ratio test.
        const small = corpus(3);
        const large = corpus(15);
        const routeSmall = (await routeWide(4, small.reports, small.digests)).userMessage.length;
        const routeLarge = (await routeWide(16, large.reports, large.digests)).userMessage.length;
        const synthSmall = (await synthWide(4, small.reports)).userMessage.length;
        const synthLarge = (await synthWide(16, large.reports)).userMessage.length;

        const routeMarginal = (routeLarge - routeSmall) / 12;
        const synthMarginal = (synthLarge - synthSmall) / 12;
        expect(routeMarginal).toBeLessThan(synthMarginal / 50);
      });
    });

    describe('stable system prompts', () => {
      it('renders a byte-identical ROUTER system prompt in round 1 and round 3', async () => {
        const first = await route(1, round1Reports, new Map([['1.1', D1]]));
        const later = await route(3, round2Reports, new Map([['1.1', D1], ['2.1', D2]]));
        // Differing round, differing report set, differing query history — none of it may
        // reach the system prompt, or the cached prefix ends at byte zero.
        expect(later.systemPrompt).toBe(first.systemPrompt);
      });

      it('carries the round-varying context in the ROUTER user message instead', async () => {
        const { userMessage } = await route(2, round2Reports, new Map([['1.1', D1]]));
        expect(userMessage).toContain('## RUN CONTEXT');
        expect(userMessage).toContain('Round 2 of 2'); // 3 iterations = 2 research rounds
        // ...and after the digests, not before them.
        expect(userMessage.indexOf('## RUN CONTEXT'))
          .toBeGreaterThan(userMessage.indexOf('Covered: alpha basics'));
      });

      it('renders a byte-identical SYNTHESIZER system prompt regardless of round', async () => {
        const first = await synthesize(1, round1Reports);
        const later = await synthesize(3, round2Reports);
        expect(later.systemPrompt).toBe(first.systemPrompt);
      });
    });
  });
});

/**
 * Synthesis corpus budgeting.
 *
 * The final synthesis is the one call whose input grows without bound — it carries every
 * report the run collected, and nothing upstream caps report size or report count. When it
 * exceeds the model's context window the provider rejects it AFTER the whole run has been
 * paid for, and the user receives a mechanical concatenation of raw reports labelled as an
 * interruption. These tests pin the bound that converts that cliff into a reduce.
 */
describe('synthesisCorpusBudgetChars', () => {
  it('leaves room for the output ceiling and the request overhead', () => {
    const budget = synthesisCorpusBudgetChars({ contextWindow: 262_144 }, 32_768);
    // Whatever the exact reserve, the corpus must not be allowed to fill the window.
    expect(budget).toBeLessThan(262_144 * 4);
    expect(budget).toBeGreaterThan(0);
  });

  it('shrinks when the output ceiling grows', () => {
    const small = synthesisCorpusBudgetChars({ contextWindow: 262_144 }, 8_000);
    const large = synthesisCorpusBudgetChars({ contextWindow: 262_144 }, 64_000);
    expect(large).toBeLessThan(small);
  });

  it('falls back to a default window for a model that does not declare one', () => {
    expect(synthesisCorpusBudgetChars({}, 8_000)).toBeGreaterThan(0);
  });

  it('never returns a budget so small that partitioning cannot converge', () => {
    // A tiny or negative window (a misconfigured models.json entry) must not produce a
    // budget of zero — that would partition every report into its own pass forever.
    expect(synthesisCorpusBudgetChars({ contextWindow: 1_000 }, 32_768)).toBeGreaterThanOrEqual(40_000);
  });
});

describe('partitionCorpus', () => {
  const size = (e: [string, string]) => e[1].length;

  it('returns a single partition when everything fits', () => {
    const entries: Array<[string, string]> = [['a', 'x'.repeat(10)], ['b', 'y'.repeat(10)]];
    expect(partitionCorpus(entries, size, 100)).toHaveLength(1);
  });

  it('splits at the budget and preserves order', () => {
    const entries: Array<[string, string]> = [
      ['a', 'x'.repeat(60)], ['b', 'y'.repeat(60)], ['c', 'z'.repeat(60)],
    ];
    const parts = partitionCorpus(entries, size, 100);
    expect(parts).toHaveLength(3);
    expect(parts.flat().map(([k]) => k)).toEqual(['a', 'b', 'c']);
  });

  it('packs greedily rather than one entry per partition', () => {
    const entries: Array<[string, string]> = [
      ['a', 'x'.repeat(40)], ['b', 'y'.repeat(40)], ['c', 'z'.repeat(40)],
    ];
    const parts = partitionCorpus(entries, size, 100);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(2);
  });

  it('gives an over-budget entry a partition of its own instead of dropping it', () => {
    // Losing a report here would silently shrink the final report. The caller truncates
    // this case; partitioning must still surface it.
    const entries: Array<[string, string]> = [['a', 'x'.repeat(500)], ['b', 'y'.repeat(10)]];
    const parts = partitionCorpus(entries, size, 100);
    expect(parts.flat()).toHaveLength(2);
    expect(parts[0]).toEqual([['a', 'x'.repeat(500)]]);
  });

  it('handles an empty corpus', () => {
    expect(partitionCorpus([], size, 100)).toEqual([]);
  });
});

describe('PlanningService — synthesis over an oversized corpus', () => {
  let svc: PlanningService;

  // A model whose window is small enough that a handful of reports overflow it, so the
  // reduce path is exercised with realistic control flow rather than a mocked branch.
  const SMALL_MODEL = { id: 'small-model', contextWindow: 20_000 } as any;

  const bigReport = (tag: string) => `${tag} topic line.\n\n${`${tag} finding sentence. `.repeat(1200)}`;

  beforeEach(async () => {
    svc = new PlanningService();
    await svc.initialize();
    vi.mocked(loadPrompt).mockReturnValue('lead prompt {{partial_synthesis_section}}');
    vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('merged report')));
  });

  const synthesize = (reports: Map<string, string>, model = SMALL_MODEL) =>
    svc.updatePlanForRound({
      sessionId: 'reduce-session',
      reports,
      round: 3,
      maxRounds: 3,
      query: 'test query',
      complexity: 2 as const,
      mustSynthesize: true,
      model,
      modelRegistry: MOCK_MODEL_REGISTRY,
      cwd: '/test/cwd',
    } as any);

  it('makes exactly one call when the corpus fits', async () => {
    await synthesize(new Map([['1.1', 'short report']]), { id: 'big-model', contextWindow: 262_144 } as any);
    expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
  });

  it('reduces in partial passes and then merges when the corpus does not fit', async () => {
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
    ]);
    const plan = await synthesize(reports);
    // More than one call means the reduce ran; the LAST call is the merge that produces
    // the report, so its result is what ships.
    expect(vi.mocked(completeSimple).mock.calls.length).toBeGreaterThan(1);
    expect(plan.action).toBe('synthesize');
    expect(plan.content).toBe('merged report');
  });

  it('sends every report to some partial pass — none is silently dropped', async () => {
    // The failure this guards is invisible: a report that reaches no pass simply does not
    // appear in the final report, and nothing says so.
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
    ]);
    await synthesize(reports);
    const allSent = vi.mocked(completeSimple).mock.calls
      .map(c => (c[1] as any).messages.map((m: any) => m.content.map((x: any) => x.text).join('')).join(''))
      .join('\n');
    expect(allSent).toContain('alpha topic line.');
    expect(allSent).toContain('beta topic line.');
    expect(allSent).toContain('gamma topic line.');
  });

  it('keeps each partial pass inside the budget', async () => {
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
    ]);
    await synthesize(reports);
    const budget = synthesisCorpusBudgetChars(SMALL_MODEL, getConfig('/test/cwd').SYNTHESIS_MAX_TOKENS);
    const messages = vi.mocked(completeSimple).mock.calls
      .map(c => (c[1] as any).messages.map((m: any) => m.content.map((x: any) => x.text).join('')).join(''));
    // Each request carries its partition plus the source list, run context and directive —
    // the overhead reserve covers those, so the corpus share must be under budget.
    for (const m of messages) expect(m.length).toBeLessThan(budget * 1.5);
  });

  it('tells a partial pass it is one, and the merge pass that its inputs are partials', async () => {
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
    ]);
    await synthesize(reports);
    const calls = vi.mocked(completeSimple).mock.calls;
    const first = (calls[0]![1] as any).systemPrompt as string;
    const last = (calls.at(-1)![1] as any).systemPrompt as string;
    // Without these the partial passes each write a CITED LINKS section and the merge
    // concatenates three reports that all claim to be complete.
    expect(first).toContain('PARTIAL PASS');
    expect(last).toContain('MERGE PASS');
    expect(last).not.toContain('PARTIAL PASS');
  });

  it('puts the partial-pass override AFTER the JSON format rule it overrides', async () => {
    // Ordering is the whole point. Interpolated before the Output Requirements block, the
    // "ONLY return valid JSON" rule would be the model's last instruction and would win —
    // the partial would come back as an envelope and the merge would receive JSON blobs
    // where it expects prose. Contains-checks do not catch this; position does.
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
    ]);
    vi.mocked(loadPrompt).mockReturnValue(
      readFileSync(path.join(
        path.dirname(fileURLToPath(import.meta.url)), '../../../src/prompts', 'system-lead-synthesizer.md',
      ), 'utf-8'),
    );
    await synthesize(reports);
    const first = (vi.mocked(completeSimple).mock.calls[0]![1] as any).systemPrompt as string;
    expect(first.indexOf('PARTIAL PASS')).toBeGreaterThan(first.indexOf('ONLY return valid JSON'));
  });

  it('unwraps a partial pass that returns the JSON envelope anyway', async () => {
    // Defence in depth behind the ordering fix: if a model returns an envelope regardless,
    // the merge must receive the prose, not the braces around it.
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
    ]);
    vi.mocked(completeSimple).mockResolvedValue(
      makeCompleteResponse('```json\n{"action":"synthesize","content":"PARTIAL PROSE BODY"}\n```'),
    );
    await synthesize(reports);
    const mergeMessage = lastEvaluatorUserMessage();
    expect(mergeMessage).toContain('PARTIAL PROSE BODY');
    expect(mergeMessage).not.toContain('"action"');
  });

  it('leaves the system prompt free of a partial-pass section on a single-pass synthesis', async () => {
    await synthesize(new Map([['1.1', 'short report']]), { id: 'big-model', contextWindow: 262_144 } as any);
    const sys = (vi.mocked(completeSimple).mock.calls.at(-1)![1] as any).systemPrompt as string;
    expect(sys).not.toContain('PARTIAL PASS');
    expect(sys).not.toContain('MERGE PASS');
  });

  it('divides the output budget across partial passes so the reduce converges', async () => {
    // Left at the full synthesis ceiling, N partials can total more than the corpus they
    // replaced, and the reduce needs pass after pass to converge (or runs out). Each
    // partial must therefore be allotted a share of the budget, not the whole of it.
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
    ]);
    await synthesize(reports);
    const calls = vi.mocked(completeSimple).mock.calls;
    const partialCaps = calls.slice(0, -1).map(c => (c[2] as { maxTokens?: number }).maxTokens ?? 0);
    const finalCap = (calls.at(-1)![2] as { maxTokens?: number }).maxTokens ?? 0;
    expect(partialCaps.length).toBeGreaterThan(1);
    for (const cap of partialCaps) expect(cap).toBeLessThan(finalCap);
  });

  it('sizes the partials so they fit the next pass when the floor does not bind', async () => {
    // The convergence property itself. SMALL_MODEL's budget hits the floor (a misconfigured
    // tiny window), where the contract is deliberately weaker — the extra passes absorb it.
    // A realistic window is where all partials must fit one follow-up request.
    const MEDIUM_MODEL = { id: 'medium-model', contextWindow: 60_000 } as any;
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
    ]);
    await synthesize(reports, MEDIUM_MODEL);
    const calls = vi.mocked(completeSimple).mock.calls;
    const partialCaps = calls.slice(0, -1).map(c => (c[2] as { maxTokens?: number }).maxTokens ?? 0);
    expect(partialCaps.length).toBeGreaterThan(1);
    const budget = synthesisCorpusBudgetChars(MEDIUM_MODEL, getConfig('/test/cwd').SYNTHESIS_MAX_TOKENS);
    expect(partialCaps.reduce((a, b) => a + b, 0) * 4).toBeLessThanOrEqual(budget);
  });

  it('warns rather than silently overflowing when the reduce runs out of passes', async () => {
    // A corpus that stays over budget after every allowed pass still gets sent. The run has
    // already been paid for by this point, and a provider rejection with no prior warning
    // reads downstream as "the model refused" rather than "the corpus never fit".
    const huge = 'x'.repeat(300_000);
    vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(huge));
    const reports = new Map([
      ['1.1', bigReport('alpha')],
      ['2.1', bigReport('beta')],
      ['3.1', bigReport('gamma')],
      ['4.1', bigReport('delta')],
    ]);
    await synthesize(reports);
    const warned = vi.mocked(logger.warn).mock.calls
      .map(c => c.map(String).join(' '))
      .some(m => m.includes('Sending it anyway'));
    expect(warned).toBe(true);
  });

  it('truncates a single report larger than the whole budget rather than failing', async () => {
    // Nothing left to partition at that point: the choice is a truncated report or a
    // rejected request that discards the entire run.
    const huge = `huge topic line.\n\n${'x'.repeat(200_000)}`;
    const plan = await synthesize(new Map([['1.1', huge]]));
    expect(plan.action).toBe('synthesize');
    const sent = vi.mocked(completeSimple).mock.calls
      .map(c => (c[1] as any).messages.map((m: any) => m.content.map((x: any) => x.text).join('')).join(''))
      .join('\n');
    expect(sent).toContain('report truncated');
    expect(sent).toContain('huge topic line.');
  });
});
