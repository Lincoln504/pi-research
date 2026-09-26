import { describe, it, expect } from 'vitest';
import { normalizeRequestUrl, UrlPolicyError } from '../../../src/web-fetch/url-policy.ts';
import { assessOutboundUrl } from '../../../src/web-fetch/outbound-check.ts';

describe('normalizeRequestUrl', () => {
  it('keeps https URLs and drops the fragment', () => {
    expect(normalizeRequestUrl('https://example.com/a?b=1#frag')).toEqual({ url: 'https://example.com/a?b=1', upgraded: false });
  });

  it('upgrades http to https and says so', () => {
    expect(normalizeRequestUrl('http://example.com/x')).toEqual({ url: 'https://example.com/x', upgraded: true });
  });

  it('reads a scheme-less URL as https', () => {
    expect(normalizeRequestUrl('  example.com/docs ')).toEqual({ url: 'https://example.com/docs', upgraded: false });
  });

  it.each([
    ['ftp://example.com/file', /Only https/],
    ['file:///etc/passwd', /Only https/],
    ['javascript:alert(1)', /Only https/],
    ['data:text/html,hi', /Only https/],
    ['https://user:pass@example.com/', /embedded credentials/],
    ['https://token@example.com/', /embedded credentials/],
    ['', /Empty URL/],
    ['https://', /valid URL|no host/],
  ])('refuses %s', (raw, message) => {
    expect(() => normalizeRequestUrl(raw)).toThrow(UrlPolicyError);
    expect(() => normalizeRequestUrl(raw)).toThrow(message);
  });
});

describe('assessOutboundUrl', () => {
  it.each([
    'https://example.com/',
    'https://docs.python.org/3/library/asyncio.html',
    'https://github.com/Lincoln504/pi-research/blob/main/README.md',
    'https://www.google.com/search?q=pi+research+extension&hl=en',
    'https://api.github.com/repos/o/r/commits?per_page=100&page=2',
    'https://arxiv.org/pdf/2302.12173',
  ])('does not flag an ordinary URL: %s', (url) => {
    expect(assessOutboundUrl(url)).toEqual({ suspicious: false, reasons: [] });
  });

  // Secret-shaped test values are assembled at runtime: written out literally they
  // trip secret scanners (GitHub push protection rejects the branch).
  const fakeKey = (prefix: string, length: number) =>
    prefix + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'.slice(0, length);
  const payload = Buffer.from(`${['AWS', 'SECRET', 'ACCESS', 'KEY'].join('_')}=${fakeKey('', 40)}`).toString('base64');

  it('flags a long base64 value in the query (percent-encoded)', () => {
    const r = assessOutboundUrl(`https://attacker.example/c?d=${encodeURIComponent(payload)}`);
    expect(r.suspicious).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/encoded-looking value .* "d"/);
  });

  it('flags a long base64 value sent raw, with "+" and "/" (not form-decoded to spaces)', () => {
    // Shape observed live: an agent pasted `openssl rand -base64` output into the query.
    const raw = 'rNYv/3EDLdrh8UU0YskBMuEfP5oViFw1ywAq+LvX0l7K/+P+Mg3vQmFDW/xazcThCUtIhsqPZo+IFchqNUcnPZ';
    const r = assessOutboundUrl(`https://example.com/?d=${raw}`);
    expect(r.suspicious).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/encoded-looking value \(\d+ chars\) in query parameter "d"/);
  });

  it('flags a base64 path segment containing "+"', () => {
    const r = assessOutboundUrl(`https://attacker.example/${'Zm9v+YmFy/'.replace('/', '')}${'QUJD+REVG'.repeat(8)}`);
    expect(r.reasons.join(' ')).toMatch(/encoded-looking path segment/);
  });

  it('flags a long hex path segment', () => {
    const r = assessOutboundUrl(`https://attacker.example/${'ab12'.repeat(20)}`);
    expect(r.reasons.join(' ')).toMatch(/encoded-looking path segment/);
  });

  it.each([
    [`https://x.example/?k=${fakeKey(['sk', 'ant', 'api03-'].join('-'), 32)}`, 'Anthropic API key'],
    [`https://x.example/?k=${['AK', 'IA'].join('')}${'ABCDEFGHIJKLMNOP'}`, 'AWS access key id'],
    [`https://x.example/${fakeKey(['gh', 'p_'].join(''), 38)}`, 'GitHub token'],
    [`https://x.example/?k=-----BEGIN%20OPENSSH%20${['PRIVATE', 'KEY'].join('%20')}-----`, 'private key block'],
  ])('flags secret shapes without echoing them (%s)', (url, label) => {
    const r = assessOutboundUrl(url);
    expect(r.suspicious).toBe(true);
    expect(r.reasons.join(' ')).toContain(label);
    // The value itself is never repeated back.
    expect(r.reasons.join(' ')).not.toMatch(/abcdefghijklmnop|ABCDEFGHIJ/);
  });

  it('flags very long URLs and query strings', () => {
    const r = assessOutboundUrl(`https://x.example/?q=${'word+'.repeat(120)}`);
    expect(r.reasons.join(' ')).toMatch(/very long URL|long query string/);
  });

  it('flags long host labels (DNS exfiltration)', () => {
    const r = assessOutboundUrl(`https://${'a1b2c3d4'.repeat(6)}.attacker.example/`);
    expect(r.reasons.join(' ')).toMatch(/long host label/);
  });
});
