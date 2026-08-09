/**
 * Regression: request() used to chain an external signal via a bare
 * `signal.addEventListener('abort', ...)` with no upfront `signal.aborted`
 * check. An AbortSignal's 'abort' event fires exactly once, at the moment
 * .abort() is called — a listener added AFTER that already happened never
 * sees it. So a caller-provided signal that was aborted BEFORE request() was
 * even called never propagated to the internal AbortController, and the
 * request went out to the real network anyway despite the caller having
 * already cancelled. Fixed by combining the timeout with the caller signal
 * via createTimeoutSignal (AbortSignal.any), which produces an
 * already-aborted combined signal up front when an input already is.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StackExchangeClient } from '../../../src/stackexchange/rest-client.ts';

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

describe('StackExchangeClient — an already-aborted caller signal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands fetch an already-aborted signal instead of a live one', async () => {
    // Real fetch immediately rejects with an AbortError when handed an
    // already-aborted signal, without making any network connection — mirror
    // that so the assertion below is meaningful end-to-end, not just a check
    // on what object reference was passed.
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      if (init.signal?.aborted) throw abortError();
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [], quota_remaining: 299, quota_max: 300 }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort('cancelled before the request even started');

    const client = new StackExchangeClient(null, 5000);
    await expect(
      client.request({ method: 'GET', endpoint: '/questions', params: new URLSearchParams() }, controller.signal),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledOnce();
    const passedSignal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    expect(passedSignal.aborted).toBe(true);
  });
});
