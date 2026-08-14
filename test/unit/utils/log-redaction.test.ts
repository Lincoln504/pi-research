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

  it('masks a secret key name carrying an underscore-joined prefix', () => {
    // `\b` is not a boundary between `_` and a letter (both are word chars), so
    // the prefixed env-var form — the single most common way a credential is
    // written down — matched none of the key-name alternatives and was logged
    // in the clear, while the bare `api_key=` next to it was masked.
    for (const line of [
      'PI_RESEARCH_API_KEY=abc123def456ghi789',
      'OPENAI_API_KEY=notaskkeyjustopaque123',
      'ZHIPUAI_API_KEY=3f8a2b.QwErTyUiOpAsDf',
      'DB_PASSWORD=hunter2hunter2',
      'user_password=hunter2',
      'MY_SECRET=hunter2hunter2',
      '{"PI_RESEARCH_API_KEY":"abc.def123456"}',
    ]) {
      const value = line.split(/[=:]/).slice(1).join('=');
      const out = redactSecrets(line);
      expect(out, line).toContain('[REDACTED]');
      expect(out, line).not.toContain(value.replace(/["}]/g, ''));
    }
  });

  it('masks a non-hex value assigned to a prefixed *_SECRET name', () => {
    // The pre-existing PI_BROWSER_AUTH_SECRET coverage passes only because a
    // 64-char run of 'a' is also valid hex — LONG_HEX_SECRET_PATTERN caught it,
    // not the key name. A value that is not hex exercises the key-name path.
    const secret = 'zqx-not-hex-at-all-9911';
    const out = redactSecrets(`PI_BROWSER_AUTH_SECRET=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('does not treat a key name merely CONTAINING a secret word as sensitive', () => {
    // The boundary is relaxed to "not alphanumeric", not dropped: only a real
    // separator (`_`, `-`, start of string) may precede the name.
    expect(redactSecrets('monkey=1')).toContain('monkey=1');
    expect(redactSecrets('keyboard=qwerty')).toContain('keyboard=qwerty');
    expect(redactSecrets('passwordless=true')).toContain('passwordless=true');
  });

  it('does not redact short hex strings like run IDs', () => {
    expect(redactSecrets('run-deadbeef started')).toContain('run-deadbeef');
  });

  it('stays fast on a long unbroken token (URL-scheme backtracking)', () => {
    // URL_CREDENTIALS_PATTERN's scheme part used an unbounded `[a-z0-9+.-]*`, so
    // every start position inside a long alphanumeric run consumed to the end and
    // backtracked one character at a time looking for `://` — quadratic. Across
    // the 40_000-character window redactSecrets scans, that measured ~1.4 SECONDS
    // of blocked event loop, on a function called for EVERY log message and fed
    // largely untrusted content (scraped pages, provider error bodies). One long
    // unbroken token on a page was the whole trigger.
    //
    // The threshold is deliberately loose (a slow shared CI runner must not flake
    // it) while still being ~100x below the pre-fix cost, so a reintroduced
    // unbounded quantifier cannot slip through.
    const hostile = 'a1b2c3d4'.repeat(5_000); // 40_000 chars, no whitespace
    const start = performance.now();
    redactSecrets(hostile);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('still masks URL userinfo credentials after the scheme bound', () => {
    for (const [input, secret] of [
      ['https://alice:s3cr3t@example.com/path', 's3cr3t'],
      ['ftp://u:p4ssw0rd@host/x', 'p4ssw0rd'],
      ['redis+sentinel://user:pw123@h:6379', 'pw123'],
      ['HTTPS://Alice:SecretVal@Example.com', 'SecretVal'],
    ] as const) {
      const out = redactSecrets(input);
      expect(out, input).not.toContain(secret);
      expect(out, input).toContain('[REDACTED]@');
    }
    // A colon in a path is not userinfo and must be left alone.
    expect(redactSecrets('https://example.com/a:b')).toContain('https://example.com/a:b');
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

  it('does not leak a fragment of a secret that straddles the REDACT_SCAN_LENGTH boundary', () => {
    // REDACT_SCAN_LENGTH = MAX_LOG_MESSAGE_LENGTH * 4 = 40_000 (log-utils.ts, not
    // exported): the pre-redaction slice boundary. A straddling secret only
    // surfaces in the VISIBLE output if enough content before that cut is
    // itself secret-dense and shrinks a lot under redaction (the real-world
    // case: many repeated tokens) — plain filler leaves the leaked fragment
    // past the final MAX_LOG_MESSAGE_LENGTH=10_000 keep, discarded either way,
    // which would make this test pass regardless of the bug. Build the filler
    // from repeated long-hex tokens (203 raw chars -> ~13 redacted chars each,
    // ~15x shrink) so the redacted filler lands well under 10_000, pulling the
    // straddling secret's post-redaction position into the visible window.
    const prefix = 'PI_BROWSER_AUTH_SECRET=';
    const secret = 'a'.repeat(64);
    const keptHexChars = 10; // how many hex chars of the secret land BEFORE the 40_000 cut
    const targetFillerLen = 40_000 - prefix.length - keptHexChars;
    const unit = `K=${'f'.repeat(200)} `;
    const unitCount = Math.floor(targetFillerLen / unit.length);
    const filler = unit.repeat(unitCount) + 'z'.repeat(targetFillerLen - unit.length * unitCount);
    const message = filler + prefix + secret + ' trailing';

    const out = redactSecrets(message);

    expect(out).not.toContain('a'.repeat(keptHexChars));
  });

  it('does not print a negative truncated-chars count when redaction expands a short message', () => {
    // SENSITIVE_KV_PATTERN expands each match ("key=1" -> "key=[REDACTED]", +9
    // chars). Enough repetitions of a short match can expand `out` past
    // MAX_LOG_MESSAGE_LENGTH (10_000) even though the raw message stayed under
    // it — pre-fix, the truncation count (rawLength - keep) went negative.
    const message = 'key=1 '.repeat(1000); // 6_000 raw chars ("key=1 " -> "key=[REDACTED] " expands to ~15_000)
    expect(message.length).toBeLessThan(10_000);

    const out = redactSecrets(message);

    expect(out).toContain('truncated');
    expect(out).not.toMatch(/truncated -\d+ chars/);
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
