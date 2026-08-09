/**
 * normalizeUrl() — the fallback-path debug log for an unparseable URL.
 *
 * Regression: the log line truncated `url` to 200 chars BEFORE it ever
 * reached logger.debug's own redactSecrets call. An unparseable URL string
 * can still carry embedded userinfo credentials (https://user:pass@host/...)
 * — if the credential landed past byte 200, the cut sliced it mid-token,
 * leaving a fragment too short for redactSecrets' patterns to recognize.
 * Same class of bug as the truncate-before-redact fix in log-utils.ts's
 * redactSecrets itself.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { normalizeUrl } from '../../../src/utils/url-utils.ts';
import { logger } from '../../../src/logger.ts';

describe('normalizeUrl — unparseable-URL fallback log', () => {
  it('redacts a credential before truncating the logged URL to 200 chars', () => {
    // 185 filler chars places the password's first bytes exactly at the
    // 200-char cut point ("...user:s3c" survives truncation but not the
    // trailing "@", so URL_CREDENTIALS_PATTERN — which requires the whole
    // scheme+user+pass+"@" — can no longer recognize it as a credential and
    // pre-fix left "s3c" exposed in the clear). Post-fix, redaction runs on
    // the FULL string first, so the whole match is replaced before the cut.
    const filler = 'x'.repeat(184);
    // A space makes `new URL(...)` throw, triggering the fallback/debug-log path.
    const bad = `${filler} http://user:s3cr3tpass@evil.example.com`;

    normalizeUrl(bad);

    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    const line = vi.mocked(logger.debug).mock.calls[0]![0] as string;
    // The security property that matters: no password fragment survives.
    // (Redaction runs first and shrinks the string, so the 200-char cut can
    // legitimately land mid-marker — that's cosmetic, not a leak.)
    expect(line).not.toContain('s3c');
  });
});
