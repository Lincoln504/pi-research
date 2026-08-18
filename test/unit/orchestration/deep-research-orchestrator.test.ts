/**
 * Deep Research Orchestrator Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepResearchOrchestrator } from '../../../src/orchestration/deep-research-orchestrator.ts';
import { resetServiceContainer, registerService, getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import {
  getFailedResearchers,
  getResearcherFailureReasons,
  consumeQueuedMessages,
  getSteeringMessages,
} from '../../../src/orchestration/session-state.ts';
import { MAX_ROUNDS_LEVEL_1 } from '../../../src/constants.ts';

// Mock the service registry
vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/service-registry.ts')>();
  return {
    ...actual,
    getService: vi.fn(),
  };
});

// Mock dependencies
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createResearchRunId: () => 'test-run-id',
  runWithLogContext: (_ctx: any, fn: any) => fn(),
}));

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({
    KNOWLEDGE_STORE_MODE: 'none',
    MAX_CONCURRENT_RESEARCHERS: 3,
    RESEARCHER_MAX_RETRIES: 2,
    RESEARCHER_MAX_RETRY_DELAY_MS: 5000,
    RESEARCHER_TIMEOUT_MS: 120000,
  })),
  DEFAULTS: { KNOWLEDGE_STORE_MODE: 'none' },
}));

// Mock session-state for steering functions
vi.mock('../../../src/orchestration/session-state.ts', () => ({
  getSteeringMessages: vi.fn(() => []),
  getQueuedSteeringMessages: vi.fn(() => []),
  consumeQueuedMessages: vi.fn(() => []),
  getActiveSteeringMessages: vi.fn(() => []),
  getActiveSessionCount: vi.fn(() => 1),
  // Default: NO failed researchers — matches runs that never delegated (e.g.
  // immediate synthesis). The hollow-run tests override these per-test.
  getFailedResearchers: vi.fn(() => []),
  getResearcherFailureReasons: vi.fn(() => ({})),
}));

describe('DeepResearchOrchestrator', () => {
  const mockCtx = {
    cwd: '/tmp',
    model: { id: 'test-model' },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
    },
    ui: {
      setWidget: vi.fn(),
    },
  };

  const options = {
    ctx: mockCtx as any,
    model: { id: 'test-model' } as any,
    query: 'test query',
    complexity: 1 as const,
    sessionId: 'test-session',
    researchId: 'test-research',
  };

  let mockPlanningService: any;
  let mockOrchestrationService: any;
  let mockSynthesisService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Re-default the session-state mocks: clearAllMocks clears call history but NOT
    // mockReturnValue/mockImplementation overrides, so a per-test override leaks into
    // every later test in the file.
    //
    // The steering pair matters most and was the one left out. A test overriding
    // consumeQueuedMessages to return a queued message silently RAISES maxRounds for
    // every test after it, which changes how many rounds run — and the test named
    // "should enforce maximum rounds and force synthesis" was running three rounds
    // while its comment asserted two, with no assertion capable of noticing. Re-default
    // them here rather than in each affected test, which is how the leak survived the
    // first time it was found.
    vi.mocked(getFailedResearchers).mockReturnValue([]);
    vi.mocked(getResearcherFailureReasons).mockReturnValue({});
    vi.mocked(consumeQueuedMessages).mockReturnValue([]);
    vi.mocked(getSteeringMessages).mockReturnValue([]);

    // Create mock planning service
    mockPlanningService = {
      name: 'planning',
      lifecycle: 'initialized',
      async initialize() {},
      async dispose() {},
      generatePlan: vi.fn().mockResolvedValue({
        action: 'delegate',
        researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
        allQueries: ['q1'],
      }),
      updatePlanForRound: vi.fn(),
      getCurrentPlan: vi.fn(() => null),
      getTotalResearchersPlanned: vi.fn(() => 0),
      incrementTotalResearchersPlanned: vi.fn(),
      addToQueryHistory: vi.fn(),
      clearPlanningState: vi.fn(),
    };

    // Create mock orchestration service
    mockOrchestrationService = {
      name: 'research-orchestration',
      lifecycle: 'initialized',
      async initialize() {},
      async dispose() {},
      checkHealth: vi.fn().mockResolvedValue(true),
      distributeSearchResults: vi.fn().mockResolvedValue(undefined),
      runResearchers: vi.fn().mockResolvedValue(undefined),
      runSearchBurst: vi.fn().mockResolvedValue([]),
      storeLinkDescriptions: vi.fn().mockResolvedValue(undefined),
      cleanupResearchServices: vi.fn().mockResolvedValue(undefined),
    };

    // Create mock synthesis service
    mockSynthesisService = {
      name: 'research-synthesis',
      lifecycle: 'initialized',
      async initialize() {},
      async dispose() {},
      synthesize: vi.fn(),
      storeReport: vi.fn(),
      getReports: vi.fn(() => []),
      hasReports: vi.fn(() => false),
      buildFallbackSynthesis: vi.fn(() => '# Fallback Synthesis'),
      clearReports: vi.fn(),
      getAllReports: vi.fn(() => new Map()),
      getAllDigests: vi.fn(() => new Map()),
      getReport: vi.fn(),
      getReportsForRound: vi.fn(() => new Map()),
      getReportCount: vi.fn(() => 0),
      ensureCitedLinks: vi.fn((_id: string, text: string) => text),
      appendSteeringGuidance: vi.fn((text: string) => text),
      appendMetadata: vi.fn((text: string) => text),
    };

    // Default getService implementation
    vi.mocked(getService).mockImplementation(async (name) => {
      if (name === ServiceNames.PLANNING) return mockPlanningService;
      if (name === ServiceNames.RESEARCH_ORCHESTRATION) return mockOrchestrationService;
      if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) return mockSynthesisService;
      return null;
    });

    // Register mock planning service
    registerService(
      ServiceNames.PLANNING,
      () => mockPlanningService,
      { allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.RESEARCH_ORCHESTRATION,
      () => mockOrchestrationService,
      { allowOverwrite: true, enableLogging: false }
    );

    registerService(
      ServiceNames.RESEARCH_SYNTHESIS_SERVICE,
      () => mockSynthesisService,
      { allowOverwrite: true, enableLogging: false }
    );
  });

  afterEach(() => {
    resetServiceContainer();
  });

  it('should run a basic research round and synthesize', async () => {
    // Mock updatePlanForRound to return synthesize (forced synthesis)
    mockPlanningService.updatePlanForRound.mockResolvedValue({
        action: 'synthesize',
        content: 'The final result',
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    const result = await orchestrator.run();

    expect(result).toBe('The final result');
    expect(mockPlanningService.generatePlan).toHaveBeenCalled();
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalled();
    expect(mockOrchestrationService.runSearchBurst).toHaveBeenCalled();
    expect(mockOrchestrationService.runResearchers).toHaveBeenCalled();
  });

  it('should handle multi-round research (delegate then synthesize)', async () => {
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      // Round 2 - delegate
      if (opts.round === 2) {
        return {
          action: 'delegate',
          researchers: [{ id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] }],
          allQueries: ['q2'],
        };
      }
      // All subsequent calls - synthesize
      return {
        action: 'synthesize',
        content: 'Multi-round result',
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 2 });
    const result = await orchestrator.run();

    expect(result).toBe('Multi-round result');
    expect(mockPlanningService.generatePlan).toHaveBeenCalled();
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalled();
  });

  /**
   * Routing and synthesis are separate calls.
   *
   * The router's decision is not a report (it reads the fresh round's findings in full for
   * evidence-based routing, but its OUTPUT is a routing decision, not report prose), so its
   * "finish" decision carries no report. Reusing it as the final report — which is what the
   * single-call evaluator did — would ship an empty or ungrounded document at the end of a
   * successful run. The coordinator's round-1 direct answer is the opposite case: that one
   * IS a real report and must not trigger a second, redundant synthesis.
   */
  describe('router / synthesizer split', () => {
    it('runs a separate synthesis call when the ROUTER chooses to finish', async () => {
      const seen: any[] = [];
      mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
        seen.push(opts);
        return opts.mustSynthesize
          ? { action: 'synthesize', content: 'The synthesized report' }
          : { action: 'synthesize', content: '', researchers: [] };
      });

      const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 2 });
      const result = await orchestrator.run();

      expect(result).toBe('The synthesized report');
      expect(seen.filter(o => !o.mustSynthesize).length).toBeGreaterThan(0);
      expect(seen.filter(o => o.mustSynthesize)).toHaveLength(1);
    });

    it('never ships a round-1 answer that no research backs', async () => {
      // There used to be a direct-answer path here: a coordinator plan carrying
      // {action:'synthesize', content} was adopted verbatim as the final report. It was
      // unreachable in the shape that was harmless (no researchers — the emptiness guard
      // in generatePlan replaced the whole plan) and reachable only in the shape that was
      // not: with researchers present it ended the run at round 1 and shipped prose
      // written before a single source was read — no queries, no scrapes, no citations.
      // generatePlan now pins round 1 to 'delegate'; if a plan reaches here saying
      // otherwise, the report is still written by the terminal synthesis over whatever
      // corpus exists, never lifted out of the plan.
      mockPlanningService.generatePlan.mockResolvedValue({
        action: 'synthesize',
        content: 'An answer invented before any research ran',
        researchers: [],
      });
      mockPlanningService.updatePlanForRound.mockResolvedValue({
        action: 'synthesize',
        content: 'The synthesized report',
      });

      const orchestrator = new DeepResearchOrchestrator(options);
      const result = await orchestrator.run();

      expect(result).toBe('The synthesized report');
      expect(result).not.toContain('invented');
      expect(mockPlanningService.updatePlanForRound).toHaveBeenCalledWith(
        expect.objectContaining({ mustSynthesize: true }),
      );
    });

    it('passes coverage digests to the routing call', async () => {
      // Without these the routing call falls back to deriving digests from report bodies,
      // which works but discards everything the researchers actually asserted.
      const digests = new Map([['1.1', 'Covered: alpha\nGaps: none\nSources: 3']]);
      mockSynthesisService.getAllDigests.mockReturnValue(digests);
      mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) =>
        opts.mustSynthesize
          ? { action: 'synthesize', content: 'done' }
          : { action: 'synthesize', content: '', researchers: [] },
      );

      const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 2 });
      await orchestrator.run();

      const routingCall = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls
        .map(c => c[0] as any)
        .find(o => !o.mustSynthesize);
      expect(routingCall?.digests).toBe(digests);
    });

    it('runs another round of researchers when the ROUTER delegates', async () => {
      // The evaluator's ability to ask for MORE research instead of finishing is the
      // decision this whole split has to preserve. The router's INPUT changed (it reads
      // the fresh round's findings in full, falling back to digests only for prior
      // rounds), but its delegate contract is unchanged: the researchers it names must
      // actually be launched, not just recorded.
      // A DISTINCT prior agenda must exist, or "the router's researchers were silently
      // swapped for the previous round's" is indistinguishable from correct behaviour and
      // the assertions below pass vacuously.
      mockPlanningService.getCurrentPlan.mockReturnValue({
        action: 'delegate',
        researchers: [{ id: '1.1', name: 'Stale Agenda', goal: 'the previous round', queries: ['stale q'] }],
        allQueries: ['stale q'],
      });
      mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) =>
        opts.mustSynthesize
          ? { action: 'synthesize', content: 'Final synthesis' }
          : {
              action: 'delegate',
              researchers: [{ id: '2.1', name: 'Gap Filler', goal: 'cover the pricing gap', queries: ['pricing q'] }],
              allQueries: ['pricing q'],
            },
      );

      const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 2 });
      await orchestrator.run();

      // Round 1 launches the coordinator's plan; a later launch must carry the ROUTER's.
      const launchedPlans = mockOrchestrationService.runResearchers.mock.calls.map((c: any[]) => c[0].plan);
      expect(launchedPlans.length).toBeGreaterThan(1);
      const routerPlan = launchedPlans.find((p: any) => p.researchers?.[0]?.name === 'Gap Filler');
      expect(routerPlan).toBeDefined();
      expect(routerPlan.researchers[0].goal).toBe('cover the pricing gap');
      // The prior agenda must not have been substituted for it.
      expect(launchedPlans.some((p: any) => p.researchers?.[0]?.name === 'Stale Agenda')).toBe(false);
      // And its queries reach the search burst that feeds them. Asserted on the recorded
      // first argument rather than via toHaveBeenCalledWith: the call passes an optional
      // AbortSignal that is undefined here, which expect.anything() does not match.
      const burstQueries = mockOrchestrationService.runSearchBurst.mock.calls.map((c: any[]) => c[0]);
      expect(burstQueries.some((q: string[]) => q.includes('pricing q'))).toBe(true);
    });

    it('keeps delegating across rounds until the budget runs out', async () => {
      // A router that never chooses to finish must be allowed to keep asking for research
      // right up to the round cap — the cap, not the router, is what ends the run.
      mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) =>
        opts.mustSynthesize
          ? { action: 'synthesize', content: 'Final synthesis' }
          : { action: 'delegate', researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }], allQueries: ['q'] },
      );

      const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 3 });
      const result = await orchestrator.run();

      expect(result).toBe('Final synthesis');
      const routingCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls
        .map(c => c[0] as any).filter(o => !o.mustSynthesize);
      expect(routingCalls.length).toBeGreaterThan(0);
      // Exactly one synthesis, at the end — delegating never triggers an early one.
      expect(vi.mocked(mockPlanningService.updatePlanForRound).mock.calls
        .map(c => c[0] as any).filter(o => o.mustSynthesize).length).toBe(1);
    });

    it('routes at depth 1 when steering extends the round budget', async () => {
      // Depth 1's BASE budget is 2 rounds, and the orchestrator skips the evaluator at the
      // cap — so without steering the router never runs and a depth-1 run goes straight
      // from researchers to synthesis. Steering breaks that: queued messages raise
      // maxRounds, round 2 stops being the cap, and the router runs for real. It is also
      // the depth-1 case with the largest corpus, so it is exactly where routing on digests
      // instead of findings matters.
      const { consumeQueuedMessages } = await import('../../../src/orchestration/session-state.ts');
      vi.mocked(consumeQueuedMessages).mockReturnValue([
        { id: '1', text: 'focus on X', status: 'active', addedAt: 0, consumedAt: 0, poppedAt: null },
      ]);
      const digests = new Map([['1.1', 'Covered: alpha\nGaps: none\nSources: 3']]);
      mockSynthesisService.getAllDigests.mockReturnValue(digests);
      mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) =>
        opts.mustSynthesize
          ? { action: 'synthesize', content: 'Final synthesis' }
          : { action: 'delegate', researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }], allQueries: ['q'] },
      );

      const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
      await orchestrator.run();

      const routingCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls
        .map(c => c[0] as any)
        .filter(o => !o.mustSynthesize);
      expect(routingCalls.length).toBeGreaterThan(0);
      for (const call of routingCalls) expect(call.digests).toBe(digests);
    });

    it('emits exactly one synthesis decision when the router finishes early', async () => {
      // The router's decision already fired onEvaluationDecision inside the loop. Firing
      // again for the terminal synthesis double-counts it for the TUI progress bar.
      mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) =>
        opts.mustSynthesize
          ? { action: 'synthesize', content: 'done' }
          : { action: 'synthesize', content: '', researchers: [] },
      );
      const onEvaluationDecision = vi.fn();

      const orchestrator = new DeepResearchOrchestrator({
        ...options,
        complexity: 2,
        observer: { onEvaluationDecision },
      } as any);
      await orchestrator.run();

      const synthesisDecisions = onEvaluationDecision.mock.calls.filter(c => c[0] === 'synthesize');
      expect(synthesisDecisions).toHaveLength(1);
    });
  });

  it('throws (not hollow success) when synthesis is empty and ZERO reports were collected', async () => {
    // Regression: the default depth-1 plan is a SINGLE researcher, and the
    // fast-stop threshold (MAX_FAILED_RESEARCHERS = 2) never trips for one
    // failure — a lone researcher that exhausted its retries (e.g. a provider
    // 429) used to reach forced synthesis with zero reports and return
    // 'Research completed but no summary was generated.' as SUCCESS (exit 0).
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: '' });
    mockSynthesisService.hasReports.mockReturnValue(false);
    const { getFailedResearchers, getResearcherFailureReasons } = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(getFailedResearchers).mockReturnValue(['1']);
    vi.mocked(getResearcherFailureReasons).mockReturnValue({ '1': 'HTTP 429 rate_limit_error from provider' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await expect(orchestrator.run()).rejects.toThrow(/produced no report.*HTTP 429 rate_limit_error/s);
  });

  it('throws (not hollow success) when researchers failed, ZERO reports exist, and synthesis is chatty refusal prose', async () => {
    // Residual of the hollow-success bug: gating the throw on EMPTY synthesis
    // text alone let a run whose sole researcher failed still ship, as long as
    // the synthesis LLM produced refusal prose ("no information was found…").
    // The gate must key on zero-reports + failed-researchers, not on the text.
    mockPlanningService.updatePlanForRound.mockResolvedValue({
      action: 'synthesize',
      content: 'Unfortunately, no reliable information was found for this query.',
    });
    mockSynthesisService.hasReports.mockReturnValue(false);
    const { getFailedResearchers, getResearcherFailureReasons } = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(getFailedResearchers).mockReturnValue(['1']);
    vi.mocked(getResearcherFailureReasons).mockReturnValue({ '1': 'HTTP 429 rate_limit_error from provider' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await expect(orchestrator.run()).rejects.toThrow(/produced no report.*HTTP 429 rate_limit_error/s);
  });

  it('zero reports is not a failure by itself — the hollow-run gate needs an actual failure', async () => {
    // The gate throws "produced no report" only when researchers ran AND failed. A run
    // that reaches synthesis with an empty corpus and nothing recorded as failed (an
    // early router synthesize, a researcher that returned nothing without erroring) must
    // still ship whatever the synthesis produced rather than dying on the gate.
    mockSynthesisService.hasReports.mockReturnValue(false);
    mockPlanningService.updatePlanForRound.mockResolvedValue({
      action: 'synthesize',
      content: 'Synthesized from what there was',
    });

    const orchestrator = new DeepResearchOrchestrator(options);
    await expect(orchestrator.run()).resolves.toBe('Synthesized from what there was');
  });

  it('should handle planning failure gracefully', async () => {
    mockPlanningService.generatePlan.mockRejectedValueOnce(new Error('Planning failed'));

    const orchestrator = new DeepResearchOrchestrator(options);

    await expect(orchestrator.run()).rejects.toThrow('Planning failed');
  });

  it('fires onError (not onComplete) and throws when a failure leaves no reports', async () => {
    mockPlanningService.generatePlan.mockRejectedValueOnce(new Error('Planning failed'));
    mockSynthesisService.hasReports.mockReturnValue(false);
    const onError = vi.fn();
    const onComplete = vi.fn();

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onError, onComplete } });
    await expect(orchestrator.run()).rejects.toThrow('Planning failed');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('fires onComplete (not onError) and returns a partial when a failure leaves collected reports', async () => {
    // A mid-run failure, but reports were collected — the orchestrator returns a
    // fallback synthesis. This is a completion, so EXACTLY onComplete fires and
    // onError must NOT (the previous behaviour fired both).
    mockPlanningService.generatePlan.mockRejectedValueOnce(new Error('boom'));
    mockSynthesisService.hasReports.mockReturnValue(true);
    mockSynthesisService.buildFallbackSynthesis.mockReturnValue('# Partial report');
    const onError = vi.fn();
    const onComplete = vi.fn();

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onError, onComplete } });
    const result = await orchestrator.run();

    expect(result).toContain('# Partial report');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a throwing onComplete observer does not double-fire or downgrade the report (success path)', async () => {
    // Regression guard: before the safeObserve wrap, a user onComplete that threw
    // on the success path diverted control into the catch, which fired onComplete
    // AGAIN with a fallback payload and silently replaced the full report with the
    // fallback synthesis. The throw must be isolated: exactly one onComplete, and
    // the full report is returned unchanged.
    mockPlanningService.updatePlanForRound.mockResolvedValue({
      action: 'synthesize',
      content: 'THE FULL REPORT',
    });
    const onComplete = vi.fn(() => { throw new Error('observer blew up'); });
    const onError = vi.fn();

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onComplete, onError } });
    const result = await orchestrator.run();

    expect(result).toBe('THE FULL REPORT'); // NOT downgraded to a fallback
    expect(onComplete).toHaveBeenCalledTimes(1); // NOT double-fired
    expect(onError).not.toHaveBeenCalled();
  });

  it('a throwing onError observer does not mask the original failure', async () => {
    // The onError wrap must swallow observer throws so the real error propagates
    // instead of being replaced by the observer's throw.
    mockPlanningService.generatePlan.mockRejectedValueOnce(new Error('Planning failed'));
    mockSynthesisService.hasReports.mockReturnValue(false);
    const onError = vi.fn(() => { throw new Error('observer blew up'); });
    const onComplete = vi.fn();

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onError, onComplete } });
    await expect(orchestrator.run()).rejects.toThrow('Planning failed'); // not 'observer blew up'
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('should enforce maximum rounds and force synthesis', async () => {
    // Mock updatePlanForRound to always return delegate
    mockPlanningService.updatePlanForRound.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
      allQueries: ['q'],
    });

    // Forced synthesis (last call)
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
        if (opts.mustSynthesize) {
            return { action: 'synthesize', content: 'Forced synthesis result' };
        }
        return {
            action: 'delegate',
            researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
            allQueries: ['q'],
        };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 }); // maxRounds = 2
    const result = await orchestrator.run();

    expect(result).toContain('Forced synthesis result');
    // The cap is the point of this test, and asserting only on the returned string does
    // not test it: a run of any length ends with the forced synthesis and returns this
    // same text. Until the steering mock leak above was fixed, this test was silently
    // running THREE rounds while its comment claimed two, and nothing here could tell.
    const calls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(calls.map((c: any[]) => Boolean(c[0].mustSynthesize))).toEqual([true]);
    expect(vi.mocked(mockOrchestrationService.runResearchers).mock.calls).toHaveLength(1);
  });

  it('should extend round budget when queued steering messages exist at run start', async () => {
    // Pretend the user has 2 queued steering messages waiting when this
    // research run begins. For complexity 1, the base budget is 2 rounds;
    // with 2 queued messages we should get up to 2 extra rounds (capped
    // at MAX_EXTRA_ROUNDS_WITH_STEERING = 2).
    // The round-budget bonus is driven by the messages consumed (queued->active)
    // at run start, i.e. the return value of consumeQueuedMessages — not by
    // getSteeringMessages (which also counts prior-run active messages).
    const { consumeQueuedMessages } = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(consumeQueuedMessages).mockReturnValue([
      { id: '1', text: 'focus on X', status: 'active', addedAt: 0, consumedAt: 0, poppedAt: null },
      { id: '2', text: 'and Y', status: 'active', addedAt: 0, consumedAt: 0, poppedAt: null },
    ]);

    // Evaluator keeps delegating until the loop exits, then forced synthesis.
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.mustSynthesize) {
        return { action: 'synthesize', content: 'Final synthesis' };
      }
      return {
        action: 'delegate',
        researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
        allQueries: ['q'],
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    const result = await orchestrator.run();

    expect(result).toContain('Final synthesis');

    // With 2 queued messages and cap=2, the budget extends from 2 → 4 rounds.
    // Rounds 2..maxRounds-1 each run an in-loop evaluator call; the LAST round does
    // not — it would break to the forced final synthesis regardless of what the
    // evaluator said, so the orchestrator skips it. Budget 4 → rounds 2,3 evaluate
    // in-loop (2 calls) + 1 forced synthesis = 3.
    const updateCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(updateCalls.length).toBe(3);
    // Exactly one of them is the forced final synthesis.
    expect(updateCalls.filter((c) => (c[0] as any)?.mustSynthesize).length).toBe(1);
  });

  it('should NOT extend round budget when no queued steering messages exist', async () => {
    // Explicitly reset steering mocks in case a previous test set them.
    const { getSteeringMessages, consumeQueuedMessages } = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(getSteeringMessages).mockReturnValue([]);
    vi.mocked(consumeQueuedMessages).mockReturnValue([]);

    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.mustSynthesize) {
        return { action: 'synthesize', content: 'Base synthesis' };
      }
      return {
        action: 'delegate',
        researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
        allQueries: ['q'],
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    const result = await orchestrator.run();

    expect(result).toContain('Base synthesis');
    // Base budget 2 rounds. Round 2 IS the cap, so it skips the in-loop evaluator
    // and goes straight to the forced final synthesis: 0 in-loop + 1 forced = 1.
    // Contrast with the extended-budget case above (3) — the difference is what
    // makes this test discriminate a 2-round budget from a 4-round one.
    const updateCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(updateCalls.length).toBe(1);
    expect((updateCalls[0]![0] as any)?.mustSynthesize).toBe(true);
  });

  it('should pass its own live, steering-extended maxRounds through to updatePlanForRound (not the base complexity value)', async () => {
    // Regression: PlanningService.updatePlanForRound used to recompute maxRounds
    // internally from the base complexity table alone, blind to the orchestrator's
    // steering-driven extension — understating the round-phase-guidance denominator
    // once steering unlocked extra rounds. The orchestrator must now forward its own
    // live `maxRounds` (base + steering bonus) on every call site.
    const { consumeQueuedMessages } = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(consumeQueuedMessages).mockReturnValue([
      { id: '1', text: 'focus on X', status: 'active', addedAt: 0, consumedAt: 0, poppedAt: null },
      { id: '2', text: 'and Y', status: 'active', addedAt: 0, consumedAt: 0, poppedAt: null },
    ]);

    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.mustSynthesize) {
        return { action: 'synthesize', content: 'Final synthesis' };
      }
      return {
        action: 'delegate',
        researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
        allQueries: ['q'],
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    await orchestrator.run();

    // Base budget (MAX_ROUNDS_LEVEL_1 = 2) + 2 queued steering messages (cap 2) = 4.
    const extendedMaxRounds = MAX_ROUNDS_LEVEL_1 + 2;
    const updateCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    for (const [callOptions] of updateCalls) {
      // Every call — in-loop evaluator AND the forced final synthesis — must carry
      // the extended value, never the understated base (2).
      expect((callOptions as any).maxRounds).toBe(extendedMaxRounds);
    }
  });

  it('should cap extra rounds at MAX_EXTRA_ROUNDS_WITH_STEERING even with many queued messages', async () => {
    // 5 queued messages — but cap is 2, so we should only get 2 extra rounds.
    const { consumeQueuedMessages } = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(consumeQueuedMessages).mockReturnValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        text: `steer ${i}`,
        status: 'active' as const,
        addedAt: 0,
        consumedAt: 0,
        poppedAt: null,
      })),
    );

    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.mustSynthesize) {
        return { action: 'synthesize', content: 'Capped synthesis' };
      }
      return {
        action: 'delegate',
        researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
        allQueries: ['q'],
      };
    });

    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1 });
    const result = await orchestrator.run();

    expect(result).toContain('Capped synthesis');
    // Cap=2 + base=2 = 4 rounds → rounds 2,3 evaluate in-loop (the 4th is the cap
    // and skips straight to synthesis) + 1 forced = 3. Same total as the 2-message
    // case above, which is the point: the cap held.
    const updateCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(updateCalls.length).toBe(3);
  });

  it('does not announce, observe or health-check the capped round, which never researches', async () => {
    // The loop used to increment the round, log "Round 2/2", fire onRoundStart, run a
    // full infrastructure health check, and only THEN test the cap and break — so every
    // capped run announced a round in which no researcher was ever dispatched. 92 of 93
    // capped runs in the retained logs did exactly that, one of them spending 105
    // seconds on the phantom round's health check. onRoundStart also arms the TUI's
    // deferred panel clear, which is consumed by a researcher start that never comes.
    const onRoundStart = vi.fn();
    // clearAllMocks() clears call history but NOT mockReturnValue overrides, and an
    // earlier test in this file leaves consumeQueuedMessages returning steering
    // messages — which would silently extend the round budget and make round 2 a real
    // research round. Reset them here, the same hazard the beforeEach documents for the
    // failed-researcher mocks.
    const steering = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(steering.consumeQueuedMessages).mockReturnValue([]);
    vi.mocked(steering.getSteeringMessages).mockReturnValue([]);
    // Complexity 1 → MAX_ROUNDS_LEVEL_1 = 2 iterations, so round 2 IS the cap.
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: '1', role: 'r', focus: 'f', queries: ['q'] }],
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Final' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onRoundStart } });
    await orchestrator.run();

    expect(MAX_ROUNDS_LEVEL_1).toBe(2);

    // The two costs the phantom round actually incurred, asserted directly rather than
    // through the announcement. The announcement is a poor proxy now that the final
    // synthesis legitimately announces the same round number (see the contiguity test
    // below), and `not.toHaveBeenCalledWith(2)` would go on passing if the loop stopped
    // announcing anything at all.
    //
    // The health check is the expensive half — 105s of it on the measured run. Only
    // round 1 reaches it, and the real implementation returns immediately for round 1
    // (nothing has run through the pool yet), so at complexity 1 no probe is performed
    // at all. Remove the cap check and this list becomes [1, 2], with round 2 doing the
    // full probe.
    expect(vi.mocked(mockOrchestrationService.checkHealth).mock.calls.map(c => c[0])).toEqual([1]);
    // The evaluator is the other half. One call, and it is the forced final synthesis —
    // not a routing call for a round whose delegation the cap would discard.
    const planCalls = vi.mocked(mockPlanningService.updatePlanForRound).mock.calls;
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]![0]).toEqual(expect.objectContaining({ mustSynthesize: true }));
    // Round 1 researched; round 2 exists only as the synthesis pass.
    expect(onRoundStart.mock.calls.map(c => c[0])).toEqual([1, 2]);
  });

  it('announces a contiguous round sequence that ends at the budget, not past it', async () => {
    // `round_start` is an SDK event, and a consumer counting rounds reads the gaps. The
    // final synthesis used to announce `maxRounds + 1` — a number outside the budget
    // every other event is expressed in — which was invisible while the loop also
    // announced the phantom final round (1, 2, 3, then a 4 nobody minded). With the
    // phantom gone it left a hole: a 3-round run emitted 1, 2, 4.
    const onRoundStart = vi.fn();
    const steering2 = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(steering2.consumeQueuedMessages).mockReturnValue([]);
    vi.mocked(steering2.getSteeringMessages).mockReturnValue([]);
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: '1', role: 'r', focus: 'f', queries: ['q'] }],
    });
    // Keep delegating, so the loop ends on the CAP rather than on a router decision —
    // the only path that reaches the post-loop announcement. The forced final call
    // (mustSynthesize) still has to return a report, or the run fails before the
    // sequence under test is complete.
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) =>
      opts?.mustSynthesize
        ? { action: 'synthesize', content: 'Final' }
        : { action: 'delegate', researchers: [{ id: '2', role: 'r', focus: 'f', queries: ['q'] }] },
    );

    // complexity 2 → 3 iterations: rounds 1 and 2 research, round 3 synthesizes.
    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      complexity: 2 as const,
      observer: { onRoundStart },
    });
    await orchestrator.run();

    expect(onRoundStart.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
  });

  it('a steering message consumed at the top of the capped round turns it into a real one', async () => {
    // This is why the cap check sits AFTER steering consumption rather than at the top
    // of the loop. Moving it earlier is a tempting simplification and it silently drops
    // the user's last-moment steering: the budget would be read before the message that
    // extends it. Complexity 1 gives 2 iterations, so round 2 is the cap — until a
    // message consumed at its start raises the budget to 3.
    const onRoundStart = vi.fn();
    const steering4 = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(steering4.consumeQueuedMessages).mockReturnValue([]);
    // getSteeringMessages is read twice per round (before consume, then after). Rounds
    // 1 and 2's "before" reads plus round 1's "after" read see nothing; round 2's
    // "after" read sees a newly consumed message, which is what buys the extra round.
    let reads = 0;
    vi.mocked(steering4.getSteeringMessages).mockImplementation(() => {
      reads++;
      return reads >= 4 ? ([{ text: 'go deeper', status: 'active' }] as any) : [];
    });

    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }],
      allQueries: ['q1'],
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Steered' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onRoundStart } });
    await orchestrator.run();

    expect(onRoundStart).toHaveBeenCalledWith(2);
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalled();
  });

  it('should report round progress to observer', async () => {
    const onRoundStart = vi.fn();
    const onSearchProgress = vi.fn();
    // Reset the leaked steering overrides (see the capped-round test): this assertion
    // used to depend on them. With complexity 1 the budget is 2 iterations, so round 2
    // is the cap and is never announced — the version of this test that expected
    // onRoundStart(2) at complexity 1 passed only because an earlier test had left
    // consumeQueuedMessages returning steering messages, silently extending the budget.
    // It was asserting the phantom round, and it was doing so by accident.
    const steering3 = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(steering3.consumeQueuedMessages).mockReturnValue([]);
    vi.mocked(steering3.getSteeringMessages).mockReturnValue([]);

    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Progress test' });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      complexity: 2 as const, // 3 iterations → rounds 1 and 2 both research
      observer: { onRoundStart, onSearchProgress },
    });

    await orchestrator.run();

    expect(onRoundStart).toHaveBeenCalledWith(1);
    expect(onRoundStart).toHaveBeenCalledWith(2);
    expect(onRoundStart).not.toHaveBeenCalledWith(3); // the cap, which never researches
  });

  it('should increment totalResearchersPlanned after each delegate round', async () => {
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [
        { id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] },
        { id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] },
      ],
      allQueries: ['q1', 'q2'],
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    // Should have incremented by 2 (number of researchers in the delegate plan)
    expect(mockPlanningService.incrementTotalResearchersPlanned).toHaveBeenCalledWith(options.researchId, 2);
  });

  it('should record query history after each delegate round', async () => {
    mockPlanningService.generatePlan.mockResolvedValue({
      action: 'delegate',
      researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1', 'q2'] }],
      allQueries: ['q1', 'q2'],
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    expect(mockPlanningService.addToQueryHistory).toHaveBeenCalledWith(options.researchId, ['q1', 'q2']);
  });

  it('should pass getCurrentPlan as previousPlan to updatePlanForRound', async () => {
    const mockPreviousPlan = { action: 'delegate' as const, researchers: [], allQueries: ['prev-q'] };
    
    mockPlanningService.generatePlan.mockResolvedValue(mockPreviousPlan);
    mockPlanningService.getCurrentPlan.mockImplementation(() => {
      return mockPlanningService.generatePlan.mock.calls.length > 0 ? mockPreviousPlan : null;
    });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    // Round 2 (final synthesis) should pass the previous plan
    expect(mockPlanningService.updatePlanForRound).toHaveBeenCalledWith(
      expect.objectContaining({ previousPlan: mockPreviousPlan })
    );
  });

  it('does not increment totalResearchersPlanned for a synthesize decision', async () => {
    // Only a delegation adds to the planned count. Round 1 always delegates, so the
    // count reflects that one team and nothing the router's synthesize decision does.
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    expect(mockPlanningService.incrementTotalResearchersPlanned).toHaveBeenCalledTimes(1);
    expect(mockPlanningService.incrementTotalResearchersPlanned).toHaveBeenCalledWith(options.researchId, 1);
  });

  it('should fire onStart observer event at the beginning of run()', async () => {
    const onStart = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onStart } });
    await orchestrator.run();

    expect(onStart).toHaveBeenCalledWith(options.query, options.complexity);
  });

  it('should fire onPlanningStart and onPlanningProgress observer events during planning', async () => {
    const onPlanningStart = vi.fn();
    const onPlanningProgress = vi.fn();

    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      observer: { onPlanningStart, onPlanningProgress },
    });
    await orchestrator.run();

    expect(onPlanningStart).toHaveBeenCalledWith(1);
    expect(onPlanningProgress).toHaveBeenCalledWith('planning');
  });

  it('should fire onPlanningSuccess when plan action is delegate', async () => {
    const onPlanningSuccess = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onPlanningSuccess } });
    await orchestrator.run();

    expect(onPlanningSuccess).toHaveBeenCalledWith(expect.objectContaining({ action: 'delegate' }));
  });

  it('should fire onSearchStart when queries are available', async () => {
    const onSearchStart = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1', 'q2'] }], allQueries: ['q1', 'q2'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onSearchStart } });
    await orchestrator.run();

    expect(onSearchStart).toHaveBeenCalledWith(['q1', 'q2']);
  });

  it('should fire onSearchComplete with result count after search phase', async () => {
    const onSearchComplete = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    // Return 3 results from search burst
    mockOrchestrationService.runSearchBurst.mockResolvedValue([
      { results: [{ url: 'a' }, { url: 'b' }] },
      { results: [{ url: 'c' }] },
    ]);

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onSearchComplete } });
    await orchestrator.run();

    // 2 results from first query, 1 from second = 3 total
    expect(onSearchComplete).toHaveBeenCalledWith(3);
  });

  it('should fire onEvaluationStart and onEvaluationProgress observer events', async () => {
    const onEvaluationStart = vi.fn();
    const onEvaluationProgress = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      observer: { onEvaluationStart, onEvaluationProgress },
    });
    await orchestrator.run();

    expect(onEvaluationStart).toHaveBeenCalled();
    expect(onEvaluationProgress).toHaveBeenCalledWith('embedding');
    expect(onEvaluationProgress).toHaveBeenCalledWith('evaluating');
  });

  it('should fire onEvaluationDecision with delegate action after research round', async () => {
    const onEvaluationDecision = vi.fn();

    // complexity 2 → maxRounds = 4
    mockPlanningService.generatePlan.mockResolvedValue({ action: 'delegate', researchers: [{ id: 'r1', name: 'R1', goal: 'G1', queries: ['q1'] }], allQueries: ['q1'] });
    
    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.round === 2) {
        return { action: 'delegate', researchers: [{ id: 'r2', name: 'R2', goal: 'G2', queries: ['q2'] }], allQueries: ['q2'] };
      }
      return { action: 'synthesize', content: 'Done' };
    });

    const orchestrator = new DeepResearchOrchestrator({
      ...options,
      complexity: 2 as const,
      observer: { onEvaluationDecision },
    });
    await orchestrator.run();

    expect(onEvaluationDecision).toHaveBeenCalledWith('delegate', expect.anything(), 2);
  });

  it('should fire onComplete with the final result string', async () => {
    const onComplete = vi.fn();

    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Final answer' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onComplete } });
    await orchestrator.run();

    expect(onComplete).toHaveBeenCalledWith('Final answer');
  });

  it('should fire onError when planning throws', async () => {
    const onError = vi.fn();
    const testError = new Error('Planning blew up');
    mockPlanningService.generatePlan.mockRejectedValue(testError);

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onError } });
    await expect(orchestrator.run()).rejects.toThrow('Planning blew up');
    expect(onError).toHaveBeenCalledWith(testError);
  });

  it('fires onSynthesisStart BEFORE the final steering drain and the forced synthesis call', async () => {
    // Regression: on the maxRounds/mustSynthesize path, onEvaluationStart re-enabled
    // steering and the last drain ran before the long synthesis call — a steer typed
    // during forced synthesis was queued with an affirmative toast, then destroyed at
    // teardown. The orchestrator must flip steering off (onSynthesisStart) first, THEN
    // drain, THEN call the evaluator, so no message can be queued-and-stranded.
    const events: string[] = [];
    const { consumeQueuedMessages } = await import('../../../src/orchestration/session-state.ts');
    vi.mocked(consumeQueuedMessages).mockImplementation(() => {
      events.push('consume');
      return [];
    });

    mockPlanningService.updatePlanForRound.mockImplementation(async (opts: any) => {
      if (opts.mustSynthesize) {
        events.push('forcedSynthesisCall');
        return { action: 'synthesize', content: 'Forced' };
      }
      events.push('inLoopEval');
      return {
        action: 'delegate',
        researchers: [{ id: 'r', name: 'R', goal: 'G', queries: ['q'] }],
        allQueries: ['q'],
      };
    });

    const onSynthesisStart = vi.fn(() => events.push('synthesisStart'));
    const orchestrator = new DeepResearchOrchestrator({ ...options, complexity: 1, observer: { onSynthesisStart } });
    const result = await orchestrator.run();

    expect(result).toContain('Forced');
    const flipIdx = events.indexOf('synthesisStart');
    const finalDrainIdx = events.lastIndexOf('consume');
    const forcedIdx = events.indexOf('forcedSynthesisCall');
    expect(flipIdx).toBeGreaterThan(-1);
    // flag off → final drain → synthesis call
    expect(flipIdx).toBeLessThan(finalDrainIdx);
    expect(finalDrainIdx).toBeLessThan(forcedIdx);
  });

  it('fires onSynthesisStart on the evaluator-chose-synthesize path too (idempotent flip)', async () => {
    const onSynthesisStart = vi.fn();
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Direct' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onSynthesisStart } });
    await orchestrator.run();

    expect(onSynthesisStart).toHaveBeenCalledTimes(1);
  });

  it('on abort mid-round: skips storeLinkDescriptions and passes skipStoreMaintenance to cleanup', async () => {
    // Esc/abort responsiveness: runResearchers returns normally on abort, so the
    // orchestrator must not run the post-round embedding pass, and the finally must
    // not run the (non-signal-aware) FTS rebuild + optimize.
    const controller = new AbortController();
    mockOrchestrationService.runResearchers.mockImplementation(async () => {
      controller.abort();
    });
    mockSynthesisService.hasReports.mockReturnValue(false);

    const orchestrator = new DeepResearchOrchestrator(options);
    await expect(orchestrator.run(controller.signal)).rejects.toThrow('Research aborted');

    expect(mockOrchestrationService.storeLinkDescriptions).not.toHaveBeenCalled();
    expect(mockOrchestrationService.cleanupResearchServices).toHaveBeenLastCalledWith(
      undefined,
      options.researchId,
      expect.anything(),
      expect.anything(),
      { skipStoreMaintenance: true },
    );
  });

  it('passes skipStoreMaintenance: false to the final cleanup on a normal completion', async () => {
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Done' });

    const orchestrator = new DeepResearchOrchestrator(options);
    await orchestrator.run();

    expect(mockOrchestrationService.cleanupResearchServices).toHaveBeenLastCalledWith(
      undefined,
      options.researchId,
      expect.anything(),
      expect.anything(),
      { skipStoreMaintenance: false },
    );
  });

  it('should fire onPlanningProgress with wait status when plan returns wait action', async () => {
    const onPlanningProgress = vi.fn();
    const onError = vi.fn();

    mockPlanningService.generatePlan.mockResolvedValue({ action: 'wait' });
    // After exceeding the wait limit the orchestrator breaks to synthesis instead of
    // throwing, so the final block resolves a report.
    mockPlanningService.updatePlanForRound.mockResolvedValue({ action: 'synthesize', content: 'Synthesized after waits' });

    const orchestrator = new DeepResearchOrchestrator({ ...options, observer: { onPlanningProgress, onError } });

    // Use fake timers so the 5-second wait between retries resolves immediately
    vi.useFakeTimers();
    let result: string;
    try {
      const runPromise = orchestrator.run();
      // Drain all pending timers (each retry schedules one 5s setTimeout)
      for (let i = 0; i < 6; i++) {
        await vi.runAllTimersAsync();
      }
      result = await runPromise;
    } finally {
      vi.useRealTimers();
    }

    // onPlanningProgress should have been called (with 'planning' for wait retries),
    // and the run should end in a graceful synthesis rather than an error.
    expect(onPlanningProgress).toHaveBeenCalledWith('planning');
    expect(onError).not.toHaveBeenCalled();
    expect(result).toBe('Synthesized after waits');
  }, 15000);
});