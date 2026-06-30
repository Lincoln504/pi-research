/**
 * Security regression tests for the synchronous SSRF validator.
 *
 * `validateUrlForSSRFSync` is the no-DNS screen the browser worker's page.route
 * guard runs on EVERY subresource request (img/script/xhr/fetch) and, via
 * `validateUrlForSSRF`, on every navigation. Before this guard the browser path
 * validated only HTTP-3xx redirects, so a page could reach a private/loopback/
 * cloud-metadata address through a client-side navigation or a subresource and
 * have the response returned to the researcher. These cases lock the screen in.
 *
 * It is deliberately DNS-free (deterministic offline) — hostname resolution is the
 * async validateUrlForSSRF's job; here we assert the literal/pattern/protocol gate.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { validateUrlForSSRFSync } from '../../../src/web-research/scraper-utils.ts';

const FLAG = 'PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE';

describe('validateUrlForSSRFSync — literal/pattern screen for the browser request guard', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('blocks the cloud-metadata endpoint 169.254.169.254 (the key SSRF target)', () => {
    expect(() => validateUrlForSSRFSync('http://169.254.169.254/latest/meta-data/')).toThrow();
  });

  it('blocks IPv4 private/loopback literals', () => {
    expect(() => validateUrlForSSRFSync('http://127.0.0.1/')).toThrow();
    expect(() => validateUrlForSSRFSync('http://10.0.0.5/')).toThrow();
    expect(() => validateUrlForSSRFSync('http://192.168.1.1/')).toThrow();
    expect(() => validateUrlForSSRFSync('http://172.16.0.1/')).toThrow();
  });

  it('blocks IPv6 loopback / mapped / unique-local literals (no DNS)', () => {
    expect(() => validateUrlForSSRFSync('http://[::1]/')).toThrow();
    expect(() => validateUrlForSSRFSync('http://[::ffff:127.0.0.1]/')).toThrow();
    expect(() => validateUrlForSSRFSync('http://[fc00::1]/')).toThrow();
  });

  it('blocks localhost and *.localhost', () => {
    expect(() => validateUrlForSSRFSync('http://localhost/')).toThrow();
    expect(() => validateUrlForSSRFSync('http://api.localhost/')).toThrow();
  });

  it('blocks non-HTTP(S) protocols', () => {
    expect(() => validateUrlForSSRFSync('file:///etc/passwd')).toThrow();
    expect(() => validateUrlForSSRFSync('gopher://127.0.0.1/')).toThrow();
  });

  it('accepts a public host without throwing, and reports it is NOT loopback-accepted (false)', () => {
    // false = passed the sync screen but a DNS pass is still warranted (the async
    // validateUrlForSSRF adds it). Crucially it does NOT throw on a normal subresource.
    expect(validateUrlForSSRFSync('https://example.com/script.js')).toBe(false);
    expect(validateUrlForSSRFSync('https://cdn.jsdelivr.net/npm/x.js')).toBe(false);
  });

  it('returns true (definitively accepted, skip DNS) for loopback ONLY under the test flag', () => {
    process.env[FLAG] = 'true';
    expect(validateUrlForSSRFSync('http://127.0.0.1:8080/page')).toBe(true);
    expect(validateUrlForSSRFSync('http://localhost/page')).toBe(true);
  });

  it('keeps cloud-metadata and RFC1918 BLOCKED even when the loopback flag is set', () => {
    process.env[FLAG] = 'true';
    // The affordance is loopback-scoped; the dangerous targets must still throw.
    expect(() => validateUrlForSSRFSync('http://169.254.169.254/')).toThrow();
    expect(() => validateUrlForSSRFSync('http://10.0.0.5/')).toThrow();
  });
});
