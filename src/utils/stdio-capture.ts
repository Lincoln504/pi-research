/**
 * Stderr/Stdout Capture
 *
 * Captures stderr/stdout during task execution to redirect native logs.
 */

// Use createRequire to get a mutable reference to 'fs'.
// ESM namespace imports (import * as fs from 'node:fs') create bindings that are
// writable at Node.js runtime but flagged as immutable by esbuild's static analysis.
// Since this module needs to monkey-patch fs.writeSync to capture native addon output
// on FD 1/2, we use createRequire — the official Node.js CJS↔ESM interop mechanism
// — to obtain a fully mutable module object.
import { createRequire } from 'node:module';
import type * as FsType from 'node:fs';
import type { Stats } from 'node:fs';
import { TextDecoder } from 'node:util';
import type { LogContext } from './log-utils.ts';
import { getLogContext, formatArg, safeJsonStringify, redactSecrets } from './log-utils.ts';

const fs: typeof FsType = createRequire(import.meta.url)('node:fs');

/**
 * Session-scoped capture flags to support concurrent research runs.
 * Maps session IDs to capture state, with a global flag as fallback.
 */
const sessionCaptureStates = new Map<string, boolean>();
let isAnyLoggerCapturingOutput = false;

/**
 * Check if a session is currently capturing output
 */
export function isSessionCapturing(sessionId?: string): boolean {
  if (sessionId) {
    return sessionCaptureStates.get(sessionId) ?? false;
  }
  return isAnyLoggerCapturingOutput;
}

/**
 * Mark a session as capturing or not capturing
 */
export function setSessionCapturing(sessionId: string, capturing: boolean): void {
  sessionCaptureStates.set(sessionId, capturing);
  if (capturing) {
    isAnyLoggerCapturingOutput = true;
  } else {
    // Update global flag based on all sessions
    isAnyLoggerCapturingOutput = Array.from(sessionCaptureStates.values()).some(v => v);
  }
}

/**
 * Clear a session's capture state
 */
export function clearSessionCapture(sessionId: string): void {
  sessionCaptureStates.delete(sessionId);
  isAnyLoggerCapturingOutput = Array.from(sessionCaptureStates.values()).some(v => v);
}

/**
 * Native log patterns that should be captured
 */
const NATIVE_LOG_PATTERNS = [
  'Warning:',
  'Error:',
  'Dawn',
  'ONNX',
  'ort',
  'maxDynamicStorageBuffersPerPipelineLayout',
  'maxComputeWorkgroupStorageSize',
  'allocation limit',
  'artificially',
  'reduced from',
  'dynamic offset allocation limit',
];

/**
 * Complex TUI ANSI escape sequences
 */
const COMPLEX_TUI_PATTERNS = [
  '\x1b[H',   // Home
  '\x1b[2J',  // Clear screen
  '\x1b[J',   // Clear to end
  '\x1b[K',   // Clear line
  '\x1b[?25', // Cursor visibility
  '\x1b[?1000', // Mouse tracking
  '\x1b[?1002',
  '\x1b[?1003',
  '\x1b[?1006',
  '\x1b[?2004', // Bracketed paste
  '\x1b[<u',     // Kitty protocol
  '\x1b[>4;0m',  // xterm modifyOtherKeys
];

/**
 * Box-drawing characters - definitive TUI marker
 */
const BOX_DRAWING_CHARS = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╴╵╶╷╭╮╯╰╱╲╳]/;

/**
 * Check if a message contains a complex TUI escape sequence
 */
function isComplexTui(message: string): boolean {
  if (!message.includes('\x1b[')) {
    return false;
  }
  
  for (const pattern of COMPLEX_TUI_PATTERNS) {
    if (message.includes(pattern)) {
      return true;
    }
  }
  
  // Check for cursor position patterns (ANSI ESC sequences — control chars intentional)
  // eslint-disable-next-line no-control-regex
  if (/\u001b\[\d+;\d+H/.test(message) || /\u001b\[\d+[ABCD]/.test(message)) {
    return true;
  }
  
  return false;
}

/**
 * Check if a message is a native log (should be captured)
 */
function isNativeLog(message: string): boolean {
  return NATIVE_LOG_PATTERNS.some(pattern => message.includes(pattern));
}

/**
 * Check if a message is box drawing (TUI)
 */
function isBoxDrawing(message: string): boolean {
  return BOX_DRAWING_CHARS.test(message);
}

/**
 * Check if stderr should be redirected
 */
function shouldRedirectStderr(stat: Stats): boolean {
  // Only redirect when FD 2 is a tty or regular file, not a pipe/socket (MCP mode)
  return !stat.isFIFO() && !stat.isSocket();
}

/**
 * Create a console patch function
 */
function createConsolePatch(level: string, logFile: string, hasSufficientDiskSpace: () => boolean) {
  return (...args: unknown[]) => {
    // Check disk space before writing
    if (!hasSufficientDiskSpace()) {
      return;
    }
    
    const timestamp = new Date().toISOString();
    const entry: LogContext = {
      timestamp,
      level: `CONSOLE_${level.toUpperCase()}`,
      ...getLogContext(),
      // Redact secrets + bound size, matching Logger.emit(); captured console
      // output can echo auth headers / tokens from dependencies.
      message: redactSecrets(args.map(formatArg).join(' ')),
    };
    try {
      fs.appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
    } catch { /* ignore */ }
  };
}

/**
 * Run a task while capturing its stderr and stdout
 */
export async function captureStdio<T>(
  logFile: string,
  hasSufficientDiskSpace: () => boolean,
  task: () => Promise<T>,
  sessionId?: string
): Promise<T> {
  // Check if this specific session or any session is already capturing
  const sessionCapturing = sessionId ? isSessionCapturing(sessionId) : false;
  if (!logFile || sessionCapturing || (!sessionId && isAnyLoggerCapturingOutput)) {
    return await task();
  }

  if (sessionId) {
    setSessionCapturing(sessionId, true);
  } else {
    isAnyLoggerCapturingOutput = true;
  }

  const decoder = new TextDecoder();

  // Save originals
  const originalStderrWrite = process.stderr.write;
  const originalStdoutWrite = process.stdout.write;
  const originalFsWriteSync = fs.writeSync;
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  // Redirect FD 2 at the OS level (Linux + macOS only)
  let savedFd2: number = -1;
  let fd2Redirected = false;
  if (process.platform !== 'win32') {
    try {
      const stat = fs.fstatSync(2);
      if (shouldRedirectStderr(stat)) {
        savedFd2 = fs.openSync('/dev/fd/2', 'a');
        fs.closeSync(2);
        const newFd = fs.openSync(logFile, 'a');
        if (newFd === 2) {
          fd2Redirected = true;
        } else {
          // Didn't get FD 2 — undo
          if (newFd >= 0) fs.closeSync(newFd);
          try {
            const r = fs.openSync(`/dev/fd/${savedFd2}`, 'a');
            if (r !== 2 && r >= 0) fs.closeSync(r);
          } catch { /* best-effort restore */ }
          try { fs.closeSync(savedFd2); } catch { /* ignore */ }
          savedFd2 = -1;
        }
      }
    } catch { /* fstat failed or /dev/fd unavailable */ }
  }

  // Patch console methods
  console.log = createConsolePatch('log', logFile, hasSufficientDiskSpace);
  console.info = createConsolePatch('info', logFile, hasSufficientDiskSpace);
  console.warn = createConsolePatch('warn', logFile, hasSufficientDiskSpace);
  console.error = createConsolePatch('error', logFile, hasSufficientDiskSpace);
  console.debug = createConsolePatch('debug', logFile, hasSufficientDiskSpace);

  // Patch stderr.write
  (process.stderr.write as any) = (chunk: string | Uint8Array, encodingOrCb?: any, callback?: any) => {
    const cb = typeof encodingOrCb === 'function' ? encodingOrCb : callback;
    const message = typeof chunk === 'string' ? chunk : decoder.decode(chunk);

    // Check disk space before writing
    if (!hasSufficientDiskSpace()) {
      if (typeof cb === 'function') cb();
      return true;
    }

    const timestamp = new Date().toISOString();
    const entry: LogContext = {
      timestamp,
      level: 'STDERR',
      ...getLogContext(),
      message: redactSecrets(message.trim()),
    };
    try {
      fs.appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
    } catch { /* ignore */ }

    if (typeof cb === 'function') cb();
    return true;
  };

  // Patch stdout.write
  (process.stdout.write as any) = (chunk: string | Uint8Array, encodingOrCb?: any, callback?: any) => {
    const message = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
    
    // Native log patterns or plain text that we want to divert from TUI
    const isNative = isNativeLog(message);
    const complexTui = isComplexTui(message);
    const boxDrawing = isBoxDrawing(message);
    const hasAnsi = message.includes('\x1b[');

    // If it's a known native log, divert it regardless of colors/TUI markers
    if (isNative && !boxDrawing) {
      const timestamp = new Date().toISOString();
      const entry: LogContext = {
        timestamp,
        level: 'STDOUT_NATIVE',
        ...getLogContext(),
        message: redactSecrets(message.trim()),
      };
      try {
        fs.appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
      } catch { /* ignore */ }

      const cb = typeof encodingOrCb === 'function' ? encodingOrCb : callback;
      if (typeof cb === 'function') cb();
      return true;
    }

    // If it's complex TUI or box-drawing, PASS THROUGH
    if (complexTui || boxDrawing) {
      return originalStdoutWrite.call(process.stdout, chunk, encodingOrCb, callback);
    }

    // If it's plain text (no ANSI) and non-empty, divert and log
    if (!hasAnsi && message.trim().length > 0) {
      if (!hasSufficientDiskSpace()) {
        const cb = typeof encodingOrCb === 'function' ? encodingOrCb : callback;
        if (typeof cb === 'function') cb();
        return true;
      }
      
      const timestamp = new Date().toISOString();
      const entry: LogContext = {
        timestamp,
        level: 'STDOUT_PLAIN',
        ...getLogContext(),
        message: redactSecrets(message.trim()),
      };
      try {
        fs.appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
      } catch { /* ignore */ }

      const cb = typeof encodingOrCb === 'function' ? encodingOrCb : callback;
      if (typeof cb === 'function') cb();
      return true;
    }

    // Everything else goes to stdout
    return originalStdoutWrite.call(process.stdout, chunk, encodingOrCb, callback);
  };

  // Patch fs.writeSync for FD 1 and 2
  try {
    const descriptor = Object.getOwnPropertyDescriptor(fs, 'writeSync');
    if (!descriptor || (descriptor.writable || descriptor.set)) {
      fs.writeSync = (fd: number, chunk: any, ...args: any[]) => {
        if (fd === 1 || fd === 2) {
          const message = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
          
          const isNative = isNativeLog(message);
          const boxDrawing = isBoxDrawing(message);
          const complexTui = isComplexTui(message);
          const hasAnsi = message.includes('\x1b[');

          const shouldDivert = fd === 2 || 
            (isNative && !boxDrawing && !complexTui) || 
            (!hasAnsi && !boxDrawing && message.trim().length > 0);

          if (shouldDivert) {
            if (!hasSufficientDiskSpace()) {
              return (typeof chunk === 'string' ? Buffer.from(chunk).length : (chunk as any).length);
            }
            
            const timestamp = new Date().toISOString();
            const entry: LogContext = {
              timestamp,
              level: fd === 1 ? 'FS_WRITE_SYNC_STDOUT' : 'FS_WRITE_SYNC_STDERR',
              ...getLogContext(),
              message: redactSecrets(message.trim()),
            };
            try {
              fs.appendFileSync(logFile, `${safeJsonStringify(entry)}\n`);
            } catch { /* ignore */ }
            return (typeof chunk === 'string' ? Buffer.from(chunk).length : (chunk as any).length);
          }
        }
        return (originalFsWriteSync as any).apply(fs, [fd, chunk, ...args]);
      };
    }
  } catch (_e) { /* ignore */ }

  try {
    return await task();
  } finally {
    // Restore everything
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
    try {
      fs.writeSync = originalFsWriteSync;
    } catch { /* ignore */ }
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
    if (sessionId) {
      setSessionCapturing(sessionId, false);
    } else {
      isAnyLoggerCapturingOutput = false;
    }

    // Restore FD 2
    if (fd2Redirected && savedFd2 >= 0) {
      try {
        fs.closeSync(2);
        const r = fs.openSync(`/dev/fd/${savedFd2}`, 'a');
        if (r !== 2 && r >= 0) {
          // Didn't recover FD 2 — leave restored FD open
        }
        try { fs.closeSync(savedFd2); } catch { /* ignore */ }
      } catch { /* ignore restore errors */ }
    }
  }
}