/**
 * Research Configuration Command Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleResearchConfigCommand } from '../../src/research-config.ts';
import { errorTracker } from '../../src/utils/error-tracker.ts';
import { healthRegistry } from '../../src/healthcheck/index.ts';

// Mock dependencies
vi.mock('../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/healthcheck/index.ts', () => ({
  healthRegistry: {
    runAll: vi.fn().mockResolvedValue({ success: true, components: [] }),
    isCritical: vi.fn().mockReturnValue(true),
  },
  runHealthCheck: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../src/utils/error-tracker.ts', () => ({
  errorTracker: {
    clear: vi.fn(),
    getReport: vi.fn().mockReturnValue({ totalErrors: 0, uniquePatterns: 0, patterns: [] }),
  },
}));

vi.mock('../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({ KNOWLEDGE_STORE_ENABLED: true })),
  validateConfig: vi.fn(),
  saveConfig: vi.fn(),
  resetConfig: vi.fn(),
}));

describe('research-config command routing', () => {
  const mockCtx = {
    ui: {
      notify: vi.fn(),
      custom: vi.fn(),
    },
    hasUI: true,
  };

  const mockPi = {
    sendMessage: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes "errors clear" command correctly', async () => {
    await handleResearchConfigCommand('errors clear', mockCtx, mockPi as any);
    expect(errorTracker.clear).toHaveBeenCalled();
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('cleared'), 'info');
  });

  it('routes "health history" command to informational message', async () => {
    await handleResearchConfigCommand('health history', mockCtx, mockPi as any);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('no longer supported'), 'info');
  });

  it('routes unknown section to error notification', async () => {
    await handleResearchConfigCommand('unknown-section', mockCtx, mockPi as any);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Unknown section'), 'error');
  });

  it('routes unknown action in known section to error notification', async () => {
    await handleResearchConfigCommand('health unknown-action', mockCtx, mockPi as any);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Unknown health action'), 'error');
  });
});
