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
// Cookie / Set-Cookie headers. The KV value class below stops at whitespace, so
// "Cookie: lang=en; SID=secret123" would mask only the first pair and leave every
// later one exposed. A cookie string is a ;-and-space separated list of secrets,
// not a single token — mask the ENTIRE header value to end-of-line.
const COOKIE_HEADER_PATTERN = /\b(set[_-]?cookie|cookie)\b(["']?\s*[:=]\s*["']?)([^\r\n]+)/gi;
// key=value / key: "value" pairs whose key names a secret. Includes bare
// `key` (not just `api_key`/`private_key`): several provider query-param
// APIs (e.g. StackExchange's `?key=<apikey>`) name the credential parameter
// with no qualifying prefix. Over-redacting an unrelated "key" field (a
// sort key, a map key) is the accepted trade-off — same one already made for
// the equally generic bare `session`/`cookie` entries below.
const SENSITIVE_KV_PATTERN =
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|bearer|set[_-]?cookie|cookie|session[_-]?id|session|csrf[_-]?token|xsrf[_-]?token|private[_-]?key|key)\b(["']?\s*[:=]\s*["']?)([^\s"',&)]+)/gi;
// Well-known opaque credential formats (OpenAI, GitHub, AWS, Slack, Anthropic).
const KNOWN_TOKEN_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[posru]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
// JSON Web Tokens — header.payload.signature, each a base64url segment.
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// HTTP Basic credentials: "Basic <base64>".
const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/gi;
// HTTP Bearer credentials: "Bearer <token>". The token is often opaque — many
// providers (e.g. GLM/zhipuai) use dotted keys that are NOT JWTs and carry no
// known prefix, so KNOWN_TOKEN_PATTERN/JWT_PATTERN miss them and the KV pass
// only masks the word "Bearer" (its value class stops at the space). Match the
// scheme and redact the whole RFC 6750 b64token that follows, whatever its shape.
const BEARER_AUTH_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
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
// How much raw input the regex chain below is allowed to scan before a final
// truncation to MAX_LOG_MESSAGE_LENGTH. A multiple of MAX_LOG_MESSAGE_LENGTH,
// not 1:1, because most patterns below SHRINK text (a 64-char secret becomes
// "[REDACTED]"), so more than `keep` raw characters can be needed to fully
// populate the final truncated output. Nothing past this point can ever
// survive into the visible output regardless, so skipping it is free — this
// is what bounds redactSecrets() to O(MAX_LOG_MESSAGE_LENGTH) instead of
// O(input length) on multi-megabyte scraped payloads.
const REDACT_SCAN_LENGTH = MAX_LOG_MESSAGE_LENGTH * 4;

export function redactSecrets(message: string): string {
  // Redact BEFORE truncating. Every pattern below needs to see a secret in
  // full to match it (e.g. LONG_HEX_SECRET_PATTERN requires 32+ contiguous
  // hex chars) — truncating first can cut a secret mid-token, leaving
  // whatever fragment survives the cut (e.g. the first 20 chars of a 64-hex
  // browser auth secret) too short for any pattern to recognize, so it was
  // written out in the clear right before the "…[truncated N chars]" marker.
  const rawLength = message.length;
  let out = rawLength > REDACT_SCAN_LENGTH ? message.slice(0, REDACT_SCAN_LENGTH) : message;
  out = out.replace(ANSI_PATTERN, '');
  out = out.replace(URL_CREDENTIALS_PATTERN, '$1[REDACTED]@');
  // Redact whole-token formats BEFORE the key/value pass: the KV value class
  // stops at whitespace, so "Authorization: Basic <b64>" would otherwise mask
  // only the word "Basic" and leave the credential blob exposed.
  out = out.replace(JWT_PATTERN, '[REDACTED]');
  out = out.replace(BASIC_AUTH_PATTERN, 'Basic [REDACTED]');
  // Before the KV pass, for the same reason as Basic above: the KV value class
  // stops at the space after "Bearer", leaving an opaque token exposed.
  out = out.replace(BEARER_AUTH_PATTERN, 'Bearer [REDACTED]');
  // Whole-header cookie masking before the KV pass, which would otherwise stop
  // at the first whitespace and leave every subsequent pair in the clear.
  out = out.replace(COOKIE_HEADER_PATTERN, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  out = out.replace(SENSITIVE_KV_PATTERN, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  out = out.replace(KNOWN_TOKEN_PATTERN, '[REDACTED]');
  out = out.replace(PROVIDER_TOKEN_PATTERN, '[REDACTED]');
  out = out.replace(LONG_HEX_SECRET_PATTERN, '[REDACTED]');

  // slice() counts UTF-16 code units, so a naive cut at MAX_LOG_MESSAGE_LENGTH
  // can land between the two halves of a surrogate pair (non-BMP characters —
  // routine in scraped CJK/emoji content). The console sink then writes a
  // lone surrogate, silently mangled to U+FFFD on UTF-8 encode; the JSON-file
  // sink emits an unpaired \uXXXX escape that many strict JSON consumers
  // reject outright. Same back-off truncateWithMarker (text-utils.ts) already
  // applies for the same reason.
  let keep = MAX_LOG_MESSAGE_LENGTH;
  if (out.length > keep) {
    const lastKeptUnit = out.charCodeAt(keep - 1);
    if (lastKeptUnit >= 0xd800 && lastKeptUnit <= 0xdbff) keep -= 1;
  }
  if (out.length > MAX_LOG_MESSAGE_LENGTH) {
    out = `${out.slice(0, keep)}…[truncated ${rawLength - keep} chars]`;
  }
  return out;
}

// Every ESC-initiated terminal sequence — not just the colour/style CSI subset
// ANSI_PATTERN strips. Alternatives, tried in order at each ESC:
//   1. CSI with parameter (incl. private-mode `?`), intermediate, and final
//      bytes per ECMA-48 — catches \x1b[?25l (hide cursor) and kin.
//   2. OSC to BEL or ST (or truncated) — catches \x1b]0;title\x07 retitling.
//   3. DCS/SOS/PM/APC to ST (or truncated).
//   4. Bare ESC plus at most one byte — the fallback that also swallows a
//      trailing/truncated ESC rather than leaking it.
// (Built from strings, so no-control-regex has nothing to flag here.)
const TERMINAL_ESCAPE_PATTERN = new RegExp(
  '\\x1b\\[[0-?]*[ -/]*[@-~]?' +
  '|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?' +
  '|\\x1b[PX^_][^\\x1b]*(?:\\x1b\\\\)?' +
  '|\\x1b.?',
  'g',
);

/**
 * Strip terminal escape sequences and residual control bytes from a line bound
 * for the CONSOLE sink. redactSecrets' ANSI_PATTERN removes only plain CSI
 * colour/style sequences, so private-mode CSI (\x1b[?25l), OSC window-retitling
 * (\x1b]0;…\x07), and DCS/SOS/PM/APC embedded in untrusted content would
 * otherwise reach the user's terminal verbatim under PI_RESEARCH_CONSOLE_LOG.
 * The console sink keeps its own explicit CR/LF→"" replace (the form CodeQL
 * recognizes as the log-injection sanitizer); this handles everything else,
 * spacing out any leftover C0/DEL byte (BEL, backspace, …) via
 * CONTROL_CHARS_PATTERN.
 */
export function stripTerminalEscapes(message: string): string {
  return message.replace(TERMINAL_ESCAPE_PATTERN, '').replace(CONTROL_CHARS_PATTERN, ' ');
}
