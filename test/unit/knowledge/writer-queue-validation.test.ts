import { describe, it, expect } from 'vitest';
import { validateUrl, normalizeUrl } from '../../../src/knowledge/writer-queue.ts';

describe('normalizeUrl', () => {
  it('should strip trailing slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
  });

  it('should lowercase hostname', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/path')).toBe('https://example.com/path');
  });

  it('should remove default ports', () => {
    expect(normalizeUrl('https://example.com:443/path')).toBe('https://example.com/path');
    expect(normalizeUrl('http://example.com:80/path')).toBe('http://example.com/path');
  });

  it('should keep non-default ports', () => {
    expect(normalizeUrl('https://example.com:8443/path')).toBe('https://example.com:8443/path');
    expect(normalizeUrl('http://example.com:8080/path')).toBe('http://example.com:8080/path');
  });

  it('should sort query parameters', () => {
    expect(normalizeUrl('https://example.com?b=2&a=1')).toBe('https://example.com/?a=1&b=2');
  });

  it('should remove empty hash fragment', () => {
    expect(normalizeUrl('https://example.com#')).toBe('https://example.com');
  });

  it('should return original string on parse failure', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });

  it('should normalize equivalent URLs to same form', () => {
    const a = normalizeUrl('https://Example.COM:443/path/?b=2&a=1');
    const b = normalizeUrl('https://example.com/path?a=1&b=2');
    expect(a).toBe(b);
  });

  it('should preserve non-trivial hash fragments', () => {
    expect(normalizeUrl('https://example.com#section')).toBe('https://example.com/#section');
  });
});

describe('WriterQueue URL Validation', () => {
  it('should accept valid HTTPS URLs', () => {
    expect(validateUrl('https://example.com')).toBe(true);
    expect(validateUrl('https://google.com/search?q=test')).toBe(true);
  });

  it('should accept valid HTTP URLs', () => {
    expect(validateUrl('http://example.com')).toBe(true);
  });

  it('should reject URLs without protocol', () => {
    expect(validateUrl('example.com')).toBe(false);
  });

  it('should reject non-HTTP(S) protocols', () => {
    expect(validateUrl('ftp://example.com')).toBe(false);
    expect(validateUrl('ssh://example.com')).toBe(false);
    expect(validateUrl('file:///etc/passwd')).toBe(false);
  });

  it('should reject localhost and loopback', () => {
    expect(validateUrl('http://localhost')).toBe(false);
    expect(validateUrl('http://localhost:3000')).toBe(false);
    expect(validateUrl('http://test.localhost')).toBe(false);
    expect(validateUrl('http://127.0.0.1')).toBe(false);
  });

  it('should reject IPv4 private network ranges', () => {
    expect(validateUrl('http://10.0.0.1')).toBe(false);
    expect(validateUrl('http://172.16.0.1')).toBe(false);
    expect(validateUrl('http://172.31.255.255')).toBe(false);
    expect(validateUrl('http://192.168.1.1')).toBe(false);
  });

  it('should reject other internal IPv4 ranges', () => {
    expect(validateUrl('http://0.0.0.0')).toBe(false);
    expect(validateUrl('http://169.254.1.1')).toBe(false);
  });

  it('should reject IPv6 internal ranges', () => {
    expect(validateUrl('http://[::1]')).toBe(false);
    expect(validateUrl('http://[fe80::1]')).toBe(false);
    expect(validateUrl('http://[fc00::1]')).toBe(false);
    expect(validateUrl('http://[fd00::1]')).toBe(false);
    expect(validateUrl('http://[::ffff:127.0.0.1]')).toBe(false);
  });

  it('should reject internal TLDs', () => {
    expect(validateUrl('http://myserver.local')).toBe(false);
    expect(validateUrl('http://myserver.internal')).toBe(false);
  });

  it('should reject malformed inputs', () => {
    expect(validateUrl('')).toBe(false);
    expect(validateUrl(null as any)).toBe(false);
    expect(validateUrl(undefined as any)).toBe(false);
    expect(validateUrl('not a url')).toBe(false);
    expect(validateUrl('http://')).toBe(false);
  });
});
