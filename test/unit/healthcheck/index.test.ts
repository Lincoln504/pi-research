
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHealthCheck, clearHealthCheckCache } from '../../../src/healthcheck/index.ts';
import { isBrowserAvailable, runBrowserHealthCheck } from '../../../src/infrastructure/browser-manager.ts';

// Mock dependencies
vi.mock('../../../src/config.ts', () => ({
  getConfig: () => ({ HEALTH_CHECK_TIMEOUT_MS: 25000 }),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/infrastructure/browser-manager.ts', () => ({
  isBrowserAvailable: vi.fn(),
  runBrowserHealthCheck: vi.fn(),
}));

describe('healthcheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthCheckCache();
  });

  it('should pass health check when browser pool reports success', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });

    const result = await runHealthCheck();

    expect(result.success).toBe(true);
    expect(result.searchOk).toBe(true);
    expect(result.scrapeOk).toBe(true);
  });

  it('should fail when browser is not available', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(false);

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.searchOk).toBe(false);
    expect(result.error).toContain('Browser binaries');
  });

  it('should fail when browser pool health check fails', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: false });

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.searchOk).toBe(false);
    expect(result.error).toContain('Browser healthcheck failed');
  });

  it('should fail when browser pool health check throws', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockRejectedValue(new Error('connection refused'));

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.searchOk).toBe(false);
    expect(result.error).toContain('connection refused');
  });
});
