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
import { PlanningService, isRetriableLlmError, salvageReportText } from '../../../src/core/planning-service.ts';
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
        // No maxRounds passed → old behavior: base value (3), impossible "Round 4 of 3"
        // text, and a ratio (4/3 > 0.8) that selects the LATE phase branch.
        expect(userText).toContain(`Round ${currentRound} of ${baseMaxRounds}`);
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
        // With the real, steering-extended budget (5) supplied, the ratio (4/5 = 0.8)
        // lands in MIDDLE instead of LATE, and the display shows the true "of 5".
        expect(userText).toContain(`Round ${currentRound} of ${steeringExtendedMaxRounds}`);
        expect(userText).toContain('Round Phase: MIDDLE');
        expect(userText).not.toContain('Round Phase: LATE');
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

    it('system-lead-evaluator.md leaves none, at every complexity level', async () => {
      const real = readPrompt('system-lead-evaluator.md');
      expect(real.match(PLACEHOLDER)?.length ?? 0).toBeGreaterThan(0);
      vi.mocked(loadPrompt).mockReturnValue(real);

      // The evaluator template branches on complexity (guidance, round phase and
      // team/query budgets differ), so one level passing proves little.
      for (const complexity of [1, 2, 3] as const) {
        await svc.updatePlanForRound({
          sessionId: 'test-session',
          reports: new Map([['1.1', 'Report text about the topic.']]),
          round: 1,
          query: 'test query',
          complexity,
          model: STUB_MODEL,
          modelRegistry: MOCK_MODEL_REGISTRY,
          cwd: '/test/cwd',
        } as any);

        const ctx = vi.mocked(completeSimple).mock.calls.at(-1)![1] as { systemPrompt: string };
        expect(ctx.systemPrompt.match(PLACEHOLDER) ?? [], `complexity ${complexity}`).toEqual([]);
      }
    });
  });

  /**
   * Prompt-cache structure.
   *
   * Every provider caches on an exact prefix of the serialized request, so what a
   * multi-round run can reuse is decided entirely by WHERE the round-varying text sits.
   * These two invariants are the whole mechanism, and both are silent when broken —
   * nothing errors, the run just pays full input price on every round. The failure mode
   * is a one-line prompt edit (a round number moved back into the system prompt, a new
   * section prepended to the findings) so it needs a test, not a comment.
   */
  describe('prompt-cache structure — the evaluator request keeps a stable prefix', () => {
    const PROMPT_DIR = path.join(
      path.dirname(fileURLToPath(import.meta.url)), '../../../src/prompts',
    );
    const LEAD_IN = 'Findings from the research team follow.';
    const SEP = '\n\n---\n\n';

    let svc: PlanningService;
    beforeEach(async () => {
      svc = new PlanningService();
      await svc.initialize();
      vi.mocked(loadPrompt).mockReturnValue(
        readFileSync(path.join(PROMPT_DIR, 'system-lead-evaluator.md'), 'utf-8'),
      );
      vi.mocked(completeSimple).mockResolvedValue(makeCompleteResponse(validSynthesizePlanJson('ok')));
    });

    const evaluate = async (round: number, reports: Map<string, string>) => {
      await svc.updatePlanForRound({
        sessionId: 'cache-session',
        reports,
        round,
        maxRounds: 3,
        query: 'test query',
        complexity: 2 as const,
        model: STUB_MODEL,
        modelRegistry: MOCK_MODEL_REGISTRY,
        cwd: '/test/cwd',
      } as any);
      const call = vi.mocked(completeSimple).mock.calls.at(-1)!;
      return {
        systemPrompt: (call[1] as { systemPrompt: string }).systemPrompt,
        userMessage: lastEvaluatorUserMessage(),
      };
    };

    // Reports carry real CITED LINKS blocks so the GLOBAL SOURCE LIST is actually
    // populated — and, crucially, GROWS between the rounds. An empty source list would
    // make its placement unobservable and quietly neuter the prefix assertion below.
    const R1 = 'Round one finding [1].\n\nCITED LINKS\n[1] https://alpha.example.com — Alpha';
    const R2 = 'Round two finding [1].\n\nCITED LINKS\n[1] https://beta.example.com — Beta';
    const round1Reports = new Map([['1.1', R1]]);
    const round2Reports = new Map([['1.1', R1], ['2.1', R2]]);

    it('renders a byte-identical system prompt in round 1 and round 3', async () => {
      const first = await evaluate(1, round1Reports);
      const later = await evaluate(3, round2Reports);
      // Differing round, differing report set, differing query history — none of it may
      // reach the system prompt, or the cached prefix ends at byte zero.
      expect(later.systemPrompt).toBe(first.systemPrompt);
    });

    it('carries the round-varying context in the user message instead', async () => {
      const { userMessage } = await evaluate(2, round2Reports);
      expect(userMessage).toContain('## RUN CONTEXT');
      expect(userMessage).toContain('Round 2 of 3');
      // ...and after the findings, not before them.
      expect(userMessage.indexOf('## RUN CONTEXT')).toBeGreaterThan(userMessage.indexOf('Round one finding'));
    });

    it('keeps round 1 findings a verbatim prefix of the round 2 message', async () => {
      const first = await evaluate(1, round1Reports);
      const second = await evaluate(2, round2Reports);

      // The lead-in plus the round-1 findings block: everything up to and including the
      // second separator-delimited section. The global source list grows by a line per
      // new URL and so must sit AFTER this, not before it.
      const sections = first.userMessage.split(SEP);
      expect(sections[0]).toBe(LEAD_IN);
      const stablePrefix = sections.slice(0, 2).join(SEP);
      expect(stablePrefix).toContain('Round one finding');
      expect(stablePrefix).not.toContain('GLOBAL SOURCE LIST');
      expect(second.userMessage.startsWith(stablePrefix)).toBe(true);
    });
  });
});
