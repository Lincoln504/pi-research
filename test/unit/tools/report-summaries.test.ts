import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTool } from '../../../src/tools/research-tool-definition.ts';

// Mock dependencies
vi.mock('../../../src/orchestration/research-manager.ts', () => ({
  runResearch: vi.fn().mockResolvedValue('Research result'),
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
      }
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

vi.mock('../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({ isReady: true })),
}));

vi.mock('../../../src/utils/input-validation.ts', () => ({
  validateAndSanitizeQuery: vi.fn((q) => q),
}));

vi.mock('../../../src/utils/session-state.ts', () => ({
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
  it('includes scrape performance summary when scrapes were performed', async () => {
    const tool = createResearchTool();
    const ctx = {
      model: { id: 'test-model' },
      modelRegistry: { getAll: () => [{ id: 'test-model' }] },
      cwd: '/tmp',
    } as any;

    const result = await tool.execute('call-1', { query: 'test' }, undefined, () => {}, ctx);
    
    const text = (result.content[0] as any).text;
    expect(text).toContain('## Scrape Performance Summary');
    expect(text).toContain('| **Fetch (Lightweight)** | 1 | 50% |');
    expect(text).toContain('| **Browser (Stealth)** | 1 | 50% |');
  });
});
