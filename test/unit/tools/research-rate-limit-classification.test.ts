/**
 * research tool — run-failure rate-limit classification
 *
 * The outer catch of the research tool reports a graceful "halted due to rate
 * limit" message when the error looks like a provider throttle. "429" must match
 * on a word boundary (mirroring messageIsTransient in web-research/retry-utils.ts):
 * a plain substring test also matched digits embedded in larger numbers — e.g. a
 * context-overflow error quoting "you requested 142935 tokens" — misreporting the
 * run as rate-limited and telling the user to simply wait and retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTool } from '../../../src/tools/research-tool-definition.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { getService } from '../../../src/core/service-registry.ts';

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
    recordRunSummary: vi.fn(),
  },
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
  getPiActivePanels: vi.fn(() => []),
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

describe('research tool — rate-limit classification of run failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies a standalone 429 status as a rate limit (graceful halt message)', async () => {
    mockRunResearchRejection(new Error('Request failed with status code 429'));

    const tool = createResearchTool();
    const result = await tool.execute('call-1', { query: 'test' }, undefined, () => {}, makeCtx());
    const text = (result.content[0] as any).text as string;

    expect(text).toContain('halted gracefully');
    expect(text).toContain('rate limit');
  });

  it('does NOT classify a context-overflow error quoting a token count containing "429" as a rate limit', async () => {
    mockRunResearchRejection(new Error("This model's maximum context length is 131072 tokens, however you requested 142935 tokens"));

    const tool = createResearchTool();
    const result = await tool.execute('call-1', { query: 'test' }, undefined, () => {}, makeCtx());
    const text = (result.content[0] as any).text as string;

    expect(text).toContain('Research failed:');
    expect(text).toContain('142935 tokens');
    expect(text.toLowerCase()).not.toContain('rate limit');
  });

  it('still classifies provider quota wording as a rate limit', async () => {
    mockRunResearchRejection(new Error('insufficient_quota: You exceeded your current quota'));

    const tool = createResearchTool();
    const result = await tool.execute('call-1', { query: 'test' }, undefined, () => {}, makeCtx());
    const text = (result.content[0] as any).text as string;

    expect(text).toContain('halted gracefully');
  });
});
