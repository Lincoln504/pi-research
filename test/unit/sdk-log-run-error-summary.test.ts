/**
 * logRunErrorSummary() — the SDK's end-of-run "tracked error(s)" WARN line.
 *
 * Regression: `p.message` is the RAW, unredacted first-seen error message on
 * an ErrorTracker pattern — unlike `p.signature`, which extractSignature()
 * already strips URLs from before grouping. A scrape/navigation failure
 * routinely echoes the failing URL verbatim, and a URL can carry userinfo
 * credentials (https://user:pass@host/...). The summary line used to slice
 * `p.message` to 48 chars BEFORE the formatted line ever reached
 * logger.warn's own redactSecrets call — a 48-char window makes landing
 * mid-credential likely, and truncating first cuts it before any pattern can
 * recognize the whole token. Same class of bug as the truncate-before-redact
 * fix in log-utils.ts's redactSecrets itself.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createResearchRunId: () => 'test-run-id',
  createLogger: vi.fn(),
  setLogger: vi.fn(),
  resetLogger: vi.fn(),
}));

import { logRunErrorSummary } from '../../src/sdk.ts';
import { logger } from '../../src/logger.ts';

describe('logRunErrorSummary', () => {
  it('redacts a credential in p.message before truncating to 48 chars', () => {
    const filler = 'x'.repeat(30);
    const report = {
      totalErrors: 1,
      uniquePatterns: 1,
      patterns: [{
        signature: 'Navigation failed: <URL>',
        message: `Navigation failed at https://${filler}user:s3cr3tpass@example.com/path`,
        count: 1,
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
        contexts: [],
        domainCounts: new Map(),
      }],
      byDomain: new Map(),
      byType: new Map(),
    };

    logRunErrorSummary(report as any, 'depth 1', 'error');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const line = vi.mocked(logger.warn).mock.calls[0]![0] as string;
    expect(line).not.toContain('s3cr3tpass');
    expect(line).toContain('[REDACTED]');
  });

  it('is a no-op for a clean run (no tracked errors)', () => {
    logRunErrorSummary({ totalErrors: 0, uniquePatterns: 0, patterns: [], byDomain: new Map(), byType: new Map() } as any, 'depth 1', 'success');
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('is a no-op for a null report', () => {
    logRunErrorSummary(null, 'depth 1', 'success');
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});
