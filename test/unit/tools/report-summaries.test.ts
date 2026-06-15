import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTool } from '../../../src/tools/research-tool-definition.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { getService } from '../../../src/core/service-registry.ts';

// Mock config
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

// Mock dependencies
vi.mock('../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({ isReady: true })),
  getService: vi.fn(async (name: any, _ctx?: any, _container?: any) => {
    if (name === ServiceNames.RESEARCH_ORCHESTRATION) {
      return {
        runResearch: vi.fn().mockResolvedValue('Research report content'),
        resolveResearchModel: vi.fn().mockResolvedValue({ id: 'test-model', provider: 'test', contextWindow: 128000 }),
        cleanupResearchServices: vi.fn(),
      };
    }
    if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) {
        return {
            appendMetadata: vi.fn((res, modelId) => `${res}\n\n*Research performed using ${modelId}*`),
        };
    }
    return undefined;
  }),
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
    getSnapshot = vi.fn(() => ({
      counters: {
        'scrape_results_total{outcome="fetch_success"}': 1,
        'scrape_results_total{outcome="browser_success"}': 1,
        'researchers_launched_total{mode="deep",complexity="1",round="1"}': 2,
        'browser_search_queries_total': 3,
        'llm_tokens_total{component="researcher",complexity="1"}': 5000,
      },
      histograms: {
        'research_session_duration_ms{mode="deep",complexity="1",status="success"}': {
          count: 1, min: 12000, max: 12000, avg: 12000, p99: 12000,
        },
      },
    }));
  },
  runWithRunRegistry: vi.fn(async (_registry, fn) => await fn()),
}));

vi.mock('../../../src/utils/research-export.ts', () => ({
  exportResearchReport: vi.fn().mockResolvedValue('/path/to/report.md'),
  appendExportMessage: vi.fn((res: any) => res),
}));

vi.mock('../../../src/tui/research-tui-manager.ts', () => ({
  createResearchTuiManager: vi.fn(() => ({
    initializePanel: vi.fn(),
    debouncedRefresh: vi.fn(),
    dispose: vi.fn(),
    panelState: { totalCost: 0, totalTokens: 100 },
    masterWidgetId: 'test-widget',
    unsubOrder: [],
  })),
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

describe('Research Tool - Report Summaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getService).mockImplementation(async (name) => {
      if (name === ServiceNames.RESEARCH_ORCHESTRATION) {
        return {
          runResearch: vi.fn().mockResolvedValue('Research result'),
          resolveResearchModel: vi.fn().mockResolvedValue({ id: 'test-model', provider: 'test', contextWindow: 128000 }),
        } as any;
      }
      if (name === ServiceNames.RESEARCH_SYNTHESIS_SERVICE) {
        return {
          appendMetadata: vi.fn((result: string) => result),
        } as any;
      }
      return null;
    });
  });

  it('includes research summary with stats when research was performed', async () => {
    const tool = createResearchTool();
    const ctx = {
      model: { id: 'test-model' },
      modelRegistry: { getAll: () => [{ id: 'test-model' }] },
      cwd: '/tmp',
    } as any;

    const result = await tool.execute('call-1', { query: 'test' }, undefined, () => {}, ctx);
    
    const text = (result.content[0] as any).text;
    // The new simplified summary format — work line + resource line + optional error footnote
    expect(text).toContain('### Research Summary');
    expect(text).toContain('**2** researchers');
    expect(text).toContain('**3** searches');
    expect(text).toContain('**2** sources analyzed');
    // Duration and tokens
    expect(text).toContain('**5,000** tokens');
    expect(text).toContain('**12.0s**');
    // No percentage symbols should appear
    expect(text).not.toMatch(/\d+%/);
    // No table formatting
    expect(text).not.toContain('|');
    // Scrape tier breakdown (fetch=1, browser=1 in mock)
    expect(text).toContain('1 fetch');
    expect(text).toContain('1 browser');
    // Fallback count is not surfaced (internal detail)
    expect(text).not.toContain('fallback');
  });

  it('does not include percentages, table formatting, or internal scrape details', async () => {
    const tool = createResearchTool();
    const ctx = {
      model: { id: 'test-model' },
      modelRegistry: { getAll: () => [{ id: 'test-model' }] },
      cwd: '/tmp',
    } as any;

    const result = await tool.execute('call-1', { query: 'test' }, undefined, () => {}, ctx);
    const text = (result.content[0] as any).text;
    
    // No old-style sections
    expect(text).not.toContain('Scrape Performance Summary');
    expect(text).not.toContain('Error Summary');
    // No percentages
    expect(text).not.toMatch(/\|\s*\*?\*?\d+%/);
    // No internal tool breakdown
    expect(text).not.toMatch(/Tools:/);
    // No diagnostic error dumps
    expect(text).not.toContain('Affected domains');
    expect(text).not.toContain('×');
  });
});
