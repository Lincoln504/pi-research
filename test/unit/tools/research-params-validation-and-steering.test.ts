/**
 * research tool — own-schema parameter validation, and headless teardown.
 *
 * Regression 1: unlike every sibling tool (search, scrape, security_search,
 * stackexchange, youtube_transcript, research_knowledge_search), the `research`
 * tool's execute() cast `params as ResearchParams` with no runtime Value.Check —
 * a malformed tool call (e.g. a non-string query from a weak model or a
 * non-schema-respecting SDK caller) reached orch.runResearch() relying entirely
 * on incidental downstream checks instead of a guaranteed up-front rejection.
 *
 * Regression 2 (historical, now superseded): the headless cleanup() closure
 * used to call clearSteeringMessages(piSessionId) unconditionally, AFTER
 * teardownUi() had already made its own (headless-blind) decision about
 * whether to clear. That was fixed by adding a getActiveResearchRunCount-gated
 * check in teardownUi — which itself turned out to race two sibling runs
 * finishing close together, and later (once reordered to close that race) to
 * fight with endResearchSession's own preserve-on-last-run logic and wipe a
 * message endResearchSession had just decided to keep. The actual fix now
 * lives entirely in endResearchSession (session-state.ts), which deregisters
 * this run and decides last-run/preserve atomically in one synchronous call;
 * teardownUi no longer duplicates any of that decision. See
 * test/unit/utils/session-state.test.ts for the behavioral coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTool } from '../../../src/tools/research-tool-definition.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { endResearchSession } from '../../../src/orchestration/session-state.ts';

vi.mock('../../../src/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config.ts')>();
  return {
    ...actual,
    getConfig: vi.fn(() => ({
      ...actual.DEFAULTS,
      RESEARCH_MODEL: 'test-model',
    })),
    validateConfig: vi.fn(),
  };
});

vi.mock('../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({ isReady: true })),
  getService: vi.fn(),
  tryGetServiceContainerFromCtx: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
}));

vi.mock('../../../src/logger.ts', () => {
  const logger = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    runCapturingStderr: vi.fn(async (fn: any) => await fn()),
  };
  return {
    logger,
    createLogger: () => logger,
    createResearchRunId: () => 'test-run-id',
    isVerboseFromEnv: () => false,
    runWithLogger: (l: any, fn: any) => fn(),
  };
});

vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: {
    increment: vi.fn(),
    recordRunSummary: vi.fn(), session: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() }, },
  MetricsRegistry: class {
    getSnapshot = vi.fn(() => ({ counters: {}, histograms: {} }));
  },
  runWithRunRegistry: vi.fn(async (_registry, fn) => await fn()),
}));

vi.mock('../../../src/utils/research-export.ts', () => ({
  exportResearchReport: vi.fn().mockResolvedValue(null),
  appendExportMessage: vi.fn((res: any) => res),
}));

vi.mock('../../../src/tui/research-tui-manager.ts', () => ({
  createResearchTuiManager: vi.fn(),
  hideWorkingIndicator: vi.fn(),
}));

vi.mock('../../../src/tui/research-health.ts', () => ({
  ensureFunctionalHealth: vi.fn().mockResolvedValue(true),
  createHealthMonitor: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock('../../../src/utils/input-validation.ts', () => ({
  validateAndSanitizeQuery: vi.fn((q) => q),
}));

vi.mock('../../../src/orchestration/session-state.ts', () => ({
  startResearchSession: vi.fn(() => 'session-123'),
  endResearchSession: vi.fn(),
  registerSessionAbort: vi.fn(),
}));

vi.mock('../../../src/observers/research-observer-impl.ts', () => ({
  createResearchObserver: vi.fn(),
  createObserverState: vi.fn(),
  stopObserverWaveAnimation: vi.fn(),
}));

vi.mock('../../../src/cleanup/research-cleanup.ts', () => ({
  createCleanupFunction: vi.fn(() => vi.fn()),
  updateUnsubOrder: vi.fn(),
}));

vi.mock('../../../src/utils/error-tracker.ts', () => ({
  runWithTracker: vi.fn(async (_tracker, fn) => await fn()),
  ErrorTracker: class {
    getReport = vi.fn(() => ({ totalErrors: 0 }));
  },
}));

function makeCtx(): any {
  return {
    model: { id: 'test-model' },
    modelRegistry: { getAll: () => [{ id: 'test-model' }] },
    cwd: '/tmp',
  };
}

function mockRunResearchRejection(error: Error): void {
  vi.mocked(getService).mockImplementation(async (name) => {
    if (name === ServiceNames.RESEARCH_ORCHESTRATION) {
      return {
        runResearch: vi.fn().mockRejectedValue(error),
        resolveResearchModel: vi.fn().mockResolvedValue({ id: 'test-model', provider: 'test', contextWindow: 128000 }),
      } as any;
    }
    if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) {
      return { appendMetadata: vi.fn((result: string) => result) } as any;
    }
    return null;
  });
}

describe('research tool — own parameter schema validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a non-string query without ever calling the orchestrator', async () => {
    const tool = createResearchTool();
    const result = await tool.execute('call-1', { query: 12345 as unknown as string }, undefined, () => {}, makeCtx());

    expect(result.details).toMatchObject({ error: 'invalid_parameters' });
    expect(getService).not.toHaveBeenCalled();
  });

  it('rejects a non-array excludeTools without ever calling the orchestrator', async () => {
    const tool = createResearchTool();
    const result = await tool.execute(
      'call-1',
      { query: 'test', excludeTools: 'search' as unknown as string[] },
      undefined,
      () => {},
      makeCtx()
    );

    expect(result.details).toMatchObject({ error: 'invalid_parameters' });
    expect(getService).not.toHaveBeenCalled();
  });

  it('still accepts a well-formed call (schema check is not over-strict)', async () => {
    mockRunResearchRejection(new Error('irrelevant failure, just proving we got past validation'));

    const tool = createResearchTool();
    const result = await tool.execute('call-1', { query: 'test query' }, undefined, () => {}, makeCtx());

    expect(result.details).not.toMatchObject({ error: 'invalid_parameters' });
    expect(getService).toHaveBeenCalled();
  });
});

describe('research tool — headless teardown deregisters via endResearchSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls endResearchSession exactly once on teardown, and does not import a separate steering-clear guard', async () => {
    // Regression (structural half): an earlier version of this fix added a
    // SEPARATE getActiveResearchRunCount/clearSteeringMessages check in
    // teardownUi, checked after cleanup(). That interacted badly with
    // endResearchSession's own last-run/preserve logic (see session-state.ts
    // and its tests for the real behavioral coverage): it could unconditionally
    // wipe a steering message endResearchSession had just decided to preserve.
    // The fix is for endResearchSession alone (a single synchronous function)
    // to own this decision — teardownUi must not duplicate it. This is a
    // deliberately narrow, structural guard against reintroducing that second
    // check; it doesn't re-derive the state-mutation behavior itself.
    mockRunResearchRejection(new Error('run failure, unrelated to steering'));

    const tool = createResearchTool();
    await tool.execute('call-1', { query: 'test' }, undefined, () => {}, makeCtx());

    expect(endResearchSession).toHaveBeenCalledTimes(1);
  });
});
