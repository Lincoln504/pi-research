/**
 * Regression: quota exhaustion must not wedge the client permanently.
 *
 * quotaRemaining is only refreshed from a successful response, but the tool-level
 * gate (stackexchange/index.ts) blocks every request while isQuotaExhausted() —
 * so a plain `quotaRemaining <= 0` check could never observe SE's real daily
 * reset and wedged the process-wide client until restart or an API-key change.
 * Exhaustion evidence is therefore time-stamped; after a probe cooldown one
 * request is allowed through, which either refreshes the quota (clearing the
 * stamp) or shows 0 / throttles again (re-arming the gate).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StackExchangeClient } from '../../../src/stackexchange/rest-client.ts';

const seResponse = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    items: [],
    has_more: false,
    quota_remaining: 100,
    quota_max: 300,
    ...overrides,
  }),
} as unknown as Response);

const doRequest = (client: StackExchangeClient) =>
  client.request({ method: 'GET', endpoint: '/questions', params: new URLSearchParams() });

describe('StackExchangeClient — quota exhaustion probe cooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports exhausted within the cooldown, then allows a probe after it elapses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => seResponse({ quota_remaining: 0 })));
    const client = new StackExchangeClient(null, 5000);

    await doRequest(client);
    expect(client.isQuotaExhausted()).toBe(true);

    // Still inside the cooldown window — the gate stays armed.
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(client.isQuotaExhausted()).toBe(true);

    // Past the cooldown: the gate opens so one probe request can discover
    // whether SE's daily reset has happened.
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(client.isQuotaExhausted()).toBe(false);
  });

  it('re-arms the gate when a probe again reports zero quota', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => seResponse({ quota_remaining: 0 })));
    const client = new StackExchangeClient(null, 5000);

    await doRequest(client);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(client.isQuotaExhausted()).toBe(false);

    // Probe: still 0 remaining — the stamp refreshes and the gate re-arms.
    await doRequest(client);
    expect(client.isQuotaExhausted()).toBe(true);
  });

  it('clears the exhaustion state when a probe shows the quota reset', async () => {
    const fetchMock = vi.fn(async () => seResponse({ quota_remaining: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new StackExchangeClient(null, 5000);

    await doRequest(client);
    vi.advanceTimersByTime(11 * 60 * 1000);

    fetchMock.mockImplementation(async () => seResponse({ quota_remaining: 300 }));
    await doRequest(client);
    expect(client.isQuotaExhausted()).toBe(false);
    expect(client.getQuotaInfo().remaining).toBe(300);
  });

  it('arms the gate when the API throws a throttle_violation error', async () => {
    // A throttle_violation carries no quota_remaining (the error path throws before
    // the quota update), so the gate must arm from the stamped evidence alone.
    vi.stubGlobal('fetch', vi.fn(async () => seResponse({
      error_id: 502,
      error_name: 'throttle_violation',
      error_message: 'too many requests from this IP',
    })));
    const client = new StackExchangeClient(null, 5000);

    await expect(doRequest(client)).rejects.toThrow(/throttle_violation/);
    expect(client.isQuotaExhausted()).toBe(true);
  });
});
