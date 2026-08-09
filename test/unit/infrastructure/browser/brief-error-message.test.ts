/**
 * briefErrorMessage() — used by task-execution-service.ts's retry-path WARN
 * logs (leader handover / transient socket error, 5 call sites) to summarize
 * an error in a log-line-sized string.
 *
 * Regression: each call site used to do
 *   (error instanceof Error ? error.message : String(error)).substring(0, 100)
 * and interpolate the result directly into the log line — truncating BEFORE
 * redactSecrets ever saw it. A Playwright/undici navigation error routinely
 * echoes the failing URL verbatim, and a URL can carry userinfo credentials
 * (https://user:pass@host/...). If the credential landed past byte 100, the
 * cut left a short fragment too short for redactSecrets' patterns to
 * recognize — leaking a partial credential in the clear. Same class of bug
 * as the truncate-before-redact fix in log-utils.ts's redactSecrets itself;
 * this helper redacts the FULL message first, then truncates the result.
 */

import { describe, it, expect } from 'vitest';
import { briefErrorMessage } from '../../../../src/infrastructure/browser/task-execution-service.ts';

describe('briefErrorMessage', () => {
  it('fully redacts a credential that would otherwise be split by the 100-char cut', () => {
    // 90 chars of filler before the credential so the userinfo secret starts
    // well past byte 100 alone but the URL_CREDENTIALS_PATTERN match (which
    // needs the whole "user:pass@" run) straddles the pre-fix cut point.
    const filler = 'x'.repeat(90);
    const message = `Navigation failed: net::ERR_CONNECTION_REFUSED at https://${filler}user:s3cr3tpass@example.com/path`;

    const out = briefErrorMessage(new Error(message));

    expect(out).not.toContain('s3cr3tpass');
    expect(out).toContain('[REDACTED]');
  });

  it('still bounds the length to roughly a log-line size', () => {
    const out = briefErrorMessage(new Error('y'.repeat(500)));
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('handles non-Error inputs', () => {
    expect(briefErrorMessage('plain string error')).toBe('plain string error');
    expect(briefErrorMessage(42)).toBe('42');
  });
});
