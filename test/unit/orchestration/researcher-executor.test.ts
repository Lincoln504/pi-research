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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResearcher } from '../../../src/orchestration/researcher-executor.ts';
import { loadPrompt } from '../../../src/core/llm/prompts.ts';
import type { RunResearcherOptions } from '../../../src/orchestration/orchestration-types.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { metrics } from '../../../src/utils/metrics.ts';
// Real (unmocked) session-state: the executor's fast-stop self-check reads live
// failure counts, so tests drive it through the real recordResearcherFailure.
import { recordResearcherFailure, resetAllPiSessions } from '../../../src/orchestration/session-state.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async (_name: any, _ctx?: any, _container?: any) => {}),
  registerService: vi.fn(),
  resetServiceContainer: vi.fn(),
  tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn(), session: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() }, },
}));

vi.mock('../../../src/core/llm/prompts.ts', () => ({
  loadPrompt: vi.fn(() => 'researcher prompt {{goal}} {{store_section}} {{evidence_section}} {{coordination_section}} {{extra_tool_guidelines}} {{digest_section}}'),
}));

vi.mock('../../../src/core/llm/inject-date.ts', () => ({
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

const { mockSearch } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
}));

vi.mock('../../../src/web-research/search.ts', () => ({
  search: mockSearch,
}));

// Hoisted session mock references
const { mockPrompt, mockAbort, mockSubscribe, mockRegister, mockUnregister, mockStoreReport, mockGetReport } = vi.hoisted(() => ({
  mockPrompt: vi.fn().mockResolvedValue(undefined),
  mockAbort: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn(() => vi.fn()), // returns unsubscribe fn
  mockRegister: vi.fn(),
  mockUnregister: vi.fn(),
  mockStoreReport: vi.fn(),
  mockGetReport: vi.fn(),
}));

vi.mock('../../../src/orchestration/researcher.ts', () => ({
  createResearcherSession: vi.fn((opts?: any) => {
    // Simulate one successful scrape so a researcher with the scrape tool enabled counts as
    // grounded — mirrors production, where the scrape tool drives onUrlScrapeResult. Without
    // this, the executor's grounding gate (scrape enabled + 0 successful scrapes) would fail
    // every success-path test. Skipped when scrape is excluded, so gate-specific tests can
    // exercise the ungrounded path by passing excludeTools: ['scrape'] or no scrape success.
    if (!opts?.excludeTools?.includes('scrape')) {
      opts?.onUrlScrapeResult?.('https://example.com/scraped', true);
    }
    return Promise.resolve({
      session: {
        prompt: mockPrompt,
        abort: mockAbort,
        subscribe: mockSubscribe,
      },
      resolvedModel: { id: 'test-model' } as any,
    });
  }),
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
    // The executor now consults the REAL session-state failure counts
    // (fast-stop self-check); failures recorded by earlier tests under the shared
    // 'test-session'/'test-research-id' ids must not leak across tests.
    resetAllPiSessions();
    mockPrompt.mockClear().mockResolvedValue(undefined);
    mockAbort.mockClear().mockResolvedValue(undefined);
    mockSubscribe.mockClear().mockReturnValue(vi.fn());
    mockRegister.mockClear();
    mockUnregister.mockClear();
    mockStoreReport.mockClear();
    // Mirror the real service: reading a report back returns the STORED body, which is the
    // report with its coverage digest already split off the head.
    mockGetReport.mockReset();
    mockGetReport.mockImplementation(() => mockStoreReport.mock.calls.at(-1)?.[2]);
    mockSearch.mockReset().mockResolvedValue([]);
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
          getReport: mockGetReport,
          appendSteeringGuidance: vi.fn((text) => text),
          ensureCitedLinks: vi.fn((_id, text) => text),
          appendMetadata: vi.fn((_text, _modelId) => _text),
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

  // ── No-initial-links retry (regression: this path used to bypass all retries) ──

  describe('no-initial-links search retry', () => {
    it('retries the search burst and proceeds once a retry returns links', async () => {
      mockSearch
        .mockResolvedValueOnce([{ query: 'query 1', results: [] }, { query: 'query 2', results: [] }])
        .mockResolvedValueOnce([{ query: 'query 1', results: [{ title: 't', url: 'https://found.example.com', content: 'c' }] }]);

      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [],
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 1, RESEARCHER_MAX_RETRY_DELAY_MS: 1 } as any,
      }));

      expect(mockSearch).toHaveBeenCalledTimes(2);
      expect(mockSearch).toHaveBeenCalledWith(DEFAULT_RESEARCHER_CONFIG.queries, expect.anything(), undefined, undefined, expect.anything());
      expect(mockPrompt).toHaveBeenCalledOnce();
    });

    it('records a researcher failure only after exhausting search retries', async () => {
      const onResearcherFailure = vi.fn();
      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [],
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 1, RESEARCHER_MAX_RETRY_DELAY_MS: 1 } as any,
        observer: { onResearcherFailure } as any,
      }));

      // maxLinkAttempts = RESEARCHER_MAX_RETRIES + 1 = 2 search attempts before giving up.
      expect(mockSearch).toHaveBeenCalledTimes(2);
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(onResearcherFailure).toHaveBeenCalledWith(DEFAULT_RESEARCHER_CONFIG.id, expect.any(String));
    });

    it('falls back to the researcher goal as the retry query when no queries are configured', async () => {
      mockSearch.mockResolvedValueOnce([{ query: 'g', results: [{ title: 't', url: 'https://found.example.com', content: 'c' }] }]);

      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [],
        config: { id: 'r1', name: 'R1', goal: 'fallback goal query', queries: [] },
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 0 } as any,
      }));

      expect(mockSearch).toHaveBeenCalledWith(['fallback goal query'], expect.anything(), undefined, undefined, expect.anything());
      expect(mockPrompt).toHaveBeenCalledOnce();
    });

    it('does not retry the search when a tolerant historicalUrls fallback already exists', async () => {
      await runResearcher(makeOptions({ initialLinks: [], historicalUrls: [{ url: 'https://x.com', description: 'd' }] }));
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockPrompt).toHaveBeenCalledOnce();
    });

    it('returns quietly — no failure record — when cancelled before initial links are acquired', async () => {
      // Regression: the link-retry loop breaks on signal.aborted, then fell into
      // the unconditional "no initial search results" failure record — painting a
      // red failed slice with a bogus root cause on a plain user cancel.
      const controller = new AbortController();
      controller.abort();
      const onResearcherFailure = vi.fn();

      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [],
        signal: controller.signal,
        observer: { onResearcherFailure } as any,
      }));

      expect(onResearcherFailure).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it('returns quietly when the container is disposing before initial links are acquired', async () => {
      const disposingCtx = { ...BASE_CTX, container: { isReady: true, isDisposing: true } };
      const onResearcherFailure = vi.fn();

      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [],
        ctx: disposingCtx as any,
        observer: { onResearcherFailure } as any,
      }));

      expect(onResearcherFailure).not.toHaveBeenCalled();
      expect(mockPrompt).not.toHaveBeenCalled();
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

    it('emits the STORED report body, not the raw model text', async () => {
      // storeReport splits the coverage digest off the head of the report. The SDK's
      // researcher_complete event must carry the same body the run works from — emitting
      // the raw text would leak routing metadata into every consumer of that event.
      mockGetReport.mockReturnValue('body without the digest');
      const onResearcherComplete = vi.fn();
      const config = { id: '2', name: 'R2', goal: 'g', queries: [] };
      await runResearcher(makeOptions({ config, observer: { onResearcherComplete } as any }));
      expect(onResearcherComplete).toHaveBeenCalledWith('2', 'body without the digest');
    });

    it('falls back to the raw text when the store has no body for that id', async () => {
      // Never emit `undefined` to an SDK consumer because a read missed.
      mockGetReport.mockReturnValue(undefined);
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

  // ── Timeout ─────────────────────────────────────────────────────────────────

  describe('researcher timeout', () => {
    it('times out even when the in-flight prompt AND session.abort() never settle', async () => {
      // Regression: the timeout used to reject only in session.abort().finally(),
      // so a hung abort (in-flight request stuck in a provider retry loop, e.g.
      // quota exhaustion) made the timeout ineffective and the researcher ran
      // forever. The rejection must fire unconditionally; cleanup's own await on
      // abort is bounded by a 10s grace.
      vi.useFakeTimers();
      try {
        mockPrompt.mockImplementation(() => new Promise(() => { /* never settles */ }));
        mockAbort.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));

        const run = runResearcher(makeOptions({
          researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 0 } as any,
        }));
        const expectation = expect(run).rejects.toThrow(/timed out after/);

        // Fire the researcher timeout, then the bounded abort-settle grace in cleanup.
        await vi.advanceTimersByTimeAsync(SYSTEM_CONFIG.RESEARCHER_TIMEOUT_MS + 1);
        await vi.advanceTimersByTimeAsync(10_001);

        await expectation;
        expect(mockAbort).toHaveBeenCalled();
        expect(mockUnregister).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Grounding gate ──────────────────────────────────────────────────────────

  describe('grounding gate (scrape enabled, zero successful scrapes)', () => {
    /** A session override that never reports a successful scrape. */
    async function stubUngroundedSession() {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      // mockImplementationOnce (not mockImplementation): reverts to the default scrape-firing
      // mock after this single call, so the override cannot leak into later tests.
      vi.mocked(createResearcherSession).mockImplementationOnce(() => Promise.resolve({
        session: { prompt: mockPrompt, abort: mockAbort, subscribe: mockSubscribe } as any,
        resolvedModel: { id: 'test-model' } as any,
      }));
    }

    it('throws and stores nothing when scrape is enabled but no scrape succeeds and there is no knowledge-store grounding', async () => {
      await stubUngroundedSession();
      await expect(runResearcher(makeOptions({
        initialLinks: ['https://example.com/a'],
        historicalUrls: [],
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 0 } as any,
      }))).rejects.toThrow(/ungrounded/i);
      expect(mockStoreReport).not.toHaveBeenCalled();
    });

    it('stands down and completes normally when scrape is DISABLED for the researcher', async () => {
      // Scrape excluded → the mock fires no scrape AND scrapeEnabled is false, so the gate
      // must not fire even with zero scrapes.
      await runResearcher(makeOptions({ excludeTools: ['scrape'] }));
      expect(mockStoreReport).toHaveBeenCalledOnce();
    });

    it('suppresses the gate in mock-scrape mode (PI_RESEARCH_MOCK_SCRAPE=true) so a mock run completes', async () => {
      // FULL_MOCK_MODE mocks the scrape worker to return a short stub that never counts as
      // real grounding. The gate guards REAL ungrounded research, so it must stand down when
      // scrape is mocked — otherwise it fails EVERY researcher in mock mode (the documented
      // "4-word scrape stub" bug). Identical ungrounded setup to the throwing test above,
      // only with the mock flag set: it must now complete instead of throwing.
      const prev = process.env['PI_RESEARCH_MOCK_SCRAPE'];
      process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
      try {
        await stubUngroundedSession();
        await runResearcher(makeOptions({
          initialLinks: ['https://example.com/a'],
          historicalUrls: [],
          researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 0 } as any,
        }));
        expect(mockStoreReport).toHaveBeenCalledOnce();
      } finally {
        if (prev === undefined) delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
        else process.env['PI_RESEARCH_MOCK_SCRAPE'] = prev;
      }
    });

    it('completes when grounded by knowledge-store URLs despite zero scrapes', async () => {
      await stubUngroundedSession();
      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [{ url: 'https://kb.example.com', description: 'prior summary' }],
      }));
      expect(mockStoreReport).toHaveBeenCalledOnce();
    });

    /**
     * Override the session so it (a) reports zero scrapes and (b) emits a single
     * tool_execution_end event carrying the given details on subscribe — the channel by which
     * the non-URL grounding tools (security_search, stackexchange) report grounding hits.
     */
    async function stubSessionEmittingToolEnd(event: Record<string, unknown>) {
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      const subscribeEmitting = vi.fn((handler: (e: any) => void) => {
        handler(event);
        return vi.fn();
      });
      vi.mocked(createResearcherSession).mockImplementationOnce(() => Promise.resolve({
        session: { prompt: mockPrompt, abort: mockAbort, subscribe: subscribeEmitting } as any,
        resolvedModel: { id: 'test-model' } as any,
      }));
    }

    it('completes when grounded by security_search hits despite zero scrapes', async () => {
      await stubSessionEmittingToolEnd({
        type: 'tool_execution_end', toolName: 'security_search', isError: false,
        result: { details: { groundingHits: 4 } },
      });
      await runResearcher(makeOptions({ initialLinks: ['https://example.com/a'], historicalUrls: [] }));
      expect(mockStoreReport).toHaveBeenCalledOnce();
    });

    it('completes when grounded by stackexchange hits despite zero scrapes', async () => {
      await stubSessionEmittingToolEnd({
        type: 'tool_execution_end', toolName: 'stackexchange', isError: false,
        result: { details: { groundingHits: 2 } },
      });
      await runResearcher(makeOptions({ initialLinks: ['https://example.com/a'], historicalUrls: [] }));
      expect(mockStoreReport).toHaveBeenCalledOnce();
    });

    it('stays ungrounded when a grounding tool returns zero hits (e.g. no vulnerabilities found)', async () => {
      await stubSessionEmittingToolEnd({
        type: 'tool_execution_end', toolName: 'security_search', isError: false,
        result: { details: { groundingHits: 0 } },
      });
      await expect(runResearcher(makeOptions({
        initialLinks: ['https://example.com/a'], historicalUrls: [],
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 0 } as any,
      }))).rejects.toThrow(/ungrounded/i);
      expect(mockStoreReport).not.toHaveBeenCalled();
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

    it('asks a DEEP researcher for a coverage digest, leaving no placeholder behind', async () => {
      // The digest is the router's only view of the run. A researcher that is never asked
      // for one produces a report the router can only read a derived stub of — routing
      // quality degrades silently, and an unreplaced {{digest_section}} would ship the
      // literal placeholder into the system prompt.
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      await runResearcher(makeOptions());
      const sessionCall = vi.mocked(createResearcherSession).mock.calls[0]![0] as any;
      expect(sessionCall.systemPrompt).toContain('COVERAGE DIGEST');
      expect(sessionCall.systemPrompt).toContain('END COVERAGE DIGEST');
      expect(sessionCall.systemPrompt).not.toContain('{{digest_section}}');
    });

    it('renders the SHIPPED researcher.md with no placeholder left behind', async () => {
      // Every other test here feeds loadPrompt a stub listing the placeholders the code
      // already knows about, so a `{{placeholder}}` added to src/prompts/researcher.md and
      // never wired into the replace chain is invisible: nothing throws, and the literal
      // braces are sent to the model as an instruction it cannot act on. The named
      // assertion above catches exactly one placeholder, by name — which is how
      // `{{digest_section}}` came to need wiring in two separate call sites.
      const real = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/prompts/researcher.md'),
        'utf-8',
      );
      const PLACEHOLDER = /\{\{[a-z_0-9]+\}\}/gi;
      expect(real.match(PLACEHOLDER)?.length ?? 0).toBeGreaterThan(0); // it really is a template
      vi.mocked(loadPrompt).mockReturnValueOnce(real);

      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      await runResearcher(makeOptions());

      const sessionCall = vi.mocked(createResearcherSession).mock.calls.at(-1)![0] as any;
      expect(sessionCall.systemPrompt.match(PLACEHOLDER) ?? []).toEqual([]);
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

    it('does NOT retry when the service container is disposing (quit/SIGTERM mid-run)', async () => {
      // Regression: a quit mid-run disposes services; the researcher's next getService throws
      // "…during container disposal". Retrying is futile and relaunches search bursts into a
      // WorkerPool that dispose() is destroying ("Cannot execute a task on destroying pool").
      mockPrompt.mockRejectedValue(new Error('transient failure'));
      const disposingCtx = { ...BASE_CTX, container: { isReady: true, isDisposing: true } };

      await expect(runResearcher(makeOptions({
        ctx: disposingCtx as any,
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 2 } as any,
      }))).rejects.toThrow('transient failure');

      // Exactly one attempt — the disposal guard breaks the loop instead of retrying.
      expect(mockPrompt).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a failure the account cannot retry its way out of', async () => {
      // The predicate is unit-tested separately, but nothing asserted the retry loop
      // consulted it — deleting the guard left both files green and restored the
      // five-runs-lost-to-credit-exhaustion regression: 30 retried attempts across two
      // days, 0 of 10 episodes recovered, each run ending with no output after paying
      // for a search burst and a synthesis call over an empty corpus.
      mockPrompt.mockRejectedValue(new Error('402 This request requires more credits, or fewer max_tokens'));

      await expect(runResearcher(makeOptions({
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 2 } as any,
      }))).rejects.toThrow('requires more credits');

      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(vi.mocked(metrics.increment).mock.calls.map(c => c[0]))
        .toContain('researcher_unretriable_total');
    });

    it('still retries the transient failures that usually recover', async () => {
      // The classifier has to stay narrow. "produced no text output" recovered 26 of 26
      // times in the retained logs, and a reasoning-effort rejection about 18 of 19 —
      // OpenRouter routes the same model to different upstream providers per request,
      // so the same call succeeds on a later attempt. Treating either as permanent
      // would break runs that currently succeed.
      mockPrompt
        .mockRejectedValueOnce(new Error('Researcher produced no text output'))
        .mockResolvedValueOnce(undefined);

      await expect(runResearcher(makeOptions({
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 2 } as any,
      }))).resolves.toBeUndefined();

      expect(mockPrompt).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry when the failure is a container-disposal error', async () => {
      mockPrompt.mockRejectedValue(new Error("Cannot get service 'x' during container disposal"));

      await expect(runResearcher(makeOptions({
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 2 } as any,
      }))).rejects.toThrow('during container disposal');

      expect(mockPrompt).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry the id-prefixed Aborted sentinel from an externally-aborted session', async () => {
      // Regression (fast-stop zombie retry): when the failure threshold trips,
      // abortAllSessions() aborts the surviving researcher EXTERNALLY — its
      // prompt() then resolves normally and ensureAssistantResponse throws the
      // '<id>: Aborted' sentinel (NOT the race's bare 'Aborted', and neither
      // signal nor container reflects the stop). The exact-equality guard missed
      // that form and retried: fresh session, fresh search/scrape burst, session
      // re-registered after cleanup already ran.
      const { ensureAssistantResponse } = await import('../../../src/utils/text-utils.ts');
      const mockEnsure = vi.mocked(ensureAssistantResponse);
      mockEnsure.mockImplementation(() => { throw new Error(`${DEFAULT_RESEARCHER_CONFIG.id}: Aborted`); });
      try {
        await expect(runResearcher(makeOptions({
          researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 2 } as any,
        }))).rejects.toThrow('1: Aborted');

        // Exactly one attempt — the sentinel guard breaks the loop instead of retrying.
        expect(mockPrompt).toHaveBeenCalledTimes(1);
      } finally {
        // Module-level mock — restore the default so later tests keep their report.
        mockEnsure.mockImplementation(() => 'mock researcher report content');
      }
    });

    it('does not record a clean cancellation as an error in metrics', async () => {
      // Regression: the catch block used to unconditionally observe
      // status:'error' and increment researcher_errors_total BEFORE the
      // torn-down classification a few lines later — so every cancelled
      // researcher inflated error metrics despite the retry-skip logic
      // correctly treating it as "not a failure."
      vi.mocked(metrics.increment).mockClear();
      vi.mocked(metrics.observe).mockClear();
      mockPrompt.mockRejectedValue(new Error("Cannot get service 'x' during container disposal"));

      await expect(runResearcher(makeOptions({
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 2 } as any,
      }))).rejects.toThrow('during container disposal');

      const latencyCall = vi.mocked(metrics.observe).mock.calls.find(([name]) => name === 'researcher_execution_latency_ms');
      expect(latencyCall?.[2]).toMatchObject({ status: 'cancelled' });
      expect(vi.mocked(metrics.increment)).not.toHaveBeenCalledWith('researcher_errors_total', expect.anything(), expect.anything());
    });

    it('routes researcher usage through recordLlmUsage — warnIfUnpriced fires for a $0 model', async () => {
      // Regression: the message_end usage block hand-copied extract→increment→emit
      // instead of calling recordLlmUsage, so warnIfUnpriced never ran for
      // researcher usage. On depth-0 runs (no coordinator) that made a
      // misconfigured price table silently report $0.0000 with no diagnostic.
      vi.mocked(metrics.increment).mockClear();
      const { logger } = await import('../../../src/logger.ts');
      vi.mocked(logger.warn).mockClear();

      let subscriber: ((event: any) => void) | undefined;
      mockSubscribe.mockImplementation(((cb: (event: any) => void) => {
        subscriber = cb;
        return vi.fn();
      }) as any);
      mockPrompt.mockImplementation(async () => {
        subscriber?.({
          type: 'message_end',
          message: { role: 'assistant', usage: { input: 100, output: 50 } },
        });
      });

      await runResearcher(makeOptions());

      // The unified path recorded the tokens under the researcher component…
      expect(vi.mocked(metrics.increment)).toHaveBeenCalledWith(
        'llm_tokens_total', 150, { component: 'researcher', complexity: '1' });
      // …and the unpriced-model warning fired (STUB_MODEL has no price table).
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.stringContaining('price table is all zeros'));
    });

    it('still records a genuine (non-cancelled) failure as an error in metrics', async () => {
      vi.mocked(metrics.increment).mockClear();
      vi.mocked(metrics.observe).mockClear();
      mockPrompt.mockRejectedValue(new Error('genuine transient failure'));

      await expect(runResearcher(makeOptions({
        researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 0 } as any,
      }))).rejects.toThrow('genuine transient failure');

      const latencyCall = vi.mocked(metrics.observe).mock.calls.find(([name]) => name === 'researcher_execution_latency_ms');
      expect(latencyCall?.[2]).toMatchObject({ status: 'error' });
      expect(vi.mocked(metrics.increment)).toHaveBeenCalledWith('researcher_errors_total', 1, expect.anything());
    });
  });

  // ── Fast-stop self-check (regression: zombie researchers) ───────────────────

  describe('fast-stop self-check', () => {
    // Regression: when the run's failure threshold trips, the fast-stop path in
    // runResearchers aborts only REGISTERED sessions — a researcher still between
    // attempts or acquiring initial links has none, and used to proceed into a
    // full LLM session + scrape burst AFTER the run had already returned and
    // released its run-cap slot. The executor must now self-stop at every
    // launch/retry boundary.

    function crossThreshold() {
      // DEFAULT_MAX_FAILED_RESEARCHERS = 2 unique failed researchers.
      recordResearcherFailure('test-session', 'test-research-id', 'failed-a', 'boom');
      recordResearcherFailure('test-session', 'test-research-id', 'failed-b', 'boom');
    }

    it('exits before building a session when the threshold is already crossed', async () => {
      crossThreshold();
      const onResearcherFailure = vi.fn();

      await expect(runResearcher(makeOptions({ observer: { onResearcherFailure } as any })))
        .resolves.toBeUndefined();

      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      expect(vi.mocked(createResearcherSession)).not.toHaveBeenCalled();
      expect(mockPrompt).not.toHaveBeenCalled();
      // A self-stop is the run's outcome, not this researcher's failure.
      expect(onResearcherFailure).not.toHaveBeenCalled();
    });

    it('returns quietly from the initial-links search loop when the threshold is crossed', async () => {
      crossThreshold();
      const onResearcherFailure = vi.fn();

      await runResearcher(makeOptions({
        initialLinks: [],
        historicalUrls: [],
        observer: { onResearcherFailure } as any,
      }));

      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(onResearcherFailure).not.toHaveBeenCalled();
    });

    it('does not build a new session when the threshold is crossed during the retry backoff', async () => {
      // THE zombie scenario: attempt 1 fails, the researcher sleeps its backoff,
      // and the fast-stop trips meanwhile (its session set is empty, so
      // abortAllSessions cannot reach it). On wake it must exit, not relaunch.
      vi.useFakeTimers();
      try {
        mockPrompt.mockRejectedValueOnce(new Error('transient failure'));
        const run = runResearcher(makeOptions({
          researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 1, RESEARCHER_MAX_RETRY_DELAY_MS: 100 } as any,
        }));

        await vi.advanceTimersByTimeAsync(0); // attempt 1 fails; backoff sleep armed
        crossThreshold();                     // threshold crossed mid-sleep
        await vi.advanceTimersByTimeAsync(1_000); // backoff elapses

        await expect(run).resolves.toBeUndefined();
        expect(mockPrompt).toHaveBeenCalledTimes(1); // no second (billed) attempt
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not prompt when the threshold crosses in the window between session creation and registration', async () => {
      // THE gap the other three checkpoints (top-of-loop, initial-links loop,
      // post-backoff) do not cover: createResearcherSession() has just resolved
      // but the session is not registered yet (registerSession runs after an
      // `await getService(...)`), so abortAllSessions()'s point-in-time scan
      // cannot reach it. Simulate the threshold tripping inside that async gap
      // by crossing it from within the session-creation mock itself — by the
      // time control returns to runResearcher, the stop has already happened
      // and nothing has checked it yet.
      const { createResearcherSession } = await import('../../../src/orchestration/researcher.ts');
      vi.mocked(createResearcherSession).mockImplementationOnce(async (opts?: any) => {
        crossThreshold();
        if (!opts?.excludeTools?.includes('scrape')) {
          opts?.onUrlScrapeResult?.('https://example.com/scraped', true);
        }
        return {
          session: { prompt: mockPrompt, abort: mockAbort, subscribe: mockSubscribe } as any,
          resolvedModel: { id: 'test-model' } as any,
        };
      });

      await expect(runResearcher(makeOptions())).resolves.toBeUndefined();

      // The billed session prompt must never fire once the run has decided to stop.
      expect(mockPrompt).not.toHaveBeenCalled();
      // The session was registered (creation succeeded before the check) and must
      // be cleanly aborted and unregistered rather than left to run unsupervised.
      expect(mockRegister).toHaveBeenCalled();
      expect(mockAbort).toHaveBeenCalled();
      expect(mockUnregister).toHaveBeenCalled();
    });
  });

  // ── Abort signal ────────────────────────────────────────────────────────────

  describe('abort signal', () => {
    it('does not re-enter a billed attempt when cancel lands during the inter-attempt backoff', async () => {
      // Regression: the backoff sleep was a bare setTimeout — a cancel during it
      // was ignored and the loop re-entered a full attempt (fresh session +
      // billed prompt) that only then lost the abort race.
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        mockPrompt.mockRejectedValueOnce(new Error('transient failure'));
        const outcome = runResearcher(makeOptions({
          signal: controller.signal,
          researchConfig: { ...SYSTEM_CONFIG, RESEARCHER_MAX_RETRIES: 1, RESEARCHER_MAX_RETRY_DELAY_MS: 60_000 } as any,
        })).then(() => 'resolved', (e: Error) => `rejected: ${e.message}`);

        await vi.advanceTimersByTimeAsync(0); // attempt 1 fails; backoff sleep armed
        controller.abort();                   // lands during the sleep
        await vi.advanceTimersByTimeAsync(2_000); // pre-fix: sleep elapses, attempt 2 launches

        // The abort sentinel keeps runResearchers' clean-cancel classification.
        expect(await outcome).toBe('rejected: Aborted');
        expect(mockPrompt).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

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
