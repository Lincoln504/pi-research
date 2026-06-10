import { describe, it, expect } from 'vitest';
import { validateUrl } from '../../../src/knowledge/writer-queue.ts';

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
