/**
 * search tool — per-session circuit-breaker scoping.
 *
 * The scrape tool threads getGlobalState().researchId into scrape() so breaker
 * state is keyed per research run (task-execution-service keys breakers on
 * BrowserTask.sessionId). The search tool previously passed no session at all —
 * the chain search() → performSearch → runWorkerSearch hard-coded
 * sessionId=undefined — so every search failure charged the GLOBAL breaker.
 * This pins the researchId travelling from the tool into search().
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/core/service-registry.ts', () => ({
  tryGetServiceContainerFromCtx: vi.fn(() => ({})),
  getServiceContainer: vi.fn(() => ({})),
}));

import { createSearchTool } from '../../../src/tools/search.ts';
import { search } from '../../../src/web-research/search.ts';

const tracker = {
  recordCall: () => true,
  getLimitMessage: () => 'limit',
  getToolCallCount: () => 0,
  getToolLimit: () => undefined,
} as any;

const baseOptions = {
  ctx: { cwd: '/tmp' } as any,
  tracker,
  config: { YOUTUBE_QUERY_EVERY_N: 5 } as any,
};

describe('createSearchTool — session scoping', () => {
  it('passes getGlobalState().researchId to search() as the sessionId (mirrors scrape)', async () => {
    const tool = createSearchTool({
      ...baseOptions,
      getGlobalState: () => ({ researchId: 'pisess-1a2b3c4d' } as any),
    });

    await tool.execute('call-1', { queries: ['q1'] }, new AbortController().signal, (() => {}) as any, {} as any);

    expect(vi.mocked(search)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(search).mock.calls[0]!;
    expect(args[0]).toEqual(['q1']);
    expect(args[5]).toBe('pisess-1a2b3c4d');
  });

  it('leaves the sessionId undefined for callers without research state (global breaker preserved)', async () => {
    const tool = createSearchTool({ ...baseOptions });

    await tool.execute('call-2', { queries: ['q1'] }, new AbortController().signal, (() => {}) as any, {} as any);

    const args = vi.mocked(search).mock.calls[0]!;
    expect(args[5]).toBeUndefined();
  });
});
