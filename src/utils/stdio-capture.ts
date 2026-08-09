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
// Active UNKEYED captures (captureStdio called without a sessionId — e.g. the outer
// research run's runCapturingStderr). Tracked as a depth counter separate from the keyed
// map so that ending a keyed capture (which recomputes the global flag) cannot clear the
// flag while an unkeyed capture is still active — otherwise a later capture would treat
// stdout/stderr as un-patched, save the still-patched writers as "originals", and on a
// LIFO-violating restore leave them permanently diverted.
let unkeyedCaptureDepth = 0;
let isAnyLoggerCapturingOutput = false;

/**
 * Active captures in creation order. Restoration MUST be LIFO: each capture saves
 * the currently-installed writers/console/fs.writeSync (and the current FD-2
 * target) as its "originals", so a frame that finishes while a later frame is
 * still active must NOT restore — it would re-install the still-active frame's
 * view of the world later, when that frame finally exits, re-pointing stderr,
 * stdout, console.* and OS-level FD 2 at a dead capture's log-file plumbing for
 * the remainder of the process. Keyed captures nest by design (a run's capture
 * around the embedding server's), and nothing orders their exits — a cancelled
 * run's outer capture routinely ends while the embedder-init capture is mid
 * flight. So: an out-of-order finisher only marks its frame retired; the frame
 * on top of the stack performs the actual restores, unwinding every already-
 * retired frame beneath it in strict reverse order.
 */
interface CaptureFrame {
  retired: boolean;
  restore: () => void;
}
const captureStack: CaptureFrame[] = [];

/**
 * Recompute the global "is anything capturing" flag from BOTH the keyed sessions and
 * the unkeyed-capture depth, so neither scheme can clobber the other's state.
 */
function recomputeGlobalCapturing(): void {
  isAnyLoggerCapturingOutput =
    unkeyedCaptureDepth > 0 || Array.from(sessionCaptureStates.values()).some(v => v);
}

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
    // Recompute from all sessions AND active unkeyed captures.
    recomputeGlobalCapturing();
  }
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
    unkeyedCaptureDepth++;
    isAnyLoggerCapturingOutput = true;
  }

  // Separate decoder PER logical byte stream, each used with {stream: true}.
  // A single native write/writeSync call can split a multi-byte UTF-8
  // character across two calls — {stream: true} is what lets a TextDecoder
  // carry an incomplete trailing sequence over to the next decode() and
  // reconstruct it, rather than replacing each half with U+FFFD independently
  // (decode() with no options treats every call as a complete, final input).
  // A SHARED decoder across genuinely independent streams would be its own
  // bug even with {stream: true}: stdout, stderr, and raw FD1/FD2 writes can
  // interleave, and a decoder's carried-over partial bytes are only valid
  // when the next call continues the SAME byte stream — mixing streams would
  // try to complete one stream's dangling sequence with another's bytes.
  const stderrDecoder = new TextDecoder();
  const stdoutDecoder = new TextDecoder();
  const fd1SyncDecoder = new TextDecoder();
  const fd2SyncDecoder = new TextDecoder();

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
        // 0o600 applies only when this open CREATES the file — keeps the log
        // owner-only in a world-traversable tmpdir if rotation removed it.
        const newFd = fs.openSync(logFile, 'a', 0o600);
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
    const message = typeof chunk === 'string' ? chunk : stderrDecoder.decode(chunk, { stream: true });

    // A chunk that lands entirely inside a multi-byte character's bytes
    // decodes to '' with {stream: true} — the bytes are buffered inside
    // stderrDecoder and will surface once the completing chunk arrives. This
    // patch (unlike stdout's) always diverts rather than passing through, so
    // without this guard it would write an empty log entry every time a
    // native write happens to split mid-character.
    if (message.length === 0) {
      if (typeof cb === 'function') cb();
      return true;
    }

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
    const message = typeof chunk === 'string' ? chunk : stdoutDecoder.decode(chunk, { stream: true });
    
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
          const fdDecoder = fd === 1 ? fd1SyncDecoder : fd2SyncDecoder;
          const message = typeof chunk === 'string' ? chunk : fdDecoder.decode(chunk, { stream: true });

          // FD 2 diverts unconditionally below (fd === 2 short-circuits
          // shouldDivert), so unlike FD 1 — whose divert conditions already
          // require non-empty content and naturally fall through to a
          // passthrough write otherwise — an empty message here (a chunk that
          // landed entirely inside a multi-byte character, buffered inside
          // fdDecoder for the completing chunk) must be skipped explicitly to
          // avoid writing an empty log entry on every mid-character split.
          if (fd === 2 && message.length === 0) {
            return (typeof chunk === 'string' ? Buffer.from(chunk).length : (chunk as any).length);
          }

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

  const frame: CaptureFrame = {
    retired: false,
    restore: () => {
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

      // Restore FD 2 to what it was when THIS frame started (for a nested frame
      // that is the enclosing frame's log-file redirect; the enclosing frame's
      // own restore, which always runs after this one in the unwind, then puts
      // the true terminal FD back).
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
    },
  };
  captureStack.push(frame);

  try {
    return await task();
  } finally {
    if (sessionId) {
      setSessionCapturing(sessionId, false);
    } else {
      unkeyedCaptureDepth = Math.max(0, unkeyedCaptureDepth - 1);
      recomputeGlobalCapturing();
    }

    // LIFO unwind (see captureStack): only the top frame restores; an
    // out-of-order finisher parks as retired and is unwound — in reverse
    // order — when everything above it has finished. Until then its patches
    // stay installed, which merely extends capture a little; restoring early
    // would divert stdio permanently.
    frame.retired = true;
    while (captureStack.length > 0 && captureStack[captureStack.length - 1]!.retired) {
      captureStack.pop()!.restore();
    }
  }
}