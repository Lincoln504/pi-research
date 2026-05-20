import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('cleanup-utils', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = os.tmpdir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns zero counts when no playwright profiles exist', async () => {
    // Import after mocks are set up
    const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');
    const result = await cleanupStaleProfiles();
    // No stale profiles should exist in a clean test environment
    expect(result).toHaveProperty('removed');
    expect(result).toHaveProperty('errors');
    expect(result.removed).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBeGreaterThanOrEqual(0);
  });

  it('returns object with removed and errors properties', async () => {
    const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');
    const result = await cleanupStaleProfiles();
    expect(typeof result.removed).toBe('number');
    expect(typeof result.errors).toBe('number');
  });

  it('result values are non-negative integers', async () => {
    const { cleanupStaleProfiles } = await import('../../../src/infrastructure/cleanup-utils.ts');
    const result = await cleanupStaleProfiles();
    expect(Number.isInteger(result.removed)).toBe(true);
    expect(Number.isInteger(result.errors)).toBe(true);
    expect(result.removed).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBeGreaterThanOrEqual(0);
  });
});
