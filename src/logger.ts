/**
 * Logger
 *
 * Silent by default. When --verbose or PI_RESEARCH_VERBOSE=1 is set,
 * writes timestamped lines to /tmp/pi-research-<timestamp>.log.
 *
 * suppressConsole() globally overrides console.* for duration of research,
 * redirecting to log file (verbose) or silencing entirely (default).
 * Returns a restore function to call when research is done.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const isVerbose =
  process.argv.includes('--verbose') ||
  process.env['PI_RESEARCH_VERBOSE'] === '1';

let logFile: string | null = null;

if (isVerbose) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  logFile = join('/tmp', `pi-research-${ts}.log`);
  try {
    writeFileSync(logFile, `# pi-research verbose log — ${new Date().toISOString()}\n`);
    process.stderr.write(`[pi-research] verbose log: ${logFile}\n`);

    // Ensure logs are saved even on crash/timeout
    setupEmergencyHandlers(logFile);
  } catch { /* ignore write errors */ }
}

/**
 * Setup emergency handlers to ensure log file is saved
 * even if process crashes, is killed, or times out.
 */
function setupEmergencyHandlers(filePath: string): void {
  if (!filePath) return;

  // Handle graceful shutdown signals
  const cleanupAndExit = (signal: string) => {
    process.stderr.write(`\n[pi-research] Received ${signal}, ensuring logs saved to: ${filePath}\n`);
    process.exit(1);
  };

  // Signal handlers for various termination scenarios
  process.on('SIGINT', () => cleanupAndExit('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => cleanupAndExit('SIGTERM')); // kill command
  process.on('SIGHUP', () => cleanupAndExit('SIGHUP'));   // Terminal closed

  // Handle uncaught exceptions
  process.on('uncaughtException', (err: Error) => {
    process.stderr.write(`\n[pi-research] UNCAUGHT EXCEPTION: ${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.stderr.write(`[pi-research] Logs saved to: ${filePath}\n`);
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`\n[pi-research] UNHANDLED PROMISE REJECTION: ${reason}\n`);
    process.stderr.write(`[pi-research] Logs saved to: ${filePath}\n`);
    process.exit(1);
  });
}

function write(level: string, ...args: unknown[]): void {
  if (!logFile) return;
  const msg = args
    .map((a) => (a instanceof Error
      ? `${a.message}`
      : typeof a === 'object'
        ? JSON.stringify(a, null, 0)
        : String(a)))
    .join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try {
    // Use appendFileSync for immediate synchronous write to disk
    appendFileSync(logFile, line);
  } catch {
    // Ignore write errors - we're doing our best
  }
}

export const logger = {
  log:   (...args: unknown[]) => write('INFO',  ...args),
  info:  (...args: unknown[]) => write('INFO',  ...args),
  error: (...args: unknown[]) => write('ERROR', ...args),
  warn:  (...args: unknown[]) => write('WARN',  ...args),
  debug: (...args: unknown[]) => write('DEBUG', ...args),
};

/**
 * Globally redirect all console.* calls to log file (verbose) or /dev/null (default).
 * This silences output from ALL modules — including internal modules, SearXNG manager, etc.
 * Returns a restore function; call it when research ends to undo the override.
 */
export function suppressConsole(): () => void {
  const saved = {
    log:   console.log,
    info:  (console as any).info,
    error: console.error,
    warn:  console.warn,
    debug: (console as any).debug,
  };

  const noop = () => {};
  const toFile = (level: string) => (...args: unknown[]) => write(level, ...args);

  if (isVerbose) {
    console.log          = toFile('INFO')  as typeof console.log;
    (console as any).info  = toFile('INFO');
    console.error        = toFile('ERROR') as typeof console.error;
    console.warn         = toFile('WARN')  as typeof console.warn;
    (console as any).debug = toFile('DEBUG');
  } else {
    console.log          = noop as typeof console.log;
    (console as any).info  = noop;
    console.error        = noop as typeof console.error;
    console.warn         = noop as typeof console.warn;
    (console as any).debug = noop;
  }

  return () => {
    console.log          = saved.log;
    (console as any).info  = saved.info;
    console.error        = saved.error;
    console.warn         = saved.warn;
    (console as any).debug = saved.debug;
  };
}
