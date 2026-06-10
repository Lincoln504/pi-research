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

export function buildDefaultDebugLogPath(researchRunId?: string): string {
  const override = process.env['PI_RESEARCH_LOG_PATH'];
  if (override) return override;
  if (researchRunId) {
    return path.join(os.tmpdir(), `pi-research-${researchRunId}.log`);
  }
  return path.join(os.tmpdir(), 'pi-research.log');
}

export function getDefaultDebugLogPathTemplate(): string {
  return buildDefaultDebugLogPath('{researchRunId}');
}

/**
 * Check whether debug/verbose logging is enabled.
 *
 * Only source of truth: PI_RESEARCH_DEBUG env var (or the config DEBUG field
 * which reads from the same env var). Set to "true" to enable INFO+DEBUG logs.
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