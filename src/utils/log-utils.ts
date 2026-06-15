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

export function buildDefaultDebugLogPath(_researchRunId?: string): string {
  const override = process.env['PI_RESEARCH_LOG_PATH'];
  if (override) return override;
  return path.join(os.tmpdir(), 'pi-research.log');
}

export function getConsolidatedLogPath(): string {
  return buildDefaultDebugLogPath();
}

export function getDefaultDebugLogPathTemplate(): string {
  return buildDefaultDebugLogPath('{researchRunId}');
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
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|bearer)\b(["']?\s*[:=]\s*["']?)([^\s"',&)]+)/gi;
// Well-known opaque credential formats (OpenAI, GitHub, AWS, Slack, Anthropic).
const KNOWN_TOKEN_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[posru]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
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
  out = out.replace(SENSITIVE_KV_PATTERN, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  out = out.replace(KNOWN_TOKEN_PATTERN, '[REDACTED]');
  return out;
}

/**
 * Neutralize control characters (newlines, carriage returns, etc.) so that
 * untrusted content cannot forge or corrupt a raw console log line
 * (log-injection defense). Use for sinks that are NOT already structurally
 * escaped — the JSON log file escapes control chars on its own.
 */
export function neutralizeControlChars(message: string): string {
  return message.replace(CONTROL_CHARS_PATTERN, ' ');
}