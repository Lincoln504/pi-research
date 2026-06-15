var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/utils/log-utils.ts
import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";
import * as path from "node:path";
function buildDefaultDebugLogPath(_researchRunId) {
  const override = process.env["PI_RESEARCH_LOG_PATH"];
  if (override) return override;
  return path.join(os.tmpdir(), "pi-research.log");
}
function isVerboseFromEnv() {
  return process.env["PI_RESEARCH_DEBUG"] === "true";
}
function getLogContext() {
  return logContextStorage.getStore() ?? {};
}
function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return "[unserializable]";
  }
}
function formatArg(arg) {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }
  if (typeof arg === "object" && arg !== null) {
    return safeJsonStringify(arg);
  }
  return String(arg);
}
function redactSecrets(message) {
  let out = message.length > MAX_LOG_MESSAGE_LENGTH ? `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}\u2026[truncated ${message.length - MAX_LOG_MESSAGE_LENGTH} chars]` : message;
  out = out.replace(ANSI_PATTERN, "");
  out = out.replace(URL_CREDENTIALS_PATTERN, "$1[REDACTED]@");
  out = out.replace(JWT_PATTERN, "[REDACTED]");
  out = out.replace(BASIC_AUTH_PATTERN, "Basic [REDACTED]");
  out = out.replace(SENSITIVE_KV_PATTERN, (_m, key, sep) => `${key}${sep}[REDACTED]`);
  out = out.replace(KNOWN_TOKEN_PATTERN, "[REDACTED]");
  out = out.replace(PROVIDER_TOKEN_PATTERN, "[REDACTED]");
  out = out.replace(LONG_HEX_SECRET_PATTERN, "[REDACTED]");
  return out;
}
function neutralizeControlChars(message) {
  return message.replace(/\r\n|\r|\n/g, " ").replace(CONTROL_CHARS_PATTERN, " ");
}
var logContextStorage, MAX_LOG_MESSAGE_LENGTH, ANSI_PATTERN, URL_CREDENTIALS_PATTERN, SENSITIVE_KV_PATTERN, KNOWN_TOKEN_PATTERN, JWT_PATTERN, BASIC_AUTH_PATTERN, PROVIDER_TOKEN_PATTERN, LONG_HEX_SECRET_PATTERN, CONTROL_CHARS_PATTERN;
var init_log_utils = __esm({
  "src/utils/log-utils.ts"() {
    "use strict";
    logContextStorage = new AsyncLocalStorage();
    MAX_LOG_MESSAGE_LENGTH = 1e4;
    ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
    URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/gi;
    SENSITIVE_KV_PATTERN = /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|bearer|set[_-]?cookie|cookie|session[_-]?id|session|csrf[_-]?token|xsrf[_-]?token|private[_-]?key)\b(["']?\s*[:=]\s*["']?)([^\s"',&)]+)/gi;
    KNOWN_TOKEN_PATTERN = /\b(sk-[A-Za-z0-9_-]{16,}|gh[posru]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
    JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
    BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/gi;
    PROVIDER_TOKEN_PATTERN = /\b(AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,}|[sp]k_(?:live|test)_[0-9A-Za-z]{16,})\b/g;
    LONG_HEX_SECRET_PATTERN = /\b[0-9a-fA-F]{32,}\b/g;
    CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/g;
  }
});

// src/utils/error-tracker.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
var trackerStorage, ErrorTracker, globalInstance, errorTracker;
var init_error_tracker = __esm({
  "src/utils/error-tracker.ts"() {
    "use strict";
    trackerStorage = new AsyncLocalStorage2();
    ErrorTracker = class {
      patterns = /* @__PURE__ */ new Map();
      MAX_CONTEXTS_PER_PATTERN = 10;
      /**
       * Normalize an error message to extract a stable signature.
       * Removes UUIDs, numbers (except HTTP status codes), URLs, and normalizes whitespace.
       *
       * @param message - The error message to normalize
       * @returns A normalized signature for grouping similar errors
       */
      extractSignature(message) {
        return message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>").replace(/\b(?![12]\d{2}\b|[3-5]\d{2}\b)\d+\b/g, "<NUM>").replace(/https?:\/\/[^\s]+/g, "<URL>").replace(/\s+/g, " ").trim();
      }
      /**
       * Track an error with optional context.
       * Groups similar errors by normalized signature and maintains a rolling buffer of contexts.
       *
       * @param error - The error to track (Error object, string message, or unknown)
       * @param context - Optional context information about where the error occurred
       */
      trackError(error, context2 = {}) {
        let message;
        if (error instanceof Error) {
          message = error.message;
        } else if (typeof error === "string") {
          message = error;
        } else {
          message = String(error);
        }
        const signature = this.extractSignature(message);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        let pattern = this.patterns.get(signature);
        if (!pattern) {
          pattern = {
            signature,
            message,
            count: 0,
            firstSeen: now,
            lastSeen: now,
            contexts: [],
            domainCounts: /* @__PURE__ */ new Map()
          };
          this.patterns.set(signature, pattern);
        }
        pattern.count++;
        pattern.lastSeen = now;
        if (context2.domain) {
          const currentCount = pattern.domainCounts.get(context2.domain) ?? 0;
          pattern.domainCounts.set(context2.domain, currentCount + 1);
        }
        pattern.contexts.push(context2);
        if (pattern.contexts.length > this.MAX_CONTEXTS_PER_PATTERN) {
          pattern.contexts.shift();
        }
      }
      /**
       * Generate a complete error report with sorted patterns and domain/type breakdowns.
       *
       * @returns An ErrorReport with aggregated error information
       */
      getReport() {
        const patterns = Array.from(this.patterns.values());
        let totalErrors = 0;
        for (const pattern of patterns) {
          totalErrors += pattern.count;
        }
        patterns.sort((a, b) => b.count - a.count);
        const byDomain = this.getErrorsByDomain();
        const byType = this.getErrorsByType();
        return {
          totalErrors,
          uniquePatterns: patterns.length,
          patterns,
          byDomain,
          byType
        };
      }
      /**
       * Group errors by domain from context information.
       *
       * @returns A Map of domain names to error counts
       */
      getErrorsByDomain() {
        const totalDomainCounts = /* @__PURE__ */ new Map();
        for (const pattern of this.patterns.values()) {
          for (const [domain, count] of pattern.domainCounts.entries()) {
            totalDomainCounts.set(domain, (totalDomainCounts.get(domain) ?? 0) + count);
          }
        }
        return totalDomainCounts;
      }
      /**
       * Group errors by type (first part of signature before colon or first few words).
       *
       * @returns A Map of error types to error counts
       */
      getErrorsByType() {
        const typeCounts = /* @__PURE__ */ new Map();
        for (const pattern of this.patterns.values()) {
          const parts = pattern.signature.split(":");
          let type = parts[0]?.trim() ?? "Unknown";
          if (type === pattern.signature) {
            const words = pattern.signature.split(" ");
            const firstWords = words.slice(0, 3).filter((w) => w.length > 0);
            type = firstWords.length > 0 ? firstWords.join(" ") : "Unknown";
          }
          typeCounts.set(type, (typeCounts.get(type) ?? 0) + pattern.count);
        }
        return typeCounts;
      }
      /**
       * Clear all tracked errors (called between research runs).
       */
      clear() {
        this.patterns.clear();
      }
    };
    globalInstance = new ErrorTracker();
    errorTracker = new Proxy(globalInstance, {
      get(target, prop, receiver) {
        const currentTracker = trackerStorage.getStore() ?? target;
        const value = Reflect.get(currentTracker, prop, receiver);
        if (typeof value === "function") {
          return value.bind(currentTracker);
        }
        return value;
      }
    });
  }
});

// src/utils/log-rotation.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
var LogRotation;
var init_log_rotation = __esm({
  "src/utils/log-rotation.ts"() {
    "use strict";
    LogRotation = class {
      MAX_LOG_SIZE = 10 * 1024 * 1024;
      // 10MB max file size
      MAX_LOG_FILES = 10;
      // Keep last 10 archived logs
      lastRotationCheck = 0;
      logger;
      constructor(logger2) {
        this.logger = logger2;
      }
      /**
       * Clear all research logs including archives.
       */
      clearLogs(logFile, logDir) {
        try {
          if (fs2.existsSync(logFile)) {
            fs2.unlinkSync(logFile);
          }
          const files = fs2.readdirSync(logDir);
          const baseName = path2.basename(logFile);
          const archives = files.filter((f) => f.startsWith(baseName) && f !== baseName);
          for (const archive of archives) {
            try {
              fs2.unlinkSync(path2.join(logDir, archive));
            } catch {
            }
          }
          this.logger.log("[Logger] All logs and archives cleared.");
        } catch (err) {
          this.logger.log("[Logger] Failed to clear logs:", err);
        }
      }
      /**
       * Rotate log files when they exceed MAX_LOG_SIZE.
       * Archives are created with ISO timestamp suffix.
       * Old archives beyond MAX_LOG_FILES are cleaned up.
       */
      rotateLogFile(logFile, logDir) {
        try {
          const stats = fs2.statSync(logFile);
          const fileSize = stats.size;
          if (fileSize <= this.MAX_LOG_SIZE) {
            return;
          }
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          const archivePath = `${logFile}.${timestamp}`;
          try {
            fs2.renameSync(logFile, archivePath);
          } catch (renameErr) {
            if (process.platform === "win32") {
              fs2.copyFileSync(logFile, archivePath);
              fs2.unlinkSync(logFile);
            } else {
              throw renameErr;
            }
          }
          try {
            const files = fs2.readdirSync(logDir);
            const logFiles = files.filter((f) => f.startsWith(path2.basename(logFile)) && f !== path2.basename(logFile)).sort();
            const toDelete = logFiles.slice(0, -this.MAX_LOG_FILES);
            for (const file of toDelete) {
              try {
                fs2.unlinkSync(path2.join(logDir, file));
              } catch {
              }
            }
          } catch {
          }
          this.logger.log("[Logger] Rotated log file to:", archivePath);
        } catch (_error) {
        }
      }
      /**
       * Check if rotation is needed and perform if necessary.
       * @returns true if rotation was performed
       */
      checkAndRotate(logFile, logDir, force = false) {
        const now = Date.now();
        if (force || now - this.lastRotationCheck > 6e4) {
          this.rotateLogFile(logFile, logDir);
          this.lastRotationCheck = now;
          return true;
        }
        return false;
      }
    };
  }
});

// src/utils/disk-space-checker.ts
import * as fs3 from "node:fs";
import { execSync } from "node:child_process";
var DiskSpaceChecker;
var init_disk_space_checker = __esm({
  "src/utils/disk-space-checker.ts"() {
    "use strict";
    DiskSpaceChecker = class {
      MIN_DISK_SPACE_BYTES = 1048576;
      // 1MB minimum
      DISK_SPACE_CHECK_INTERVAL_MS = 6e4;
      // Check every 60 seconds
      lastDiskSpaceCheck = 0;
      hasDiskSpace = true;
      /**
       * Check if there is sufficient disk space for logging.
       * Checks are throttled to avoid excessive filesystem operations.
       */
      checkDiskSpace(logDir) {
        const now = Date.now();
        if (now - this.lastDiskSpaceCheck < this.DISK_SPACE_CHECK_INTERVAL_MS) {
          return this.hasDiskSpace;
        }
        this.lastDiskSpaceCheck = now;
        try {
          if (typeof fs3.statfs !== "undefined") {
            const stats = fs3.statfsSync(logDir);
            const availableBytes = stats.bavail * stats.bsize;
            if (availableBytes < this.MIN_DISK_SPACE_BYTES) {
              this.hasDiskSpace = false;
              process.stderr.write(
                `[pi-research] Insufficient disk space for logging: ${Math.round(availableBytes / 1024 / 1024)}MB available, minimum ${this.MIN_DISK_SPACE_BYTES / 1024 / 1024}MB required
`
              );
            } else {
              this.hasDiskSpace = true;
            }
          } else {
            try {
              const output = execSync("wmic logicaldisk get freespace /value", { encoding: "utf-8", timeout: 5e3 });
              const match = output.match(/FreeSpace=(\d+)/);
              const availableBytes = match ? parseInt(match[1], 10) : Infinity;
              this.hasDiskSpace = availableBytes >= this.MIN_DISK_SPACE_BYTES;
            } catch {
              this.hasDiskSpace = true;
            }
          }
        } catch (_error) {
          this.hasDiskSpace = true;
        }
        return this.hasDiskSpace;
      }
    };
  }
});

// src/utils/stdio-capture.ts
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";
function isSessionCapturing(sessionId) {
  if (sessionId) {
    return sessionCaptureStates.get(sessionId) ?? false;
  }
  return isAnyLoggerCapturingOutput;
}
function setSessionCapturing(sessionId, capturing) {
  sessionCaptureStates.set(sessionId, capturing);
  if (capturing) {
    isAnyLoggerCapturingOutput = true;
  } else {
    isAnyLoggerCapturingOutput = Array.from(sessionCaptureStates.values()).some((v) => v);
  }
}
function isComplexTui(message) {
  if (!message.includes("\x1B[")) {
    return false;
  }
  for (const pattern of COMPLEX_TUI_PATTERNS) {
    if (message.includes(pattern)) {
      return true;
    }
  }
  if (/\u001b\[\d+;\d+H/.test(message) || /\u001b\[\d+[ABCD]/.test(message)) {
    return true;
  }
  return false;
}
function isNativeLog(message) {
  return NATIVE_LOG_PATTERNS.some((pattern) => message.includes(pattern));
}
function isBoxDrawing(message) {
  return BOX_DRAWING_CHARS.test(message);
}
function shouldRedirectStderr(stat) {
  return !stat.isFIFO() && !stat.isSocket();
}
function createConsolePatch(level, logFile, hasSufficientDiskSpace) {
  return (...args) => {
    if (!hasSufficientDiskSpace()) {
      return;
    }
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const entry = {
      timestamp,
      level: `CONSOLE_${level.toUpperCase()}`,
      ...getLogContext(),
      // Redact secrets + bound size, matching Logger.emit(); captured console
      // output can echo auth headers / tokens from dependencies.
      message: redactSecrets(args.map(formatArg).join(" "))
    };
    try {
      fs4.appendFileSync(logFile, `${safeJsonStringify(entry)}
`);
    } catch {
    }
  };
}
async function captureStdio(logFile, hasSufficientDiskSpace, task, sessionId) {
  const sessionCapturing = sessionId ? isSessionCapturing(sessionId) : false;
  if (!logFile || sessionCapturing || !sessionId && isAnyLoggerCapturingOutput) {
    return await task();
  }
  if (sessionId) {
    setSessionCapturing(sessionId, true);
  } else {
    isAnyLoggerCapturingOutput = true;
  }
  const decoder = new TextDecoder();
  const originalStderrWrite = process.stderr.write;
  const originalStdoutWrite = process.stdout.write;
  const originalFsWriteSync = fs4.writeSync;
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };
  let savedFd2 = -1;
  let fd2Redirected = false;
  if (process.platform !== "win32") {
    try {
      const stat = fs4.fstatSync(2);
      if (shouldRedirectStderr(stat)) {
        savedFd2 = fs4.openSync("/dev/fd/2", "a");
        fs4.closeSync(2);
        const newFd = fs4.openSync(logFile, "a");
        if (newFd === 2) {
          fd2Redirected = true;
        } else {
          if (newFd >= 0) fs4.closeSync(newFd);
          try {
            const r = fs4.openSync(`/dev/fd/${savedFd2}`, "a");
            if (r !== 2 && r >= 0) fs4.closeSync(r);
          } catch {
          }
          try {
            fs4.closeSync(savedFd2);
          } catch {
          }
          savedFd2 = -1;
        }
      }
    } catch {
    }
  }
  console.log = createConsolePatch("log", logFile, hasSufficientDiskSpace);
  console.info = createConsolePatch("info", logFile, hasSufficientDiskSpace);
  console.warn = createConsolePatch("warn", logFile, hasSufficientDiskSpace);
  console.error = createConsolePatch("error", logFile, hasSufficientDiskSpace);
  console.debug = createConsolePatch("debug", logFile, hasSufficientDiskSpace);
  process.stderr.write = (chunk, encodingOrCb, callback) => {
    const cb = typeof encodingOrCb === "function" ? encodingOrCb : callback;
    const message = typeof chunk === "string" ? chunk : decoder.decode(chunk);
    if (!hasSufficientDiskSpace()) {
      if (typeof cb === "function") cb();
      return true;
    }
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const entry = {
      timestamp,
      level: "STDERR",
      ...getLogContext(),
      message: redactSecrets(message.trim())
    };
    try {
      fs4.appendFileSync(logFile, `${safeJsonStringify(entry)}
`);
    } catch {
    }
    if (typeof cb === "function") cb();
    return true;
  };
  process.stdout.write = (chunk, encodingOrCb, callback) => {
    const message = typeof chunk === "string" ? chunk : decoder.decode(chunk);
    const isNative = isNativeLog(message);
    const complexTui = isComplexTui(message);
    const boxDrawing = isBoxDrawing(message);
    const hasAnsi = message.includes("\x1B[");
    if (isNative && !boxDrawing) {
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      const entry = {
        timestamp,
        level: "STDOUT_NATIVE",
        ...getLogContext(),
        message: redactSecrets(message.trim())
      };
      try {
        fs4.appendFileSync(logFile, `${safeJsonStringify(entry)}
`);
      } catch {
      }
      const cb = typeof encodingOrCb === "function" ? encodingOrCb : callback;
      if (typeof cb === "function") cb();
      return true;
    }
    if (complexTui || boxDrawing) {
      return originalStdoutWrite.call(process.stdout, chunk, encodingOrCb, callback);
    }
    if (!hasAnsi && message.trim().length > 0) {
      if (!hasSufficientDiskSpace()) {
        const cb2 = typeof encodingOrCb === "function" ? encodingOrCb : callback;
        if (typeof cb2 === "function") cb2();
        return true;
      }
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      const entry = {
        timestamp,
        level: "STDOUT_PLAIN",
        ...getLogContext(),
        message: redactSecrets(message.trim())
      };
      try {
        fs4.appendFileSync(logFile, `${safeJsonStringify(entry)}
`);
      } catch {
      }
      const cb = typeof encodingOrCb === "function" ? encodingOrCb : callback;
      if (typeof cb === "function") cb();
      return true;
    }
    return originalStdoutWrite.call(process.stdout, chunk, encodingOrCb, callback);
  };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(fs4, "writeSync");
    if (!descriptor || (descriptor.writable || descriptor.set)) {
      fs4.writeSync = (fd, chunk, ...args) => {
        if (fd === 1 || fd === 2) {
          const message = typeof chunk === "string" ? chunk : decoder.decode(chunk);
          const isNative = isNativeLog(message);
          const boxDrawing = isBoxDrawing(message);
          const complexTui = isComplexTui(message);
          const hasAnsi = message.includes("\x1B[");
          const shouldDivert = fd === 2 || isNative && !boxDrawing && !complexTui || !hasAnsi && !boxDrawing && message.trim().length > 0;
          if (shouldDivert) {
            if (!hasSufficientDiskSpace()) {
              return typeof chunk === "string" ? Buffer.from(chunk).length : chunk.length;
            }
            const timestamp = (/* @__PURE__ */ new Date()).toISOString();
            const entry = {
              timestamp,
              level: fd === 1 ? "FS_WRITE_SYNC_STDOUT" : "FS_WRITE_SYNC_STDERR",
              ...getLogContext(),
              message: redactSecrets(message.trim())
            };
            try {
              fs4.appendFileSync(logFile, `${safeJsonStringify(entry)}
`);
            } catch {
            }
            return typeof chunk === "string" ? Buffer.from(chunk).length : chunk.length;
          }
        }
        return originalFsWriteSync.apply(fs4, [fd, chunk, ...args]);
      };
    }
  } catch (_e) {
  }
  try {
    return await task();
  } finally {
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
    try {
      fs4.writeSync = originalFsWriteSync;
    } catch {
    }
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
    if (fd2Redirected && savedFd2 >= 0) {
      try {
        fs4.closeSync(2);
        const r = fs4.openSync(`/dev/fd/${savedFd2}`, "a");
        if (r !== 2 && r >= 0) {
        }
        try {
          fs4.closeSync(savedFd2);
        } catch {
        }
      } catch {
      }
    }
  }
}
var fs4, sessionCaptureStates, isAnyLoggerCapturingOutput, NATIVE_LOG_PATTERNS, COMPLEX_TUI_PATTERNS, BOX_DRAWING_CHARS;
var init_stdio_capture = __esm({
  "src/utils/stdio-capture.ts"() {
    "use strict";
    init_log_utils();
    fs4 = createRequire(import.meta.url)("node:fs");
    sessionCaptureStates = /* @__PURE__ */ new Map();
    isAnyLoggerCapturingOutput = false;
    NATIVE_LOG_PATTERNS = [
      "Warning:",
      "Error:",
      "Dawn",
      "ONNX",
      "ort",
      "maxDynamicStorageBuffersPerPipelineLayout",
      "maxComputeWorkgroupStorageSize",
      "allocation limit",
      "artificially",
      "reduced from",
      "dynamic offset allocation limit"
    ];
    COMPLEX_TUI_PATTERNS = [
      "\x1B[H",
      // Home
      "\x1B[2J",
      // Clear screen
      "\x1B[J",
      // Clear to end
      "\x1B[K",
      // Clear line
      "\x1B[?25",
      // Cursor visibility
      "\x1B[?1000",
      // Mouse tracking
      "\x1B[?1002",
      "\x1B[?1003",
      "\x1B[?1006",
      "\x1B[?2004",
      // Bracketed paste
      "\x1B[<u",
      // Kitty protocol
      "\x1B[>4;0m"
      // xterm modifyOtherKeys
    ];
    BOX_DRAWING_CHARS = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╴╵╶╷╭╮╯╰╱╲╳]/;
  }
});

// src/logger.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync } from "node:fs";
import { AsyncLocalStorage as AsyncLocalStorage3 } from "node:async_hooks";
import * as path3 from "node:path";
function getLogger(sessionId) {
  const contextLogger = loggerContext.getStore();
  if (contextLogger) return contextLogger;
  if (sessionId) {
    let lg = sessionLoggers.get(sessionId);
    if (!lg) {
      lg = new Logger({
        verbose: isVerboseFromEnv(),
        researchRunId: sessionId,
        consoleLog: process.env["PI_RESEARCH_CONSOLE_LOG"] === "true"
      });
      sessionLoggers.set(sessionId, lg);
    }
    return lg;
  }
  if (!_globalLogger) {
    _globalLogger = new Logger({
      verbose: isVerboseFromEnv(),
      consoleLog: process.env["PI_RESEARCH_CONSOLE_LOG"] === "true"
    });
  }
  return _globalLogger;
}
var LOGGER_BRAND, Logger, loggerContext, sessionLoggers, _globalLogger, logger;
var init_logger = __esm({
  "src/logger.ts"() {
    "use strict";
    init_error_tracker();
    init_log_utils();
    init_log_rotation();
    init_disk_space_checker();
    init_stdio_capture();
    init_log_utils();
    LOGGER_BRAND = /* @__PURE__ */ Symbol.for("pi-research.Logger");
    Logger = class {
      verbose;
      consoleLog;
      logFile;
      logDir;
      sessionId;
      [LOGGER_BRAND] = true;
      rotation;
      diskSpaceChecker;
      constructor(options = {}) {
        this.verbose = options.verbose ?? isVerboseFromEnv();
        this.consoleLog = options.consoleLog ?? process.env["PI_RESEARCH_CONSOLE_LOG"] === "true";
        this.logFile = options.logFilePath ?? buildDefaultDebugLogPath();
        this.logDir = path3.dirname(this.logFile);
        this.sessionId = options.researchRunId;
        this.rotation = new LogRotation(this);
        this.diskSpaceChecker = new DiskSpaceChecker();
        try {
          if (!existsSync2(this.logDir)) {
            mkdirSync(this.logDir, { recursive: true });
          }
        } catch {
        }
      }
      emit(level, ...args) {
        if (!this.verbose && (level === "INFO" /* INFO */ || level === "DEBUG" /* DEBUG */)) {
          return;
        }
        if (!this.diskSpaceChecker.checkDiskSpace(this.logDir)) {
          return;
        }
        const force = level === "ERROR" || level === "WARN";
        this.rotation.checkAndRotate(this.logFile, this.logDir, force);
        const timestamp = (/* @__PURE__ */ new Date()).toISOString();
        const firstError = args.find((arg) => arg instanceof Error);
        const message = redactSecrets(args.map(formatArg).join(" "));
        const entry = {
          timestamp,
          level,
          ...getLogContext(),
          message,
          ...firstError ? { errorMessage: redactSecrets(firstError.message), errorStack: redactSecrets(firstError.stack ?? "") } : {}
        };
        const line = `${safeJsonStringify(entry)}
`;
        try {
          appendFileSync(this.logFile, line);
        } catch {
        }
        if (this.consoleLog) {
          const color = level === "ERROR" /* ERROR */ ? "\x1B[31m" : level === "WARN" /* WARN */ ? "\x1B[33m" : level === "DEBUG" /* DEBUG */ ? "\x1B[90m" : "\x1B[36m";
          const reset = "\x1B[0m";
          const msg = neutralizeControlChars(message);
          const prefix = this.sessionId ? `[${this.sessionId}] ` : "";
          console.log(`${color}${timestamp} ${level} ${prefix}${reset}${msg}`);
        }
      }
      async runCapturingStderr(task) {
        return captureStdio(
          this.logFile,
          () => this.diskSpaceChecker.checkDiskSpace(this.logDir),
          task,
          this.sessionId
        );
      }
      log(...args) {
        this.emit("INFO" /* INFO */, ...args);
      }
      info(...args) {
        this.emit("INFO" /* INFO */, ...args);
      }
      error(...args) {
        const errArg = args.find((arg) => arg instanceof Error);
        if (errArg) {
          const context2 = getLogContext();
          errorTracker.trackError(errArg, context2);
        }
        this.emit("ERROR" /* ERROR */, ...args);
      }
      warn(...args) {
        this.emit("WARN" /* WARN */, ...args);
      }
      debug(...args) {
        this.emit("DEBUG" /* DEBUG */, ...args);
      }
      clear() {
        this.rotation.clearLogs(this.logFile, this.logDir);
      }
      getLogFilePath() {
        return this.logFile;
      }
      isVerbose() {
        return this.verbose;
      }
    };
    loggerContext = new AsyncLocalStorage3();
    sessionLoggers = /* @__PURE__ */ new Map();
    _globalLogger = null;
    logger = {
      log: (...args) => getLogger().log(...args),
      info: (...args) => getLogger().info(...args),
      error: (...args) => getLogger().error(...args),
      warn: (...args) => getLogger().warn(...args),
      debug: (...args) => getLogger().debug(...args),
      clear: () => getLogger().clear(),
      runCapturingStderr: (task) => getLogger().runCapturingStderr(task)
    };
  }
});

// src/utils/metrics.ts
import { AsyncLocalStorage as AsyncLocalStorage4 } from "node:async_hooks";
var MetricsRegistry, runRegistryStorage, MAX_RUN_HISTORY, SessionMetrics, metrics;
var init_metrics = __esm({
  "src/utils/metrics.ts"() {
    "use strict";
    init_logger();
    MetricsRegistry = class {
      counters = /* @__PURE__ */ new Map();
      gauges = /* @__PURE__ */ new Map();
      histograms = /* @__PURE__ */ new Map();
      serializeLabels(labels) {
        if (!labels) return "";
        const keys = Object.keys(labels).sort();
        return keys.map((k) => `${k}="${labels[k]}"`).join(",");
      }
      getKey(name, labels) {
        const labelStr = this.serializeLabels(labels);
        return labelStr ? `${name}{${labelStr}}` : name;
      }
      increment(name, value = 1, labels) {
        const key = this.getKey(name, labels);
        this.counters.set(key, (this.counters.get(key) ?? 0) + value);
        if (name === "llm_cost_total" || name === "llm_tokens_total") {
          logger.debug(`[Metrics] Incremented ${name} by ${value}${labels ? ` (labels: ${JSON.stringify(labels)})` : ""}`);
        }
      }
      setGauge(name, value, labels) {
        this.gauges.set(this.getKey(name, labels), value);
      }
      observe(name, value, labels) {
        if (!Number.isFinite(value)) return;
        const key = this.getKey(name, labels);
        let entry = this.histograms.get(key);
        if (!entry) {
          entry = { values: [], pointer: 0, limit: 1e4, dirty: true, cached: null };
          this.histograms.set(key, entry);
        }
        entry.dirty = true;
        if (entry.values.length < entry.limit) {
          entry.values.push(value);
        } else {
          entry.values[entry.pointer] = value;
          entry.pointer = (entry.pointer + 1) % entry.limit;
        }
      }
      async measure(name, action, labels) {
        const start = process.hrtime.bigint();
        try {
          const result = await action();
          this.observe(name, Number(process.hrtime.bigint() - start) / 1e6, labels);
          return result;
        } catch (error) {
          this.observe(name, Number(process.hrtime.bigint() - start) / 1e6, { ...labels, error: "true" });
          this.increment(`${name}_errors_total`, 1, labels);
          throw error;
        }
      }
      percentile(sorted, pct) {
        const len = sorted.length;
        if (len === 0) return 0;
        if (len === 1) return sorted[0] ?? 0;
        if (pct <= 0) return sorted[0] ?? 0;
        if (pct >= 100) return sorted[len - 1] ?? 0;
        const rank = pct / 100 * (len - 1);
        const lo = Math.floor(rank);
        const hi = Math.ceil(rank);
        const w = rank - lo;
        return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * w;
      }
      getSnapshot() {
        const snap = { counters: {}, gauges: {}, histograms: {} };
        for (const [k, v] of this.counters) snap.counters[k] = v;
        for (const [k, v] of this.gauges) snap.gauges[k] = v;
        for (const [k, entry] of this.histograms) {
          if (entry.values.length === 0) continue;
          if (!entry.dirty && entry.cached) {
            snap.histograms[k] = entry.cached;
            continue;
          }
          const vals = entry.values;
          const sorted = vals.slice().sort((a, b) => a - b);
          const sum = sorted.reduce((a, b) => a + b, 0);
          const histogram = {
            count: sorted.length,
            min: sorted[0] ?? 0,
            max: sorted[sorted.length - 1] ?? 0,
            avg: sum / sorted.length,
            p50: this.percentile(sorted, 50),
            p90: this.percentile(sorted, 90),
            p95: this.percentile(sorted, 95),
            p99: this.percentile(sorted, 99)
          };
          entry.cached = histogram;
          entry.dirty = false;
          snap.histograms[k] = histogram;
        }
        return snap;
      }
      clear() {
        this.counters.clear();
        this.gauges.clear();
        this.histograms.clear();
      }
    };
    runRegistryStorage = new AsyncLocalStorage4();
    MAX_RUN_HISTORY = 10;
    SessionMetrics = class {
      _session = new MetricsRegistry();
      _sessionStartedAt = Date.now();
      _runHistory = [];
      getActive() {
        return runRegistryStorage.getStore() ?? this._session;
      }
      // ── Emit API (routes to active registry) ──────────────────────────────
      increment(name, value = 1, labels) {
        this.getActive().increment(name, value, labels);
      }
      setGauge(name, value, labels) {
        this.getActive().setGauge(name, value, labels);
      }
      observe(name, value, labels) {
        this.getActive().observe(name, value, labels);
      }
      async measure(name, action, labels) {
        return this.getActive().measure(name, action, labels);
      }
      // ── Session-level read API ─────────────────────────────────────────────
      /** Snapshot of the session registry (infrastructure / cross-run metrics). */
      getSessionSnapshot() {
        return this._session.getSnapshot();
      }
      /**
       * Backwards-compatible alias for getSessionSnapshot().
       * Callers that previously used metrics.getSnapshot() now receive the
       * session-level data rather than an undefined blend of run + session.
       */
      getSnapshot() {
        return this._session.getSnapshot();
      }
      /** Millisecond timestamp when this session started or was last reset. */
      getSessionStartedAt() {
        return this._sessionStartedAt;
      }
      /**
       * Ordered run summaries, oldest first. Capped at MAX_RUN_HISTORY entries.
       * Returns a shallow copy so callers cannot mutate the internal list.
       */
      getRunHistory() {
        return this._runHistory;
      }
      // ── Run lifecycle API ──────────────────────────────────────────────────
      /**
       * Append a completed run's snapshot to the history.
       * Call this AFTER runWithRunRegistry returns so the write lands in session
       * scope. Automatically evicts the oldest entry when the cap is reached.
       */
      recordRunSummary(summary) {
        this._runHistory.push(summary);
        if (this._runHistory.length > MAX_RUN_HISTORY) {
          this._runHistory.shift();
        }
      }
      // ── Reset API ──────────────────────────────────────────────────────────
      /**
       * Clear the session registry, run history, and session start timestamp.
       * In-flight run registries are NOT affected.
       */
      clearSession() {
        this._session.clear();
        this._runHistory = [];
        this._sessionStartedAt = Date.now();
      }
      /** Backwards-compatible alias for clearSession(). */
      clear() {
        this.clearSession();
      }
    };
    metrics = new SessionMetrics();
  }
});

// src/utils/user-agent.ts
var USER_AGENTS;
var init_user_agent = __esm({
  "src/utils/user-agent.ts"() {
    "use strict";
    USER_AGENTS = [
      // Chrome on Windows (updated 2025)
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      // Chrome on macOS
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      // Chrome on Linux
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      // Firefox on Windows (updated 2025)
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:139.0) Gecko/20100101 Firefox/139.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
      // Firefox on macOS
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0"
    ];
  }
});

// src/web-research/scraper-types.ts
var MAX_HTML_SIZE, MAX_PDF_SIZE, INTERNAL_NETWORK_PATTERNS, FILTERED_TAGS, BOT_PATTERNS, IMAGE_LINK_PATTERN, MARKDOWN_IMAGE_PATTERN;
var init_scraper_types = __esm({
  "src/web-research/scraper-types.ts"() {
    "use strict";
    init_user_agent();
    MAX_HTML_SIZE = 25 * 1024 * 1024;
    MAX_PDF_SIZE = 100 * 1024 * 1024;
    INTERNAL_NETWORK_PATTERNS = [
      /^127\./,
      // IPv4 loopback
      /^0\./,
      // IPv4 "this" network
      /^::1$/,
      // IPv6 loopback
      /^fe80::/i,
      // IPv6 link-local
      /^fc00::/i,
      // IPv6 unique local
      /^fd00::/i,
      // IPv6 unique local
      /^169\.254\./,
      // IPv4 link-local (and metadata)
      /^10\./,
      // RFC 1918 Class A private
      /^192\.168\./,
      // RFC 1918 Class C private
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      // RFC 1918 Class B private
      /^::ffff:(127\.|0\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i
      // IPv4-mapped IPv6
    ];
    FILTERED_TAGS = [
      "nav",
      "header",
      "footer",
      "aside",
      "script",
      "style",
      "noscript",
      "form",
      "input",
      "select",
      "textarea",
      "button",
      "object",
      "embed",
      "svg",
      "symbol",
      "use",
      "defs",
      "path",
      "circle",
      "rect",
      "line",
      "polygon",
      "img",
      "iframe"
    ];
    BOT_PATTERNS = [
      ["_cf_chl_", "Cloudflare challenge"],
      ["cf_chl_opt", "Cloudflare challenge opt"],
      ["cdn-cgi/challenge-platform", "Cloudflare challenge platform"],
      ["ddos-guard", "DDoS-Guard challenge"],
      ["Just a moment...", "Cloudflare interstitial"],
      ["Checking your browser before accessing", "Cloudflare interstitial"]
    ];
    IMAGE_LINK_PATTERN = /\[([^\]]*)\]\((data:image\/[^)]+|[^)\s]+\.(?:svg|png|jpe?g|gif|webp|bmp|ico)(?:\?[^)]*)?)\)/gi;
    MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\((?:data:image\/[^)]+|[^)\s]+)\)/gi;
  }
});

// src/web-research/scraper-utils.ts
var scraper_utils_exports = {};
__export(scraper_utils_exports, {
  createJsMarkdownConverter: () => createJsMarkdownConverter,
  createNativeMarkdownConverter: () => createNativeMarkdownConverter,
  extractDomain: () => extractDomain,
  getRandomUserAgent: () => getRandomUserAgent,
  stripImageLinks: () => stripImageLinks,
  validateContent: () => validateContent,
  validateUrlForSSRF: () => validateUrlForSSRF
});
import * as dns from "node:dns/promises";
import crypto from "node:crypto";
import { NodeHtmlMarkdown } from "node-html-markdown";
function getRandomUserAgent() {
  try {
    const index = crypto.randomInt(0, USER_AGENTS.length);
    const userAgent = USER_AGENTS[index];
    return userAgent ?? USER_AGENTS[0];
  } catch {
    return USER_AGENTS[0];
  }
}
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
async function validateUrlForSSRF(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    metrics.increment("scrape_errors_total", 1, { error_type: "invalid_url" });
    throw new Error(`Invalid URL: ${url}`, { cause: e });
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    metrics.increment("scrape_ssrf_blocks_total", 1, { block_type: "invalid_protocol" });
    throw new Error("Only HTTP/HTTPS protocols are allowed");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    metrics.increment("scrape_ssrf_blocks_total", 1, { block_type: "localhost" });
    throw new Error("Access to localhost is not allowed");
  }
  for (const pattern of INTERNAL_NETWORK_PATTERNS) {
    if (pattern.test(hostname)) {
      metrics.increment("scrape_ssrf_blocks_total", 1, { block_type: "internal_network" });
      throw new Error("Access to internal networks is not allowed");
    }
  }
  const [v4Results, v6Results] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname)
  ]);
  const v4Addresses = v4Results.status === "fulfilled" ? v4Results.value : [];
  const v6Addresses = v6Results.status === "fulfilled" ? v6Results.value : [];
  for (const ip of v4Addresses) {
    if (isPrivateIp(ip)) {
      metrics.increment("scrape_ssrf_blocks_total", 1, { block_type: "dns_rebinding_v4" });
      throw new Error("Hostname resolves to a private/reserved IPv4 address");
    }
  }
  for (const ip of v6Addresses) {
    if (isPrivateIpv6(ip)) {
      metrics.increment("scrape_ssrf_blocks_total", 1, { block_type: "dns_rebinding_v6" });
      throw new Error("Hostname resolves to a private/reserved IPv6 address");
    }
  }
}
function isPrivateIp(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  if (a === void 0 || b === void 0) return false;
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
}
function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch && mappedMatch[1]) {
    return isPrivateIp(mappedMatch[1]);
  }
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
  return false;
}
function stripImageLinks(markdown) {
  return markdown.replace(MARKDOWN_IMAGE_PATTERN, "").replace(IMAGE_LINK_PATTERN, "$1").replace(/\n{3,}/g, "\n\n").trim();
}
function createNativeMarkdownConverter(nativeModule) {
  return async (html) => {
    if (!nativeModule || !nativeModule.convert || !nativeModule.HeadingStyle || !nativeModule.CodeBlockStyle) {
      throw new Error("Native markdown converter not properly initialized");
    }
    const result = nativeModule.convert(html, {
      headingStyle: nativeModule.HeadingStyle.Atx,
      codeBlockStyle: nativeModule.CodeBlockStyle.Backticks,
      wrap: false
    });
    return stripImageLinks(result.content ?? "");
  };
}
function createJsMarkdownConverter() {
  const converter = new NodeHtmlMarkdown({
    codeBlockStyle: "fenced",
    textReplace: [[/\u00a0/g, " "]],
    ignore: [...FILTERED_TAGS]
  });
  return async (html) => {
    const markdown = converter.translate(html);
    return stripImageLinks(markdown);
  };
}
function validateContent(html, markdown, url) {
  const htmlLow = html.toLowerCase();
  for (const [pattern, reason] of BOT_PATTERNS) {
    if (htmlLow.includes(pattern)) {
      metrics.increment("scrape_errors_total", 1, { error_type: "bot_protection" });
      const error = new Error(`Fetch blocked: ${reason}`);
      errorTracker.trackError(error, {
        component: "scrapers",
        operation: "validate",
        url,
        domain: extractDomain(url),
        errorType: "bot_protection"
      });
      throw error;
    }
  }
  const words = markdown.trim().split(/\s+/).filter((w) => w.length > 0);
  let stubCheckHostname = "";
  try {
    stubCheckHostname = new URL(url).hostname;
  } catch {
  }
  if (words.length < 50 && stubCheckHostname !== "example.com") {
    metrics.increment("scrape_errors_total", 1, { error_type: "stub_content" });
    const error = new Error(`Fetch returned stub: only ${words.length} words found.`);
    errorTracker.trackError(error, {
      component: "scrapers",
      operation: "validate",
      url,
      domain: extractDomain(url),
      errorType: "stub_content"
    });
    throw error;
  }
}
var init_scraper_utils = __esm({
  "src/web-research/scraper-utils.ts"() {
    "use strict";
    init_error_tracker();
    init_metrics();
    init_scraper_types();
  }
});

// src/infrastructure/browser/thread-worker.ts
import { ClusterWorker } from "poolifier";
import crypto2 from "node:crypto";
import process3 from "node:process";

// src/infrastructure/browser/thread-worker-lifecycle.ts
init_log_utils();
import process2 from "node:process";
import cluster from "node:cluster";
import * as fs from "node:fs/promises";
var workerId = "";
function setWorkerId(id) {
  workerId = id;
}
function setupIpcErrorHandler() {
  if (!cluster.isWorker || !cluster.worker) {
    return;
  }
  cluster.worker.on("error", (err) => {
    if (err && err.code === "ERR_IPC_CHANNEL_CLOSED") {
      return;
    }
    throw err;
  });
}
function setupUncaughtExceptionHandler() {
  process2.on("uncaughtException", (err) => {
    if (err && err.message && err.message.includes("reading 'url'") && err.stack && err.stack.includes("coreBundle.js")) {
      logToDebugFile("WARN", `[Worker-${workerId}] Suppressed Playwright core error: ${err.message}`);
      return;
    }
    if (err && err.message && err.message.includes("reading 'frames'") && err.stack && err.stack.includes("coreBundle.js")) {
      logToDebugFile("WARN", `[Worker-${workerId}] Suppressed Playwright frame error: ${err.message}`);
      return;
    }
    logToDebugFile("ERROR", `[Worker-${workerId}] Uncaught Exception: ${err.stack || err.message}`);
  });
  process2.on("unhandledRejection", (reason) => {
    const errMsg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logToDebugFile("WARN", `[Worker-${workerId}] Unhandled Rejection (non-fatal): ${errMsg}`);
  });
}
var orphanCheckTimer = null;
var cleanupBrowser = null;
function setBrowserCleanup(fn) {
  cleanupBrowser = fn;
}
function setupOrphanProtection() {
  if (!cluster.isWorker) {
    return;
  }
  if (!process2.ppid) {
    return;
  }
  const checkOrphan = async () => {
    try {
      process2.kill(process2.ppid, 0);
      orphanCheckTimer = setTimeout(checkOrphan, 1e4);
      if (orphanCheckTimer) {
        orphanCheckTimer.unref();
      }
    } catch (_e) {
      logToDebugFile("WARN", `[Worker-${workerId}] Parent process died or unreachable (orphaned), shutting down...`);
      if (cleanupBrowser) {
        await cleanupBrowser().catch((err) => {
          logToDebugFile("WARN", `[Worker-${workerId}] Browser cleanup failed during orphan exit:`, err);
        });
      }
      cleanupOrphanProtection();
      process2.env["PI_PROCESS_EXITING"] = "1";
      process2.exit(1);
    }
  };
  orphanCheckTimer = setTimeout(checkOrphan, 1e4);
  if (orphanCheckTimer) {
    orphanCheckTimer.unref();
  }
}
function cleanupOrphanProtection() {
  if (orphanCheckTimer) {
    clearTimeout(orphanCheckTimer);
    orphanCheckTimer = null;
  }
}
function logToDebugFile(level, ...args) {
  const logFile = process2.env["PI_RESEARCH_LOG_FILE"];
  if (!logFile) return;
  try {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const entry = {
      timestamp,
      level,
      workerId,
      message: redactSecrets(args.map((arg) => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === "object" && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(" "))
    };
    fs.appendFile(logFile, `${JSON.stringify(entry)}
`).catch(() => {
    });
  } catch {
  }
}
function createKillHandler() {
  return async () => {
    logToDebugFile("INFO", `[Worker-${workerId}] Worker shutting down`);
    if (cleanupBrowser) {
      await cleanupBrowser().catch((err) => {
        logToDebugFile("WARN", `[Worker-${workerId}] Browser cleanup failed during shutdown:`, err);
      });
    }
    cleanupOrphanProtection();
    if (!cluster.isWorker) {
      return;
    }
    setTimeout(() => {
      logToDebugFile("INFO", `[Worker-${workerId}] Forcing process exit (Cluster)`);
      process2.env["PI_PROCESS_EXITING"] = "1";
      process2.exit(0);
    }, 100).unref();
  };
}

// src/infrastructure/browser/thread-worker-messaging.ts
init_log_utils();
import { appendFileSync as appendFileSync2 } from "node:fs";
var workerId2 = "";
var pageCreationLock = Promise.resolve();
async function createPageSafe(context2) {
  let release;
  const nextLock = new Promise((resolve) => {
    release = resolve;
  });
  const currentLock = pageCreationLock;
  pageCreationLock = currentLock.then(() => nextLock);
  await currentLock;
  try {
    const pagePromise = context2.newPage();
    pagePromise.catch((err) => logToDebugFile2("DEBUG", `[ThreadWorker] Background page creation rejection: ${err.message}`));
    let timeoutId;
    const result = await Promise.race([
      pagePromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Browser page creation timed out after 60000ms")), 6e4);
      })
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    return result;
  } finally {
    release();
  }
}
function setWorkerId2(id) {
  workerId2 = id;
}
function logToDebugFile2(level, ...args) {
  const logFile = process.env["PI_RESEARCH_LOG_FILE"];
  if (!logFile) return;
  try {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const entry = {
      timestamp,
      level,
      workerId: workerId2,
      // Redact secrets + bound size; worker logs include full scrape/search
      // URLs, which can carry credentials in userinfo or query strings.
      message: redactSecrets(args.map((arg) => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === "object" && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(" "))
    };
    appendFileSync2(logFile, `${JSON.stringify(entry)}
`);
  } catch {
  }
}
async function setupMocking(context2) {
  const mockSearch = process.env["PI_RESEARCH_MOCK_SEARCH"] === "true";
  const mockScrape = process.env["PI_RESEARCH_MOCK_SCRAPE"] === "true";
  if (!mockSearch && !mockScrape) return;
  logToDebugFile2("INFO", `[Worker-${workerId2}] Setting up browser mocking (Search: ${mockSearch}, Scrape: ${mockScrape})`);
  await context2.route("**", (route, request) => {
    const urlStr = request.url();
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      route.continue();
      return;
    }
    const isDuckDuckGo = url.hostname === "duckduckgo.com" || url.hostname === "lite.duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com");
    if (mockSearch && isDuckDuckGo) {
      logToDebugFile2("DEBUG", `[Worker-${workerId2}] Mocking search response for: ${urlStr}`);
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `
          <html><head><title>DuckDuckGo Lite</title></head><body>
            <form action="/lite/" method="post">
              <input name="q" type="text">
              <input type="submit" value="Search">
            </form>
            <table class="result-link">
              <tr>
                <td><a class="result-link" href="https://example.com/mock-result-1?uddg=https%3A%2F%2Fexample.com%2Ftarget-1">Mock Result 1</a></td>
              </tr>
              <tr>
                <td class="result-snippet">This is a mocked search result snippet for testing purposes.</td>
              </tr>
              <tr>
                <td><a class="result-link" href="https://example.com/mock-result-2?uddg=https%3A%2F%2Fexample.com%2Ftarget-2">Mock Result 2</a></td>
              </tr>
              <tr>
                <td class="result-snippet">Another mocked snippet to verify multiple result extraction.</td>
              </tr>
            </table>
          </body></html>
        `
      });
      return;
    }
    if (mockScrape && !isDuckDuckGo) {
      logToDebugFile2("DEBUG", `[Worker-${workerId2}] Mocking scrape response for: ${urlStr}`);
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<html><body><h1>Mocked Page Content</h1><p>This content was mocked for ${url} during integration testing.</p></body></html>`
      });
      return;
    }
    route.continue();
  });
}
async function extractSearchResults(page) {
  return await page.evaluate(() => {
    const found = [];
    const links = Array.from(document.querySelectorAll("a.result-link"));
    links.forEach((link) => {
      const row = link.closest("tr");
      const snippet = row?.nextElementSibling?.querySelector("td.result-snippet")?.textContent?.trim() || "";
      const title = link.textContent?.trim() || "";
      let url = link.href;
      try {
        const u = new URL(url);
        const uddg = u.searchParams.get("uddg");
        if (uddg) url = decodeURIComponent(uddg || "");
      } catch {
      }
      let urlHostname = "";
      try {
        urlHostname = new URL(url).hostname;
      } catch {
      }
      if (title && url && urlHostname !== "duckduckgo.com" && !urlHostname.endsWith(".duckduckgo.com") && url.startsWith("http")) {
        found.push({ title, url, content: snippet });
      }
    });
    return found;
  });
}
async function executeSearchTask(_context, query) {
  const page = await createPageSafe(_context);
  const SEARCH_TIMEOUT = parseInt(process.env["PI_RESEARCH_SEARCH_TIMEOUT_MS"] || "45000", 10);
  page.setDefaultTimeout(SEARCH_TIMEOUT);
  page.setDefaultNavigationTimeout(SEARCH_TIMEOUT);
  try {
    logToDebugFile2("DEBUG", `[Worker-${workerId2}] Starting search for: ${query}`);
    if (process.env["PI_RESEARCH_MOCK_SEARCH"] === "true") {
      await page.goto(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded" });
    } else {
      await page.goto("https://lite.duckduckgo.com/lite/", { waitUntil: "domcontentloaded" });
      await page.fill('input[name="q"]', query);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.keyboard.press("Enter")
      ]);
    }
    const results = await extractSearchResults(page);
    await page.close();
    const jitterBase = process.env["PI_RESEARCH_MOCK_SEARCH"] === "true" ? 10 : 500;
    const jitterRange = process.env["PI_RESEARCH_MOCK_SEARCH"] === "true" ? 10 : 1e3;
    const jitter = Math.floor(Math.random() * jitterRange) + jitterBase;
    await new Promise((r) => setTimeout(r, jitter));
    return { results, jitter };
  } catch (error) {
    await page.close().catch((err) => logToDebugFile2("DEBUG", `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
    throw error;
  }
}
async function executeScrapeTask(_context, url) {
  const page = await createPageSafe(_context);
  const SCRAPE_TIMEOUT = parseInt(process.env["PI_RESEARCH_SCRAPE_TIMEOUT_MS"] || "15000", 10);
  page.setDefaultTimeout(SCRAPE_TIMEOUT);
  page.setDefaultNavigationTimeout(SCRAPE_TIMEOUT);
  try {
    logToDebugFile2("DEBUG", `[Worker-${workerId2}] Starting scrape for: ${url}`);
    const { validateUrlForSSRF: validateForWorker } = await Promise.resolve().then(() => (init_scraper_utils(), scraper_utils_exports));
    page.on("request", async (req) => {
      if (req.isNavigationRequest() && req.redirectedFrom() != null) {
        try {
          await validateForWorker(req.url());
        } catch (_ssrfErr) {
          await req.abort("blockedbyclient").catch(() => {
          });
        }
      }
    });
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    const contentType = await response?.headerValue("content-type") || "";
    if (contentType.includes("application/pdf")) {
      if (!response) throw new Error(`[Worker] No response received for PDF URL: ${url}`);
      const buffer = await response.body();
      await page.close();
      return { contentType, buffer, jitter: 0 };
    }
    let html = await page.content();
    const cfPatterns = ["_cf_chl_", "cdn-cgi/challenge-platform", "cf_chl_opt", "Just a moment...", "Checking your browser before accessing"];
    const hasCloudflare = cfPatterns.some((pattern) => html.includes(pattern));
    if (hasCloudflare) {
      logToDebugFile2("WARN", `[Worker-${workerId2}] Cloudflare challenge detected for: ${url}`);
      try {
        await page.waitForFunction(
          () => {
            const body = document.body.innerHTML;
            return !body.includes("_cf_chl_") && !body.includes("cdn-cgi/challenge-platform") && !body.includes("cf_chl_opt") && !body.includes("Just a moment...") && !body.includes("Checking your browser before accessing") && body.length > 200;
          },
          { timeout: 5e3 }
        );
        html = await page.content();
        logToDebugFile2("INFO", `[Worker-${workerId2}] Cloudflare challenge resolved for: ${url}`);
      } catch (_waitError) {
        logToDebugFile2("ERROR", `[Worker-${workerId2}] Cloudflare challenge failed for: ${url}`);
        const error = new Error("Fetch blocked: Cloudflare challenge");
        error.cause = _waitError;
        throw error;
      }
    }
    const needsWait = html.length < 5e3 || html.includes('id="root"') || html.includes('id="app"') || html.includes("<noscript>");
    if (needsWait) {
      await page.waitForLoadState("networkidle", { timeout: 1e4 }).catch((err) => logToDebugFile2("DEBUG", `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
      html = await page.content();
    }
    const jitter = process.env["PI_RESEARCH_MOCK_SCRAPE"] === "true" ? 0 : Math.floor(Math.random() * 1e3) + 500;
    if (jitter > 0) await new Promise((r) => setTimeout(r, jitter));
    await page.close();
    return { contentType, html, jitter };
  } catch (error) {
    await page.close().catch((err) => logToDebugFile2("DEBUG", `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
    throw error;
  }
}
async function executeHealthCheckAttempt(_context, navTimeoutMs) {
  const page = await createPageSafe(_context);
  page.setDefaultTimeout(navTimeoutMs);
  page.setDefaultNavigationTimeout(navTimeoutMs);
  try {
    const navStart = Date.now();
    await page.goto("https://lite.duckduckgo.com/lite/", { waitUntil: "domcontentloaded" });
    const navMs = Date.now() - navStart;
    if (navMs > 3e3) {
      logToDebugFile2("WARN", `[Worker-${workerId2}] DDG Lite navigation was slow: ${navMs}ms (expected <1s). Possible rate-limit or network congestion.`);
    }
    const title = await page.title();
    await page.close();
    return { success: !!title, navMs };
  } catch (error) {
    await page.close().catch((err) => logToDebugFile2("DEBUG", `[ThreadWorker] Swallowed page close/wait error: ${err.message || String(err)}`));
    throw error;
  }
}
async function executeHealthCheck(_context, initMs) {
  const configuredMs = parseInt(process.env["PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS"] || "0", 10);
  const HEALTH_TIMEOUT = configuredMs > 0 ? Math.max(1e4, configuredMs) : 1e4;
  if (initMs > 3e3) {
    logToDebugFile2("WARN", `[Worker-${workerId2}] Browser init was slow: ${initMs}ms \u2014 leaving less headroom for DDG navigation.`);
  }
  try {
    return await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT);
  } catch (firstError) {
    logToDebugFile2("WARN", `[Worker-${workerId2}] Health check attempt 1 failed: ${firstError instanceof Error ? firstError.message : String(firstError)}. Retrying once...`);
    try {
      return await executeHealthCheckAttempt(_context, HEALTH_TIMEOUT);
    } catch (retryError) {
      logToDebugFile2("ERROR", `[Worker-${workerId2}] Health check failed after retry: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      throw retryError;
    }
  }
}
function shouldResetBrowser(errorMsg) {
  return errorMsg.includes("Target closed") || errorMsg.includes("browser has disconnected") || errorMsg.includes("Protocol error") || errorMsg.includes("Session closed");
}

// src/infrastructure/browser/thread-worker-browser.ts
init_log_utils();
var browser = null;
var context = null;
var initPromise = null;
var workerId3 = "";
function setWorkerId3(id) {
  workerId3 = id;
}
var isBrowserConnected = () => {
  try {
    return browser && typeof browser.isConnected === "function" && browser.isConnected();
  } catch {
    logToDebugFile3("DEBUG", "[ThreadWorker] browser.isConnected check threw, treating as disconnected");
    return false;
  }
};
function logToDebugFile3(level, ...args) {
  const logFile = process.env["PI_RESEARCH_LOG_FILE"];
  if (!logFile) return;
  try {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const entry = {
      timestamp,
      level,
      workerId: workerId3,
      message: redactSecrets(args.map((arg) => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === "object" && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(" "))
    };
    import("node:fs/promises").then((fsp) => fsp.appendFile(logFile, `${JSON.stringify(entry)}
`)).catch(() => {
    });
  } catch {
  }
}
async function initBrowser() {
  if (isBrowserConnected() && context) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (!isBrowserConnected() || !context) {
        logToDebugFile3("INFO", `[Worker-${workerId3}] Initializing browser instance...`);
        let CamoufoxModule;
        try {
          CamoufoxModule = await import("camoufox-js");
        } catch (e) {
          throw new Error(`[Worker] camoufox-js not found in node_modules. Please run 'npm install'. Original error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        }
        const { Camoufox } = CamoufoxModule;
        const launchTimeoutMs = 9e4;
        const launchPromise = Camoufox({
          headless: true,
          humanize: true,
          locale: "en-US",
          screen: {
            width: 1920,
            height: 1080,
            colorDepth: 24,
            pixelRatio: 1
          }
        });
        launchPromise.catch((err) => logToDebugFile3("DEBUG", `[ThreadWorker] Background browser launch rejection: ${err.message}`));
        let launchTimeoutId;
        const launchedBrowser = await Promise.race([
          launchPromise,
          new Promise((_, reject) => {
            launchTimeoutId = setTimeout(() => reject(new Error(`Browser launch timed out after ${launchTimeoutMs}ms`)), launchTimeoutMs);
          })
        ]);
        if (launchTimeoutId) clearTimeout(launchTimeoutId);
        browser = launchedBrowser;
        const contextPromise = browser.newContext();
        contextPromise.catch((err) => logToDebugFile3("DEBUG", `[ThreadWorker] Background browser context rejection: ${err.message}`));
        let contextTimeoutId;
        context = await Promise.race([
          contextPromise,
          new Promise((_, reject) => {
            contextTimeoutId = setTimeout(() => reject(new Error("Browser context creation timed out after 30000ms")), 3e4);
          })
        ]);
        if (contextTimeoutId) clearTimeout(contextTimeoutId);
        await setupMocking(context);
        logToDebugFile3("INFO", `[Worker-${workerId3}] Browser initialized.`);
      }
    } catch (e) {
      if (browser && typeof browser.close === "function") {
        browser.close().catch((err) => logToDebugFile3("DEBUG", `[Worker-${workerId3}] Swallowed browser close error during failed init: ${err.message}`));
      }
      browser = null;
      context = null;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Camoufox is not installed") || msg.includes("Version information not found")) {
        throw new Error(`[Worker] Browser binaries not found. Please run 'npm run setup' to install them.`, { cause: e });
      }
      throw e;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}
function getContext() {
  return context;
}
function resetBrowser() {
  if (context) context.close().catch((err) => logToDebugFile3("DEBUG", `[Worker-${workerId3}] Swallowed context close error during reset: ${err.message}`));
  if (browser) browser.close().catch((err) => logToDebugFile3("DEBUG", `[Worker-${workerId3}] Swallowed browser close error during reset: ${err.message}`));
  context = null;
  browser = null;
}
async function cleanupBrowser2() {
  const timeoutMs = 2e3;
  const cleanup = async () => {
    if (context) await context.close().catch((err) => logToDebugFile3("DEBUG", `[Worker-${workerId3}] Swallowed context close error during cleanup: ${err.message}`));
    if (browser) await browser.close().catch((err) => logToDebugFile3("DEBUG", `[Worker-${workerId3}] Swallowed browser close error during cleanup: ${err.message}`));
  };
  try {
    await Promise.race([
      cleanup(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Browser cleanup timed out")), timeoutMs))
    ]);
  } catch {
  } finally {
    context = null;
    browser = null;
  }
}

// src/infrastructure/browser/thread-worker.ts
var workerId4 = crypto2.randomBytes(2).toString("hex");
setWorkerId(workerId4);
setWorkerId3(workerId4);
setWorkerId2(workerId4);
setupIpcErrorHandler();
setupUncaughtExceptionHandler();
setBrowserCleanup(cleanupBrowser2);
if (process3.env["GITHUB_ACTIONS"] !== "true") {
  setupOrphanProtection();
}
var FULL_MOCK_MODE = process3.env["PI_RESEARCH_MOCK_SEARCH"] === "true" && process3.env["PI_RESEARCH_MOCK_SCRAPE"] === "true";
async function runTask(data) {
  if (!data) {
    return { error: "No task data provided", duration: 0 };
  }
  const { type, query, url, queuedAt: _queuedAt, taskTimeoutMs } = data;
  const startTime = Date.now();
  if (FULL_MOCK_MODE) {
    if (type === "search") {
      return {
        results: [{ title: "Mock Result", url: "https://example.com/mock", content: `Mock search result for: ${query ?? ""}` }],
        duration: Date.now() - startTime,
        jitter: 0
      };
    }
    if (type === "scrape") {
      return {
        contentType: "text/html",
        html: `<html><body><p>Mock content for ${url ?? ""}</p></body></html>`,
        duration: Date.now() - startTime,
        jitter: 0
      };
    }
    if (type === "healthcheck") {
      return { success: true, navMs: 0, duration: Date.now() - startTime };
    }
  }
  const abortController = new AbortController();
  let taskTimer;
  if (taskTimeoutMs && taskTimeoutMs > 0) {
    taskTimer = setTimeout(() => abortController.abort(new Error(`Task timed out after ${taskTimeoutMs}ms`)), taskTimeoutMs);
  }
  try {
    await initBrowser();
    const initMs = Date.now() - startTime;
    let result;
    if (type === "search") {
      if (!query) throw new Error("Search task requires a query");
      const searchResult = await executeSearchTask(getContext(), query);
      result = { results: searchResult.results, duration: Date.now() - startTime, jitter: searchResult.jitter };
    } else if (type === "scrape") {
      if (!url) throw new Error("Scrape task requires a URL");
      const scrapeResult = await executeScrapeTask(getContext(), url);
      result = { ...scrapeResult, duration: Date.now() - startTime };
    } else if (type === "healthcheck") {
      const healthResult = await executeHealthCheck(getContext(), initMs);
      result = { ...healthResult, duration: Date.now() - startTime };
    } else {
      result = { error: "Unknown task type", duration: Date.now() - startTime };
    }
    if (abortController.signal.aborted) {
      return { error: `Task timed out after ${taskTimeoutMs}ms`, duration: Date.now() - startTime };
    }
    return result;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (shouldResetBrowser(errMsg)) {
      resetBrowser();
    }
    return {
      error: errMsg,
      duration: Date.now() - startTime
    };
  } finally {
    if (taskTimer !== void 0) clearTimeout(taskTimer);
  }
}
var worker = new ClusterWorker(runTask, {
  killHandler: createKillHandler()
});
var thread_worker_default = worker;
export {
  thread_worker_default as default
};
