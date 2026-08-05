/**
 * stackexchange — shared client across tool calls
 *
 * The client instance carries the resilience state the SE API requires callers to
 * honor across requests (backoff directive, quota tracking, circuit breaker). A
 * per-call `new StackExchangeClient(...)` reset all of it on every tool call, so
 * stackexchangeCommand must reuse one process-wide client, rebuilding only when
 * the API key changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ctorArgs, mockRequest } = vi.hoisted(() => ({
  ctorArgs: [] as unknown[][],
  mockRequest: vi.fn(),
}));

vi.mock('../../../src/stackexchange/rest-client.ts', () => ({
  StackExchangeClient: class {
    constructor(...args: unknown[]) { ctorArgs.push(args); }
    isQuotaExhausted() { return false; }
    isQuotaLow() { return false; }
    getQuotaInfo() { return { remaining: 100, max: 300, requestCount: 1, lastBackoff: null }; }
    request(...args: unknown[]) { return mockRequest(...args); }
  },
}));

import { stackexchangeCommand } from '../../../src/stackexchange/index.ts';

const ctx = { ui: { notify: vi.fn() } } as any;

describe('stackexchange shared client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ items: [], has_more: false });
  });

  it('reuses one client instance across tool calls (resilience state persists)', async () => {
    await stackexchangeCommand({ command: 'search', params: { query: 'first', format: 'json' }, ctx });
    await stackexchangeCommand({ command: 'search', params: { query: 'second', format: 'json' }, ctx });
    await stackexchangeCommand({ command: 'site', params: { format: 'json' }, ctx });

    expect(ctorArgs.length).toBe(1);
  });

  it('rebuilds the client only when the API key changes', async () => {
    const prevKey = process.env['STACKEXCHANGE_API_KEY'];
    try {
      delete process.env['STACKEXCHANGE_API_KEY'];
      await stackexchangeCommand({ command: 'search', params: { query: 'a', format: 'json' }, ctx });
      const countAfterFirst = ctorArgs.length;

      process.env['STACKEXCHANGE_API_KEY'] = 'new-key';
      await stackexchangeCommand({ command: 'search', params: { query: 'b', format: 'json' }, ctx });

      expect(ctorArgs.length).toBe(countAfterFirst + 1);
      expect(ctorArgs[ctorArgs.length - 1]![0]).toBe('new-key');

      // Same key again — no rebuild
      await stackexchangeCommand({ command: 'search', params: { query: 'c', format: 'json' }, ctx });
      expect(ctorArgs.length).toBe(countAfterFirst + 1);
    } finally {
      if (prevKey === undefined) delete process.env['STACKEXCHANGE_API_KEY'];
      else process.env['STACKEXCHANGE_API_KEY'] = prevKey;
    }
  });
});
