/**
 * Research Configuration Command Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleResearchConfigCommand } from '../../src/research-config.ts';

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

vi.mock('../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({ KNOWLEDGE_STORE_ENABLED: true })),
  validateConfig: vi.fn(),
  saveConfig: vi.fn(),
  resetConfig: vi.fn(),
}));

describe('research-config command', () => {
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

  it('opens interactive TUI menu and ignores any arguments', async () => {
    await handleResearchConfigCommand('some random args', mockCtx, mockPi as any);
    
    // Should call ui.custom to open the menu
    expect(mockCtx.ui.custom).toHaveBeenCalled();
    
    // Should NOT call notify for "unknown section" anymore because args are ignored
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it('requires UI mode to open the menu', async () => {
    const noUiCtx = { ...mockCtx, hasUI: false };
    await handleResearchConfigCommand('', noUiCtx, mockPi as any);
    
    expect(noUiCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('requires UI mode'), 'error');
    expect(noUiCtx.ui.custom).not.toHaveBeenCalled();
  });
});
