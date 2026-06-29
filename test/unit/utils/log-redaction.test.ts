/**
 * Log Redaction & Sanitization Unit Tests
 *
 * Verifies that redactSecrets() masks the credential formats that can reach the
 * logger via scraped/network content, and that neutralizeControlChars() strips
 * the line-break/control-char log-injection vector. These guards back the
 * CodeQL "Network data written to file" / "Log injection" alerts on logger.ts.
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, neutralizeControlChars } from '../../../src/utils/log-utils.ts';

describe('redactSecrets', () => {
  it('masks credentials embedded in URL userinfo', () => {
    const out = redactSecrets('connecting to https://alice:s3cr3t@example.com/path');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('[REDACTED]@');
  });

  it('masks sensitive key/value pairs', () => {
    expect(redactSecrets('api_key=abcdef123456')).not.toContain('abcdef123456');
    expect(redactSecrets('"password": "hunter2"')).not.toContain('hunter2');
    expect(redactSecrets('Cookie: sessionid=deadbeefdeadbeef')).not.toContain('deadbeefdeadbeef');
  });

  it('masks known opaque token formats', () => {
    expect(redactSecrets('token sk-ABCDEFGHIJKLMNOPQRSTUV')).toContain('[REDACTED]');
    expect(redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toContain('[REDACTED]');
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
  });

  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSecrets(`Authorization header was Bearer ${jwt}`);
    expect(out).not.toContain('eyJzdWIi');
    expect(out).toContain('[REDACTED]');
  });

  it('masks HTTP Basic credentials', () => {
    const out = redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==');
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA==');
    expect(out).toContain('[REDACTED]');
  });

  it('masks an opaque Bearer token that is not a JWT or known format', () => {
    // GLM/zhipuai-style dotted key: not a JWT, no known prefix — the value the
    // KV/known-token passes miss. The scheme-aware Bearer pattern must catch it.
    const opaque = 'a1b2c3d4e5f6g7h8.i9j0k1l2m3n4o5p6';
    const out = redactSecrets(`Authorization: Bearer ${opaque}`);
    expect(out).not.toContain(opaque);
    expect(out).toContain('[REDACTED]');
  });

  it('masks a bare Bearer token (no Authorization key prefix)', () => {
    const opaque = 'zhipu-XXXXXXXXXXXXXXXX.YYYYYYYYYYYY';
    const out = redactSecrets(`sending header Bearer ${opaque} to provider`);
    expect(out).not.toContain(opaque);
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('masks Stripe and Google provider keys', () => {
    expect(redactSecrets('sk_live_abcdefghijklmnop1234')).toContain('[REDACTED]');
    // Google API keys are "AIza" + exactly 35 chars.
    expect(redactSecrets(`AIza${'a'.repeat(35)}`)).toContain('[REDACTED]');
  });

  it('masks long opaque hex secrets (e.g. the 64-hex browser auth secret)', () => {
    const secret = 'a'.repeat(64);
    const out = redactSecrets(`PI_BROWSER_AUTH_SECRET=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('does not redact short hex strings like run IDs', () => {
    expect(redactSecrets('run-deadbeef started')).toContain('run-deadbeef');
  });

  it('bounds oversized messages', () => {
    const out = redactSecrets('x'.repeat(20_000));
    expect(out.length).toBeLessThan(11_000);
    expect(out).toContain('truncated');
  });
});

describe('neutralizeControlChars', () => {
  it('strips CR/LF so untrusted content cannot forge a log line', () => {
    const out = neutralizeControlChars('clean\r\nINJECTED forged line');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
    // CRLF is one line break, collapsed to a single space.
    expect(out).toBe('clean INJECTED forged line');
  });

  it('strips other C0 control chars and DEL', () => {
    expect(neutralizeControlChars('a\x00b\x07c\x7fd')).toBe('a b c d');
  });
});
