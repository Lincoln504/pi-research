/**
 * research tool — own-schema parameter validation, and headless steering-clear
 * concurrency guard.
 *
 * Regression 1: unlike every sibling tool (search, scrape, security_search,
 * stackexchange, youtube_transcript, research_knowledge_search), the `research`
 * tool's execute() cast `params as ResearchParams` with no runtime Value.Check —
 * a malformed tool call (e.g. a non-string query from a weak model or a
 * non-schema-respecting SDK caller) reached orch.runResearch() relying entirely
 * on incidental downstream checks instead of a guaranteed up-front rejection.
 *
 * Regression 2: the headless cleanup() closure used to call
 * clearSteeringMessages(piSessionId) unconditionally, AFTER teardownUi() had
 * already made its own (headless-blind, since getPiActivePanels never sees a
 * headless run) decision about whether to clear. A finishing headless run could
 * wipe a concurrent sibling headless run's queued/active steering with no error
 * or indication to either caller. getActiveResearchRunCount (backed by the
 * `aborts` map, populated by BOTH the TUI and headless branches) fixes the
 * blind guard; removing the second unconditional clear closes the bypass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTool } from '../../../src/tools/research-tool-definition.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { clearSteeringMessages, getActiveResearchRunCount } from '../../../src/orchestration/session-state.ts';

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
  clearSteeringMessages: vi.fn(),
  getActiveResearchRunCount: vi.fn(() => 0),
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

describe('research tool — headless steering-clear concurrency guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT clear steering when another run is still active in the session', async () => {
    vi.mocked(getActiveResearchRunCount).mockReturnValue(2);
    mockRunResearchRejection(new Error('run failure, unrelated to steering'));

    const tool = createResearchTool();
    await tool.execute('call-1', { query: 'test' }, undefined, () => {}, makeCtx());

    expect(clearSteeringMessages).not.toHaveBeenCalled();
  });

  it('clears steering exactly once when this is the last active run', async () => {
    vi.mocked(getActiveResearchRunCount).mockReturnValue(1);
    mockRunResearchRejection(new Error('run failure, unrelated to steering'));

    const tool = createResearchTool();
    await tool.execute('call-1', { query: 'test' }, undefined, () => {}, makeCtx());

    // Pre-fix this was 2: once from teardownUi's own guarded call, once more
    // unconditionally from inside the headless cleanup() closure.
    expect(clearSteeringMessages).toHaveBeenCalledTimes(1);
  });
});
