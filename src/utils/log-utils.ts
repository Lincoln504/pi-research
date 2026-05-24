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
  if (researchRunId) {
    return path.join(os.tmpdir(), `pi-research-${researchRunId}.log`);
  }
  return path.join(os.tmpdir(), 'pi-research.log');
}

export function getDefaultDebugLogPathTemplate(): string {
  return buildDefaultDebugLogPath('{researchRunId}');
}

export function isVerboseFromEnv(): boolean {
  return process.argv.includes('--verbose') || 
         process.argv.includes('-v') ||
         process.argv.includes('--debug') ||
         process.env['PI_RESEARCH_VERBOSE'] === '1' ||
         process.env['PI_RESEARCH_DEBUG'] === '1' ||
         process.env['DEBUG'] === '1' ||
         process.env['DEBUG'] === 'pi-research';
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