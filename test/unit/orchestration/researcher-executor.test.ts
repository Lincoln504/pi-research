/**
 * researcher-executor Unit Tests
 *
 * Tests the `runResearcher` function's observable behaviour: skip guard,
 * observer callbacks, abort-signal propagation, retry logic, and successful
 * report storage.  `createResearcherSession` and the session-manager services
 * are mocked at the boundary — all retry/abort/skip logic inside the function
 * runs against real implementation code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runResearcher } from '../../../src/orchestration/researcher-executor.ts';
import type { RunResearcherOptions } from '../../../src/orchestration/orchestration-types.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(),
  registerService: vi.fn(),
  resetServiceContainer: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn() },
}));

vi.mock('../../../src/utils/prompts.ts', () => ({
  loadPrompt: vi.fn(() => 'researcher prompt {{goal}} {{store_section}} {{evidence_section}} {{coordination_section}} {{extra_tool_guidelines}}'),
}));

vi.mock('../../../src/utils/inject-date.ts', () => ({
  injectCurrentDate: vi.fn((_t: string) => _t),
}));

vi.mock('../../../src/utils/shared-links.ts', () => ({
  registerScrapedLinks: vi.fn(),
  normalizeUrl: vi.fn((u: string) => u),
}));

vi.mock('../../../src/utils/text-utils.ts', () => ({
  ensureAssistantResponse: vi.fn(() => 'mock researcher report content'),
}));

vi.mock('@earendil-works/pi-ai', () => ({
  calculateCost: vi.fn(() => ({ total: 0 })),
}));

// Hoisted session mock references
const { mockPrompt, mockAbort, mockSubscribe, mockRegister, mockUnregister, mockStoreReport } = vi.hoisted(() => ({
  mockPrompt: vi.fn().mockResolvedValue(undefined),
  mockAbort: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn(() => vi.fn()), // returns unsubscribe fn
  mockRegister: vi.fn(),
  mockUnregister: vi.fn(),
  mockStoreReport: vi.fn(),
}));

vi.mock('../../../src/orchestration/researcher.ts', () => ({
  createResearcherSession: vi.fn(() => Promise.resolve({
    session: {
      prompt: mockPrompt,
      abort: mockAbort,
      subscribe: mockSubscribe,
    },
    resolvedModel: { id: 'test-model' } as any,
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STUB_MODEL = { id: 'test-model' } as any;

/** Default ResearcherConfig (the researcher's own id/name/goal/queries). */
const DEFAULT_RESEARCHER_CONFIG = {
  id: '1',
  name: 'General Researcher',
  goal: 'Research the topic comprehensively',
  queries: ['query 1', 'query 2'],
};

/** System-level research config (timeouts, retry counts). */
const SYSTEM_CONFIG = {
  RESEARCHER_MAX_RETRIES: 0,
  RESEARCHER_MAX_RETRY_DELAY_MS: 100,
  RESEARCHER_TIMEOUT_MS: 5000,
};

const STUB_PLANNING_SERVICE = {
  getCurrentPlan: vi.fn(() => null),
} as any;

const BASE_CTX = {
  cwd: '/tmp',
  model: STUB_MODEL,
  modelRegistry: {
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'k', headers: {} }),
  },
} as any;

function makeOptions(overrides: Partial<RunResearcherOptions> = {}): RunResearcherOptions {
  return {
    config: DEFAULT_RESEARCHER_CONFIG,      // ResearcherConfig (id, name, goal, queries)
    initialLinks: ['https://example.com/article1'],
    historicalUrls: [], sessionId: 'test-session',
    researchId: 'test-research-id',
    round: 1,
    query: 'What is TypeScript?',
    complexity: 1,
    ctx: BASE_CTX,
    model: STUB_MODEL,
    researchConfig: SYSTEM_CONFIG as any,   // system config (timeouts, retries)
    planningService: STUB_PLANNING_SERVICE,
    observer: undefined,
    signal: undefined,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runResearcher', () => {
  beforeEach(async () => {
    mockPrompt.mockClear().mockResolvedValue(undefined);
    mockAbort.mockClear().mockResolvedValue(undefined);
    mockSubscribe.mockClear().mockReturnValue(vi.fn());
    mockRegister.mockClear();
    mockUnregister.mockClear();
    mockStoreReport.mockClear();
    STUB_PLANNING_SERVICE.getCurrentPlan.mockReturnValue(null);

    // Default getService implementation
    vi.mocked(getService).mockImplementation(async (name) => {
      if (name === ServiceNames.RESEARCH_SESSION_SERVICE) {
        return {
          registerSession: mockRegister,
          unregisterSession: mockUnregister,
        } as any;
      }
      if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) {
        return {
          storeReport: mockStoreReport,
          appendSteeringGuidance: vi.fn((text) => text),
          ensureCitedLinks: vi.fn((_id, text) => text),
        } as any;
      }
      return null;
    });

    // Clear the createResearcherSession call history so per-test call[0] is always fresh
    const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
    vi.mocked(createResearcherSession).mockClear();
  });

  // ── Skip guard ──────────────────────────────────────────────────────────────

  describe('skip guard', () => {
    it('returns without prompting when both initialLinks and historicalUrls are empty', async () => {
      await runResearcher(makeOptions({ initialLinks: [], historicalUrls: [], sessionId: 'test-session' }));
      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it('fires onResearcherFailure when skipping (no initial links)', async () => {
      const onResearcherFailure = vi.fn();
      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [], sessionId: 'test-session',
        observer: { onResearcherFailure } as any,
      }));
      expect(onResearcherFailure).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    });

    it('fires onResearcherFailure with the researcher id when skipping', async () => {
      const onResearcherFailure = vi.fn();
      const config = { id: 'r42', name: 'R42', goal: 'g', queries: [] };
      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [], sessionId: 'test-session',
        config,
        observer: { onResearcherFailure } as any,
      }));
      expect(onResearcherFailure).toHaveBeenCalledWith('r42', expect.any(String));
    });

    it('proceeds when only initialLinks is non-empty', async () => {
      await runResearcher(makeOptions({ initialLinks: ['https://x.com'], historicalUrls: [], sessionId: 'test-session' }));
      expect(mockPrompt).toHaveBeenCalledOnce();
    });

    it('proceeds when only historicalUrls is non-empty', async () => {
      await runResearcher(makeOptions({ initialLinks: [], historicalUrls: [{ url: 'https://x.com', description: 'test description' }] }));
      expect(mockPrompt).toHaveBeenCalledOnce();
    });
  });

  // ── Observer callbacks ──────────────────────────────────────────────────────

  describe('observer callbacks', () => {
    it('fires onResearcherStart before prompting', async () => {
      const events: string[] = [];
      const observer = {
        onResearcherStart: vi.fn(() => events.push('start')),
        onResearcherComplete: vi.fn(() => events.push('complete')),
      };
      mockPrompt.mockImplementation(() => { events.push('prompt'); return Promise.resolve(undefined); });

      await runResearcher(makeOptions({ observer: observer as any }));

      expect(events[0]).toBe('start');
      expect(events).toContain('prompt');
      expect(events[events.length - 1]).toBe('complete');
    });

    it('passes the researcher id, name, goal, and round to onResearcherStart', async () => {
      const onResearcherStart = vi.fn();
      const config = { id: '5', name: 'Security Analyst', goal: 'Find vulnerabilities', queries: [] };
      await runResearcher(makeOptions({ config, observer: { onResearcherStart } as any }));
      expect(onResearcherStart).toHaveBeenCalledWith('5', 'Security Analyst', 'Find vulnerabilities', 1);
    });

    it('fires onResearcherComplete with the researcher id and response text on success', async () => {
      const onResearcherComplete = vi.fn();
      const config = { id: '2', name: 'R2', goal: 'g', queries: [] };
      await runResearcher(makeOptions({ config, observer: { onResearcherComplete } as any }));
      expect(onResearcherComplete).toHaveBeenCalledWith('2', 'mock researcher report content');
    });

    it('propagates the error when all attempts are exhausted', async () => {
      mockPrompt.mockRejectedValue(new Error('network error'));
      const config = { id: '3', name: 'R3', goal: 'g', queries: [] };

      await expect(runResearcher(makeOptions({
        config,
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 0 } as any,
      }))).rejects.toThrow('network error');

      // Session must be aborted and unregistered even on failure
      expect(mockAbort).toHaveBeenCalled();
      expect(mockUnregister).toHaveBeenCalled();
    });
  });

  // ── Successful execution ────────────────────────────────────────────────────

  describe('successful execution', () => {
    it('stores the report in the synthesis service', async () => {
      await runResearcher(makeOptions());
      expect(mockStoreReport).toHaveBeenCalledOnce();
      expect(mockStoreReport).toHaveBeenCalledWith(
        'test-research-id',
        expect.stringContaining('1.'), // round.id format
        'mock researcher report content'
      );
    });

    it('registers the session before prompting and unregisters it after', async () => {
      const callOrder: string[] = [];
      mockRegister.mockImplementation(() => callOrder.push('register'));
      mockPrompt.mockImplementation(() => { callOrder.push('prompt'); return Promise.resolve(undefined); });
      mockUnregister.mockImplementation(() => callOrder.push('unregister'));

      await runResearcher(makeOptions());

      expect(callOrder.indexOf('register')).toBeLessThan(callOrder.indexOf('prompt'));
      expect(callOrder.indexOf('prompt')).toBeLessThan(callOrder.indexOf('unregister'));
    });

    it('always calls abort on the session in the finally block', async () => {
      await runResearcher(makeOptions());
      expect(mockAbort).toHaveBeenCalled();
    });

    it('unsubscribes from session events after completion', async () => {
      const unsubscribe = vi.fn();
      mockSubscribe.mockReturnValueOnce(unsubscribe);
      await runResearcher(makeOptions());
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('includes historical URLs in the prompt when provided', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      await runResearcher(makeOptions({ historicalUrls: [{ url: 'https://hist.example.com', description: 'Found info about XYZ here' }] }));
      const sessionCall = vi.mocked(createResearcherSession).mock.calls[0]![0] as any;
      expect(sessionCall.systemPrompt).toContain('https://hist.example.com');
      expect(sessionCall.systemPrompt).toContain('Found info about XYZ here');
    });

    it('includes initial search result links in the prompt', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      await runResearcher(makeOptions({ initialLinks: ['https://search-result.com'] }));
      const sessionCall = vi.mocked(createResearcherSession).mock.calls[0]![0] as any;
      expect(sessionCall.systemPrompt).toContain('https://search-result.com');
    });
  });

  // ── Retry logic ─────────────────────────────────────────────────────────────

  describe('retry logic', () => {
    it('retries the specified number of times before throwing', async () => {
      const error = new Error('transient failure');
      mockPrompt.mockRejectedValue(error);
      const maxRetries = 2;

      await expect(runResearcher(makeOptions({
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: maxRetries } as any,
      }))).rejects.toThrow('transient failure');

      // maxAttempts = RESEARCHER_MAX_RETRIES + 1 = 3 calls
      expect(mockPrompt).toHaveBeenCalledTimes(maxRetries + 1);
    });

    it('succeeds on the second attempt after one failure', async () => {
      mockPrompt
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValueOnce(undefined);

      await expect(runResearcher(makeOptions({
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 1 } as any,
      }))).resolves.toBeUndefined();

      expect(mockStoreReport).toHaveBeenCalledOnce();
    });

    it('aborts and unregisters the session after each failed attempt', async () => {
      mockPrompt.mockRejectedValue(new Error('fail'));

      await expect(runResearcher(makeOptions({
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 1 } as any,
      }))).rejects.toThrow('fail');

      // One abort per attempt (2 attempts)
      expect(mockAbort).toHaveBeenCalledTimes(2);
      expect(mockUnregister).toHaveBeenCalledTimes(2);
    });
  });

  // ── Abort signal ────────────────────────────────────────────────────────────

  describe('abort signal', () => {
    it('rejects with a pre-aborted signal when prompt is pending', async () => {
      const controller = new AbortController();
      controller.abort();

      // Prompt never resolves — abort signal race must win
      mockPrompt.mockImplementation(() => new Promise(() => {}));

      await expect(runResearcher(makeOptions({ signal: controller.signal }))).rejects.toThrow();
    });

    it('calls session.abort() when the signal is fired mid-prompt', async () => {
      const controller = new AbortController();
      // Prompt blocks indefinitely so the abort signal fires first
      mockPrompt.mockImplementation(() => new Promise(() => {}));

      const p = runResearcher(makeOptions({ signal: controller.signal })).catch(() => {});
      controller.abort();
      await p;

      expect(mockAbort).toHaveBeenCalled();
    });
  });

  // ── previousQueriesSection ──────────────────────────────────────────────────

  describe('previous queries from current plan', () => {
    it('includes sibling researcher queries in the system prompt when a current plan exists', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      STUB_PLANNING_SERVICE.getCurrentPlan.mockReturnValue({
        action: 'delegate',
        researchers: [],
        allQueries: ['previous query 1', 'previous query 2'],
      });

      await runResearcher(makeOptions());

      const sessionCall = vi.mocked(createResearcherSession).mock.calls[0]![0] as any;
      expect(sessionCall.systemPrompt).toContain('previous query 1');
      expect(sessionCall.systemPrompt).toContain('previous query 2');
    });

    it('omits the sibling section when currentPlan has no queries', async () => {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      STUB_PLANNING_SERVICE.getCurrentPlan.mockReturnValue({
        action: 'delegate', researchers: [], allQueries: [],
      });

      await runResearcher(makeOptions());

      const sessionCall = vi.mocked(createResearcherSession).mock.calls[0]![0] as any;
      expect(sessionCall.systemPrompt).not.toContain('Previous Queries');
    });
  });
});
