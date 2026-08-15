/**
 * Security regression tests for the connect-time SSRF gate (ssrfSafeLookup).
 *
 * validateUrlForSSRF runs at request time, but fetch re-resolves the hostname
 * when it opens the socket — a DNS-rebinding attacker can answer public during
 * validation and private (e.g. the cloud metadata 169.254.169.254) at connect.
 * ssrfSafeLookup is wired into the undici connector so the address actually
 * connected to is the address that gets validated. These tests drive the lookup
 * directly with a stubbed resolver so they are deterministic and offline.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ssrfSafeLookup, isSsrfBlockError } from '../../../src/web-research/scraper-utils.ts';

const FLAG = 'PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE';

function lookupResult(addresses: Array<{ address: string; family: number }> | Error) {
  const resolveImpl = (_host: any, _opts: any, cb: any) => {
    if (addresses instanceof Error) cb(addresses);
    else cb(null, addresses);
  };
  return new Promise<{ err: NodeJS.ErrnoException | null; address?: any; family?: number }>((resolve) => {
    ssrfSafeLookup('host.example', { all: true } as any, (err, address, family) => {
      resolve({ err, address, family });
    }, resolveImpl as any);
  });
}

describe('ssrfSafeLookup — connect-time SSRF gate', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('passes through a public address', async () => {
    const { err, address } = await lookupResult([{ address: '93.184.216.34', family: 4 }]);
    expect(err).toBeNull();
    expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('blocks a private IPv4 (RFC1918) resolved at connect time', async () => {
    const { err } = await lookupResult([{ address: '10.0.0.5', family: 4 }]);
    expect(err).toBeTruthy();
    expect((err as any)?.code).toBe('ESSRFBLOCKED');
  });

  it('blocks the cloud metadata link-local address', async () => {
    const { err } = await lookupResult([{ address: '169.254.169.254', family: 4 }]);
    expect(err).toBeTruthy();
    expect((err as any)?.code).toBe('ESSRFBLOCKED');
  });

  it('blocks IPv6 loopback', async () => {
    const { err } = await lookupResult([{ address: '::1', family: 6 }]);
    expect(err).toBeTruthy();
  });

  it('filters out a private address but keeps a public one (mixed records)', async () => {
    const { err, address } = await lookupResult([
      { address: '10.0.0.5', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(err).toBeNull();
    expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('permits loopback only when the test flag is set', async () => {
    process.env[FLAG] = 'true';
    const { err, address } = await lookupResult([{ address: '127.0.0.1', family: 4 }]);
    expect(err).toBeNull();
    expect(address).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });

  it('still blocks non-loopback private ranges even with the loopback flag set', async () => {
    process.env[FLAG] = 'true';
    const { err } = await lookupResult([{ address: '169.254.169.254', family: 4 }]);
    expect(err).toBeTruthy();
  });

  it('propagates a resolver error unchanged', async () => {
    const resolveErr = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const { err } = await lookupResult(resolveErr);
    expect((err as any)?.code).toBe('ENOTFOUND');
  });
});

describe('isSsrfBlockError — classifying blocks wherever they surface', () => {
  it('matches the request-time validator message directly', () => {
    expect(isSsrfBlockError(new Error('URL host is not allowed: private address'))).toBe(true);
  });

  it('finds the connect-time ESSRFBLOCKED down an undici cause chain', () => {
    // undici never surfaces the connector error directly — fetch throws
    // "TypeError: fetch failed" with the real error as (possibly nested) cause.
    // Pre-fix, this was filed as a generic fetch error instead of ssrf_blocked.
    const inner = Object.assign(
      new Error('SSRF blocked: evil.example resolved only to private/reserved addresses at connect time'),
      { code: 'ESSRFBLOCKED' },
    );
    const wrapped = new TypeError('fetch failed');
    (wrapped as { cause?: unknown }).cause = inner;
    expect(isSsrfBlockError(wrapped)).toBe(true);

    const doubleWrapped = new TypeError('fetch failed');
    (doubleWrapped as { cause?: unknown }).cause = new Error('connect error');
    ((doubleWrapped as { cause?: unknown }).cause as { cause?: unknown }).cause = inner;
    expect(isSsrfBlockError(doubleWrapped)).toBe(true);
  });

  it('rejects ordinary network errors, including cyclic cause chains', () => {
    expect(isSsrfBlockError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isSsrfBlockError('not an error')).toBe(false);
    const cyclic = new TypeError('fetch failed');
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(isSsrfBlockError(cyclic)).toBe(false); // bounded walk terminates
  });
});
