/**
 * Regression: the request timeout must cover the response *body* read, not just
 * the headers. Previously clearTimeout fired as soon as fetch resolved (headers
 * received), so a stalled body (response.json()) had no timeout and could hang
 * for the whole process lifetime. The timeout is now cleared only in `finally`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StackExchangeClient } from '../../../src/stackexchange/rest-client.ts';

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

describe('StackExchangeClient — timeout covers the body read', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('times out when the body never arrives (headers resolve, json() stalls)', async () => {
    // fetch resolves immediately (headers), but json() only settles when the
    // request's own AbortSignal fires — i.e. it relies on the timeout still
    // being armed during the body read.
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const signal: AbortSignal = init.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new StackExchangeClient(null, 50); // 50ms timeout
    await expect(
      client.request({ method: 'GET', endpoint: '/questions', params: new URLSearchParams() }),
    ).rejects.toThrow(/timeout/i);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns normally when the body resolves before the timeout', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [], quota_remaining: 299, quota_max: 300 }),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    const client = new StackExchangeClient(null, 5000);
    const res = await client.request<{ items: unknown[] }>({
      method: 'GET',
      endpoint: '/questions',
      params: new URLSearchParams(),
    });
    expect(res.quota_remaining).toBe(299);
  });
});
