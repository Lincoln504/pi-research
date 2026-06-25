/**
 * Log Utilities
 *
 * Utilities for log configuration, context management, and formatting.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LogContext {
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  researchRunId?: string;
  toolName?: string;
  phase?: string;
  eventName?: string;
  [key: string]: unknown;
}

const logContextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Resolve the consolidated diagnostic log path.
 * Defaults to {os.tmpdir()}/pi-research.log; overridable via PI_RESEARCH_LOG_PATH.
 * All scopes (main process, researchers, embedding server, browser worker) write
 * to this single file — logging is intentionally consolidated, not per-run-id.
 */
export function buildDefaultDebugLogPath(): string {
  const override = process.env['PI_RESEARCH_LOG_PATH'];
  if (override) return override;
  return path.join(os.tmpdir(), 'pi-research.log');
}

/**
 * Check whether debug/verbose logging is enabled.
 *
 * Reads PI_RESEARCH_DEBUG env var. This env var is kept in sync with
 * config.DEBUG whenever the config is loaded or saved (see config.ts).
 * Set to "true" to enable INFO+DEBUG logs.
 */
export function isVerboseFromEnv(): boolean {
  return process.env['PI_RESEARCH_DEBUG'] === 'true';
}

export function createResearchRunId(): string {
  return `run-${randomBytes(4).toString('hex')}`;
}

export function getLogContext(): LogContext {
  return logContextStorage.getStore() ?? {};
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  const parent = logContextStorage.getStore() ?? {};
  return logContextStorage.run({ ...parent, ...context }, callback);
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return '[unserializable]';
  }
}

export function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }
  if (typeof arg === 'object' && arg !== null) {
    return safeJsonStringify(arg);
  }
  return String(arg);
}

/** Upper bound on a single log message; defends the log file against being
 *  flooded by large network/scraped payloads passed to the logger. */
const MAX_LOG_MESSAGE_LENGTH = 10_000;

// ANSI escape sequences embedded in untrusted content (we add our own colours
// separately for the console). Matching the ESC control byte is the point here.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
// Credentials embedded in a URL userinfo component: scheme://user:pass@host
const URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/gi;
// key=value / key: "value" pairs whose key names a secret.
const SENSITIVE_KV_PATTERN =
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|bearer|set[_-]?cookie|cookie|session[_-]?id|session|csrf[_-]?token|xsrf[_-]?token|private[_-]?key)\b(["']?\s*[:=]\s*["']?)([^\s"',&)]+)/gi;
// Well-known opaque credential formats (OpenAI, GitHub, AWS, Slack, Anthropic).
const KNOWN_TOKEN_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[posru]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
// JSON Web Tokens — header.payload.signature, each a base64url segment.
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// HTTP Basic credentials: "Basic <base64>".
const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/gi;
// Provider keys not covered by KNOWN_TOKEN_PATTERN: Google API/OAuth, Stripe.
const PROVIDER_TOKEN_PATTERN =
  /\b(AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,}|[sp]k_(?:live|test)_[0-9A-Za-z]{16,})\b/g;
// Long opaque hex secrets (>=32 hex chars), e.g. the 64-hex browser auth secret
// or MD5/SHA-style tokens. Diagnostic logs may over-redact content hashes of
// this length; that trade-off favors not persisting credentials clear-text.
const LONG_HEX_SECRET_PATTERN = /\b[0-9a-fA-F]{32,}\b/g;
// All C0 control characters plus DEL — newlines/carriage returns are the log/
// terminal-injection vector when written to a raw console line. Matching these
// control bytes is exactly the intent.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/g;

/**
 * Redact secrets and bound the size of a log message before it is persisted.
 *
 * Removes embedded ANSI sequences, masks credentials in URLs, sensitive
 * key/value pairs, and known token formats, and truncates oversized payloads.
 * Applied to every message before it reaches the log file or the console, so
 * neither sink receives clear-text secrets or unbounded network data.
 */
export function redactSecrets(message: string): string {
  let out = message.length > MAX_LOG_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}…[truncated ${message.length - MAX_LOG_MESSAGE_LENGTH} chars]`
    : message;
  out = out.replace(ANSI_PATTERN, '');
  out = out.replace(URL_CREDENTIALS_PATTERN, '$1[REDACTED]@');
  // Redact whole-token formats BEFORE the key/value pass: the KV value class
  // stops at whitespace, so "Authorization: Basic <b64>" would otherwise mask
  // only the word "Basic" and leave the credential blob exposed.
  out = out.replace(JWT_PATTERN, '[REDACTED]');
  out = out.replace(BASIC_AUTH_PATTERN, 'Basic [REDACTED]');
  out = out.replace(SENSITIVE_KV_PATTERN, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  out = out.replace(KNOWN_TOKEN_PATTERN, '[REDACTED]');
  out = out.replace(PROVIDER_TOKEN_PATTERN, '[REDACTED]');
  out = out.replace(LONG_HEX_SECRET_PATTERN, '[REDACTED]');
  return out;
}

/**
 * Neutralize control characters (newlines, carriage returns, etc.) so that
 * untrusted content cannot forge or corrupt a raw console log line
 * (log-injection defense). Use for sinks that are NOT already structurally
 * escaped — the JSON log file escapes control chars on its own.
 */
export function neutralizeControlChars(message: string): string {
  // Strip CR/LF explicitly first. These are the actual log-injection vector
  // (forged/corrupted log lines) and an explicit line-break replacement is the
  // form static analysis recognizes as a log-injection sanitizer. The second
  // pass removes any remaining C0 control chars + DEL.
  return message.replace(/\r\n|\r|\n/g, ' ').replace(CONTROL_CHARS_PATTERN, ' ');
}
