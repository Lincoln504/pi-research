/**
 * Log Redaction & Sanitization Unit Tests
 *
 * Verifies that redactSecrets() masks the credential formats that can reach the
 * logger via scraped/network content, and that stripTerminalEscapes() strips
 * the terminal-escape/control-char log-injection vector. These guards back the
 * CodeQL "Network data written to file" / "Log injection" alerts on logger.ts.
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, stripTerminalEscapes } from '../../../src/utils/log-utils.ts';

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

  it('masks the ENTIRE Cookie header value, not just the first pair', () => {
    // The KV value class stops at whitespace, so pre-fix only `lang=en;` was
    // masked and every later pair — including the actual credential — survived.
    const out = redactSecrets('Cookie: lang=en; SID=secret123; theme=dark');
    expect(out).not.toContain('secret123');
    expect(out).not.toContain('theme=dark');
    expect(out).toContain('[REDACTED]');
  });

  it('masks the ENTIRE Set-Cookie header value', () => {
    const out = redactSecrets('Set-Cookie: SSID=tok4bcde; Path=/; HttpOnly; Secure');
    expect(out).not.toContain('tok4bcde');
    expect(out).not.toContain('HttpOnly');
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

  it('masks a bare "key=" parameter (e.g. the StackExchange ?key=<apikey> query param)', () => {
    // rest-client.ts sets the SE API key via url.searchParams.set('key',
    // apiKey) — no "api_"/"private_" qualifying prefix, so SENSITIVE_KV_PATTERN's
    // key-name alternation needed the bare "key" entry to catch it.
    const out = redactSecrets('GET https://api.stackexchange.com/2.3/questions?key=abcdef1234567890&site=stackoverflow');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('[REDACTED]');
  });

  it('still redacts the qualified key forms without double-matching (api_key, private_key)', () => {
    expect(redactSecrets('api_key=abc123secret')).not.toContain('abc123secret');
    expect(redactSecrets('private_key=zzz999secret')).not.toContain('zzz999secret');
  });

  it('does not redact short hex strings like run IDs', () => {
    expect(redactSecrets('run-deadbeef started')).toContain('run-deadbeef');
  });

  it('bounds oversized messages', () => {
    const out = redactSecrets('x'.repeat(20_000));
    expect(out.length).toBeLessThan(11_000);
    expect(out).toContain('truncated');
  });

  it('does not split a UTF-16 surrogate pair at the truncation boundary', () => {
    // MAX_LOG_MESSAGE_LENGTH is 10_000 (log-utils.ts, not exported). Placed so
    // the emoji's high surrogate lands exactly at index 9999 — straddling the
    // 10_000-unit cut point. A naive slice(0, 10_000) would keep the lone
    // high surrogate and drop its low surrogate: silently mangled to U+FFFD
    // by the console sink's UTF-8 encode, and an invalid unpaired \uXXXX
    // escape on the JSON-file sink.
    // 'z' (not a hex digit) so the run isn't itself caught by
    // LONG_HEX_SECRET_PATTERN — this test is purely about the truncation
    // boundary, not redaction.
    const message = 'z'.repeat(9999) + '\u{1F600}' + 'trailing text after the emoji';
    const out = redactSecrets(message);
    const body = out.slice(0, out.indexOf('…[truncated'));

    const lastCode = body.charCodeAt(body.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    // Backs off to exclude the whole emoji rather than split it.
    expect(body).toBe('z'.repeat(9999));
  });

  it('does not leak a fragment of a secret that straddles the truncation boundary', () => {
    // MAX_LOG_MESSAGE_LENGTH is 10_000 (log-utils.ts, not exported). Pre-fix,
    // truncation ran BEFORE redaction: a secret split by the cut left
    // whichever fragment survived the cut too short for any pattern's length
    // minimum (LONG_HEX_SECRET_PATTERN needs 32+ contiguous hex chars) —
    // exposed in the clear right before the "…[truncated N chars]" marker.
    const prefix = 'PI_BROWSER_AUTH_SECRET=';
    const secret = 'a'.repeat(64);
    const keptHexChars = 10; // how many hex chars of the secret land BEFORE the 10_000 cut
    const filler = 'z'.repeat(10_000 - prefix.length - keptHexChars);
    const message = filler + prefix + secret + ' trailing';

    const out = redactSecrets(message);

    expect(out).not.toContain('a'.repeat(keptHexChars));
    expect(out).toContain('[REDACTED]');
  });
});

describe('stripTerminalEscapes', () => {
  it('strips private-mode CSI sequences the colour-only ANSI pattern misses', () => {
    expect(stripTerminalEscapes('a\x1b[?25lb')).toBe('ab'); // hide-cursor
    expect(stripTerminalEscapes('a\x1b[31mb')).toBe('ab'); // plain colour too
  });

  it('strips OSC sequences terminated by BEL or ST', () => {
    expect(stripTerminalEscapes('x\x1b]0;evil title\x07y')).toBe('xy');
    expect(stripTerminalEscapes('x\x1b]8;;http://evil\x1b\\y')).toBe('xy');
  });

  it('strips DCS/SOS/PM/APC sequences and truncated/bare escapes', () => {
    expect(stripTerminalEscapes('x\x1bP+q544e\x1b\\y')).toBe('xy'); // DCS
    expect(stripTerminalEscapes('x\x1b_payload\x1b\\y')).toBe('xy'); // APC
    expect(stripTerminalEscapes('truncated\x1b]0;no-terminator')).toBe('truncated');
    expect(stripTerminalEscapes('dangling\x1b')).toBe('dangling');
  });

  it('spaces out residual raw control bytes (BEL, NUL)', () => {
    expect(stripTerminalEscapes('a\x07b\x00c')).toBe('a b c');
  });
});
