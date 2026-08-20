/**
 * research tool — cancellation reporting on the resolves-normally path
 *
 * Regression: DeepResearchOrchestrator.run() does not throw on cancellation once
 * at least one researcher has produced a report — it returns a fallback synthesis
 * through its normal return path (see deep-research-orchestrator.ts's
 * synthesisService.hasReports branch). The tool's own try/catch only checked the
 * abort signal inside its catch block, so a cancellation that resolved normally
 * fell straight through to the unconditional success handling: metrics recorded
 * status 'success', and the returned text carried no indication it was a partial
 * report — the only channel the calling agent (an AgentToolResult consumer only
 * ever sees `content[].text`; `details` is logs/UI-only) has to learn the run was
 * cancelled. This mirrors the identical bug class the v1.3.0 CLI fix addressed for
 * cmdResearch, at a different call site (research-tool-definition.ts, not cli.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTool } from '../../../src/tools/research-tool-definition.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { getService } from '../../../src/core/service-registry.ts';
import { metrics } from '../../../src/utils/metrics.ts';

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

/** Mocks orch.runResearch to RESOLVE normally, mirroring the orchestrator's own
 *  fallback-synthesis-on-cancel contract (no throw once a report exists). */
function mockRunResearchResolution(partialReport: string): void {
  vi.mocked(getService).mockImplementation(async (name) => {
    if (name === ServiceNames.RESEARCH_ORCHESTRATION) {
      return {
        runResearch: vi.fn().mockResolvedValue(partialReport),
        resolveResearchModel: vi.fn().mockResolvedValue({ id: 'test-model', provider: 'test', contextWindow: 128000 }),
      } as any;
    }
    if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) {
      return { appendMetadata: vi.fn((result: string) => result) } as any;
    }
    return null;
  });
}

describe('research tool — cancellation reporting when the orchestrator resolves normally', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags a cancelled-but-partial run in the report text, the details, and the metrics status', async () => {
    mockRunResearchResolution('## Partial findings\n\nWhatever was collected before the stop.');

    const controller = new AbortController();
    controller.abort();

    const tool = createResearchTool();
    const result = await tool.execute('call-1', { query: 'test' }, controller.signal, () => {}, makeCtx());
    const text = (result.content[0] as any).text as string;

    // The calling agent only ever sees content[].text — the cancellation must be
    // legible there, not just in details/metrics that the agent never reads.
    expect(text).toContain('cancelled');
    expect(text).toContain('Whatever was collected before the stop.');
    expect((result.details as any).cancelled).toBe(true);

    const recordedStatus = vi.mocked(metrics.recordRunSummary).mock.calls[0]?.[0]?.status;
    expect(recordedStatus).toBe('cancelled');
  });

  it('does not flag or annotate an ordinary, uncancelled run', async () => {
    mockRunResearchResolution('## Complete findings\n\nEverything collected.');

    const tool = createResearchTool();
    const result = await tool.execute('call-1', { query: 'test' }, undefined, () => {}, makeCtx());
    const text = (result.content[0] as any).text as string;

    expect(text).not.toContain('cancelled');
    expect((result.details as any).cancelled).toBeUndefined();

    const recordedStatus = vi.mocked(metrics.recordRunSummary).mock.calls[0]?.[0]?.status;
    expect(recordedStatus).toBe('success');
  });
});
