// src/core/llm/model-registry-factory.ts
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
function buildHeaders(provider) {
  if (provider === "openrouter") return { "HTTP-Referer": "https://pi.ai", "X-Title": "pi-research" };
  return {};
}
function buildModelRegistry(apiKey, provider) {
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const modelsJsonPath = path.join(agentDir, "models.json");
  const authPath = path.join(agentDir, "auth.json");
  if (apiKey && provider) {
    const authStorage = AuthStorage.inMemory({
      [provider]: { type: "api_key", key: apiKey }
    });
    return ModelRegistry.create(
      authStorage,
      fs.existsSync(modelsJsonPath) ? modelsJsonPath : void 0
    );
  }
  if (fs.existsSync(authPath)) {
    const authStorage = AuthStorage.create(authPath);
    return ModelRegistry.create(
      authStorage,
      fs.existsSync(modelsJsonPath) ? modelsJsonPath : void 0
    );
  }
  return ModelRegistry.inMemory(AuthStorage.inMemory());
}
function constructMinimalModel(provider, modelId, _apiKey) {
  return {
    provider,
    id: modelId,
    name: modelId,
    api: provider === "openai" ? "openai-completions" : provider + "-conversations",
    baseUrl: "",
    // Provider-specific base URLs are handled by pi-ai internal registry
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 32768,
    headers: buildHeaders(provider)
  };
}
function resolveModel(registry, modelSpec, provider, apiKey) {
  if (modelSpec) {
    const slashIdx = modelSpec.indexOf("/");
    if (slashIdx > 0) {
      const prov = modelSpec.slice(0, slashIdx);
      const modelId = modelSpec.slice(slashIdx + 1);
      const found2 = registry.find(prov, modelId);
      if (found2) return found2;
      if (apiKey && provider) {
        return constructMinimalModel(prov, modelId, apiKey);
      }
      throw new Error(`Model "${modelSpec}" not found in pi's configured model registry. Check ~/.pi/agent/models.json.`);
    }
    const allModels = registry.getAll();
    const found = allModels.find((m) => m.id === modelSpec);
    if (found) return found;
    throw new Error(`Invalid model string "${modelSpec}". Expected "provider/id" e.g. "openai/gpt-4o".`);
  }
  if (provider) {
    const allModels = registry.getAll();
    const found = allModels.find((m) => m.provider === provider);
    if (found) return found;
  }
  const available = registry.getAvailable();
  if (available.length > 0) return available[0];
  const all = registry.getAll();
  if (all.length > 0) return all[0];
  if (apiKey && provider && modelSpec) {
    const slashIdx = modelSpec.indexOf("/");
    if (slashIdx > 0) {
      return constructMinimalModel(
        modelSpec.slice(0, slashIdx),
        modelSpec.slice(slashIdx + 1),
        apiKey
      );
    }
    return constructMinimalModel(provider, modelSpec, apiKey);
  }
  throw new Error(
    "No LLM model available. Please configure your model registry (~/.pi/agent/models.json) or provide an explicit apiKey."
  );
}

// src/openclaw-entry.ts
import { Type as Type10 } from "typebox";
import { randomUUID as randomUUID6 } from "node:crypto";

// src/logger.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync } from "node:fs";
import { AsyncLocalStorage as AsyncLocalStorage3 } from "node:async_hooks";
import * as path4 from "node:path";

// src/utils/error-tracker.ts
import { AsyncLocalStorage } from "node:async_hooks";
var trackerStorage = new AsyncLocalStorage();
var ErrorTracker = class {
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
  trackError(error, context = {}) {
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
    if (context.domain) {
      const currentCount = pattern.domainCounts.get(context.domain) ?? 0;
      pattern.domainCounts.set(context.domain, currentCount + 1);
    }
    pattern.contexts.push(context);
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
var globalInstance = new ErrorTracker();
var errorTracker = new Proxy(globalInstance, {
  get(target, prop, receiver) {
    const currentTracker = trackerStorage.getStore() ?? target;
    const value = Reflect.get(currentTracker, prop, receiver);
    if (typeof value === "function") {
      return value.bind(currentTracker);
    }
    return value;
  }
});

// src/utils/log-utils.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import * as os2 from "node:os";
import * as path2 from "node:path";
var logContextStorage = new AsyncLocalStorage2();
function buildDefaultDebugLogPath(_researchRunId) {
  const override = process.env["PI_RESEARCH_LOG_PATH"];
  if (override) return override;
  return path2.join(os2.tmpdir(), "pi-research.log");
}
function isVerboseFromEnv() {
  return process.env["PI_RESEARCH_DEBUG"] === "true";
}
function createResearchRunId() {
  return `run-${randomBytes(4).toString("hex")}`;
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

// src/utils/log-rotation.ts
import * as fs2 from "node:fs";
import * as path3 from "node:path";
var LogRotation = class {
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
      const baseName = path3.basename(logFile);
      const archives = files.filter((f) => f.startsWith(baseName) && f !== baseName);
      for (const archive of archives) {
        try {
          fs2.unlinkSync(path3.join(logDir, archive));
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
        const logFiles = files.filter((f) => f.startsWith(path3.basename(logFile)) && f !== path3.basename(logFile)).sort();
        const toDelete = logFiles.slice(0, -this.MAX_LOG_FILES);
        for (const file of toDelete) {
          try {
            fs2.unlinkSync(path3.join(logDir, file));
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

// src/utils/disk-space-checker.ts
import * as fs3 from "node:fs";
import { execSync } from "node:child_process";
var DiskSpaceChecker = class {
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

// src/utils/stdio-capture.ts
import { createRequire } from "node:module";
import { TextDecoder as TextDecoder2 } from "node:util";
var fs4 = createRequire(import.meta.url)("node:fs");
var sessionCaptureStates = /* @__PURE__ */ new Map();
var isAnyLoggerCapturingOutput = false;
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
var NATIVE_LOG_PATTERNS = [
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
var COMPLEX_TUI_PATTERNS = [
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
var BOX_DRAWING_CHARS = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╴╵╶╷╭╮╯╰╱╲╳]/;
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
function shouldRedirectStderr(stat4) {
  return !stat4.isFIFO() && !stat4.isSocket();
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
      message: args.map(formatArg).join(" ")
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
  const decoder = new TextDecoder2();
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
      const stat4 = fs4.fstatSync(2);
      if (shouldRedirectStderr(stat4)) {
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
      message: message.trim()
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
        message: message.trim()
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
        message: message.trim()
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
              message: message.trim()
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

// src/logger.ts
var LOGGER_BRAND = /* @__PURE__ */ Symbol.for("pi-research.Logger");
var Logger = class {
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
    this.logDir = path4.dirname(this.logFile);
    this.sessionId = options.researchRunId;
    this.rotation = new LogRotation(this);
    this.diskSpaceChecker = new DiskSpaceChecker();
    try {
      if (!existsSync3(this.logDir)) {
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
    const entry = {
      timestamp,
      level,
      ...getLogContext(),
      message: args.map(formatArg).join(" "),
      ...firstError ? { errorMessage: firstError.message, errorStack: firstError.stack } : {}
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
      const msg = args.map(formatArg).join(" ");
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
      const context = getLogContext();
      errorTracker.trackError(errArg, context);
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
var loggerContext = new AsyncLocalStorage3();
var sessionLoggers = /* @__PURE__ */ new Map();
var _globalLogger = null;
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
function resetLogger(sessionId) {
  if (sessionId) {
    sessionLoggers.delete(sessionId);
  } else {
    _globalLogger = null;
    sessionLoggers.clear();
  }
}
var logger = {
  log: (...args) => getLogger().log(...args),
  info: (...args) => getLogger().info(...args),
  error: (...args) => getLogger().error(...args),
  warn: (...args) => getLogger().warn(...args),
  debug: (...args) => getLogger().debug(...args),
  clear: () => getLogger().clear(),
  runCapturingStderr: (task) => getLogger().runCapturingStderr(task)
};

// src/core/service-registry.ts
import { AsyncLocalStorage as AsyncLocalStorage4 } from "node:async_hooks";
var initializationContext = new AsyncLocalStorage4();
var ServiceContainer = class {
  services = /* @__PURE__ */ new Map();
  dependencies = /* @__PURE__ */ new Map();
  isDisposing = false;
  isReady = false;
  cwd = process.cwd();
  config = null;
  defaultOptions;
  constructor(options = {}) {
    this.defaultOptions = {
      lazyInitialization: options.lazyInitialization ?? true,
      allowOverwrite: options.allowOverwrite ?? false,
      enableLogging: options.enableLogging ?? true
    };
  }
  /**
   * Register a service with the container
   */
  register(name, factory, options = {}) {
    if (this.isDisposing) {
      throw new Error(`Cannot register service '${name}' during container disposal`);
    }
    const mergedOptions = { ...this.defaultOptions, ...options };
    if (this.services.has(name)) {
      if (!mergedOptions.allowOverwrite) {
        throw new Error(`Service '${name}' is already registered. Use registerAndReplace() to overwrite.`);
      }
      if (mergedOptions.enableLogging) {
        logger.warn(`[ServiceContainer] Replacing service '${name}'`);
      }
    } else {
      if (mergedOptions.enableLogging) {
        logger.debug(`[ServiceContainer] Registering service '${name}'`);
      }
    }
    this.services.set(name, {
      factory,
      instance: null,
      initializationPromise: null,
      options: mergedOptions
    });
    this.dependencies.set(name, /* @__PURE__ */ new Set());
  }
  /**
   * Register a service, replacing any existing service
   */
  async registerAndReplace(name, factory, options = {}) {
    const mergedOptions = { ...this.defaultOptions, ...options, allowOverwrite: true };
    if (this.services.has(name)) {
      const registration = this.services.get(name);
      if (registration.instance && registration.instance.dispose) {
        try {
          await registration.instance.dispose();
        } catch (err) {
          logger.warn(`[ServiceContainer] Error disposing replaced service '${name}':`, err);
        }
      }
    }
    this.register(name, factory, mergedOptions);
  }
  /**
   * Record a dependency between two services
   */
  addDependency(dependent, dependency) {
    let deps = this.dependencies.get(dependent);
    if (!deps) {
      deps = /* @__PURE__ */ new Set();
      this.dependencies.set(dependent, deps);
    }
    deps.add(dependency);
  }
  /**
   * Get a service instance, initializing it if necessary
   */
  async get(name, ctx) {
    if (this.isDisposing) {
      throw new Error(`Cannot get service '${name}' during container disposal`);
    }
    const caller = initializationContext.getStore();
    if (caller && caller !== name) {
      this.addDependency(caller, name);
    }
    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }
    if (registration.instance) {
      if (ctx && registration.instance.initialize) {
        return initializationContext.run(name, async () => {
          await registration.instance.initialize(ctx);
          return registration.instance;
        });
      }
      return registration.instance;
    }
    if (registration.initializationPromise) {
      return registration.initializationPromise;
    }
    registration.initializationPromise = initializationContext.run(
      name,
      () => this._initializeService(registration, ctx)
    );
    try {
      const instance = await registration.initializationPromise;
      return instance;
    } catch (error) {
      registration.initializationPromise = null;
      throw error;
    }
  }
  /**
   * Get a service instance synchronously (returns null if not initialized)
   */
  tryGet(name) {
    if (this.isDisposing) {
      return null;
    }
    const registration = this.services.get(name);
    if (!registration) {
      return null;
    }
    return registration.instance;
  }
  /**
   * Check if a service is registered
   */
  has(name) {
    return this.services.has(name);
  }
  /**
   * Check if a service is initialized
   */
  isInitialized(name) {
    const registration = this.services.get(name);
    if (!registration) return false;
    return registration.instance !== null;
  }
  /**
   * Clear (reset) a service instance, forcing re-initialization on next access
   */
  async clear(name) {
    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }
    if (registration.instance && registration.instance.dispose) {
      await registration.instance.dispose().catch((err) => {
        logger.warn(`[ServiceContainer] Error disposing service '${name}':`, err);
      });
    }
    registration.instance = null;
    registration.initializationPromise = null;
    if (registration.options.enableLogging) {
      logger.debug(`[ServiceContainer] Cleared service '${name}'`);
    }
  }
  /**
   * Replace a service instance with a new one
   */
  async replace(name, newInstance) {
    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`Service '${name}' is not registered`);
    }
    if (registration.instance && registration.instance.dispose) {
      await registration.instance.dispose().catch((err) => {
        logger.warn(`[ServiceContainer] Error disposing old service '${name}':`, err);
      });
    }
    registration.instance = newInstance;
    registration.initializationPromise = null;
    if (registration.options.enableLogging) {
      logger.debug(`[ServiceContainer] Replaced service '${name}'`);
    }
  }
  /**
   * Dispose all services using a true Directed Acyclic Graph (DAG) teardown.
   * This guarantees that services are only disposed after all their dependents
   * have been successfully torn down.
   */
  async disposeAll() {
    if (this.isDisposing) {
      return;
    }
    this.isDisposing = true;
    if (this.defaultOptions.enableLogging) {
      logger.log("[ServiceContainer] Disposing all services (DAG-ordered teardown)...");
    }
    try {
      const activeServices = Array.from(this.services.keys()).filter(
        (name) => this.services.get(name)?.instance !== null
      );
      const disposed = /* @__PURE__ */ new Set();
      while (disposed.size < activeServices.length) {
        const toDispose = [];
        for (const name of activeServices) {
          if (disposed.has(name)) continue;
          const hasUndisposedDependents = activeServices.some(
            (other) => !disposed.has(other) && other !== name && this.dependencies.get(other)?.has(name)
          );
          if (!hasUndisposedDependents) {
            toDispose.push(name);
          }
        }
        if (toDispose.length === 0) {
          const remaining = activeServices.filter((n) => !disposed.has(n));
          logger.warn(`[ServiceContainer] Circular dependency or stuck disposal detected for: ${remaining.join(", ")}. Falling back to reverse-registration order.`);
          const reverseRegistrations = Array.from(this.services.entries()).reverse();
          for (const [name, registration] of reverseRegistrations) {
            if (!disposed.has(name) && registration.instance && registration.instance.dispose) {
              try {
                await registration.instance.dispose();
              } catch (err) {
                logger.warn(`[ServiceContainer] Error disposing '${name}':`, err);
              }
              registration.instance = null;
              registration.initializationPromise = null;
            }
          }
          break;
        }
        const serviceNamesInOrder = Array.from(this.services.keys());
        toDispose.sort((a, b) => serviceNamesInOrder.indexOf(b) - serviceNamesInOrder.indexOf(a));
        for (const name of toDispose) {
          const registration = this.services.get(name);
          if (registration.instance && registration.instance.dispose) {
            try {
              await registration.instance.dispose();
            } catch (err) {
              logger.warn(`[ServiceContainer] Error disposing service '${name}':`, err);
            }
          }
          registration.instance = null;
          registration.initializationPromise = null;
          disposed.add(name);
        }
      }
    } finally {
      this.isDisposing = false;
      if (this.defaultOptions.enableLogging) {
        logger.log("[ServiceContainer] All services disposed (registrations preserved)");
      }
    }
  }
  /**
   * Get the number of registered services
   */
  get size() {
    return this.services.size;
  }
  /**
   * Get names of all registered services
   */
  getServiceNames() {
    return Array.from(this.services.keys());
  }
  /**
   * Get lifecycle state of a service
   */
  getServiceLifecycle(name) {
    const registration = this.services.get(name);
    if (!registration) {
      return null;
    }
    if (registration.instance) {
      return "initialized" /* INITIALIZED */;
    }
    if (registration.initializationPromise) {
      return "initializing" /* INITIALIZING */;
    }
    return "uninitialized" /* UNINITIALIZED */;
  }
  /**
   * Reset the container, clearing all services
   * This is primarily used for testing to ensure clean state between test runs
   */
  async reset() {
    if (this.isDisposing) {
      throw new Error("Cannot reset container while disposing");
    }
    if (this.defaultOptions.enableLogging) {
      logger.debug("[ServiceContainer] Resetting container...");
    }
    await this.disposeAll();
    this.services.clear();
    this.dependencies.clear();
    this.isDisposing = false;
    this.isReady = false;
    if (this.defaultOptions.enableLogging) {
      logger.debug("[ServiceContainer] Container reset complete");
    }
  }
  /**
   * Internal method to initialize a service
   */
  async _initializeService(registration, ctx) {
    let instance = null;
    try {
      instance = await registration.factory();
      registration.instance = instance;
      instance.lifecycle = "initializing" /* INITIALIZING */;
      if (instance.initialize) {
        await instance.initialize(ctx);
      }
      instance.lifecycle = "initialized" /* INITIALIZED */;
      registration.initializationPromise = null;
      if (registration.options.enableLogging) {
        logger.debug(`[ServiceContainer] Service '${instance.name}' initialized`);
      }
      return instance;
    } catch (error) {
      if (instance) {
        instance.lifecycle = "uninitialized" /* UNINITIALIZED */;
        registration.instance = null;
      }
      registration.initializationPromise = null;
      throw error;
    }
  }
};
var globalServiceContainer = new ServiceContainer({
  lazyInitialization: true,
  allowOverwrite: false,
  enableLogging: true
});
function getServiceContainer() {
  return globalServiceContainer;
}
function registerService(name, factory, options, container = globalServiceContainer) {
  container.register(name, factory, options);
}
function getService(name, ctx, container = globalServiceContainer) {
  return container.get(name, ctx);
}
function tryGetService(name, container = globalServiceContainer) {
  return container.tryGet(name);
}
function tryGetServiceContainerFromCtx(ctx) {
  if (ctx?.container && typeof ctx.container.get === "function" && typeof ctx.container.register === "function") {
    return ctx.container;
  }
  return globalServiceContainer;
}
function disposeAllServices(container = globalServiceContainer) {
  return container.disposeAll();
}
function resetServiceContainer(container = globalServiceContainer) {
  return container.reset();
}

// src/core/interfaces/service-names.ts
var ServiceNames = {
  SCHEDULER: "scheduler",
  SCHEDULER_FACTORY: "scheduler-factory",
  HEALTH_CHECK_CACHE: "health-check-cache",
  STATE_MANAGER: "state-manager",
  KNOWLEDGE_STORE: "knowledge-store",
  WRITER_QUEUE: "writer-queue",
  METRICS: "metrics",
  PLANNING: "planning",
  PROCESS_LIFECYCLE: "process-lifecycle",
  RESEARCH_ORCHESTRATION: "research-orchestration",
  STATE_PATH_CONFIGURATION: "state-path-configuration",
  // Helper services for state management
  FILE_LOCK_SERVICE: "file-lock-service",
  GPU_RESOURCE_SERVICE: "gpu-resource-service",
  STATE_SESSION_MANAGER: "state-session-manager",
  STATE_BROWSER_MANAGER: "state-browser-manager",
  STATE_BACKUP_MANAGER: "state-backup-manager",
  STATE_METRICS_COLLECTOR: "state-metrics-collector",
  STATE_VALIDATOR: "state-validator",
  HEALTH_REGISTRY: "health-registry",
  // Browser infrastructure services
  WORKER_POOL_MANAGER: "worker-pool-manager",
  // Research session services
  RESEARCH_SESSION_SERVICE: "research-session-service",
  RESEARCH_SYNTHESIS_SERVICE: "research-synthesis-service"
};

// src/core/scheduler-service.ts
var SchedulerService = class {
  name = ServiceNames.SCHEDULER;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  scheduler = null;
  initializationPromise = null;
  schedulerVersion = null;
  pendingShutdownPromise = null;
  restartInProgress = false;
  async initialize() {
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) return;
    this.lifecycle = "disposing" /* DISPOSING */;
    if (this.scheduler) {
      try {
        await this.scheduler.shutdown();
      } catch (err) {
        logger.error("[SchedulerService] Error during scheduler shutdown:", err);
      }
      this.scheduler = null;
    }
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  /**
   * Ensure a scheduler is available for research
   * This implements the leader election / connection logic
   */
  async ensureScheduler(config, ctx) {
    if (this.scheduler) return this.scheduler;
    if (this.initializationPromise) return this.initializationPromise;
    const container = tryGetServiceContainerFromCtx(ctx);
    this.initializationPromise = (async () => {
      try {
        const factory = await getService(ServiceNames.SCHEDULER_FACTORY, ctx, container);
        const scheduler = await factory.getScheduler(config);
        this.scheduler = scheduler;
        return scheduler;
      } finally {
        this.initializationPromise = null;
      }
    })();
    return this.initializationPromise;
  }
  /**
   * Get the current scheduler instance if initialized
   */
  getScheduler() {
    return this.scheduler;
  }
  /**
   * Check if the scheduler is ready
   */
  isReady() {
    return this.scheduler !== null;
  }
  // ============================================================================
  // ISchedulerInternals Implementation
  // ============================================================================
  getSchedulerInstance() {
    return this.scheduler;
  }
  setSchedulerInstance(instance) {
    this.scheduler = instance;
  }
  getSchedulerVersion() {
    return this.schedulerVersion;
  }
  setSchedulerVersion(version) {
    this.schedulerVersion = version;
  }
  getSchedulerInitializationPromise() {
    return this.initializationPromise;
  }
  setSchedulerInitializationPromise(promise) {
    this.initializationPromise = promise;
  }
  getPendingShutdownPromise() {
    return this.pendingShutdownPromise;
  }
  setPendingShutdownPromise(promise) {
    this.pendingShutdownPromise = promise;
  }
  isSchedulerRestartInProgress() {
    return this.restartInProgress;
  }
  setSchedulerRestartInProgress(inProgress) {
    this.restartInProgress = inProgress;
  }
};

// src/core/health-check-service.ts
var DEFAULT_BACKOFF_BASE_MS = 1e3;
var DEFAULT_BACKOFF_MAX_MS = 6e4;
var DEFAULT_BACKOFF_MULTIPLIER = 2;
var HealthCheckService = class {
  name = ServiceNames.HEALTH_CHECK_CACHE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  // Thread-safe state management using atomic operations
  _pendingCheck = null;
  _failureCount = 0;
  _backoffUntil = 0;
  // Backoff configuration
  _backoffBaseMs;
  _backoffMaxMs;
  _backoffMultiplier;
  constructor(options) {
    this._backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this._backoffMaxMs = options?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this._backoffMultiplier = options?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  }
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    logger.debug("[HealthCheckService] Initializing...");
    this._pendingCheck = null;
    this._failureCount = 0;
    this._backoffUntil = 0;
    this.lifecycle = "initialized" /* INITIALIZED */;
    logger.debug("[HealthCheckService] Initialized");
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposing" /* DISPOSING */;
    logger.debug("[HealthCheckService] Disposing...");
    this.clear();
    this.lifecycle = "disposed" /* DISPOSED */;
    logger.debug("[HealthCheckService] Disposed");
  }
  /**
   * Get the cached pending health check promise
   */
  getPendingCheck() {
    return this._pendingCheck;
  }
  /**
   * Set a pending health check promise
   * This should only be called from orchestration code that coordinates health checks
   */
  setPendingCheck(promise) {
    this._pendingCheck = promise;
    if (promise) {
      promise.finally(() => {
        if (this._pendingCheck === promise) {
          this._pendingCheck = null;
        }
      });
    }
  }
  /**
   * Get the failure count
   */
  getFailureCount() {
    return this._failureCount;
  }
  /**
   * Increment the failure count
   */
  incrementFailureCount() {
    this._failureCount++;
    logger.debug(`[HealthCheckService] Failure count incremented to ${this._failureCount}`);
  }
  /**
   * Reset the failure count
   */
  resetFailureCount() {
    if (this._failureCount > 0) {
      logger.debug(`[HealthCheckService] Failure count reset from ${this._failureCount} to 0`);
    }
    this._failureCount = 0;
  }
  /**
   * Get the backoff timestamp
   */
  getBackoffUntil() {
    return this._backoffUntil;
  }
  /**
   * Set the backoff timestamp
   */
  setBackoffUntil(timestamp) {
    this._backoffUntil = timestamp;
    const remainingMs = Math.max(0, timestamp - Date.now());
    if (remainingMs > 0) {
      logger.debug(`[HealthCheckService] Backoff set: ${remainingMs}ms remaining`);
    }
  }
  /**
   * Clear all cache state
   */
  clear() {
    this._pendingCheck = null;
    this._failureCount = 0;
    this._backoffUntil = 0;
    logger.debug("[HealthCheckService] Cache cleared");
  }
  /**
   * Check if a backoff is currently active
   */
  isBackoffActive() {
    return Date.now() < this._backoffUntil;
  }
  /**
   * Get remaining backoff time in milliseconds
   */
  getBackoffRemainingMs() {
    return Math.max(0, this._backoffUntil - Date.now());
  }
  /**
   * Calculate the next backoff duration based on failure count
   * Uses exponential backoff with jitter
   */
  calculateNextBackoffMs() {
    const backoffMs = Math.min(
      this._backoffBaseMs * Math.pow(this._backoffMultiplier, this._failureCount),
      this._backoffMaxMs
    );
    const jitter = backoffMs * 0.25 * (Math.random() * 2 - 1);
    return Math.floor(backoffMs + jitter);
  }
  /**
   * Set backoff based on current failure count
   */
  setBackoff() {
    const backoffMs = this.calculateNextBackoffMs();
    this._backoffUntil = Date.now() + backoffMs;
    logger.debug(`[HealthCheckService] Backoff set: ${backoffMs}ms (${this._failureCount} failures)`);
  }
  /**
   * Record a health check failure
   * Increments failure count and sets backoff
   */
  recordFailure() {
    this.incrementFailureCount();
    this.setBackoff();
  }
  /**
   * Record a health check success
   * Resets failure count and clears backoff
   */
  recordSuccess() {
    this.resetFailureCount();
    this._backoffUntil = 0;
    logger.debug("[HealthCheckService] Health check success recorded");
  }
  /**
   * Get the current backoff state as an object
   */
  getBackoffState() {
    return {
      isActive: this.isBackoffActive(),
      remainingMs: this.getBackoffRemainingMs(),
      failureCount: this._failureCount,
      nextBackoffMs: this.calculateNextBackoffMs()
    };
  }
  /**
   * Wait for backoff to complete if active
   * Returns immediately if no backoff is active
   */
  async waitForBackoff() {
    const remainingMs = this.getBackoffRemainingMs();
    if (remainingMs > 0) {
      logger.debug(`[HealthCheckService] Waiting for backoff: ${remainingMs}ms`);
      await new Promise((resolve5) => setTimeout(resolve5, remainingMs));
      logger.debug("[HealthCheckService] Backoff complete");
    }
  }
  /**
   * Check if a new health check should be allowed
   * Returns false if backoff is active or a check is already pending
   */
  shouldAllowCheck() {
    if (this._pendingCheck !== null) {
      logger.debug("[HealthCheckService] Check not allowed: already pending");
      return false;
    }
    if (this.isBackoffActive()) {
      const remainingMs = this.getBackoffRemainingMs();
      logger.debug(`[HealthCheckService] Check not allowed: backoff active (${remainingMs}ms remaining)`);
      return false;
    }
    return true;
  }
};

// src/core/planning-service.ts
import { completeSimple } from "@earendil-works/pi-ai";

// src/core/llm/inject-date.ts
function getCurrentDateString() {
  const now = /* @__PURE__ */ new Date();
  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  };
  return now.toLocaleDateString("en-US", options);
}
function injectCurrentDate(prompt, _agentType) {
  const dateString = getCurrentDateString();
  const dateContext = `**Current Date:** ${dateString}

`;
  return dateContext + prompt;
}

// src/core/llm/prompts.ts
import { readFileSync } from "node:fs";
import { join as join4, dirname as dirname2 } from "node:path";
import { fileURLToPath } from "node:url";
var __filename = fileURLToPath(import.meta.url);
var CORE_LLM_DIR = dirname2(__filename);
var PROMPT_CANDIDATES = [
  join4(CORE_LLM_DIR, "../../prompts"),
  // source tree
  join4(CORE_LLM_DIR, "prompts")
  // openclaw bundle (dist/prompts/)
];
function loadPrompt(name) {
  for (const dir of PROMPT_CANDIDATES) {
    try {
      return readFileSync(join4(dir, `${name}.md`), "utf-8");
    } catch {
    }
  }
  logger.error(`[prompts] Failed to load prompt: ${name} (searched: ${PROMPT_CANDIDATES.join(", ")})`);
  return "";
}

// src/types/llm.ts
import { calculateCost } from "@earendil-works/pi-ai";
function parseTokenUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return {};
  }
  const obj = usage;
  const result = {};
  if (typeof obj["input"] === "number") {
    result.input = obj["input"];
  }
  if (typeof obj["output"] === "number") {
    result.output = obj["output"];
  }
  if (typeof obj["cacheRead"] === "number") {
    result.cacheRead = obj["cacheRead"];
  }
  if (typeof obj["cacheWrite"] === "number") {
    result.cacheWrite = obj["cacheWrite"];
  }
  if (typeof obj["totalTokens"] === "number") {
    result.totalTokens = obj["totalTokens"];
  }
  if (obj["cost"] && typeof obj["cost"] === "object") {
    result.cost = obj["cost"];
  }
  return result;
}
function calculateTotalTokens(usage) {
  if (usage.totalTokens !== void 0) {
    return usage.totalTokens;
  }
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}
function extractUsage(model, rawUsage) {
  if (!rawUsage) {
    return { tokens: 0, cost: 0, parsed: {} };
  }
  const parsed = parseTokenUsage(rawUsage);
  const tokens = calculateTotalTokens(parsed);
  let cost = parsed.cost?.total ?? rawUsage.cost?.total ?? 0;
  if (cost === 0 && tokens > 0) {
    try {
      const calculatedCost = calculateCost(model, rawUsage);
      cost = calculatedCost.total;
    } catch {
    }
  }
  return { tokens, cost, parsed };
}

// src/utils/metrics.ts
import { AsyncLocalStorage as AsyncLocalStorage5 } from "node:async_hooks";
var MetricsRegistry = class {
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
var runRegistryStorage = new AsyncLocalStorage5();
var MAX_RUN_HISTORY = 10;
var SessionMetrics = class {
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
var metrics = new SessionMetrics();

// src/utils/json-utils.ts
function extractJsonFromCodeBlocks(text) {
  const codeBlockRegex = /```(?:json|javascript)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const codeContent = match[1] ?? "";
    try {
      const parsed = JSON.parse(codeContent.trim());
      return { success: true, value: parsed, method: "code-block" };
    } catch {
      continue;
    }
  }
  return {
    success: false,
    value: void 0,
    error: "No valid JSON found in code blocks"
  };
}
function findMatchingBracket(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const open3 = text[start];
  const close = open3 === "{" ? "}" : "]";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open3) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { index: i, inString: false };
    }
  }
  return { index: -1, inString };
}
function preRepairJson(jsonStr) {
  return jsonStr.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, "$1");
}
function extractJsonObject(text) {
  const objStart = text.indexOf("{");
  if (objStart === -1) {
    return {
      success: false,
      value: void 0,
      error: "No JSON object boundaries found"
    };
  }
  const { index: objEnd, inString } = findMatchingBracket(text, objStart);
  if (objEnd === -1) {
    logger.debug("[json-utils] JSON object truncated; attempting local repair");
    let partialText = text.slice(objStart);
    if (inString) {
      partialText += '"';
    }
    for (let i = 1; i <= 15; i++) {
      try {
        const candidate = preRepairJson(partialText + "}".repeat(i));
        const parsed = JSON.parse(candidate);
        logger.debug(`[json-utils] JSON object truncated; salvaged by appending ${inString ? "quote and " : ""}${i} closing braces`);
        return { success: true, value: parsed, method: "raw-object" };
      } catch {
        continue;
      }
    }
    return {
      success: false,
      value: void 0,
      error: "No matching closing brace found and local repair failed"
    };
  }
  try {
    const jsonStr = preRepairJson(text.slice(objStart, objEnd + 1));
    const parsed = JSON.parse(jsonStr);
    return { success: true, value: parsed, method: "raw-object" };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      value: void 0,
      error: `Failed to parse JSON object: ${errorMsg}`
    };
  }
}
function extractJsonArray(text) {
  const arrStart = text.indexOf("[");
  if (arrStart === -1) {
    return {
      success: false,
      value: void 0,
      error: "No JSON array boundaries found"
    };
  }
  const { index: arrEnd, inString } = findMatchingBracket(text, arrStart);
  if (arrEnd === -1) {
    logger.debug("[json-utils] JSON array truncated; attempting local repair");
    let partialText = text.slice(arrStart);
    if (inString) {
      partialText += '"';
    }
    for (let i = 1; i <= 15; i++) {
      try {
        const candidate = preRepairJson(partialText + "]".repeat(i));
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
          logger.debug(`[json-utils] JSON array truncated; salvaged by appending ${inString ? "quote and " : ""}${i} closing brackets`);
          return { success: true, value: parsed, method: "raw-array" };
        }
      } catch {
        continue;
      }
    }
    return {
      success: false,
      value: void 0,
      error: "No matching closing bracket found and local repair failed"
    };
  }
  try {
    const jsonStr = preRepairJson(text.slice(arrStart, arrEnd + 1));
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      return {
        success: false,
        value: void 0,
        error: "Parsed value is not an array"
      };
    }
    return { success: true, value: parsed, method: "raw-array" };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      value: void 0,
      error: `Failed to parse JSON array: ${errorMsg}`
    };
  }
}
function extractJson(text, targetType = "any") {
  const codeBlockResult = extractJsonFromCodeBlocks(text);
  if (codeBlockResult.success) {
    logger.debug("[json-utils] Extracted JSON from code block");
    return codeBlockResult;
  }
  if (targetType === "object" || targetType === "any") {
    const objectResult = extractJsonObject(text);
    if (objectResult.success) {
      logger.debug("[json-utils] Extracted JSON object from raw text");
      return objectResult;
    }
  }
  if (targetType === "array" || targetType === "any") {
    const arrayResult = extractJsonArray(text);
    if (arrayResult.success) {
      logger.debug("[json-utils] Extracted JSON array from raw text");
      return arrayResult;
    }
  }
  return {
    success: false,
    value: void 0,
    error: "No valid JSON found using any extraction method"
  };
}

// src/config.ts
import * as fs5 from "node:fs";
import * as path6 from "node:path";
import * as os3 from "node:os";
import { Type } from "typebox";
import { Value } from "typebox/value";

// src/utils/text-utils.ts
import * as path5 from "node:path";
function extractText(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  const msg = message;
  const { content } = msg;
  if (typeof content === "string") {
    return stripThinkingTags(content);
  }
  if (Array.isArray(content)) {
    try {
      return content.filter((b) => b && typeof b === "object" && b["type"] === "text").map((b) => {
        const blockObj = b;
        const text = blockObj["text"];
        return typeof text === "string" ? stripThinkingTags(text) : "";
      }).filter((t) => t.length > 0).join("\n");
    } catch (_error) {
    }
  }
  return "";
}
function stripThinkingTags(text) {
  if (!text) return "";
  return text.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, "").replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, "").replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, "").trim();
}
function ensureAssistantResponse(session, label) {
  const msgs = session.messages;
  const last = [...msgs].reverse().find((m) => m.role === "assistant");
  if (!last) {
    throw new Error(`${label}: No assistant response found`);
  }
  if (last.stopReason === "error" || last.errorMessage && last.stopReason !== "aborted") {
    const msg = last.errorMessage || "Unknown error";
    if (msg.includes("429")) {
      throw new Error(`Model API rate limit (429) \u2014 wait a moment and retry. Details: ${msg}`);
    }
    throw new Error(`${label}: Provider error - ${msg}`);
  }
  if (last.stopReason === "length") {
    const text2 = extractText(last);
    if (text2.trim()) {
      logger.warn(`${label}: Response truncated by token limit \u2014 returning partial result`);
      return text2;
    }
    throw new Error(`${label}: Response was truncated by token limit and produced no usable text.`);
  }
  const text = extractText(last);
  if (!text.trim()) {
    throw new Error(
      `${label}: Researcher produced no text output. This usually means the browser-based search engine was unavailable during the run \u2014 check system resources and retry.`
    );
  }
  return text;
}
function normalizeWorkspacePath(wsPath) {
  if (!wsPath) return "";
  const resolved = path5.resolve(wsPath);
  return resolved.endsWith(path5.sep) && resolved.length > 1 ? resolved.slice(0, -1) : resolved;
}
function parseCitations(report) {
  const sectionMatch = /###\s*CITED LINKS[\s\S]*$/i.exec(report);
  if (!sectionMatch) return [];
  const section = sectionMatch[0];
  const citations = [];
  const blocks = section.split(/(?:\*\*|)\s*(?:\[\d+\]|\d+\.)\s*(?:\*\*|)/).slice(1);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length === 0) continue;
    const firstLine = lines[0].trim();
    let url;
    let desc = "";
    let source = "";
    const inlineMatch = /^(https?:\/\/[^\s\n]+)(?:\s+\[Source:\s*([^\]]*)\])?(?:\s*[—–-]\s*([^\n]*))?/.exec(firstLine);
    if (inlineMatch) {
      url = inlineMatch[1].trim().replace(/[*_~`]+$/, "").replace(/[,.)]+$/, "");
      source = inlineMatch[2]?.trim() || "";
      desc = (inlineMatch[3]?.trim() || "").replace(/[*_~`]+$/, "");
    } else {
      const candidateUrl = firstLine.split(/\s+/)[0].trim().replace(/[*_~`]+$/, "").replace(/[,.)]+$/, "");
      if (!candidateUrl.startsWith("http")) continue;
      url = candidateUrl;
    }
    const descLines = [];
    let foundDescTag = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.match(/^Source:/i)) {
        source = line.replace(/^Source:\s*/i, "").trim();
        continue;
      }
      if (!foundDescTag) {
        if (line.match(/^Description:/i)) {
          foundDescTag = true;
          descLines.push(line.replace(/^Description:\s*/i, ""));
        }
      } else {
        descLines.push(line);
      }
    }
    if (descLines.length > 0) {
      desc = descLines.join("\n").trim();
    }
    if (url) {
      citations.push({ url, description: desc, source });
    }
  }
  return citations;
}

// src/config.ts
var ConfigSchema = Type.Object({
  /** Per-researcher timeout in milliseconds (default: 300000, range: 3-30 min) */
  RESEARCHER_TIMEOUT_MS: Type.Number({ minimum: 18e4, maximum: 18e5, default: 3e5 }),
  /** Maximum number of concurrent researcher processes (default: 3, range: 1-5) */
  MAX_CONCURRENT_RESEARCHERS: Type.Number({ minimum: 1, maximum: 5, default: 3 }),
  /** Maximum number of retries for a failed researcher (default: 2, range: 0-5) */
  RESEARCHER_MAX_RETRIES: Type.Number({ minimum: 0, maximum: 5, default: 2 }),
  /** Base delay between retries in milliseconds (default: 2000, range: 100-10000) */
  RESEARCHER_MAX_RETRY_DELAY_MS: Type.Number({ minimum: 100, maximum: 1e4, default: 2e3 }),
  /** Target depth for recursive research (default: 1, range: 1-3) */
  DEFAULT_RESEARCH_DEPTH: Type.Number({ minimum: 1, maximum: 3, default: 1 }),
  /** Number of batches to allow for a single scrape tool call (default: 2, 0=unlimited) */
  MAX_SCRAPE_BATCHES: Type.Number({ minimum: 0, maximum: 99, default: 2 }),
  /** Number of parallel browser pool workers (default: 4, range: 1-10) */
  WORKER_THREADS: Type.Number({ minimum: 1, maximum: 10, default: 4 }),
  /** Number of concurrent tasks per pool worker process (default: 2, range: 1-10) */
  WORKER_CONCURRENCY: Type.Number({ minimum: 1, maximum: 10, default: 2 }),
  /** Knowledge store isolation mode (default: 'none') */
  KNOWLEDGE_STORE_MODE: Type.Union([Type.Literal("none"), Type.Literal("project"), Type.Literal("global")], { default: "none" }),
  /** Embedding model to use for the knowledge store */
  EMBEDDING_MODEL: Type.String({ default: "onnx-community/granite-embedding-small-english-r2-ONNX" }),
  /** Hardware backend for embeddings: 'webgpu' or 'cpu' */
  EMBEDDING_DEVICE: Type.Union([Type.Literal("webgpu"), Type.Literal("cpu")], { default: "webgpu" }),
  /** Timeout for scraping operations in milliseconds (default: 15000, range: 5-120 seconds) */
  SCRAPE_TIMEOUT_MS: Type.Number({ minimum: 5e3, maximum: 12e4, default: 15e3 }),
  /** How long to keep documents in the knowledge store before eviction (default: 30 days) */
  KNOWLEDGE_STORE_CACHE_TTL_DAYS: Type.Number({ minimum: 1, maximum: 365, default: 30 }),
  /** Timeout for embedding model initialization (default: 300000ms) */
  EMBEDDING_MODEL_INIT_TIMEOUT_MS: Type.Number({ minimum: 1e4, maximum: 6e5, default: 3e5 }),
  /** Max fraction of context window to use for initial scrape context (default: 0.15) */
  MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: Type.Number({ minimum: 0.05, maximum: 1, default: 0.15 }),
  /** Estimated tokens per scrape result for planning (default: 2500) */
  AVG_TOKENS_PER_SCRAPE: Type.Number({ minimum: 500, maximum: 1e4, default: 2500 }),
  /** Maximum number of concurrent scrapes (default: 3) */
  MAX_CONCURRENT_SCRAPES: Type.Number({ minimum: 1, maximum: 20, default: 3 }),
  /** Health check timeout in milliseconds (default: 10000ms) */
  HEALTH_CHECK_TIMEOUT_MS: Type.Number({ minimum: 2e3, maximum: 12e4, default: 1e4 }),
  /** Default timeout for browser page operations like search (default: 45000ms) */
  SEARCH_TIMEOUT_MS: Type.Number({ minimum: 5e3, maximum: 12e4, default: 45e3 }),
  /** TUI refresh debounce in milliseconds (default: 100ms) */
  TUI_REFRESH_DEBOUNCE_MS: Type.Number({ minimum: 0, maximum: 1e3, default: 100 }),
  /** Timeout for individual browser tasks (default: 10000ms) */
  BROWSER_TASK_TIMEOUT_MS: Type.Number({ minimum: 2e3, maximum: 12e4, default: 1e4 }),
  /** Timeout for coordinator/evaluator/repair/knowledge LLM calls in ms (default: 300000 = 5 min, range: 60s-600s).
   *  Not exposed in TUI — controlled via PI_RESEARCH_LLM_TIMEOUT_MS env var. */
  LLM_TIMEOUT_MS: Type.Number({ minimum: 6e4, maximum: 6e5, default: 3e5 }),
  /** LLM Model override for researcher sub-agents and knowledge synthesis.
   *  Format: provider/model-id (e.g. google/gemini-2.0-flash-001) or just model-id.
   *  When set, this overrides ctx.model for researcher sub-agents (both deep and quick)
   *  and the knowledge synthesis background LLM. The coordinator and evaluator always
   *  use the caller's model (ctx.model).
   */
  RESEARCH_MODEL: Type.Optional(Type.String()),
  /** Explicit directory for the knowledge store database (overrides default) */
  KNOWLEDGE_STORE_DIR: Type.Optional(Type.String()),
  /** Whether to automatically export a markdown research report to disk at the end (default: false) */
  RESEARCH_REPORT_EXPORT_ENABLED: Type.Boolean({ default: false }),
  /** Strategy for database schema/model migrations: 'drop', 're-embed', or 'backup' (default: 'backup') */
  MIGRATION_STRATEGY: Type.Union([
    Type.Literal("drop"),
    Type.Literal("re-embed"),
    Type.Literal("backup")
  ], { default: "backup" }),
  /** Whether to mirror logs to the console (stdout/stderr). (default: false) */
  CONSOLE_LOG: Type.Boolean({ default: false }),
  /** Enable debug/verbose logging (writes INFO+DEBUG to log file). (default: false) */
  DEBUG: Type.Boolean({ default: false })
});
var DEFAULTS = Value.Create(ConfigSchema);
var LOCAL_SCOPE_KEYS = /* @__PURE__ */ new Set([
  "PI_RESEARCH_DEFAULT_RESEARCH_DEPTH",
  "PI_RESEARCH_KNOWLEDGE_STORE_MODE"
]);
var USER_MIGRATION_KEYS = [
  // Core user-scoped from schema
  "PI_RESEARCH_TIMEOUT_MS",
  "PI_RESEARCH_MAX_RESEARCHERS",
  "PI_RESEARCH_MAX_RETRIES",
  "PI_RESEARCH_RETRY_DELAY_MS",
  "PI_RESEARCH_MAX_SCRAPE_BATCHES",
  "PI_RESEARCH_WORKER_THREADS",
  "PI_RESEARCH_WORKER_CONCURRENCY",
  "PI_RESEARCH_EMBEDDING_MODEL",
  "PI_RESEARCH_EMBEDDING_DEVICE",
  "PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS",
  "PI_RESEARCH_SCRAPE_TIMEOUT_MS",
  "PI_RESEARCH_CACHE_TTL_DAYS",
  "PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING",
  "PI_RESEARCH_AVG_TOKENS_PER_SCRAPE",
  "PI_RESEARCH_MAX_CONCURRENT_SCRAPES",
  "PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS",
  "PI_RESEARCH_SEARCH_TIMEOUT_MS",
  "PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS",
  "PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS",
  "PI_RESEARCH_LLM_TIMEOUT_MS",
  "PI_RESEARCH_MIGRATION_STRATEGY",
  "PI_RESEARCH_CONSOLE_LOG",
  "PI_RESEARCH_MODEL",
  "PI_RESEARCH_KNOWLEDGE_DIR",
  "PI_RESEARCH_REPORT_EXPORT_ENABLED",
  "PI_RESEARCH_DEBUG"
];
function getProjectSettingsRegistryPath() {
  const stateDir = process.env["PI_RESEARCH_STATE_DIR"] ?? path6.join(os3.homedir(), ".pi", "state");
  return path6.join(stateDir, "project-settings.json");
}
function loadProjectSettingsRegistry() {
  const registryPath = getProjectSettingsRegistryPath();
  try {
    if (fs5.existsSync(registryPath)) {
      const content = fs5.readFileSync(registryPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (err) {
    logger.warn("[config] Failed to read project settings registry:", err);
  }
  return {};
}
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_err) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
function saveProjectSettingsRegistry(registry) {
  const registryPath = getProjectSettingsRegistryPath();
  const dir = path6.dirname(registryPath);
  if (!fs5.existsSync(dir)) {
    fs5.mkdirSync(dir, { recursive: true });
  }
  const lockPath = `${registryPath}.lock`;
  let lockFd = null;
  const maxRetries = 100;
  try {
    for (let i = 0; i < maxRetries; i++) {
      try {
        lockFd = fs5.openSync(lockPath, "wx");
        break;
      } catch (err) {
        if (err.code === "EEXIST") {
          try {
            const stats = fs5.statSync(lockPath);
            if (Date.now() - stats.mtimeMs > 3e4) {
              fs5.unlinkSync(lockPath);
              continue;
            }
          } catch {
          }
          sleepSync(50);
          continue;
        }
        throw err;
      }
    }
    if (lockFd !== null) {
      fs5.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
    } else {
      throw new Error(`Failed to acquire lock for project settings registry after ${maxRetries} retries. Aborting to prevent data corruption.`);
    }
  } catch (err) {
    logger.error("[config] Failed to save project settings registry:", err);
  } finally {
    if (lockFd !== null) {
      try {
        fs5.closeSync(lockFd);
      } catch {
      }
      try {
        fs5.unlinkSync(lockPath);
      } catch {
      }
    }
  }
}
function getGlobalConfigDir() {
  return path6.join(os3.homedir(), ".pi", "research");
}
function getGlobalEnvFilePath() {
  return path6.join(getGlobalConfigDir(), "config.env");
}
function getLocalEnvFilePath(cwd = process.cwd()) {
  return path6.resolve(cwd, ".pi-research.env");
}
function getDbDir(config, cwd = process.cwd()) {
  const cfg = config || getConfig(cwd);
  if (cfg.KNOWLEDGE_STORE_DIR) {
    return path6.isAbsolute(cfg.KNOWLEDGE_STORE_DIR) ? cfg.KNOWLEDGE_STORE_DIR : path6.resolve(cwd, cfg.KNOWLEDGE_STORE_DIR);
  }
  return path6.join(getGlobalConfigDir(), "knowledge_db");
}
function parseDotEnv(content) {
  const out = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).replace(/\r$/, "");
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (key) out[key] = val;
  }
  return out;
}
function loadEnvFiles(cwd) {
  const merged = {};
  const globalPath = getGlobalEnvFilePath();
  const registry = loadProjectSettingsRegistry();
  const normalizedCwd = normalizeWorkspacePath(cwd);
  const homeRegistry = registry[normalizeWorkspacePath(os3.homedir())];
  try {
    if (!fs5.existsSync(globalPath) && homeRegistry && Object.keys(homeRegistry).length > 0) {
      logger.info("[config] config.env missing. Initializing from user settings in central registry...");
      const migrated = {};
      for (const key of USER_MIGRATION_KEYS) {
        if (homeRegistry[key] !== void 0) migrated[key] = homeRegistry[key];
      }
      if (Object.keys(migrated).length > 0) {
        const dummyConfig = createConfig(migrated, {});
        saveConfig(dummyConfig, "user", cwd);
      }
    }
  } catch (err) {
    logger.warn("[config] Failed one-time config.env migration:", err);
  }
  try {
    if (fs5.existsSync(globalPath)) {
      Object.assign(merged, parseDotEnv(fs5.readFileSync(globalPath, "utf-8")));
    }
  } catch (err) {
    logger.warn("[config] Failed to read global env file:", err);
  }
  const legacyPath = getLocalEnvFilePath(cwd);
  let legacyEnv = {};
  if (fs5.existsSync(legacyPath)) {
    try {
      logger.warn(`[config] \u26A0 .pi-research.env files are deprecated. Settings will be auto-migrated to the centralized registry. Remove ${legacyPath} after migration.`);
      legacyEnv = parseDotEnv(fs5.readFileSync(legacyPath, "utf-8"));
      Object.assign(merged, legacyEnv);
      if (!registry[normalizedCwd] || JSON.stringify(registry[normalizedCwd]) !== JSON.stringify(legacyEnv)) {
        logger.info(`[config] Migrating legacy .pi-research.env settings from ${cwd} to central registry...`);
        registry[normalizedCwd] = { ...registry[normalizedCwd], ...legacyEnv };
        saveProjectSettingsRegistry(registry);
      }
    } catch (err) {
      logger.warn(`[config] Failed to load legacy settings for ${cwd}:`, err);
    }
  }
  if (registry[normalizedCwd]) {
    for (const [key, val] of Object.entries(registry[normalizedCwd])) {
      if (LOCAL_SCOPE_KEYS.has(key) && legacyEnv[key] !== void 0 && legacyEnv[key] !== val) {
        logger.warn(`[config] Config divergence for ${key} in ${cwd}: Registry="${val}" vs Legacy="${legacyEnv[key]}". Registry wins.`);
      }
    }
    for (const [key, val] of Object.entries(registry[normalizedCwd])) {
      if (!LOCAL_SCOPE_KEYS.has(key) && merged[key] !== void 0 && merged[key] !== val) {
        logger.warn(`[config] Registry override for user-scoped ${key}: Registry="${val}" overrides config.env="${merged[key]}". This indicates a stale snapshot in the registry. Registry wins \u2014 consider re-saving your user settings.`);
      }
    }
    Object.assign(merged, registry[normalizedCwd]);
  } else if (Object.keys(merged).length === 0 && !fs5.existsSync(legacyPath) && !fs5.existsSync(globalPath)) {
    logger.warn(`[config] No configuration found for workspace: ${cwd}. Using code defaults. Run /research-config to configure.`);
  }
  return merged;
}
function saveConfig(config, scope = "local", cwd = process.cwd()) {
  const allValues = {
    PI_RESEARCH_TIMEOUT_MS: String(config.RESEARCHER_TIMEOUT_MS),
    PI_RESEARCH_MAX_RESEARCHERS: String(config.MAX_CONCURRENT_RESEARCHERS),
    PI_RESEARCH_MAX_RETRIES: String(config.RESEARCHER_MAX_RETRIES),
    PI_RESEARCH_RETRY_DELAY_MS: String(config.RESEARCHER_MAX_RETRY_DELAY_MS),
    PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS: String(config.HEALTH_CHECK_TIMEOUT_MS ?? DEFAULTS.HEALTH_CHECK_TIMEOUT_MS),
    PI_RESEARCH_SEARCH_TIMEOUT_MS: String(config.SEARCH_TIMEOUT_MS),
    PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS: String(config.TUI_REFRESH_DEBOUNCE_MS),
    PI_RESEARCH_DEFAULT_RESEARCH_DEPTH: String(config.DEFAULT_RESEARCH_DEPTH),
    PI_RESEARCH_MAX_SCRAPE_BATCHES: String(config.MAX_SCRAPE_BATCHES),
    PI_RESEARCH_WORKER_THREADS: String(config.WORKER_THREADS),
    PI_RESEARCH_WORKER_CONCURRENCY: String(config.WORKER_CONCURRENCY),
    PI_RESEARCH_KNOWLEDGE_STORE_MODE: config.KNOWLEDGE_STORE_MODE,
    PI_RESEARCH_EMBEDDING_MODEL: config.EMBEDDING_MODEL,
    PI_RESEARCH_EMBEDDING_DEVICE: config.EMBEDDING_DEVICE,
    PI_RESEARCH_SCRAPE_TIMEOUT_MS: String(config.SCRAPE_TIMEOUT_MS),
    PI_RESEARCH_CACHE_TTL_DAYS: String(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
    PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS: String(config.EMBEDDING_MODEL_INIT_TIMEOUT_MS),
    PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: String(config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING),
    PI_RESEARCH_AVG_TOKENS_PER_SCRAPE: String(config.AVG_TOKENS_PER_SCRAPE),
    PI_RESEARCH_MAX_CONCURRENT_SCRAPES: String(config.MAX_CONCURRENT_SCRAPES),
    PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS: String(config.BROWSER_TASK_TIMEOUT_MS),
    PI_RESEARCH_LLM_TIMEOUT_MS: String(config.LLM_TIMEOUT_MS),
    PI_RESEARCH_MIGRATION_STRATEGY: config.MIGRATION_STRATEGY,
    PI_RESEARCH_CONSOLE_LOG: String(config.CONSOLE_LOG),
    ...config.RESEARCH_MODEL ? { PI_RESEARCH_MODEL: config.RESEARCH_MODEL } : {},
    ...config.KNOWLEDGE_STORE_DIR ? { PI_RESEARCH_KNOWLEDGE_DIR: config.KNOWLEDGE_STORE_DIR } : {},
    PI_RESEARCH_REPORT_EXPORT_ENABLED: String(config.RESEARCH_REPORT_EXPORT_ENABLED),
    PI_RESEARCH_DEBUG: String(config.DEBUG)
  };
  const newValues = scope === "local" ? Object.fromEntries(Object.entries(allValues).filter(([k]) => LOCAL_SCOPE_KEYS.has(k))) : Object.fromEntries(Object.entries(allValues).filter(([k]) => !LOCAL_SCOPE_KEYS.has(k)));
  if (scope === "local") {
    const registry = loadProjectSettingsRegistry();
    const normalizedCwd = normalizeWorkspacePath(cwd);
    registry[normalizedCwd] = newValues;
    saveProjectSettingsRegistry(registry);
    logger.debug(`[config] Saved project settings for ${normalizedCwd} to central registry.`);
    return;
  }
  const p = getGlobalEnvFilePath();
  const lockPath = `${p}.lock`;
  const dir = path6.dirname(p);
  if (!fs5.existsSync(dir)) {
    fs5.mkdirSync(dir, { recursive: true });
  }
  let lockFd = null;
  const lockRetryDelay = 50;
  const lockMaxRetries = 100;
  for (let i = 0; i < lockMaxRetries; i++) {
    try {
      lockFd = fs5.openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const stats = fs5.statSync(lockPath);
          if (Date.now() - stats.mtimeMs > 3e4) {
            fs5.unlinkSync(lockPath);
            continue;
          }
        } catch {
        }
        const jitter = Math.floor(Math.random() * 20);
        sleepSync(lockRetryDelay + jitter);
        continue;
      }
      throw err;
    }
  }
  if (lockFd === null) {
    throw new Error(`Failed to acquire lock for ${p} after ${lockMaxRetries} retries`);
  }
  try {
    let lines = [];
    if (fs5.existsSync(p)) {
      lines = fs5.readFileSync(p, "utf-8").split("\n");
    } else {
      lines = [
        `# pi-research global configuration`,
        ""
      ];
    }
    const updatedKeys = /* @__PURE__ */ new Set();
    const outLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        outLines.push(line);
        continue;
      }
      const eq = line.indexOf("=");
      if (eq < 1) {
        outLines.push(line);
        continue;
      }
      const key = line.slice(0, eq).trim();
      if (newValues[key] !== void 0) {
        outLines.push(`${key}=${newValues[key]}`);
        updatedKeys.add(key);
      } else {
        outLines.push(line);
      }
    }
    for (const [key, val] of Object.entries(newValues)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (!updatedKeys.has(key) && val !== "") {
        if (outLines.length > 0 && outLines[outLines.length - 1]?.trim() !== "") {
          outLines.push("");
        }
        outLines.push(`${key}=${val}`);
        updatedKeys.add(key);
      }
    }
    const tmpPath = `${p}.tmp.${Date.now()}`;
    fs5.writeFileSync(tmpPath, outLines.join("\n"), "utf-8");
    try {
      fs5.renameSync(tmpPath, p);
    } catch (renameErr) {
      if (process.platform === "win32") {
        fs5.copyFileSync(tmpPath, p);
        try {
          fs5.unlinkSync(tmpPath);
        } catch {
        }
      } else {
        try {
          fs5.unlinkSync(tmpPath);
        } catch {
        }
        throw renameErr;
      }
    }
  } catch (err) {
    logger.error(`[config] Failed to write config to ${p}:`, err);
    throw err;
  } finally {
    fs5.closeSync(lockFd);
    try {
      fs5.unlinkSync(lockPath);
    } catch {
    }
  }
}
var configCache = /* @__PURE__ */ new Map();
function createConfig(env, processEnv) {
  const e = { ...env, ...processEnv };
  const raw = {
    RESEARCHER_TIMEOUT_MS: parseEnvNumber(e, "PI_RESEARCH_TIMEOUT_MS", DEFAULTS.RESEARCHER_TIMEOUT_MS, 18e4, 18e5),
    MAX_CONCURRENT_RESEARCHERS: parseEnvNumber(e, "PI_RESEARCH_MAX_RESEARCHERS", DEFAULTS.MAX_CONCURRENT_RESEARCHERS, 1, 5),
    RESEARCHER_MAX_RETRIES: parseEnvNumber(e, "PI_RESEARCH_MAX_RETRIES", DEFAULTS.RESEARCHER_MAX_RETRIES, 0, 5),
    RESEARCHER_MAX_RETRY_DELAY_MS: parseEnvNumber(e, "PI_RESEARCH_RETRY_DELAY_MS", DEFAULTS.RESEARCHER_MAX_RETRY_DELAY_MS, 100, 1e4),
    DEFAULT_RESEARCH_DEPTH: parseEnvNumber(e, "PI_RESEARCH_DEFAULT_RESEARCH_DEPTH", DEFAULTS.DEFAULT_RESEARCH_DEPTH, 1, 3),
    MAX_SCRAPE_BATCHES: parseEnvNumber(e, "PI_RESEARCH_MAX_SCRAPE_BATCHES", DEFAULTS.MAX_SCRAPE_BATCHES, 0, 99),
    WORKER_THREADS: parseEnvNumber(e, "PI_RESEARCH_WORKER_THREADS", DEFAULTS.WORKER_THREADS, 1, 10),
    WORKER_CONCURRENCY: parseEnvNumber(e, "PI_RESEARCH_WORKER_CONCURRENCY", DEFAULTS.WORKER_CONCURRENCY, 1, 10),
    KNOWLEDGE_STORE_MODE: parseEnvString(e, "PI_RESEARCH_KNOWLEDGE_STORE_MODE", "none"),
    EMBEDDING_MODEL: parseEnvString(e, "PI_RESEARCH_EMBEDDING_MODEL", DEFAULTS.EMBEDDING_MODEL),
    EMBEDDING_DEVICE: parseEnvString(e, "PI_RESEARCH_EMBEDDING_DEVICE", DEFAULTS.EMBEDDING_DEVICE),
    SCRAPE_TIMEOUT_MS: parseEnvNumber(e, "PI_RESEARCH_SCRAPE_TIMEOUT_MS", DEFAULTS.SCRAPE_TIMEOUT_MS, 5e3, 12e4),
    // Accept both canonical name and legacy name for backward compatibility.
    // saveConfig writes the canonical name (PI_RESEARCH_CACHE_TTL_DAYS) but
    // older sessions may have written PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS.
    KNOWLEDGE_STORE_CACHE_TTL_DAYS: e["PI_RESEARCH_CACHE_TTL_DAYS"] !== void 0 ? parseEnvNumber(e, "PI_RESEARCH_CACHE_TTL_DAYS", DEFAULTS.KNOWLEDGE_STORE_CACHE_TTL_DAYS, 1, 365) : parseEnvNumber(e, "PI_RESEARCH_KNOWLEDGE_STORE_CACHE_TTL_DAYS", DEFAULTS.KNOWLEDGE_STORE_CACHE_TTL_DAYS, 1, 365),
    EMBEDDING_MODEL_INIT_TIMEOUT_MS: parseEnvNumber(e, "PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS", DEFAULTS.EMBEDDING_MODEL_INIT_TIMEOUT_MS, 1e4, 6e5),
    MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING: parseEnvNumber(e, "PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING", DEFAULTS.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING, 0.05, 1),
    AVG_TOKENS_PER_SCRAPE: parseEnvNumber(e, "PI_RESEARCH_AVG_TOKENS_PER_SCRAPE", DEFAULTS.AVG_TOKENS_PER_SCRAPE, 500, 1e4),
    MAX_CONCURRENT_SCRAPES: parseEnvNumber(e, "PI_RESEARCH_MAX_CONCURRENT_SCRAPES", DEFAULTS.MAX_CONCURRENT_SCRAPES, 1, 20),
    HEALTH_CHECK_TIMEOUT_MS: parseEnvNumber(e, "PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS", DEFAULTS.HEALTH_CHECK_TIMEOUT_MS, 2e3, 12e4),
    SEARCH_TIMEOUT_MS: parseEnvNumber(e, "PI_RESEARCH_SEARCH_TIMEOUT_MS", DEFAULTS.SEARCH_TIMEOUT_MS, 5e3, 12e4),
    TUI_REFRESH_DEBOUNCE_MS: parseEnvNumber(e, "PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS", DEFAULTS.TUI_REFRESH_DEBOUNCE_MS, 0, 1e3),
    BROWSER_TASK_TIMEOUT_MS: parseEnvNumber(e, "PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS", DEFAULTS.BROWSER_TASK_TIMEOUT_MS, 2e3, 12e4),
    LLM_TIMEOUT_MS: parseEnvNumber(e, "PI_RESEARCH_LLM_TIMEOUT_MS", DEFAULTS.LLM_TIMEOUT_MS, 6e4, 6e5),
    MIGRATION_STRATEGY: parseEnvString(e, "PI_RESEARCH_MIGRATION_STRATEGY", DEFAULTS.MIGRATION_STRATEGY),
    CONSOLE_LOG: parseEnvBool(e, "PI_RESEARCH_CONSOLE_LOG", DEFAULTS.CONSOLE_LOG),
    RESEARCH_MODEL: parseEnvString(e, "PI_RESEARCH_MODEL", DEFAULTS.RESEARCH_MODEL),
    KNOWLEDGE_STORE_DIR: parseEnvString(e, "PI_RESEARCH_KNOWLEDGE_DIR", DEFAULTS.KNOWLEDGE_STORE_DIR),
    RESEARCH_REPORT_EXPORT_ENABLED: parseEnvBool(e, "PI_RESEARCH_REPORT_EXPORT_ENABLED", DEFAULTS.RESEARCH_REPORT_EXPORT_ENABLED),
    DEBUG: parseEnvBool(e, "PI_RESEARCH_DEBUG", DEFAULTS.DEBUG)
  };
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (value !== void 0) {
      config[key] = value;
    }
  }
  if (processEnv["PI_RESEARCH_DEBUG"] === void 0) {
    processEnv["PI_RESEARCH_DEBUG"] = String(config.DEBUG);
  }
  return config;
}
function getConfig(cwd = process.cwd()) {
  const cacheKey = normalizeWorkspacePath(cwd);
  const cached = configCache.get(cacheKey);
  if (cached) return cached;
  const e = loadEnvFiles(cwd);
  const config = createConfig(e, process.env);
  configCache.set(cacheKey, config);
  return config;
}
function validateConfig(config) {
  const errors = [...Value.Errors(ConfigSchema, config)];
  if (errors.length > 0) {
    throw new Error(`Invalid configuration: ${errors.map((e) => `${e.path || ""} ${e.message}`).join(", ")}`);
  }
}
function parseEnvNumber(env, key, def, min, max) {
  const v = env[key];
  if (v === void 0 || v === "") return def;
  const n = parseFloat(v);
  if (isNaN(n)) {
    logger.warn(`[config] Environment variable ${key}="${v}" is not a valid number, using default: ${def}`);
    return def;
  }
  if (min !== void 0 && n < min) {
    logger.warn(`[config] ${key}=${n} is below minimum ${min}, clamping`);
    return min;
  }
  if (max !== void 0 && n > max) {
    logger.warn(`[config] ${key}=${n} is above maximum ${max}, clamping`);
    return max;
  }
  return n;
}
function parseEnvBool(env, key, def) {
  const v = env[key];
  if (v === void 0 || v === "") return def;
  return v.toLowerCase() === "true";
}
function parseEnvString(env, key, def) {
  return env[key] || def;
}

// src/core/llm/llm-timeout.ts
function createTimeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`LLM call timed out after ${ms}ms (${label})`));
    }, ms);
  });
}
function getLlmTimeoutMs(config) {
  try {
    const cfg = config ?? getConfig();
    return cfg.LLM_TIMEOUT_MS;
  } catch {
    return 3e5;
  }
}

// src/core/llm/llm-utils.ts
function buildSafeOptions(model, options, defaultCap = 4096) {
  return {
    ...options,
    // Ensure maxTokens is never null/None to avoid provider-side crashes
    maxTokens: options.maxTokens ?? Math.min(defaultCap, model.maxTokens || defaultCap),
    // Default to 'minimal' reasoning for better planning/logic if supported,
    // but allow the caller to explicitly override it.
    reasoning: options.reasoning ?? "minimal"
  };
}
function validateAndExtractText(response, label) {
  if (response.stopReason === "error" || response.errorMessage) {
    const errorMsg = response.errorMessage || "Unknown provider error";
    logger.error(`[${label}] LLM call failed: ${errorMsg}`);
    if (errorMsg.toLowerCase().includes("limit exhausted") || errorMsg.includes("1310")) {
      throw new Error(`${label} failed: API Rate Limit Exhausted. Please check your provider account or try a different model.`);
    }
    const cleanMsg = typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg);
    throw new Error(`${label} failed: ${cleanMsg}`);
  }
  const text = extractText(response);
  if (!text || !text.trim()) {
    throw new Error(`${label} returned no text content from LLM. Raw response: ${JSON.stringify(response, null, 2)}`);
  }
  return text;
}

// src/core/llm/agentic-repair.ts
import { Value as Value2 } from "typebox/value";
async function repairJsonWithLlm(text, completer, auth, options) {
  const { model, context, schema, serviceName = "RepairService", signal } = options;
  logger.warn(`[${serviceName}] JSON parse failed; attempting agentic salvage`);
  let repairPrompt = `I attempted to parse a JSON response but it contains formation errors, syntax issues, or is incomplete (truncated).
Your task is to repair the JSON so it is perfectly valid while preserving all the intended data.

`;
  if (context) {
    repairPrompt += `CONTEXT (what was requested):
${context}

`;
  }
  repairPrompt += `MALFORMED RESPONSE:
---
${text}
---

`;
  if (schema) {
    repairPrompt += `The result MUST strictly follow this JSON Schema:
${JSON.stringify(schema, null, 2)}

`;
    repairPrompt += `Ensure all required fields are present. If data for a field is missing, use a sensible default (empty string, empty array, or null).

`;
  }
  repairPrompt += `TASK: Fix any JSON formation errors (missing braces, trailing commas, malformed quotes, truncation, etc.) in the response above.
If the response was truncated, do your best to salvage as much data as possible into a valid structure.
Return ONLY the valid JSON object. No prose before or after.`;
  const maxAttempts = 2;
  const systemPrompt = "You are an expert JSON repair assistant. Your goal is to fix malformed JSON responses and ensure the output is valid JSON according to the provided schema (if any).";
  const llmTimeout = getLlmTimeoutMs();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        logger.debug(`[${serviceName}] Salvage attempt ${attempt}/${maxAttempts}...`);
      }
      const response = await Promise.race([
        completer(model, {
          systemPrompt,
          messages: [
            { role: "user", content: [{ type: "text", text: repairPrompt }], timestamp: Date.now() }
          ]
        }, buildSafeOptions(model, {
          ...auth,
          signal
        }, 4096)),
        createTimeout(llmTimeout, `agentic-repair-${serviceName}`)
      ]);
      let responseText;
      try {
        responseText = validateAndExtractText(response, `JSON Repair (${serviceName})`);
      } catch (error) {
        logger.warn(`[${serviceName}] Salvage attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const extracted = extractJson(responseText, "any");
      if (!extracted.success || !extracted.value) {
        logger.warn(`[${serviceName}] Salvage attempt ${attempt} failed: output still invalid JSON: ${extracted.error}`);
        continue;
      }
      const salvaged = extracted.value;
      if (schema) {
        const coerced = Value2.Convert(schema, salvaged);
        if (!Value2.Check(schema, coerced)) {
          const errors = [...Value2.Errors(schema, coerced)];
          const errorDetail = errors.map((e) => `${e.path}: ${e.message}`).join(", ");
          logger.warn(`[${serviceName}] Salvage attempt ${attempt} succeeded but validation failed: ${errorDetail}. Salvaged: ${JSON.stringify(salvaged)}, Coerced: ${JSON.stringify(coerced)}`);
          if (attempt < maxAttempts) {
            repairPrompt += `

Your previous attempt failed validation with these errors: ${errorDetail}. Please fix them.`;
            continue;
          }
          logger.error(`[${serviceName}] Salvage failed: final attempt still invalid according to schema`);
          return null;
        }
        return coerced;
      }
      return salvaged;
    } catch (err) {
      logger.error(`[${serviceName}] Salvage attempt ${attempt} unexpected error:`, err);
      if (attempt >= maxAttempts) break;
    }
  }
  return null;
}

// src/constants.ts
var REQUEST_DELAY_MS_NVD = 6e3;
var REQUEST_DELAY_MS_OTHER = 1e3;
var MAX_GATHERING_CALLS = 12;
function getMaxScrapeBatches(config) {
  try {
    const batches = (config || getConfig()).MAX_SCRAPE_BATCHES;
    return batches === 0 || batches > 99 ? 999999 : batches;
  } catch {
    return 2;
  }
}
var MAX_SCRAPE_URLS = 6;
var MAX_TEAM_SIZE_LEVEL_1 = 2;
var MAX_TEAM_SIZE_LEVEL_2 = 3;
var MAX_TEAM_SIZE_LEVEL_3 = 5;
var MAX_ROUNDS_LEVEL_1 = 2;
var MAX_ROUNDS_LEVEL_2 = 3;
var MAX_ROUNDS_LEVEL_3 = 3;
var MAX_EXTRA_ROUNDS_WITH_STEERING = 2;
var OSV_TIMEOUT_MS = 1e4;
var MAX_FILENAME_QUERY_LENGTH = 150;
var MAX_EXPORT_RETRIES = 3;
var DEFAULT_MAX_RETRIES = 3;
var DEFAULT_INITIAL_DELAY_MS = 1e3;
var DEFAULT_MAX_DELAY_MS = 1e4;
var DEFAULT_MODEL_CONTEXT_WINDOW = 2e5;
var BATCH_2_DEFAULT_CONCURRENCY = 15;
var RESEARCHER_LAUNCH_DELAY_MS = 1500;
var MAX_QUERIES_PER_RESEARCHER_LEVEL_1 = 10;
var MAX_QUERIES_PER_RESEARCHER_LEVEL_2 = 15;
var MAX_QUERIES_PER_RESEARCHER_LEVEL_3 = 20;

// src/core/interfaces/research-plan-types.ts
import { Type as Type2 } from "typebox";
var ResearcherConfigSchema = Type2.Object({
  id: Type2.Union([Type2.String(), Type2.Number()]),
  name: Type2.String(),
  goal: Type2.String(),
  queries: Type2.Array(Type2.String())
});
var ResearchPlanSchema = Type2.Object({
  action: Type2.Optional(Type2.Union([
    Type2.Literal("synthesize"),
    Type2.Literal("delegate"),
    Type2.Literal("wait")
  ])),
  researchers: Type2.Array(ResearcherConfigSchema),
  allQueries: Type2.Optional(Type2.Array(Type2.String())),
  content: Type2.Optional(Type2.String()),
  title: Type2.Optional(Type2.String())
});

// src/core/planning-constants.ts
var PlanningResponseSchemaAsTSchema = ResearchPlanSchema;
var EvaluationResponseSchemaAsTSchema = ResearchPlanSchema;

// src/core/planning-utils.ts
import { Value as Value3 } from "typebox/value";
function getTeamSize(complexity) {
  return complexity === 1 ? MAX_TEAM_SIZE_LEVEL_1 : complexity === 2 ? MAX_TEAM_SIZE_LEVEL_2 : MAX_TEAM_SIZE_LEVEL_3;
}
function getQueryBudget(complexity) {
  return complexity === 1 ? MAX_QUERIES_PER_RESEARCHER_LEVEL_1 : complexity === 2 ? MAX_QUERIES_PER_RESEARCHER_LEVEL_2 : MAX_QUERIES_PER_RESEARCHER_LEVEL_3;
}
function getMaxRounds(complexity) {
  return complexity === 1 ? MAX_ROUNDS_LEVEL_1 : complexity === 2 ? MAX_ROUNDS_LEVEL_2 : MAX_ROUNDS_LEVEL_3;
}
function getComplexityGuidance(complexity, maxTeamSize, queryBudget) {
  if (complexity === 1) {
    return "**Complexity: Level 1 (Normal)**. Conduct a thorough, well-rounded investigation of the topic covering the primary angles with adequate citations. **Plan ONLY Round 1** \u2014 a single comprehensive round. **Default to a single researcher** for most Level 1 topics \u2014 one focused researcher can handle the majority of normal-complexity queries efficiently. Use 2 researchers only when the topic clearly spans two distinct, non-overlapping domains that benefit from parallel investigation. This is a ONE-SHOT effort: plan Round 1 as if it is the only round, because it should be. Only Level 2 or Level 3 research should involve multiple rounds.";
  } else if (complexity === 2) {
    return `**Complexity: Level 2 (Deep)**. **ONLY for HIGH/EXTREME research needs.** Level 2 should be reserved for topics that clearly require deeper investigation than a single comprehensive round can provide. **Plan ONLY Round 1** \u2014 a thorough, well-structured first round. Subsequent rounds are reactive and only delegated when Round 1 findings reveal clear gaps that warrant deeper or broader coverage. Do not pre-plan multiple rounds; delegate follow-ups only when Round 1 demonstrates genuine need.

Scale your team (1-${maxTeamSize}) based on topic scope \u2014 not every round needs the full team. A single well-targeted researcher for follow-up gaps is usually sufficient.`;
  } else {
    return `**Complexity: Level 3 (Ultra)**. Perform an exhaustive, deep-dive research effort, leaving no stone unturned. **Plan ONLY Round 1** \u2014 make it comprehensive, deploying up to ${maxTeamSize} researchers with full query budgets (${queryBudget} each) covering all major dimensions of the topic. Round 1 should aim to cover the full scope comprehensively.

Rounds 2-3 are purely reactive \u2014 they only happen when Round 1 findings reveal gaps that warrant deeper diving into specific dimensions or broader exploration of adjacent topics. Do NOT pre-plan multiple rounds; let the findings drive the need. Think of Round 1 as the comprehensive landscape map, with follow-up rounds as targeted expeditions into areas that need more detail.

**ULTRA-SPECIFICITY MANDATE**: Level 3 demands granular, exhaustive detail on every fact that benefits from it \u2014 exact figures, dates, names, mechanisms, edge cases, historical context, technical specifics, and primary-source precision. Plan dedicated researchers for drilling into the ultra-specific dimensions of any finding where greater detail adds value.`;
  }
}
function getEvaluatorComplexityGuidance(complexity) {
  if (complexity === 1) {
    return `**Level 1 (Normal)** - Thorough, well-rounded investigation with solid multi-source coverage.

- **SYNTHESIZE when**: The primary topic is covered from multiple angles with evidence from diverse sources and no significant gaps remain that would prevent a complete answer.
- **DELEGATE when**: Coverage is incomplete, important angles are missing, or additional sources would meaningfully strengthen the findings.

**DEFAULT PATH**: Synthesize after Round 1 if the researcher produced solid coverage of the core topic. **Level 1 should almost always be a single round** \u2014 only delegate a second round when Round 1 clearly missed important angles or lacks source diversity. A single researcher is the default for Level 1 follow-up rounds \u2014 only use 2 researchers if the remaining gaps clearly span two distinct domains. Level 2 research escalation should be reserved for truly high/extreme research needs only.`;
  } else if (complexity === 2) {
    return `**Level 2 (Deep)** - Thorough, multi-phase investigation with comprehensive citations.

- **SYNTHESIZE when**: You are confident the research is genuinely complete. This means multiple angles covered with substantial findings across all major topics, diverse sources cited throughout, and no significant gaps in coverage.
- **DELEGATE when**: ANY gaps remain in major topics, insufficient source diversity, missing details, or areas that need deeper exploration. Don't synthesize prematurely.

**DEFAULT PATH: When in doubt, DELEGATE**. It is better to conduct additional research rounds than to synthesize with incomplete findings. Level 2 is designed for multi-round research. Each round adds depth and citation diversity \u2014 but do not delegate unnecessarily. Synthesize after Round 1 ONLY if the researcher produced comprehensive coverage of the topic with good source diversity. If Round 1 has any gaps, delegate Round 2. A third round is only warranted when Round 2 still leaves significant holes. Scale researcher count to match the gaps \u2014 focused gaps may only need 1 researcher, while broad gaps benefit from the full team.`;
  } else {
    return `**Level 3 (Ultra)** - Exhaustive, comprehensive deep-dive with extensive citations.

- **SYNTHESIZE when**: You are confident the research is genuinely and exhaustively complete. This means exhaustively covered across ALL substantial avenues with multiple diverse sources per major topic, comprehensive citations throughout, and no meaningful gaps remain.
- **DELEGATE when**: ANY meaningful gaps, nuanced angles, insufficient source diversity, inadequate citations, or areas needing deeper investigation remain.

**DEFAULT PATH: When in doubt, DELEGATE**. It is better to conduct additional research rounds than to synthesize with incomplete findings. Level 3 has ${MAX_ROUNDS_LEVEL_3} rounds available. Be generous with follow-up delegation \u2014 lean toward using all available rounds. Each round adds breadth, depth, and citation diversity. Delegate for follow-up whenever remaining gaps or under-explored angles exist, even if progress has been good. Only synthesize when you have genuinely comprehensive coverage across all major areas with no meaningful gaps that another round would address.

**ULTRA-SPECIFICITY MANDATE**: For every fact, finding, or topic area where greater granularity adds value, delegate additional researchers to pursue it. This includes: exact figures and statistics, precise dates and timelines, technical mechanisms, named individuals and their specific contributions, primary-source verbatim data, edge cases, and any dimension where surface-level coverage would leave the reader with unanswered questions.`;
  }
}
function getRoundPhaseGuidance(currentRound, maxRounds, complexity, maxTeamSize) {
  const roundRatio = currentRound / maxRounds;
  if (roundRatio <= 0.5) {
    if (complexity === 3) {
      return `

---

**Round Phase: EARLY (Round ${currentRound} of ${maxRounds}) \u2014 Level 3 Ultra**

**DELEGATE. Do not synthesize.** You are in the early phase of an exhaustive research effort with ${maxRounds} rounds available.
- Deploy up to ${maxTeamSize} researchers across completely distinct angles \u2014 leave no major dimension unmapped
- Not every round needs all ${maxTeamSize} researchers \u2014 use as many as the remaining gaps require
- Fully saturate each researcher's query budget; partial budgets waste available depth
- This phase exists to establish the broadest possible foundation of sources and findings
- Do NOT synthesize under any circumstances this early`;
    }
    return `

---

**Round Phase: EARLY (Round ${currentRound} of ${maxRounds})**

You are in the early phase of research. Be more permissive with delegation:
- Deploy researchers to broadly map the landscape
- Not every round needs all ${maxTeamSize} researchers \u2014 use as many as the remaining gaps require
- Don't worry if findings are incomplete \u2014 later rounds can fill gaps
- Focus on breadth and initial exploration
- Use available researchers to cover distinct angles in parallel`;
  } else if (roundRatio <= 0.8) {
    if (complexity === 3) {
      return `

---

**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds}) \u2014 Level 3 Ultra**

**PREFER DELEGATION.** You are in the middle phase of exhaustive research \u2014 use your remaining rounds.
- Not every round needs all ${maxTeamSize} researchers \u2014 use as many as the remaining gaps require
- With ${maxRounds - currentRound} round(s) remaining, delegate to cover angles not yet fully explored, drill into deeper sub-topics, or verify findings with additional sources
- Be generous with follow-up \u2014 delegate whenever gaps or under-explored angles exist
- Synthesize ONLY when you genuinely cannot identify gaps that another round would address
- If you can name even one meaningful unexplored angle \u2014 DELEGATE`;
    }
    if (complexity === 2) {
      return `

---

**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds})**

**Level 2 (Deep) Guidance**: You are in the middle phase of deep research. Continue delegating when there are still meaningful gaps or areas to explore.

- Not every round needs all ${maxTeamSize} researchers \u2014 use as many as the remaining gaps require
- Synthesize only when findings are comprehensive and no significant gaps remain that warrant another round
- Default to delegating when in doubt

`;
    }
    return `

---

**Round Phase: MIDDLE (Round ${currentRound} of ${maxRounds})**

You are in the middle phase of research. Apply balanced judgment:
- Not every round needs all ${maxTeamSize} researchers \u2014 use as many as the remaining gaps require
- Synthesize if you have substantial coverage of the key aspects
- Delegate for significant gaps or to explore specialized sub-topics
- Consider depth over breadth at this stage
- Focus on rounding out incomplete areas`;
  } else {
    if (complexity === 3) {
      return `

---

**Round Phase: LATE (Round ${currentRound} of ${maxRounds}) \u2014 Level 3 Ultra**

You are in the late phase of exhaustive research. Still prefer delegation \u2014 use your remaining rounds.
- Not every round needs all ${maxTeamSize} researchers \u2014 use as many as the remaining gaps require
- Delegate if ANY meaningful dimension remains under-sourced, under-verified, or shallowly covered
- Use remaining rounds to drill into specialist detail, verify findings, or explore nuanced angles surfaced by earlier rounds
- Synthesize only when you have genuinely exhausted meaningful research avenues AND have comprehensive multi-source coverage across all major areas`;
    }
    return `

---

**Round Phase: LATE (Round ${currentRound} of ${maxRounds})**

You are in the late phase of research. Set a higher threshold for delegation:
- Not every round needs all ${maxTeamSize} researchers \u2014 use as many as the remaining gaps require
- Synthesize if the core question is answerable with current findings
- Delegate only for CRITICAL gaps that cannot be resolved from existing findings
- Avoid delegating for minor details or marginal improvements
- Focus on delivering a complete, coherent response`;
  }
}
function parseJsonPlan(text) {
  const result = extractJson(text, "object");
  if (!result.success || !result.value) {
    const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;
    throw new Error(`Failed to extract valid JSON plan: ${result.error}. Raw response preview: "${preview}"`);
  }
  try {
    const coerced = Value3.Convert(ResearchPlanSchema, result.value);
    if (!Value3.Check(ResearchPlanSchema, coerced)) {
      const errors = [...Value3.Errors(ResearchPlanSchema, coerced)];
      const errorMsg = errors.map((e) => `${e.path}: ${e.message}`).join(", ");
      throw new Error(`Plan validation failed: ${errorMsg}`);
    }
    const plan = coerced;
    if (plan.researchers) {
      plan.researchers.forEach((r) => {
        r.id = String(r.id);
      });
    }
    return plan;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Plan validation error: ${msg}`, { cause: err });
  }
}
function buildFallbackCoordinatorPlan(serviceName, _rawText, query) {
  const words = query.split(/\s+/).slice(0, 6).join(" ");
  const queries = [query, `${words} overview`, `${words} latest`].filter(Boolean).slice(0, 3);
  logger.warn(`[${serviceName}] Coordinator fallback: single researcher for "${query.slice(0, 80)}"`);
  return {
    action: "delegate",
    researchers: [{ id: "1", name: "General Researcher", goal: `Research the following query comprehensively: ${query}`, queries }],
    allQueries: queries
  };
}
function capResearcherQueries(plan, complexity, serviceName) {
  const budget = getQueryBudget(complexity);
  const ROUND_HARD_CAP = complexity === 1 ? 20 : complexity === 2 ? 45 : 100;
  if (!plan.researchers) return plan;
  const maxTeam = getTeamSize(complexity);
  plan.researchers = plan.researchers.filter((r) => r && typeof r === "object" && Array.isArray(r.queries) && r.queries.length > 0).slice(0, maxTeam).map((r) => {
    const normalized = { ...r, id: String(r.id) };
    if (normalized.queries.length > budget) {
      logger.warn(`[${serviceName}] Capping researcher ${normalized.id} queries: ${normalized.queries.length} \u2192 ${budget}`);
      normalized.queries = normalized.queries.slice(0, budget);
    }
    return normalized;
  });
  let totalQueries = plan.researchers.reduce((sum, r) => sum + r.queries.length, 0);
  if (totalQueries > ROUND_HARD_CAP) {
    logger.warn(`[${serviceName}] Total round queries (${totalQueries}) exceeds hard cap (${ROUND_HARD_CAP}). Trimming...`);
    while (totalQueries > ROUND_HARD_CAP) {
      let maxCount = 0;
      let maxIdx = -1;
      if (!plan.researchers) break;
      for (let i = 0; i < plan.researchers.length; i++) {
        if (plan.researchers[i].queries.length > maxCount) {
          maxCount = plan.researchers[i].queries.length;
          maxIdx = i;
        }
      }
      if (maxIdx === -1) break;
      plan.researchers[maxIdx].queries.pop();
      totalQueries--;
    }
  }
  plan.allQueries = plan.researchers.flatMap((r) => r.queries);
  if (plan.action === "delegate" && plan.researchers.length === 0) {
    logger.warn(`[${serviceName}] No valid researchers after query cap/filtering, forcing synthesize`);
    return { ...plan, action: "synthesize", researchers: [], allQueries: [] };
  }
  return plan;
}
function generateResearchers(plan, _query, _complexity) {
  if (!plan.researchers) {
    return [];
  }
  const researchers = plan.researchers.map((r) => ({
    ...r,
    id: String(r.id)
  }));
  return researchers;
}

// src/core/planning-service.ts
var PlanningService = class {
  name = ServiceNames.PLANNING;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  // State per research session
  currentPlans = /* @__PURE__ */ new Map();
  totalResearchersPlanned = /* @__PURE__ */ new Map();
  queryHistory = /* @__PURE__ */ new Map();
  async initialize() {
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    this.currentPlans.clear();
    this.totalResearchersPlanned.clear();
    this.queryHistory.clear();
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  /**
   * Check if the service is ready
   */
  isReady() {
    return this.lifecycle === "initialized" /* INITIALIZED */;
  }
  /**
   * Clear planning state for a specific research ID
   */
  clearPlanningState(researchId) {
    if (researchId) {
      this.currentPlans.delete(researchId);
      this.totalResearchersPlanned.delete(researchId);
      this.queryHistory.delete(researchId);
    } else {
      this.currentPlans.clear();
      this.totalResearchersPlanned.clear();
      this.queryHistory.clear();
    }
  }
  /**
   * Get the current plan for a session
   */
  getCurrentPlan(researchId) {
    return this.currentPlans.get(researchId) || null;
  }
  /**
   * Get total number of researchers planned across all rounds
   */
  getTotalResearchersPlanned(researchId) {
    return this.totalResearchersPlanned.get(researchId) || 0;
  }
  /**
   * Increment total number of researchers planned
   */
  incrementTotalResearchersPlanned(researchId, count) {
    const current = this.getTotalResearchersPlanned(researchId);
    this.totalResearchersPlanned.set(researchId, current + count);
  }
  /**
   * Get query history for a session
   */
  getQueryHistory(researchId) {
    const history = this.queryHistory.get(researchId);
    return history ? Array.from(history) : [];
  }
  /**
   * Record search queries to history to prevent duplication in later rounds
   */
  addToQueryHistory(researchId, queries) {
    if (!this.queryHistory.has(researchId)) {
      this.queryHistory.set(researchId, /* @__PURE__ */ new Set());
    }
    const history = this.queryHistory.get(researchId);
    for (const q of queries) {
      if (q && q.trim()) {
        history.add(q.toLowerCase().trim());
      }
    }
  }
  /**
   * Interface pass-throughs for planning utilities
   */
  getTeamSize(complexity) {
    return getTeamSize(complexity);
  }
  getQueryBudget(complexity) {
    return getQueryBudget(complexity);
  }
  getComplexityGuidance(complexity, maxTeamSize, queryBudget) {
    return getComplexityGuidance(complexity, maxTeamSize, queryBudget);
  }
  getEvaluatorComplexityGuidance(complexity) {
    return getEvaluatorComplexityGuidance(complexity);
  }
  getRoundPhaseGuidance(currentRound, maxRounds, complexity, maxTeamSize) {
    return getRoundPhaseGuidance(currentRound, maxRounds, complexity, maxTeamSize);
  }
  parseJsonPlan(text) {
    return parseJsonPlan(text);
  }
  buildFallbackCoordinatorPlan(rawText, query) {
    return buildFallbackCoordinatorPlan("PlanningService", rawText, query);
  }
  capResearcherQueries(plan, complexity, serviceName) {
    return capResearcherQueries(plan, complexity, serviceName);
  }
  generateResearchers(plan, query, complexity) {
    return generateResearchers(plan, query, complexity);
  }
  /**
   * Helper to populate prompt templates with placeholders.
   */
  populatePrompt(template, replacements) {
    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
      const placeholder = `{{${key}}}`;
      result = result.split(placeholder).join(String(value));
    }
    return result;
  }
  /**
   * Generate initial research plan
   */
  async generatePlan(options) {
    const { sessionId, query, complexity, model, signal, observer, steeringMessages, modelRegistry } = options;
    logger.log(`[PlanningService] Generating initial plan for: "${query}" (Complexity: ${complexity})`);
    const config = getConfig(options.cwd);
    const promptTemplate = loadPrompt("system-coordinator");
    const maxTeamSize = this.getTeamSize(complexity);
    const queryBudget = this.getQueryBudget(complexity);
    const complexityGuidance = this.getComplexityGuidance(complexity, maxTeamSize, queryBudget);
    let steeringSection = "";
    if (steeringMessages && steeringMessages.length > 0) {
      steeringSection = "\n\n### ADDITIONAL USER GUIDANCE (Apply these rules and instructions to your plan and decisions)\n" + steeringMessages.map((m) => `- ${m}`).join("\n");
    }
    const disabledToolsSection = options.excludeTools && options.excludeTools.length > 0 ? `
## DISABLED TOOLS
The following tools are DISABLED for this session: ${options.excludeTools.join(", ")}. Do NOT reference or attempt to use them.
` : "";
    const systemPrompt = injectCurrentDate(promptTemplate, "coordinator");
    const populatedPrompt = this.populatePrompt(systemPrompt, {
      root_query: query,
      additional_considerations: steeringSection,
      complexity_label: complexity === 1 ? "Level 1 (Normal)" : complexity === 2 ? "Level 2 (Deep)" : "Level 3 (Ultra)",
      max_team_size: maxTeamSize,
      query_budget: queryBudget,
      complexity_guidance: complexityGuidance,
      disabled_tools_section: disabledToolsSection
    });
    const userMessage = `Generate the initial research plan for: "${query}"`;
    try {
      const authResult = await modelRegistry.getApiKeyAndHeaders(model);
      if (!authResult.ok) {
        throw new Error(`Failed to get API key for planning: ${authResult.error}`);
      }
      const llmTimeout = config.LLM_TIMEOUT_MS;
      const response = await Promise.race([
        completeSimple(model, {
          systemPrompt: populatedPrompt,
          messages: [
            { role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }
          ]
        }, buildSafeOptions(model, {
          apiKey: authResult.apiKey || "",
          headers: authResult.headers,
          signal
        }, 4096)),
        createTimeout(llmTimeout, "coordinator-generatePlan")
      ]);
      const rawUsage = response.usage;
      if (rawUsage) {
        const { tokens, cost } = extractUsage(model, rawUsage);
        if (tokens > 0 || cost > 0) {
          metrics.increment("llm_tokens_total", tokens, { component: "coordinator", complexity: String(complexity) });
          metrics.increment("llm_cost_total", cost, { component: "coordinator", complexity: String(complexity) });
          observer?.onTokensConsumed?.(tokens, cost);
        }
      }
      const responseText = validateAndExtractText(response, "Coordinator");
      let plan = null;
      try {
        plan = this.parseJsonPlan(responseText);
      } catch {
        logger.warn("[PlanningService] Initial plan JSON malformed, attempting agentic repair");
        const repaired = await repairJsonWithLlm(
          responseText,
          completeSimple,
          { apiKey: authResult.apiKey || "", headers: authResult.headers },
          {
            model,
            schema: PlanningResponseSchemaAsTSchema,
            context: `Research planning for: ${query}`,
            serviceName: "PlanningService",
            signal
          }
        );
        if (repaired) {
          try {
            plan = this.parseJsonPlan(JSON.stringify(repaired));
          } catch {
            plan = null;
          }
        }
      }
      if (!plan) {
        logger.warn("[PlanningService] Failed to generate valid plan, building fallback");
        plan = this.buildFallbackCoordinatorPlan(responseText, query);
      }
      plan = this.capResearcherQueries(plan, complexity, this.name);
      if (plan.action !== "synthesize") {
        plan.action = "delegate";
      }
      this.currentPlans.set(sessionId, plan);
      return plan;
    } catch (err) {
      logger.error("[PlanningService] Failed to generate plan:", err);
      throw err;
    }
  }
  /**
   * Update plan / evaluate progress after a round
   */
  async updatePlanForRound(options) {
    const { sessionId, query, complexity, round, model, reports, mustSynthesize, signal, observer, steeringMessages, modelRegistry } = options;
    logger.log(`[PlanningService] Evaluating Round ${round} findings for: "${query}"`);
    const config = getConfig(options.cwd);
    const promptTemplate = loadPrompt("system-lead-evaluator");
    const maxTeamSize = this.getTeamSize(complexity);
    const queryBudget = this.getQueryBudget(complexity);
    const maxRounds = getMaxRounds(complexity);
    const complexityGuidance = this.getEvaluatorComplexityGuidance(complexity);
    const roundPhaseGuidance = this.getRoundPhaseGuidance(round, maxRounds, complexity, maxTeamSize);
    let steeringSection = "";
    if (steeringMessages && steeringMessages.length > 0) {
      steeringSection = "\n\n### ADDITIONAL USER GUIDANCE (Ensure findings follow these rules)\n" + steeringMessages.map((m) => `- ${m}`).join("\n");
    }
    const disabledToolsSection = options.excludeTools && options.excludeTools.length > 0 ? `
## DISABLED TOOLS
The following tools are DISABLED for this session: ${options.excludeTools.join(", ")}. Do NOT reference or attempt to use them.
` : "";
    const previousPlan = options.previousPlan;
    const initialAgendaSection = previousPlan && previousPlan.researchers && previousPlan.researchers.length > 0 ? `
## Initial Research Agenda
${previousPlan.researchers.map((r) => `- ${r.name}: ${r.goal}`).join("\n")}
` : "";
    const previousQueries = this.getQueryHistory(sessionId);
    const previousQueriesSection = previousQueries.length > 0 ? `
## Previously Executed Queries
${previousQueries.map((q) => `- ${q}`).join("\n")}
` : "";
    const systemPrompt = injectCurrentDate(promptTemplate, "evaluator");
    const populatedPrompt = this.populatePrompt(systemPrompt, {
      root_query: query,
      round_number: round,
      max_rounds: maxRounds,
      complexity_label: complexity === 1 ? "Level 1 (Normal)" : complexity === 2 ? "Level 2 (Deep)" : "Level 3 (Ultra)",
      initial_agenda_section: initialAgendaSection,
      previous_queries_section: previousQueriesSection,
      additional_considerations: steeringSection,
      disabled_tools_section: disabledToolsSection,
      complexity_guidance: complexityGuidance,
      round_phase_guidance: roundPhaseGuidance,
      max_team_size: maxTeamSize,
      query_budget: queryBudget
    });
    const findings = Array.from(reports.entries()).map(([id, report]) => `### Researcher ${id}
${report}`).join("\n\n");
    const userMessage = mustSynthesize ? `Research budget exhausted. Synthesize final report now based on findings:

${findings}` : `Evaluate the following findings and decide next steps (delegate more researchers or synthesize final report):

${findings}`;
    try {
      const authResult = await modelRegistry.getApiKeyAndHeaders(model);
      if (!authResult.ok) {
        throw new Error(`Failed to get API key for evaluation: ${authResult.error}`);
      }
      const llmTimeout = config.LLM_TIMEOUT_MS;
      const response = await Promise.race([
        completeSimple(model, {
          systemPrompt: populatedPrompt,
          messages: [
            { role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }
          ]
        }, buildSafeOptions(model, {
          apiKey: authResult.apiKey || "",
          headers: authResult.headers,
          signal
        }, 4096)),
        createTimeout(llmTimeout, "evaluator-updatePlanForRound")
      ]);
      const rawUsage = response.usage;
      if (rawUsage) {
        const { tokens, cost } = extractUsage(model, rawUsage);
        if (tokens > 0 || cost > 0) {
          metrics.increment("llm_tokens_total", tokens, { component: "evaluator", complexity: String(complexity) });
          metrics.increment("llm_cost_total", cost, { component: "evaluator", complexity: String(complexity) });
          observer?.onTokensConsumed?.(tokens, cost);
        }
      }
      const responseText = validateAndExtractText(response, "Evaluator");
      let plan = null;
      try {
        plan = this.parseJsonPlan(responseText);
      } catch {
        logger.warn("[PlanningService] Evaluation JSON malformed, attempting agentic repair");
        const repaired = await repairJsonWithLlm(
          responseText,
          completeSimple,
          { apiKey: authResult.apiKey || "", headers: authResult.headers },
          {
            model,
            schema: EvaluationResponseSchemaAsTSchema,
            context: `Research evaluation for: ${query} (Round ${round})`,
            serviceName: "PlanningService",
            signal
          }
        );
        if (repaired) {
          try {
            plan = this.parseJsonPlan(JSON.stringify(repaired));
          } catch {
            plan = null;
          }
        }
      }
      if (!plan) {
        logger.warn("[PlanningService] Failed to generate valid evaluation, falling back to synthesize");
        const safeContent = responseText.length > 50 ? responseText : "";
        plan = { action: "synthesize", content: safeContent, researchers: [] };
      }
      const finalPlan = plan;
      if (mustSynthesize) {
        finalPlan.action = "synthesize";
      }
      if (finalPlan.action === "delegate") {
        const capped = this.capResearcherQueries(finalPlan, complexity, this.name);
        this.currentPlans.set(sessionId, capped);
        return capped;
      }
      this.currentPlans.set(sessionId, finalPlan);
      return finalPlan;
    } catch (err) {
      logger.error("[PlanningService] Failed to update plan:", err);
      throw err;
    }
  }
  /**
   * Generate queries for a researcher
   */
  async generateQueries(options) {
    return options.researcher.queries || [];
  }
};

// src/core/service-initialization.ts
function registerCoreServices(container = getServiceContainer()) {
  logger.debug("[ServiceInitialization] Registering core services...");
  registerService(
    ServiceNames.SCHEDULER,
    () => new SchedulerService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.HEALTH_CHECK_CACHE,
    () => new HealthCheckService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.PLANNING,
    () => new PlanningService(),
    {
      lazyInitialization: false,
      // Planning service needs to be available early
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  logger.debug("[ServiceInitialization] All core services registered");
}
async function initializeCoreServices(ctx, container = getServiceContainer()) {
  logger.log("[ServiceInitialization] Initializing core services...");
  const initialized = [];
  const failed = [];
  const criticalInfrastructure = [
    { name: ServiceNames.METRICS, label: "Metrics Service" },
    { name: ServiceNames.PROCESS_LIFECYCLE, label: "Process Lifecycle Service" },
    { name: ServiceNames.STATE_PATH_CONFIGURATION, label: "State Path Configuration" },
    { name: ServiceNames.FILE_LOCK_SERVICE, label: "File Lock Service" },
    { name: ServiceNames.STATE_BACKUP_MANAGER, label: "State Backup Manager" },
    { name: ServiceNames.STATE_SESSION_MANAGER, label: "State Session Manager" },
    { name: ServiceNames.STATE_BROWSER_MANAGER, label: "State Browser Manager" },
    { name: ServiceNames.STATE_METRICS_COLLECTOR, label: "State Metrics Collector" },
    { name: ServiceNames.STATE_VALIDATOR, label: "State Validator" },
    { name: ServiceNames.GPU_RESOURCE_SERVICE, label: "GPU Resource Service" },
    { name: ServiceNames.STATE_MANAGER, label: "State Manager Service" },
    { name: ServiceNames.HEALTH_CHECK_CACHE, label: "Health Check Cache Service" },
    { name: ServiceNames.HEALTH_REGISTRY, label: "Health Registry Service" }
  ];
  const eagerServices = [
    { name: ServiceNames.PLANNING, label: "Planning Service" }
  ];
  const lazyServices = [
    ServiceNames.SCHEDULER,
    ServiceNames.KNOWLEDGE_STORE,
    ServiceNames.RESEARCH_ORCHESTRATION,
    ServiceNames.WORKER_POOL_MANAGER
  ];
  try {
    logger.log("[ServiceInitialization] Initializing critical infrastructure services...");
    for (const service of criticalInfrastructure) {
      try {
        logger.debug(`[ServiceInitialization] Initializing ${service.label}...`);
        await getService(service.name, ctx, container);
        initialized.push(service.label);
        logger.debug(`[ServiceInitialization] ${service.label} initialized`);
      } catch (err) {
        const errorMsg = `${service.label} initialization failed`;
        logger.error(`[ServiceInitialization] FAILED: ${errorMsg}:`, err);
        failed.push(errorMsg);
      }
    }
    logger.log("[ServiceInitialization] Initializing eagerly-marked services...");
    for (const service of eagerServices) {
      try {
        logger.debug(`[ServiceInitialization] Initializing ${service.label}...`);
        await getService(service.name, ctx, container);
        initialized.push(service.label);
        logger.debug(`[ServiceInitialization] ${service.label} initialized`);
      } catch (err) {
        const errorMsg = `${service.label} initialization failed`;
        logger.error(`[ServiceInitialization] FAILED: ${errorMsg}:`, err);
        failed.push(errorMsg);
      }
    }
    if (lazyServices.length > 0) {
      logger.log(`[ServiceInitialization] ${lazyServices.length} services configured for lazy initialization: ${lazyServices.join(", ")}`);
    }
    if (failed.length === 0) {
      logger.log(`[ServiceInitialization] All ${initialized.length} critical services initialized successfully`);
    } else {
      logger.warn(`[ServiceInitialization] \u26A0 ${initialized.length}/${initialized.length + failed.length} services initialized, ${failed.length} failed`);
      for (const failure of failed) {
        logger.warn(`[ServiceInitialization]   - ${failure}`);
      }
    }
    return { success: failed.length === 0, initialized, failed };
  } catch (err) {
    logger.error("[ServiceInitialization] Failed to initialize core services:", err);
    throw err;
  }
}
async function disposeCoreServices(container = getServiceContainer()) {
  logger.log("[ServiceInitialization] Disposing core services...");
  try {
    try {
      const stateManager = await getService(ServiceNames.STATE_MANAGER, void 0, container);
      await stateManager.clearEmbeddingServer();
      logger.debug("[ServiceInitialization] Cleared embedding server state before disposal");
    } catch {
    }
    await disposeAllServices(container);
    logger.log("[ServiceInitialization] Core services disposed successfully");
  } catch (err) {
    logger.error("[ServiceInitialization] Failed to dispose core services:", err);
    throw err;
  }
}

// src/infrastructure/browser/scheduler-factory.ts
import * as crypto4 from "node:crypto";
import * as net from "node:net";
import * as path8 from "node:path";

// src/infrastructure/file-lock-service.ts
import * as fs6 from "node:fs/promises";
import * as crypto from "node:crypto";
import * as pathmod from "node:path";
import { AsyncLocalStorage as AsyncLocalStorage6 } from "node:async_hooks";
var lockContext = new AsyncLocalStorage6();
var FileLockService = class {
  name = ServiceNames.FILE_LOCK_SERVICE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  _initialized = false;
  lockFilePath;
  lockTimeout;
  lockRetries;
  lockRetryDelay;
  lockStaleThreshold;
  // Lock tracking
  lockHandle = null;
  lockUuid = crypto.randomUUID();
  queue = Promise.resolve();
  resolveTurn = null;
  lockCount = 0;
  constructor(options) {
    this.lockFilePath = options.lockFilePath;
    this.lockTimeout = options.lockTimeout ?? 2e4;
    this.lockRetries = options.lockRetries ?? 200;
    this.lockRetryDelay = options.lockRetryDelay ?? 100;
    this.lockStaleThreshold = options.lockStaleThreshold ?? 15e3;
  }
  async initialize() {
    if (this._initialized) {
      return;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    try {
      const lockDir = pathmod.dirname(this.lockFilePath);
      await fs6.mkdir(lockDir, { recursive: true, mode: 448 });
    } catch (err) {
      logger.warn(`[FileLockService] Failed to create lock directory: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.cleanupStaleLocksOnStartup();
    this._initialized = true;
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    this.lifecycle = "disposing" /* DISPOSING */;
    await this.cleanup();
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  /**
   * Clean up any stale lock files on initialization.
   * This handles cases where locks weren't released due to crashes.
   */
  async cleanupStaleLocksOnStartup() {
    try {
      const rawContent = await fs6.readFile(this.lockFilePath, "utf-8").catch(() => null);
      if (rawContent === null) return;
      const stats = await fs6.stat(this.lockFilePath);
      const lockAge = Date.now() - stats.mtimeMs;
      const parsed = this._parseLockContent(rawContent);
      const ownerAlive = this._isOwnerAlive(parsed?.pid ?? null);
      if (!ownerAlive || lockAge > this.lockStaleThreshold) {
        logger.log(
          `[FileLockService] Cleaning up stale lock file (${Math.round(lockAge / 1e3)}s old, owner alive: ${ownerAlive})`
        );
        await fs6.unlink(this.lockFilePath);
        logger.log("[FileLockService] Stale lock removed");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const errnoError = error;
        if (errnoError.code !== "ENOENT") {
          logger.warn(`[FileLockService] Could not check lock file: ${errnoError.message}`);
        }
      }
    }
  }
  /**
   * Acquire a filesystem lock for exclusive access.
   * Supports re-entrancy (recursive locking) within the same async execution context.
   * @throws Error if unable to acquire lock within timeout
   */
  async acquireLock() {
    const heldLocks = lockContext.getStore();
    const lockKey = `${this.lockFilePath}:${this.lockUuid}`;
    if (heldLocks?.has(lockKey)) {
      if (this.lockHandle !== null) {
        this.lockCount++;
        return;
      }
    }
    let myResolve;
    const myTurn = new Promise((resolve5) => {
      myResolve = resolve5;
    });
    const previous = this.queue;
    this.queue = myTurn;
    try {
      await previous;
    } catch (_err) {
    }
    if (heldLocks?.has(lockKey) && this.lockHandle !== null) {
      this.lockCount++;
      if (myResolve) myResolve();
      return;
    }
    this.resolveTurn = myResolve;
    const startTime = Date.now();
    let contentionCount = 0;
    try {
      for (let _attempt = 0; _attempt < this.lockRetries; _attempt++) {
        let handle = null;
        try {
          handle = await fs6.open(this.lockFilePath, "wx", 384);
          await handle.write(this._makeLockContent());
          await handle.sync();
          this.lockHandle = handle;
          this.lockCount = 1;
          if (heldLocks) {
            heldLocks.add(lockKey);
          }
          const duration = Date.now() - startTime;
          metrics.observe("state_lock_acquire_duration_ms", duration);
          metrics.increment("state_lock_acquire_total", 1, { status: "success" });
          metrics.setGauge("state_lock_held", 1);
          if (contentionCount > 0) {
            metrics.increment("state_lock_contention_total", 1);
            metrics.observe("state_lock_contention_retries", contentionCount);
          }
          return;
        } catch (error) {
          if (handle) {
            try {
              await handle.close();
            } catch {
            }
            try {
              await fs6.unlink(this.lockFilePath);
            } catch {
            }
          }
          if (error instanceof Error && "code" in error) {
            const errnoError = error;
            if (errnoError.code === "EEXIST") {
              contentionCount++;
              try {
                const rawContent = await fs6.readFile(this.lockFilePath, "utf-8");
                const parsed = this._parseLockContent(rawContent);
                const lockUuid = parsed?.uuid ?? "";
                const stats = await fs6.stat(this.lockFilePath);
                const lockAge = Date.now() - stats.mtimeMs;
                if (lockUuid === this.lockUuid) {
                  try {
                    await fs6.unlink(this.lockFilePath);
                  } catch {
                  }
                  continue;
                }
                const ownerAlive = this._isOwnerAlive(parsed?.pid ?? null);
                if (!ownerAlive || lockAge > this.lockStaleThreshold) {
                  if (ownerAlive && lockAge <= this.lockStaleThreshold) {
                  } else {
                    const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString("hex")}`;
                    try {
                      await fs6.rename(this.lockFilePath, trashPath);
                      const trashContent = await fs6.readFile(trashPath, "utf-8");
                      const trashParsed = this._parseLockContent(trashContent);
                      if ((trashParsed?.uuid ?? "") !== lockUuid) {
                        try {
                          await fs6.link(trashPath, this.lockFilePath);
                        } catch {
                        }
                        await fs6.unlink(trashPath);
                        continue;
                      }
                      await fs6.unlink(trashPath);
                    } catch {
                    }
                    continue;
                  }
                }
              } catch (_statError) {
                const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString("hex")}`;
                try {
                  await fs6.rename(this.lockFilePath, trashPath);
                  await fs6.unlink(trashPath);
                  continue;
                } catch {
                }
              }
              if (Date.now() - startTime >= this.lockTimeout) {
                const duration = Date.now() - startTime;
                metrics.observe("state_lock_acquire_duration_ms", duration, { status: "timeout" });
                metrics.increment("state_lock_acquire_total", 1, { status: "timeout" });
                throw new Error(
                  `Failed to acquire lock at ${this.lockFilePath}: timeout after ${this.lockTimeout}ms`,
                  { cause: error }
                );
              }
              await this.sleep(this.lockRetryDelay);
              continue;
            }
          }
          throw error;
        }
      }
      metrics.increment("state_lock_acquire_total", 1, { status: "failed" });
      throw new Error(`Failed to acquire lock after ${this.lockRetries} retries`);
    } catch (err) {
      if (this.resolveTurn) {
        this.resolveTurn();
        this.resolveTurn = null;
      }
      throw err;
    }
  }
  /**
   * Release the filesystem lock.
   */
  async releaseLock() {
    if (this.lockHandle === null) {
      return;
    }
    this.lockCount--;
    if (this.lockCount > 0) {
      return;
    }
    try {
      const content = await fs6.readFile(this.lockFilePath, "utf8").catch(() => "");
      const parsed = this._parseLockContent(content);
      if (parsed?.uuid === this.lockUuid) {
        await fs6.unlink(this.lockFilePath).catch(() => {
        });
      }
      await this.lockHandle.close().catch(() => {
      });
      this.lockHandle = null;
      this.lockCount = 0;
      const heldLocks = lockContext.getStore();
      if (heldLocks) {
        heldLocks.delete(`${this.lockFilePath}:${this.lockUuid}`);
      }
      metrics.setGauge("state_lock_held", 0);
    } finally {
      const resolve5 = this.resolveTurn;
      this.resolveTurn = null;
      if (resolve5) {
        resolve5();
      }
    }
  }
  /**
   * Execute a function within the scope of a filesystem lock.
   * This is the preferred way to use the lock service.
   * Safe re-entrancy is supported within the same async flow.
   */
  async withLock(callback, _timeout = 3e4) {
    const heldLocks = lockContext.getStore();
    const lockKey = `${this.lockFilePath}:${this.lockUuid}`;
    if (heldLocks?.has(lockKey)) {
      return await callback();
    }
    return await lockContext.run(heldLocks || /* @__PURE__ */ new Set(), async () => {
      await this.acquireLock();
      try {
        return await callback();
      } finally {
        await this.releaseLock();
      }
    });
  }
  /**
   * Force clean up any lock files owned by this instance.
   */
  async cleanup() {
    if (this.lockHandle) {
      try {
        const content = await fs6.readFile(this.lockFilePath, "utf8").catch(() => "");
        const parsed = this._parseLockContent(content);
        if (parsed?.uuid === this.lockUuid) {
          await fs6.unlink(this.lockFilePath).catch(() => {
          });
        }
      } catch {
      }
      try {
        await this.lockHandle.close();
      } catch {
      }
      this.lockHandle = null;
    }
    this.lockCount = 0;
  }
  /**
   * Check if the current instance holds the lock
   */
  isLocked() {
    return this.lockHandle !== null;
  }
  /**
   * Get the UUID for this service instance
   */
  getLockUuid() {
    return this.lockUuid;
  }
  /**
   * Encode the lock file content with owner identity for liveness checks.
   */
  _makeLockContent() {
    return JSON.stringify({ uuid: this.lockUuid, pid: process.pid });
  }
  /**
   * Parse lock file content — handles both legacy bare-UUID and new JSON format.
   * Returns null if content is empty or unparseable.
   */
  _parseLockContent(content) {
    const trimmed = content.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.uuid === "string") {
        return { uuid: parsed.uuid, pid: typeof parsed.pid === "number" ? parsed.pid : null };
      }
    } catch {
      return { uuid: trimmed, pid: null };
    }
    return null;
  }
  /**
   * Check whether the process that wrote the lock file is still alive.
   * Returns true (assume alive) if we cannot determine liveness.
   */
  _isOwnerAlive(pid) {
    if (pid === null) return true;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Sleep for a specified number of milliseconds
   */
  sleep(ms) {
    return new Promise((resolve5) => setTimeout(resolve5, ms));
  }
};

// src/infrastructure/browser/config.ts
import * as crypto2 from "node:crypto";
import { join as join6 } from "node:path";
import { existsSync as existsSync5, mkdirSync as mkdirSync3 } from "node:fs";
import { platform, homedir as homedir3 } from "node:os";
function getBrowserCacheDir() {
  if (process.env["PLAYWRIGHT_BROWSERS_PATH"]) {
    return process.env["PLAYWRIGHT_BROWSERS_PATH"];
  }
  const osPlatform = platform();
  if (osPlatform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] || join6(homedir3(), "AppData", "Local");
    return join6(localAppData, "camoufox", "Cache");
  } else if (osPlatform === "darwin") {
    return join6(homedir3(), "Library", "Caches", "camoufox");
  } else {
    const cacheHome = process.env["XDG_CACHE_HOME"] || join6(homedir3(), ".cache");
    return join6(cacheHome, "camoufox");
  }
}
function getBrowserEnv(config) {
  const env = { ...process.env };
  const customPath = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (customPath) {
    env["PLAYWRIGHT_BROWSERS_PATH"] = customPath;
  } else {
    delete env["PLAYWRIGHT_BROWSERS_PATH"];
  }
  const logFilePath = getLogger().getLogFilePath();
  if (logFilePath) {
    env["PI_RESEARCH_LOG_FILE"] = logFilePath;
  }
  const c = config || getConfig();
  env["PI_RESEARCH_SCRAPE_TIMEOUT_MS"] = String(c.SCRAPE_TIMEOUT_MS);
  env["PI_RESEARCH_SEARCH_TIMEOUT_MS"] = String(c.SEARCH_TIMEOUT_MS);
  env["PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS"] = String(c.HEALTH_CHECK_TIMEOUT_MS);
  return env;
}
function ensureBrowserCacheDir() {
  const cacheDir = getBrowserCacheDir();
  if (!existsSync5(cacheDir)) {
    try {
      mkdirSync3(cacheDir, { recursive: true });
    } catch (_e) {
    }
  }
  return cacheDir;
}
function getCamoufoxBinaryPath() {
  const customPath = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (customPath) {
    return customPath;
  }
  const osPlatform = platform();
  if (osPlatform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] || join6(homedir3(), "AppData", "Local");
    return join6(localAppData, "camoufox", "Cache");
  } else if (osPlatform === "darwin") {
    return join6(homedir3(), "Library", "Caches", "camoufox");
  } else {
    const cacheHome = process.env["XDG_CACHE_HOME"] || join6(homedir3(), ".cache");
    return join6(cacheHome, "camoufox");
  }
}
function generateSchedulerVersion(config) {
  const c = config || getConfig();
  const versionString = `v2:${c.WORKER_THREADS}:${c.WORKER_CONCURRENCY}:${c.MAX_CONCURRENT_RESEARCHERS}`;
  return crypto2.createHash("sha256").update(versionString).digest("hex").substring(0, 16);
}
function getMaxWorkers(config) {
  return (config || getConfig()).WORKER_THREADS;
}
function getSchedulerVersion(config) {
  return generateSchedulerVersion(config);
}
function isBrowserAvailable() {
  if (isFullMockMode()) return false;
  try {
    import.meta.resolve("camoufox-js");
    return existsSync5(getCamoufoxBinaryPath());
  } catch {
    return false;
  }
}
function isFullMockMode() {
  return process.env["PI_RESEARCH_MOCK_SEARCH"] === "true" && process.env["PI_RESEARCH_MOCK_SCRAPE"] === "true";
}

// src/infrastructure/browser/browser-client.ts
import * as http2 from "node:http";

// src/infrastructure/browser/client-agent.ts
import * as http from "node:http";
var clientAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  // Allow up to 100 concurrent requests to the leader
  maxFreeSockets: 10,
  // Set timeout to 180s (3x the client timeout) to handle slow browser responses
  // and prevent "socket hang up" errors during peak load
  timeout: 18e4
});
function getClientAgent() {
  return clientAgent;
}

// src/infrastructure/browser/browser-client.ts
var BrowserClient = class {
  constructor(port, authSecret) {
    this.port = port;
    this.authSecret = authSecret ?? process.env["PI_BROWSER_AUTH_SECRET"] ?? "";
    logger.log(`[BrowserClient] Connecting to global scheduler at http://127.0.0.1:${port}`);
  }
  port;
  authSecret;
  async request(path16, data, signal) {
    const start = Date.now();
    const operation = path16.includes("/search") ? "search" : path16.includes("/scrape") ? "browser-task" : path16.includes("/healthcheck") ? "healthcheck" : "network";
    return new Promise((resolve5, reject) => {
      const agent = getClientAgent();
      const timeoutMs = 6e4;
      let resolved = false;
      const controller = new AbortController();
      let abortCleanup;
      if (signal) {
        if (signal.aborted) {
          return reject(new Error("Aborted"));
        }
        const onAbort = () => {
          if (resolved) return;
          resolved = true;
          controller.abort();
          reject(new Error("Aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          controller.abort();
          const error = new Error(`[BrowserClient] Request to ${path16} timed out after ${timeoutMs}ms (Shared queue may be deep)`);
          errorTracker.trackError(error, {
            component: "browser-manager",
            operation,
            errorType: "timeout"
          });
          reject(error);
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const req = http2.request({
        hostname: "127.0.0.1",
        port: this.port,
        path: path16,
        method: "POST",
        agent,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          // FIX (#21): Send auth token to authenticate with browser server
          "X-Browser-Auth": this.authSecret
        }
      }, (res) => {
        clearTimeout(timer);
        abortCleanup?.();
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => {
          if (resolved) return;
          resolved = true;
          const duration = Date.now() - start;
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode !== 200) {
              const error = new Error(parsed.error || `HTTP ${res.statusCode}`);
              errorTracker.trackError(error, {
                component: "browser-manager",
                operation,
                errorType: "http_error"
              });
              reject(error);
            } else {
              logger.debug(`[BrowserClient] Request ${path16} completed in ${duration}ms`);
              resolve5(parsed);
            }
          } catch (_e) {
            const preview = body.length > 200 ? body.slice(0, 200) + "..." : body;
            const error = new Error(`Failed to parse response (status ${res.statusCode}): ${preview}`);
            errorTracker.trackError(error, {
              component: "browser-manager",
              operation,
              errorType: "parse_error"
            });
            reject(error);
          }
        });
        res.on("error", (err) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          abortCleanup?.();
          const error = new Error(`[BrowserClient] Response stream error on ${path16}: ${err.message}`);
          errorTracker.trackError(error, {
            component: "browser-manager",
            operation,
            errorType: "response_stream_error"
          });
          reject(error);
        });
      });
      req.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        abortCleanup?.();
        if (err.name === "AbortError") return;
        const nodeErr = err;
        let errorMsg;
        let errorType;
        if (nodeErr.code === "ECONNRESET" || nodeErr.code === "EPIPE") {
          errorMsg = `Browser pool socket ${path16} closed (pool likely busy or restarting) - ${err.message}`;
          errorType = "connection_reset";
        } else if (nodeErr.code === "ECONNREFUSED") {
          errorMsg = `Browser pool ${path16} unreachable (server may have crashed) - ${err.message}`;
          errorType = "connection_refused";
        } else if (nodeErr.code === "ETIMEDOUT") {
          errorMsg = `Browser pool ${path16} timed out (slow browser response) - ${err.message}`;
          errorType = "timeout";
        } else {
          errorMsg = `Browser pool ${path16} error: ${err.message}`;
          errorType = "unknown";
        }
        const error = new Error(errorMsg);
        logger.error(`[BrowserClient] Request to http://127.0.0.1:${this.port}${path16} failed:`, errorMsg);
        errorTracker.trackError(error, {
          component: "browser-manager",
          operation,
          errorType
        });
        reject(error);
      });
      req.write(JSON.stringify(data));
      req.end();
    });
  }
  async runSearch(query, _config, signal) {
    return this.request("/search", { query }, signal);
  }
  async runScrape(url, _config, signal) {
    return this.request("/scrape", { url }, signal);
  }
  async runHealthCheck(_config, signal) {
    return this.request("/healthcheck", {}, signal);
  }
  async shutdown() {
  }
};

// src/infrastructure/browser/browser-server.ts
import * as http3 from "node:http";
import * as crypto3 from "node:crypto";
var _authSecret = null;
function getOrCreateAuthSecret() {
  if (!_authSecret) {
    _authSecret = crypto3.randomBytes(32).toString("hex");
  }
  return _authSecret;
}
function getBrowserServerAuthSecret() {
  return getOrCreateAuthSecret();
}
var BrowserServer = class {
  constructor(options) {
    this.options = options;
  }
  options;
  server = null;
  port = 0;
  async start() {
    return new Promise((resolve5, reject) => {
      this.server = http3.createServer(async (req, res) => {
        const rawAuth = req.headers["x-browser-auth"];
        const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
        const expected = Buffer.from(getOrCreateAuthSecret(), "utf8");
        const actual = Buffer.from(authHeader ?? "", "utf8");
        if (actual.length !== expected.length || !crypto3.timingSafeEqual(actual, expected)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end("Method Not Allowed");
          return;
        }
        let body = "";
        const MAX_BODY_SIZE = 10 * 1024 * 1024;
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > MAX_BODY_SIZE) {
            req.destroy(new Error("Payload too large"));
          }
        });
        req.on("error", (err) => {
          logger.error("[BrowserServer] Request stream error:", err);
        });
        req.on("end", async () => {
          try {
            const data = JSON.parse(body);
            let result;
            switch (req.url) {
              case "/search":
                result = await this.options.onSearch(data.query);
                break;
              case "/scrape":
                result = await this.options.onScrape(data.url);
                break;
              case "/healthcheck":
                result = await this.options.onHealthCheck();
                break;
              default:
                res.writeHead(404);
                res.end("Not Found");
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (error) {
            logger.error("[BrowserServer] Error handling request:", error);
            let errorMessage = "Unknown error";
            if (error instanceof Error && error.message) {
              errorMessage = (error.message.split("\n")[0] || "").trim();
            } else if (typeof error === "string") {
              errorMessage = (error.split("\n")[0] || "").trim();
            }
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: errorMessage }));
          }
        });
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          logger.log(`[BrowserServer] Listening on http://127.0.0.1:${this.port}`);
          resolve5(this.port);
        } else {
          reject(new Error("Failed to get server port"));
        }
      });
      this.server.on("error", (err) => {
        logger.error("[BrowserServer] Server error:", err);
        reject(err);
      });
    });
  }
  async stop() {
    if (this.server) {
      this.server.closeAllConnections?.();
      return new Promise((resolve5) => {
        this.server?.close(() => {
          this.server = null;
          resolve5();
        });
      });
    }
  }
  getPort() {
    return this.port;
  }
};

// src/infrastructure/browser/browser-cleanup.ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs7 from "node:fs/promises";
import * as path7 from "node:path";
import * as os4 from "node:os";
var execAsync = promisify(exec);
async function cleanupOrphanedCamoufoxProcesses() {
  const platform4 = os4.platform();
  try {
    if (platform4 === "darwin" || platform4 === "linux") {
      await cleanupOrphanedProcessesUnix();
    } else if (platform4 === "win32") {
      await cleanupOrphanedProcessesWindows();
    } else {
      logger.warn(`[BrowserCleanup] Platform ${platform4} not supported for orphan cleanup`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[BrowserCleanup] Failed to cleanup orphaned processes: ${msg}`);
  }
}
async function cleanupOrphanedProcessesUnix() {
  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,comm | grep -E "(firefox|camoufox)" | grep -v grep'
    );
    const lines = stdout.trim().split("\n");
    const cleanupTasks = [];
    for (const line of lines) {
      const match = line.trim().match(/^\s*(\d+)\s+(\d+)/);
      if (!match || !match[1] || !match[2]) continue;
      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const comm = line.trim().split(/\s+/)[2] || "unknown";
      let isOrphan = false;
      if (ppid === 1) {
        isOrphan = true;
      } else {
        try {
          process.kill(ppid, 0);
          isOrphan = false;
        } catch {
          isOrphan = true;
        }
      }
      if (isOrphan) {
        cleanupTasks.push((async () => {
          logger.log(`[BrowserCleanup] Found orphaned ${comm} process: PID ${pid}, parent PID ${ppid}`);
          try {
            process.kill(pid, "SIGTERM");
            await new Promise((resolve5) => setTimeout(resolve5, 500));
            try {
              process.kill(pid, 0);
              process.kill(pid, "SIGKILL");
              logger.warn(`[BrowserCleanup] Force killed orphaned process: PID ${pid}`);
            } catch {
              logger.log(`[BrowserCleanup] Terminated orphaned process: PID ${pid}`);
            }
          } catch (killError) {
            const msg = killError instanceof Error ? killError.message : String(killError);
            logger.warn(`[BrowserCleanup] Failed to kill orphaned process PID ${pid}: ${msg}`);
          }
        })());
      }
    }
    if (cleanupTasks.length > 0) {
      await Promise.all(cleanupTasks);
      logger.log(`[BrowserCleanup] Cleaned up ${cleanupTasks.length} orphaned browser process(es)`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[BrowserCleanup] Failed to find orphaned processes: ${msg}`);
  }
}
async function cleanupOrphanedProcessesWindows() {
  try {
    const { stdout } = await execAsync(
      'tasklist /FI "IMAGENAME eq firefox.exe" /FO CSV /NH'
    );
    const lines = stdout.trim().split("\n");
    const cleanupTasks = [];
    for (const line of lines) {
      if (!line.includes("firefox.exe")) continue;
      const match = line.match(/"(\d+)"/);
      if (!match || !match[1]) continue;
      const pid = parseInt(match[1], 10);
      cleanupTasks.push((async () => {
        try {
          const { stdout: parentInfo } = await execAsync(
            `wmic process where ProcessId=${pid} get ParentProcessId /VALUE`
          );
          const parentMatch = parentInfo.match(/ParentProcessId=(\d+)/);
          if (!parentMatch || !parentMatch[1]) return;
          const ppid = parseInt(parentMatch[1], 10);
          try {
            await execAsync(`tasklist /FI "PID eq ${ppid}" /NH`);
            return;
          } catch {
            logger.log(`[BrowserCleanup] Found orphaned firefox.exe process: PID ${pid}, dead parent PID ${ppid}`);
          }
        } catch {
          logger.log(`[BrowserCleanup] Potentially orphaned firefox.exe process: PID ${pid}`);
        }
        try {
          await execAsync(`taskkill /PID ${pid} /F`);
          logger.log(`[BrowserCleanup] Terminated orphaned process: PID ${pid}`);
        } catch (killError) {
          const msg = killError instanceof Error ? killError.message : String(killError);
          logger.warn(`[BrowserCleanup] Failed to kill orphaned process PID ${pid}: ${msg}`);
        }
      })());
    }
    if (cleanupTasks.length > 0) {
      await Promise.all(cleanupTasks);
      logger.log(`[BrowserCleanup] Cleaned up ${cleanupTasks.length} orphaned browser process(es)`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[BrowserCleanup] Failed to find orphaned processes on Windows: ${msg}`);
  }
}
async function getBrowserPidsForWorkers(workerPids) {
  const platform4 = os4.platform();
  const pids = [];
  if (!workerPids || workerPids.length === 0) return pids;
  try {
    if (platform4 === "darwin" || platform4 === "linux") {
      const { stdout } = await execAsync('ps -eo pid,ppid,comm | grep -E "(firefox|camoufox)" | grep -v grep').catch(() => ({ stdout: "" }));
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        const match = line.trim().match(/^\s*(\d+)\s+(\d+)\s+/);
        if (match && match[1] && match[2]) {
          const pid = parseInt(match[1], 10);
          const ppid = parseInt(match[2], 10);
          if (workerPids.includes(ppid)) pids.push(pid);
        }
      }
    } else if (platform4 === "win32") {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq firefox.exe" /FO CSV /NH').catch(() => ({ stdout: "" }));
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        if (!line.includes("firefox.exe")) continue;
        const match = line.match(/"(\d+)"/);
        if (!match || !match[1]) continue;
        const pid = parseInt(match[1], 10);
        try {
          const { stdout: parentInfo } = await execAsync(`wmic process where ProcessId=${pid} get ParentProcessId /VALUE`);
          const parentMatch = parentInfo.match(/ParentProcessId=(\d+)/);
          if (parentMatch && parentMatch[1]) {
            const ppid = parseInt(parentMatch[1], 10);
            if (workerPids.includes(ppid)) pids.push(pid);
          }
        } catch {
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[BrowserCleanup] Failed to get browser PIDs for workers: ${msg}`);
  }
  return pids;
}
async function killBrowserProcesses(pids) {
  if (!pids || pids.length === 0) return;
  const platform4 = os4.platform();
  await Promise.all(pids.map(async (pid) => {
    try {
      if (platform4 === "win32") {
        await execAsync(`taskkill /PID ${pid} /F /T`);
        logger.debug(`[BrowserCleanup] Terminated worker browser process: PID ${pid}`);
      } else {
        process.kill(pid, "SIGTERM");
        await new Promise((resolve5) => setTimeout(resolve5, 200));
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
          logger.debug(`[BrowserCleanup] Force killed worker browser process: PID ${pid}`);
        } catch {
          logger.debug(`[BrowserCleanup] Terminated worker browser process: PID ${pid}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`[BrowserCleanup] Failed to kill browser process PID ${pid}: ${msg}`);
    }
  }));
}

// src/infrastructure/browser/priority-task-queue.ts
var PriorityTaskQueue = class {
  searchQueue = [];
  healthcheckQueue = [];
  scrapeQueue = [];
  activeCount = 0;
  maxTotalConcurrency;
  maxQueueDepth;
  constructor(maxTotalConcurrency, maxQueueDepth = 500) {
    this.maxTotalConcurrency = maxTotalConcurrency;
    this.maxQueueDepth = maxQueueDepth;
  }
  /**
   * Enqueue a task with priority.
   * Searches and healthchecks have high priority.
   */
  enqueue(type, fn, signal) {
    return new Promise((resolve5, reject) => {
      const task = { type, fn, resolve: resolve5, reject, signal };
      if (signal?.aborted) {
        return reject(new Error(`Task ${type} aborted before enqueuing`));
      }
      const totalDepth = this.healthcheckQueue.length + this.searchQueue.length + this.scrapeQueue.length;
      if (totalDepth >= this.maxQueueDepth) {
        return reject(new Error(`PriorityTaskQueue at capacity (${this.maxQueueDepth} tasks). Dropping ${type} task.`));
      }
      let onAbort;
      if (signal) {
        onAbort = () => {
          if (this.removeFromQueue(task)) {
            task.reject(new Error(`Task ${type} aborted while in queue`));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const wrappedResolve = (val) => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        resolve5(val);
      };
      const wrappedReject = (err) => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        reject(err);
      };
      task.resolve = wrappedResolve;
      task.reject = wrappedReject;
      if (type === "healthcheck") {
        this.healthcheckQueue.push(task);
      } else if (type === "search") {
        this.searchQueue.push(task);
      } else {
        this.scrapeQueue.push(task);
      }
      logger.debug(`[PriorityQueue] Task enqueued: ${type}. Active: ${this.activeCount}, Capacity: ${this.maxTotalConcurrency}. Queues: H:${this.healthcheckQueue.length} S:${this.searchQueue.length} SC:${this.scrapeQueue.length}`);
      this.process();
    });
  }
  removeFromQueue(task) {
    const queues = [this.healthcheckQueue, this.searchQueue, this.scrapeQueue];
    for (const q of queues) {
      const idx = q.indexOf(task);
      if (idx !== -1) {
        q.splice(idx, 1);
        return true;
      }
    }
    return false;
  }
  process() {
    while (this.activeCount < this.maxTotalConcurrency) {
      let task;
      if (this.healthcheckQueue.length > 0) {
        task = this.healthcheckQueue.shift();
      } else if (this.searchQueue.length > 0) {
        task = this.searchQueue.shift();
      } else if (this.scrapeQueue.length > 0) {
        task = this.scrapeQueue.shift();
      }
      if (!task) {
        break;
      }
      if (task.signal?.aborted) {
        task.reject(new Error(`Task ${task.type} aborted before starting`));
        continue;
      }
      this.runTask(task);
    }
  }
  async runTask(task) {
    if (task.signal?.aborted) {
      task.reject(new Error(`Task ${task.type} aborted before starting`));
      return;
    }
    this.activeCount++;
    logger.debug(`[PriorityQueue] Starting task: ${task.type}. Active: ${this.activeCount}/${this.maxTotalConcurrency}`);
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    } finally {
      this.activeCount--;
      logger.debug(`[PriorityQueue] Task finished: ${task.type}. Active: ${this.activeCount}/${this.maxTotalConcurrency}`);
      process.nextTick(() => this.process());
    }
  }
  /**
   * Update the maximum concurrency limit (e.g. if config changes).
   */
  updateConcurrency(maxTotalConcurrency) {
    this.maxTotalConcurrency = maxTotalConcurrency;
    logger.debug(`[PriorityQueue] Concurrency updated to ${maxTotalConcurrency}`);
    this.process();
  }
  /**
   * FIX (#18): Shut down the queue, rejecting all pending tasks.
   * In-progress tasks are allowed to complete. This prevents the queue from
   * holding unsettled promises that would hang the calling orchestrator.
   */
  shutdown() {
    const error = new Error("PriorityTaskQueue is shutting down");
    for (const task of this.healthcheckQueue) {
      task.reject(error);
    }
    for (const task of this.searchQueue) {
      task.reject(error);
    }
    for (const task of this.scrapeQueue) {
      task.reject(error);
    }
    this.healthcheckQueue.length = 0;
    this.searchQueue.length = 0;
    this.scrapeQueue.length = 0;
    logger.debug(`[PriorityQueue] Shutdown complete. Active tasks: ${this.activeCount}`);
  }
  /**
   * Get current status for metrics or logging.
   */
  getStats() {
    return {
      activeCount: this.activeCount,
      searchQueueDepth: this.searchQueue.length,
      scrapeQueueDepth: this.scrapeQueue.length,
      healthcheckQueueDepth: this.healthcheckQueue.length,
      capacity: this.maxTotalConcurrency
    };
  }
};

// src/infrastructure/browser/browser-task-scheduler.ts
var BrowserTaskScheduler = class {
  // 5 minutes (was 30min — wasted RAM)
  constructor(schedulerId, stateManager, container = getServiceContainer()) {
    this.schedulerId = schedulerId;
    this.stateManager = stateManager;
    this.container = container;
    this.startLeadershipCheck();
    this.resetIdleTimer();
  }
  schedulerId;
  stateManager;
  container;
  workerPoolManager = null;
  server = null;
  priorityQueue = null;
  leadershipTimer = null;
  idleTimer = null;
  consecutiveLeadershipMisses = 0;
  LEADERSHIP_CHECK_INTERVAL_MS = 5e3;
  LEADERSHIP_MISS_THRESHOLD = 3;
  isShuttingDown = false;
  IDLE_TIMEOUT_MS = 5 * 60 * 1e3;
  async getWorkerPoolManager() {
    if (!this.workerPoolManager) {
      this.workerPoolManager = await getService(ServiceNames.WORKER_POOL_MANAGER, void 0, this.container);
      await this.workerPoolManager.initialize();
    }
    return this.workerPoolManager;
  }
  /**
   * Get or create the priority task queue.
   * This is synchronous to prevent races where multiple concurrent requests
   * might create redundant queue instances before the reference is set.
   */
  getPriorityQueue(config) {
    const c = config || getConfig();
    const maxTotalConcurrency = c.WORKER_THREADS * c.WORKER_CONCURRENCY;
    if (!this.priorityQueue) {
      this.priorityQueue = new PriorityTaskQueue(maxTotalConcurrency);
    } else {
      this.priorityQueue.updateConcurrency(maxTotalConcurrency);
    }
    return this.priorityQueue;
  }
  startLeadershipCheck() {
    const check = async () => {
      if (this.isShuttingDown) return;
      try {
        const serverInfo = await this.stateManager.getBrowserServer();
        if (serverInfo?.schedulerId !== this.schedulerId) {
          this.consecutiveLeadershipMisses++;
          metrics.increment("browser_leadership_misses_total", 1);
          metrics.setGauge("browser_is_leader", 0);
          logger.warn(`[Scheduler] Leadership check failed (${this.consecutiveLeadershipMisses}/${this.LEADERSHIP_MISS_THRESHOLD}) - ID: ${this.schedulerId}, Current: ${serverInfo?.schedulerId}`);
          if (this.consecutiveLeadershipMisses >= this.LEADERSHIP_MISS_THRESHOLD) {
            metrics.increment("browser_leadership_lost_total", 1);
            logger.error(`[Scheduler] Leadership threshold exceeded (${this.consecutiveLeadershipMisses} misses), shutting down pool...`);
            await this.shutdown();
            return;
          }
        } else {
          if (this.consecutiveLeadershipMisses > 0) {
            logger.log(`[Scheduler] Leadership confirmed, resetting miss counter from ${this.consecutiveLeadershipMisses}`);
            this.consecutiveLeadershipMisses = 0;
          }
          metrics.setGauge("browser_is_leader", 1);
        }
        const poolManager = await this.getWorkerPoolManager();
        poolManager.resetConsecutiveErrors();
      } catch (err) {
        logger.warn("[Scheduler] Leadership check error:", err);
      } finally {
        if (!this.isShuttingDown) {
          this.leadershipTimer = setTimeout(check, this.LEADERSHIP_CHECK_INTERVAL_MS);
          if (this.leadershipTimer.unref) this.leadershipTimer.unref();
        }
      }
    };
    this.leadershipTimer = setTimeout(check, this.LEADERSHIP_CHECK_INTERVAL_MS);
    if (this.leadershipTimer.unref) this.leadershipTimer.unref();
  }
  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.log("[Scheduler] Browser pool idle timeout reached, shutting down...");
      this.shutdown();
    }, this.IDLE_TIMEOUT_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }
  resetIdleTimerOnActivity() {
    this.resetIdleTimer();
  }
  async startServer() {
    this.server = new BrowserServer({
      onSearch: (q) => this.runSearch(q),
      onScrape: (u) => this.runScrape(u),
      onHealthCheck: () => this.runHealthCheck()
    });
    process.env["PI_BROWSER_AUTH_SECRET"] = getBrowserServerAuthSecret();
    return this.server.start();
  }
  async runSearch(query, config, signal) {
    this.resetIdleTimer();
    const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
    const startTime = Date.now();
    const baseTimeoutMs = (config || getConfig()).BROWSER_TASK_TIMEOUT_MS;
    const timeoutMs = baseTimeoutMs + 1e4;
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Search task timed out after ${timeoutMs}ms (including queue wait). query="${query}"`));
      }, timeoutMs);
      if (timeoutId.unref) timeoutId.unref();
    });
    logger.debug(`[BrowserTaskScheduler] Executing search: "${query}" (Timeout: ${timeoutMs}ms)`);
    let result;
    try {
      const queue = this.getPriorityQueue(config);
      result = await Promise.race([
        queue.enqueue("search", async () => {
          return await Promise.race([
            pool.execute({ type: "search", query, queuedAt: startTime, taskTimeoutMs: timeoutMs }),
            timeoutPromise
          ]);
        }, signal),
        timeoutPromise
      ]);
      logger.debug(`[BrowserTaskScheduler] Search completed: "${query}" in ${Date.now() - startTime}ms`);
    } catch (error) {
      logger.error(`[BrowserTaskScheduler] Search failed: "${query}"`, error);
      metrics.increment("browser_search_errors_total", 1);
      errorTracker.trackError(error instanceof Error ? error : String(error), {
        component: "browser-manager",
        operation: "search",
        query,
        taskType: "search"
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    const duration = Date.now() - startTime;
    metrics.observe("browser_search_duration_ms", duration, { status: "success" });
    metrics.increment("browser_search_requests_total", 1, { status: "success" });
    if (result.error) {
      metrics.increment("browser_search_requests_total", 1, { status: "error" });
      errorTracker.trackError(new Error(result.error), {
        component: "browser-manager",
        operation: "search",
        query,
        taskType: "search",
        errorType: "search_error"
      });
      throw new Error(result.error);
    }
    return result.results;
  }
  async runScrape(url, config, signal) {
    this.resetIdleTimer();
    const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
    const startTime = Date.now();
    const baseTimeoutMs = (config || getConfig()).SCRAPE_TIMEOUT_MS;
    const isMocking = process.env["PI_RESEARCH_MOCK_SCRAPE"] === "true";
    const timeoutMs = baseTimeoutMs + (isMocking ? 5e3 : 1e4);
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Scrape task timed out after ${timeoutMs}ms (including queue wait). url="${url}"`));
      }, timeoutMs);
      if (timeoutId.unref) timeoutId.unref();
    });
    let result;
    try {
      const queue = this.getPriorityQueue(config);
      result = await Promise.race([
        queue.enqueue("scrape", async () => {
          return await Promise.race([
            pool.execute({ type: "scrape", url, queuedAt: startTime, taskTimeoutMs: timeoutMs }),
            timeoutPromise
          ]);
        }, signal),
        timeoutPromise
      ]);
    } catch (error) {
      metrics.increment("browser_scrape_errors_total", 1);
      errorTracker.trackError(error instanceof Error ? error : String(error), {
        component: "browser-manager",
        operation: "browser-task",
        taskType: "scrape"
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    const duration = Date.now() - startTime;
    metrics.observe("browser_scrape_duration_ms", duration, { status: "success" });
    metrics.increment("browser_scrape_requests_total", 1, { status: "success" });
    if (result.error) {
      metrics.increment("browser_scrape_requests_total", 1, { status: "error" });
      errorTracker.trackError(new Error(result.error), {
        component: "browser-manager",
        operation: "browser-task",
        taskType: "scrape",
        errorType: "scrape_error"
      });
      throw new Error(result.error);
    }
    return result;
  }
  async runHealthCheck(config, signal) {
    this.resetIdleTimer();
    const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
    const startTime = Date.now();
    const isMocking = process.env["PI_RESEARCH_MOCK_SEARCH"] === "true" || process.env["PI_RESEARCH_MOCK_SCRAPE"] === "true";
    const timeoutMs = (45e3 + 6e4) / (isMocking ? 4 : 1);
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms (including queue wait)`)), timeoutMs);
      if (timeoutId.unref) timeoutId.unref();
    });
    let result;
    try {
      const queue = this.getPriorityQueue(config);
      result = await Promise.race([
        queue.enqueue("healthcheck", async () => {
          const execPromise = pool.execute({ type: "healthcheck", queuedAt: startTime, taskTimeoutMs: timeoutMs });
          execPromise.catch((err) => logger.debug(`[BrowserTaskScheduler] Background healthcheck task rejection: ${err.message}`));
          return await Promise.race([
            execPromise,
            timeoutPromise
          ]);
        }, signal),
        timeoutPromise
      ]);
    } catch (error) {
      metrics.increment("browser_healthcheck_errors_total", 1);
      errorTracker.trackError(error instanceof Error ? error : String(error), {
        component: "browser-manager",
        operation: "healthcheck",
        taskType: "healthcheck"
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    const duration = Date.now() - startTime;
    metrics.observe("browser_healthcheck_duration_ms", duration, { status: "success" });
    metrics.increment("browser_healthcheck_requests_total", 1, { status: "success" });
    metrics.setGauge("browser_pool_health", 1);
    logger.debug(`[Scheduler] Healthcheck completed in ${duration}ms`);
    if (result.error) {
      metrics.increment("browser_healthcheck_requests_total", 1, { status: "error" });
      metrics.setGauge("browser_pool_health", 0);
      errorTracker.trackError(new Error(result.error), {
        component: "browser-manager",
        operation: "healthcheck",
        taskType: "healthcheck",
        errorType: "healthcheck_error"
      });
      throw new Error(result.error);
    }
    return result;
  }
  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.leadershipTimer) {
      clearTimeout(this.leadershipTimer);
      this.leadershipTimer = null;
    }
    const schedulerService = await getService(ServiceNames.SCHEDULER, void 0, this.container);
    const currentScheduler = schedulerService.getSchedulerInstance();
    if (currentScheduler && "schedulerId" in currentScheduler && currentScheduler.schedulerId === this.schedulerId) {
      schedulerService.setSchedulerInstance(null);
      schedulerService.setSchedulerVersion(null);
      schedulerService.setSchedulerInitializationPromise(null);
    }
    let serverInfo = null;
    try {
      serverInfo = await this.stateManager.getBrowserServer();
    } catch (err) {
      logger.warn("[Scheduler] Could not read browser server state during shutdown:", err);
    }
    if (serverInfo?.pid === process.pid && serverInfo?.schedulerId === this.schedulerId) {
      await this.stateManager.clearBrowserServer().catch((err) => {
        logger.warn("[Scheduler] Failed to clear browser server state during shutdown:", err);
      });
    }
    if (this.server) {
      try {
        await Promise.race([
          this.server.stop(),
          new Promise((resolve5) => setTimeout(resolve5, 2e3))
        ]);
      } catch (e) {
        logger.warn("[Scheduler] Server shutdown error:", e);
      }
      this.server = null;
    }
    let targetBrowserPids = [];
    if (this.workerPoolManager) {
      const pool = this.workerPoolManager.getPool();
      if (pool && pool.workerNodes) {
        const workerPids = pool.workerNodes.map((n) => n.worker?.process?.pid).filter(Boolean);
        if (workerPids.length > 0) {
          targetBrowserPids = await getBrowserPidsForWorkers(workerPids);
        }
      }
    }
    if (this.priorityQueue) {
      this.priorityQueue.shutdown();
      this.priorityQueue = null;
    }
    if (this.workerPoolManager) {
      await this.workerPoolManager.shutdown();
    }
    if (targetBrowserPids.length > 0) {
      await Promise.race([
        killBrowserProcesses(targetBrowserPids),
        new Promise((resolve5) => setTimeout(resolve5, 1e4))
      ]);
    }
    try {
      const orphanPromise = cleanupOrphanedCamoufoxProcesses();
      orphanPromise.catch((err) => logger.debug(`[BrowserTaskScheduler] Background orphan cleanup rejection: ${err.message}`));
      await Promise.race([
        orphanPromise,
        new Promise((resolve5) => setTimeout(resolve5, 15e3))
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("[Scheduler] Failed to cleanup orphaned browsers:", msg);
    }
  }
};

// src/infrastructure/browser/scheduler-factory.ts
var browserInitLocks = /* @__PURE__ */ new Map();
async function disposeBrowserInitLock(container = getServiceContainer()) {
  const lock = browserInitLocks.get(container);
  if (lock) {
    try {
      await lock.dispose();
    } catch (err) {
      logger.debug("[SchedulerFactory] Error disposing browserInitLock:", err);
    }
    browserInitLocks.delete(container);
  }
}
async function getBrowserInitLock(container) {
  let lock = browserInitLocks.get(container);
  if (lock) return lock;
  const pathConfig = await getService(ServiceNames.STATE_PATH_CONFIGURATION, void 0, container);
  const lockFilePath = path8.join(pathConfig.getLockDirPath(), "browser-init.lock");
  lock = new FileLockService({
    lockFilePath,
    lockTimeout: 6e4,
    // 60s timeout for browser startup
    lockRetries: 600,
    lockRetryDelay: 100,
    lockStaleThreshold: 6e4
    // 60s stale threshold (must be <= lockTimeout)
  });
  await lock.initialize();
  browserInitLocks.set(container, lock);
  return lock;
}
async function isPortListening(port, timeoutMs = 2e3) {
  return new Promise((resolve5) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve5(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, "127.0.0.1");
  });
}
async function forceSchedulerRestart(forceClearRemoteState = false, container = getServiceContainer()) {
  const schedulerService = tryGetService(ServiceNames.SCHEDULER, container);
  if (!schedulerService) {
    logger.warn("[Scheduler] Scheduler service not available for restart");
    return;
  }
  if (schedulerService.isSchedulerRestartInProgress()) {
    logger.log("[Scheduler] Restart already in progress, skipping concurrent call.");
    return;
  }
  schedulerService.setSchedulerRestartInProgress(true);
  try {
    logger.log("[Scheduler] Forcing scheduler restart due to config change...");
    const oldScheduler = schedulerService.getSchedulerInstance();
    schedulerService.setSchedulerInstance(null);
    schedulerService.setSchedulerVersion(null);
    schedulerService.setSchedulerInitializationPromise(null);
    const stateManager = await getService(ServiceNames.STATE_MANAGER, void 0, container);
    const serverInfo = await stateManager.getBrowserServer();
    let shouldClearState = true;
    if (serverInfo) {
      const isAlive = await stateManager.isPidAlive(serverInfo.pid, serverInfo.schedulerId);
      if (isAlive && serverInfo.pid !== process.pid && !forceClearRemoteState) {
        logger.log(`[Scheduler] Skipping clearBrowserServer \u2014 live scheduler (PID ${serverInfo.pid}) owns state.`);
        shouldClearState = false;
      } else if (forceClearRemoteState) {
        logger.log(`[Scheduler] Force clearing remote state for PID ${serverInfo.pid} due to unreachability.`);
      }
    }
    if (shouldClearState) {
      await stateManager.clearBrowserServer().catch((error) => {
        logger.warn("[Scheduler] Failed to clear browser server from state:", error);
      });
    }
    if (oldScheduler && "schedulerId" in oldScheduler && oldScheduler.schedulerId) {
      if (oldScheduler instanceof BrowserTaskScheduler) {
        const shutdownPromise = oldScheduler.shutdown().catch((err) => {
          logger.warn("[Scheduler] Error during old scheduler shutdown after restart:", err);
        });
        schedulerService.setPendingShutdownPromise(shutdownPromise);
        shutdownPromise.finally(() => {
          if (schedulerService.getPendingShutdownPromise() === shutdownPromise) {
            schedulerService.setPendingShutdownPromise(null);
          }
        });
      }
    }
    logger.log("[Scheduler] Restart complete. Next call will create fresh scheduler.");
  } finally {
    schedulerService.setSchedulerRestartInProgress(false);
    await disposeBrowserInitLock(container).catch(() => {
    });
  }
}
async function getScheduler(config, container = getServiceContainer()) {
  const schedulerService = await getService(ServiceNames.SCHEDULER, void 0, container);
  const currentVersion = generateSchedulerVersion(config);
  let existing = schedulerService.getSchedulerInstance();
  const cachedVersion = schedulerService.getSchedulerVersion();
  if (existing && cachedVersion && cachedVersion !== currentVersion) {
    logger.log(`[Scheduler] Config changed (old: ${cachedVersion}, new: ${currentVersion}), forcing restart...`);
    await forceSchedulerRestart(false, container);
    existing = null;
  }
  if (existing) {
    if ("resetIdleTimerOnActivity" in existing && typeof existing["resetIdleTimerOnActivity"] === "function") {
      existing["resetIdleTimerOnActivity"]();
    }
    return existing;
  }
  const existingPromise = schedulerService.getSchedulerInitializationPromise();
  if (existingPromise) return existingPromise;
  let p;
  const initializationFunction = async () => {
    const lock = await getBrowserInitLock(container);
    return await lock.withLock(async () => {
      const schedulerVersion = currentVersion;
      const schedulerId = crypto4.randomUUID();
      const stateManager = await getService(ServiceNames.STATE_MANAGER, void 0, container);
      const serverInfo = await stateManager.getBrowserServer();
      if (serverInfo) {
        const isAlive = await stateManager.isPidAlive(serverInfo.pid, serverInfo.schedulerId);
        if (isAlive) {
          const state = await stateManager.readState();
          const storedVersion = state.schedulerVersion;
          if (storedVersion && storedVersion !== currentVersion) {
            logger.log(`[Scheduler] Existing scheduler has stale config (old: ${storedVersion}, new: ${currentVersion}), forcing restart...`);
            if (serverInfo.pid !== process.pid) {
              logger.log(`[Scheduler] Bypassing stale scheduler process (PID ${serverInfo.pid}) by clearing state...`);
            }
            await stateManager.clearBrowserServer();
          } else {
            const portOk = await isPortListening(serverInfo.port);
            if (!portOk) {
              logger.warn(`[Scheduler] PID ${serverInfo.pid} is alive but port ${serverInfo.port} is not listening \u2014 clearing stale state and starting fresh.`);
              await stateManager.clearBrowserServer().catch((e) => {
                logger.warn("[Scheduler] Failed to clear stale browser server state:", e);
              });
            } else {
              logger.log(`[Scheduler] Connecting to existing scheduler (version: ${currentVersion})`);
              const client = new BrowserClient(serverInfo.port, serverInfo.authSecret);
              if (schedulerService.getSchedulerInitializationPromise() === p) {
                schedulerService.setSchedulerInstance(client);
                schedulerService.setSchedulerVersion(currentVersion);
              } else {
                logger.warn("[Scheduler] Initialization finished but was superseded by a restart. Disposing...");
                await client.shutdown().catch((err) => logger.debug("Swallowed shutdown error:", err));
                throw new Error("Initialization superseded");
              }
              return client;
            }
          }
        }
      }
      const scheduler = new BrowserTaskScheduler(schedulerId, stateManager, container);
      let port;
      try {
        port = await scheduler.startServer();
      } catch (error) {
        logger.error("[Scheduler] Failed to start server, running standalone:", error);
        if (schedulerService.getSchedulerInitializationPromise() === p) {
          schedulerService.setSchedulerInstance(scheduler);
          schedulerService.setSchedulerVersion(currentVersion);
        } else {
          await scheduler.shutdown().catch((err) => logger.debug("Swallowed shutdown error:", err));
          throw new Error("Initialization superseded", { cause: error });
        }
        return scheduler;
      }
      let wonElection = false;
      let winnerPort = port;
      let winnerAuthSecret;
      try {
        await stateManager.updateState(async (state) => {
          if (state.browserServer) {
            const alive = await stateManager.isPidAlive(state.browserServer.pid, state.browserServer.schedulerId, true);
            if (alive) {
              winnerPort = state.browserServer.port;
              winnerAuthSecret = state.browserServer.authSecret;
              wonElection = false;
              return state;
            }
          }
          const secret = getBrowserServerAuthSecret();
          state.browserServer = { port, pid: process.pid, schedulerId, authSecret: secret };
          state.schedulerVersion = schedulerVersion;
          wonElection = true;
          return state;
        });
      } catch (error) {
        logger.error("[Scheduler] Failed to register as leader, running standalone:", error);
        if (schedulerService.getSchedulerInitializationPromise() === p) {
          schedulerService.setSchedulerInstance(scheduler);
          schedulerService.setSchedulerVersion(currentVersion);
        } else {
          await scheduler.shutdown().catch((err) => logger.debug("Swallowed shutdown error:", err));
          throw new Error("Initialization superseded", { cause: error });
        }
        return scheduler;
      }
      if (!wonElection) {
        logger.log(`[Scheduler] Lost election, connecting to winner at port ${winnerPort}`);
        await scheduler.shutdown();
        const client = new BrowserClient(winnerPort, winnerAuthSecret);
        if (schedulerService.getSchedulerInitializationPromise() === p) {
          schedulerService.setSchedulerInstance(client);
          schedulerService.setSchedulerVersion(schedulerVersion);
        } else {
          await client.shutdown().catch((err) => logger.debug("Swallowed shutdown error:", err));
          throw new Error("Initialization superseded");
        }
        return client;
      }
      logger.log(`[Scheduler] Won election, serving as leader on port ${port} (PID ${process.pid})`);
      metrics.increment("browser_leadership_wins_total", 1);
      if (schedulerService.getSchedulerInitializationPromise() === p) {
        schedulerService.setSchedulerInstance(scheduler);
        schedulerService.setSchedulerVersion(schedulerVersion);
      } else {
        logger.warn("[Scheduler] Won election but was superseded by restart. Shutting down pool...");
        await scheduler.shutdown().catch((err) => logger.debug("Swallowed shutdown error:", err));
        throw new Error("Initialization superseded");
      }
      return scheduler;
    });
  };
  p = initializationFunction();
  schedulerService.setSchedulerInitializationPromise(p);
  p.catch(() => {
    if (schedulerService.getSchedulerInitializationPromise() === p) {
      schedulerService.setSchedulerInitializationPromise(null);
    }
  });
  return p;
}

// src/infrastructure/scheduler-factory-service.ts
var SchedulerFactoryService = class {
  name = ServiceNames.SCHEDULER_FACTORY;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  container = getServiceContainer();
  async initialize(ctx) {
    if (ctx?.container) {
      this.container = ctx.container;
    }
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    await disposeBrowserInitLock(this.container);
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  /**
   * Get or create a scheduler instance.
   * Handles leader election and client/server mode switching.
   */
  async getScheduler(config) {
    return getScheduler(config, this.container);
  }
  /**
   * Get the current scheduler version string.
   */
  getSchedulerVersion(config) {
    return getSchedulerVersion(config);
  }
  /**
   * Force a restart of the scheduler by clearing the global cache and state.
   */
  async forceSchedulerRestart(forceClearRemoteState) {
    return forceSchedulerRestart(forceClearRemoteState, this.container);
  }
};

// src/infrastructure/state/state-manager.ts
import * as fs8 from "node:fs/promises";
import * as path9 from "node:path";
import * as crypto5 from "node:crypto";
import * as os5 from "node:os";
import process2 from "node:process";

// src/infrastructure/state/state-session-api.ts
var StateSessionApi = class {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }
  sessionManager;
  /**
   * Add a new session to the state
   * @param sessionId The session ID to add
   * @param param PID (number) or container name (string)
   * @param updateState Function to update state atomically
   * @param processPid PID of the current process
   * @param getStartTime Function to get process start time
   * @throws Error if unable to update state
   */
  async addSession(sessionId, param, updateState, processPid, getStartTime) {
    const pid = typeof param === "number" ? param : processPid;
    const startTime = await getStartTime(pid);
    await updateState(async (state) => {
      return this.sessionManager.addSession(state, sessionId, pid, startTime);
    });
  }
  /**
   * Remove a session from the state
   * @param sessionId The session ID to remove
   * @param updateState Function to update state atomically
   */
  async removeSession(sessionId, updateState) {
    await updateState((state) => {
      return this.sessionManager.removeSession(state, sessionId);
    });
  }
  /**
   * Update the heartbeat timestamp for a session
   * @param sessionId The session ID to update
   * @param updateState Function to update state atomically
   */
  async updateHeartbeat(sessionId, updateState) {
    await updateState((state) => {
      return this.sessionManager.updateHeartbeat(state, sessionId);
    });
  }
  /**
   * Clean up stale sessions based on timeout and process liveness
   * @param timeoutMs Timeout in milliseconds for session staleness
   * @param readState Function to read state
   * @param updateState Function to update state atomically
   * @returns Number of sessions removed
   */
  async cleanupStaleSessions(timeoutMs, readState, updateState) {
    const state = await readState();
    const sessionsToRemove = await this.sessionManager.classifyStaleSessions(state, timeoutMs);
    if (sessionsToRemove.size > 0) {
      await updateState((state2) => {
        return this.sessionManager.removeStaleSessions(state2, sessionsToRemove);
      });
    }
    return sessionsToRemove.size;
  }
};

// src/infrastructure/state/state-browser-api.ts
var StateBrowserApi = class {
  constructor(browserManager) {
    this.browserManager = browserManager;
  }
  browserManager;
  /**
   * Get the current browser server information
   * @param readState Function to read state
   * @returns Browser server info or null if not set
   */
  async getBrowserServer(readState) {
    const state = await readState();
    return this.browserManager.getBrowserServer(state);
  }
  /**
   * Set the current browser server information (atomic: only overwrites if no live server exists)
   * @param port The browser server port
   * @param pid The browser server process ID
   * @param schedulerId Optional scheduler ID
   * @param updateState Function to update state atomically
   * @param getStartTime Function to get process start time
   */
  async setBrowserServer(port, pid, schedulerId, updateState, getStartTime, authSecret) {
    const startTime = await getStartTime(pid);
    await updateState((state) => {
      return this.browserManager.setBrowserServer(state, port, pid, schedulerId, startTime, authSecret);
    });
  }
  /**
   * Clear the browser server information
   * @param updateState Function to update state atomically
   */
  async clearBrowserServer(updateState) {
    await updateState((state) => {
      return this.browserManager.clearBrowserServer(state);
    });
  }
  /**
   * Check if a process is alive with optional scheduler ID verification
   * @param pid The process ID to check
   * @param expectedSchedulerId Optional scheduler ID to verify
   * @param readState Function to read state (can skip lock)
   * @param isPidAlive Function to check if PID is alive
   * @param skipLock Whether to skip lock when reading state
   * @returns true if process is alive and scheduler ID matches (if provided)
   */
  async isPidAlive(pid, expectedSchedulerId, readState, isPidAlive) {
    const alive = isPidAlive(pid);
    if (!alive) return false;
    if (expectedSchedulerId) {
      const state = await readState();
      return this.browserManager.isPidAlive(state, pid, expectedSchedulerId, isPidAlive);
    }
    return true;
  }
};

// src/infrastructure/state/state-manager.ts
var StateManager = class {
  stateFilePath;
  lockDirPath;
  backupDirPath;
  lockFilePath;
  // Sub-services (injected via constructor)
  fileLockService;
  processLifecycle;
  gpuResourceService;
  sessionApi;
  browserApi;
  backupManager;
  metricsCollector;
  validator;
  constructor(options) {
    const {
      stateDir: providedStateDir,
      processLifecycle,
      fileLockService,
      gpuResourceService,
      sessionManager,
      browserManager,
      backupManager,
      metricsCollector,
      validator
    } = options;
    let stateDir = providedStateDir;
    if (!stateDir) {
      const homeDir = os5.homedir();
      stateDir = path9.join(homeDir, ".pi", "state");
    }
    this.stateFilePath = path9.join(stateDir, "research-state.json");
    this.lockDirPath = path9.join(stateDir, ".locks");
    this.backupDirPath = path9.join(stateDir, "backups");
    this.lockFilePath = path9.join(this.lockDirPath, "research-state.lock");
    this.fileLockService = fileLockService;
    this.processLifecycle = processLifecycle;
    this.gpuResourceService = gpuResourceService;
    this.sessionApi = new StateSessionApi(sessionManager);
    this.browserApi = new StateBrowserApi(browserManager);
    this.backupManager = backupManager;
    this.metricsCollector = metricsCollector;
    this.validator = validator;
  }
  /**
   * Initialize directories with proper permissions
   */
  async ensureDirectories() {
    const dirs = [
      path9.dirname(this.stateFilePath),
      this.lockDirPath,
      this.backupDirPath
    ];
    for (const dir of dirs) {
      try {
        await fs8.mkdir(dir, { recursive: true, mode: 448 });
      } catch (err) {
        logger.error(`[StateManager] Failed to create directory ${dir}:`, err);
        throw err;
      }
    }
  }
  /**
   * Get the default state
   */
  getDefaultState() {
    return {
      version: 1,
      containerId: crypto5.randomBytes(16).toString("hex"),
      containerName: "pi-research-shared-state",
      port: 0,
      sessions: {},
      lastUpdated: Date.now()
    };
  }
  // ==================== Core State Operations ====================
  /**
   * Internal read without lock acquisition (caller must hold lock)
   */
  async _readState() {
    try {
      const content = await fs8.readFile(this.stateFilePath, "utf-8");
      const state = JSON.parse(content);
      return this.validator.validateState(state);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        const errnoError = error;
        if (errnoError.code === "ENOENT") {
          return this.getDefaultState();
        }
      }
      if (error instanceof SyntaxError || error instanceof Error && error.message.includes("parse")) {
        logger.error("[StateManager] State file corrupted, attempting recovery...");
        await this.recoverFromCorruptionDirect();
        try {
          const recovered = await fs8.readFile(this.stateFilePath, "utf-8");
          const recoveredState = JSON.parse(recovered);
          return this.validator.validateState(recoveredState);
        } catch {
          return this.getDefaultState();
        }
      }
      throw new Error(`Failed to read state: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  /**
   * Read the state from the file system
   * @param skipLock If true, skip acquiring the file lock (caller must hold it)
   */
  async readState(skipLock) {
    await this.ensureDirectories();
    if (skipLock) {
      return await this._readState();
    }
    return await this.fileLockService.withLock(async () => {
      return await this._readState();
    });
  }
  /**
   * Write the state to the file system atomically with backup creation
   */
  async writeState(state) {
    await this.ensureDirectories();
    const startTime = Date.now();
    try {
      await this.fileLockService.withLock(() => this._writeState(state));
      const duration = Date.now() - startTime;
      metrics.observe("state_operation_duration_ms", duration, { operation: "write", status: "success" });
      metrics.increment("state_operations_total", 1, { operation: "write", status: "success" });
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.observe("state_operation_duration_ms", duration, { operation: "write", status: "error" });
      metrics.increment("state_operations_total", 1, { operation: "write", status: "error" });
      throw error;
    }
  }
  /**
   * Internal write without lock acquisition (caller must hold lock)
   */
  async _writeState(state) {
    this.validator.validateState(state);
    state.lastUpdated = Date.now();
    let tempFilePath = null;
    try {
      await this.backupManager.createBackup();
      const tempFileName = `research-state-${crypto5.randomBytes(16).toString("hex")}.tmp`;
      tempFilePath = path9.join(path9.dirname(this.stateFilePath), tempFileName);
      const content = JSON.stringify(state, null, 2);
      const fh = await fs8.open(tempFilePath, "w", 384);
      try {
        await fh.writeFile(content, { encoding: "utf-8" });
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await fs8.rename(tempFilePath, this.stateFilePath);
      } catch (renameErr) {
        if (process2.platform === "win32") {
          await fs8.copyFile(tempFilePath, this.stateFilePath);
          await fs8.unlink(tempFilePath);
        } else {
          throw renameErr;
        }
      }
      tempFilePath = null;
      await this.backupManager.cleanupOldBackups();
    } catch (error) {
      throw new Error(`Failed to write state: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (tempFilePath) {
        await fs8.unlink(tempFilePath).catch((err) => {
          logger.warn("[StateManager] Failed to clean up temp file:", err);
        });
      }
    }
  }
  /**
   * Update state atomically using an updater function
   */
  async updateState(updater) {
    await this.ensureDirectories();
    const startTime = Date.now();
    try {
      await this.fileLockService.withLock(async () => {
        const currentState = await this._readState();
        const newState = await updater(currentState);
        await this._writeState(newState);
      });
      const duration = Date.now() - startTime;
      metrics.observe("state_operation_duration_ms", duration, { operation: "update", status: "success" });
      metrics.increment("state_operations_total", 1, { operation: "update", status: "success" });
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.observe("state_operation_duration_ms", duration, { operation: "update", status: "error" });
      metrics.increment("state_operations_total", 1, { operation: "update", status: "error" });
      throw error;
    }
  }
  // ==================== Session API ====================
  async addSession(sessionId, param) {
    await this.sessionApi.addSession(
      sessionId,
      param,
      this.updateState.bind(this),
      process2.pid,
      this.processLifecycle.getProcessStartTime.bind(this.processLifecycle)
    );
  }
  async removeSession(sessionId) {
    await this.sessionApi.removeSession(sessionId, this.updateState.bind(this));
  }
  async updateHeartbeat(sessionId) {
    await this.sessionApi.updateHeartbeat(sessionId, this.updateState.bind(this));
  }
  async cleanupStaleSessions(timeoutMs) {
    return this.sessionApi.cleanupStaleSessions(timeoutMs, this.readState.bind(this), this.updateState.bind(this));
  }
  // ==================== Browser API ====================
  async getBrowserServer() {
    return this.browserApi.getBrowserServer(this.readState.bind(this));
  }
  async setBrowserServer(port, pid, schedulerId, authSecret) {
    await this.browserApi.setBrowserServer(
      port,
      pid,
      schedulerId,
      this.updateState.bind(this),
      this.processLifecycle.getProcessStartTime.bind(this.processLifecycle),
      authSecret
    );
  }
  async clearBrowserServer() {
    await this.browserApi.clearBrowserServer(this.updateState.bind(this));
  }
  // ==================== Embedding Server API ====================
  async getEmbeddingServer() {
    const state = await this.readState();
    return state.embeddingServer ?? null;
  }
  async clearEmbeddingServer() {
    await this.updateState((state) => {
      delete state.embeddingServer;
      return state;
    });
  }
  // ==================== Process API ====================
  async isPidAlive(pid, expectedSchedulerId, skipLock) {
    const state = await this.readState(skipLock);
    const expectedStartTime = state.browserServer?.pid === pid ? state.browserServer.startTime : void 0;
    return this.processLifecycle.isPidAlive(pid, expectedSchedulerId, {
      getState: (s) => this.readState(s ?? skipLock),
      skipLock,
      getSchedulerIdFromState: (state2) => state2.browserServer?.schedulerId,
      expectedStartTime
    });
  }
  // ==================== GPU Lock API ====================
  async acquireGpuLock(sessionId, timeoutMs) {
    return this.gpuResourceService.acquireGpuLock(this.updateState.bind(this), sessionId, timeoutMs);
  }
  async releaseGpuLock(pid) {
    await this.gpuResourceService.releaseGpuLock(this.updateState.bind(this), pid);
  }
  async getGpuOwner() {
    const state = await this.readState();
    return state.gpuOwner || null;
  }
  // ==================== Metrics ====================
  async getMetrics() {
    const state = await this.readState();
    return this.metricsCollector.getMetrics(state);
  }
  // ==================== Recovery ====================
  async recoverFromCorruptionDirect() {
    try {
      await this.backupManager.recoverFromCorruption();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[StateManager] Failed to recover from corruption: ${message}`);
      throw error;
    }
  }
  // ==================== Cleanup ====================
  async cleanup() {
    await this.fileLockService.cleanup();
  }
  // ==================== Public Getters ====================
  getStateFilePath() {
    return this.stateFilePath;
  }
  getLockFilePath() {
    return this.lockFilePath;
  }
  getBackupDirPath() {
    return this.backupDirPath;
  }
  getFileLockService() {
    return this.fileLockService;
  }
  getProcessLifecycleService() {
    return this.processLifecycle;
  }
  getGpuResourceService() {
    return this.gpuResourceService;
  }
};

// src/infrastructure/state/state-manager-service.ts
var StateManagerService = class {
  name = ServiceNames.STATE_MANAGER;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  // The underlying state manager instance
  _stateManager = null;
  async initialize(ctx) {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    logger.debug("[StateManagerService] Initializing...");
    const container = tryGetServiceContainerFromCtx(ctx);
    const processLifecycle = await getService(ServiceNames.PROCESS_LIFECYCLE, ctx, container);
    const fileLockService = await getService(ServiceNames.FILE_LOCK_SERVICE, ctx, container);
    const backupManager = await getService(ServiceNames.STATE_BACKUP_MANAGER, ctx, container);
    const gpuResourceService = await getService(ServiceNames.GPU_RESOURCE_SERVICE, ctx, container);
    const sessionManager = await getService(ServiceNames.STATE_SESSION_MANAGER, ctx, container);
    const browserManager = await getService(ServiceNames.STATE_BROWSER_MANAGER, ctx, container);
    const metricsCollector = await getService(ServiceNames.STATE_METRICS_COLLECTOR, ctx, container);
    const validator = await getService(ServiceNames.STATE_VALIDATOR, ctx, container);
    const pathConfig = await getService(ServiceNames.STATE_PATH_CONFIGURATION, ctx, container);
    const stateDir = pathConfig.getStateDir();
    this._stateManager = new StateManager({
      stateDir,
      processLifecycle,
      fileLockService,
      backupManager,
      gpuResourceService,
      sessionManager,
      browserManager,
      metricsCollector,
      validator
    });
    this.lifecycle = "initialized" /* INITIALIZED */;
    logger.debug("[StateManagerService] Initialized");
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposing" /* DISPOSING */;
    logger.debug("[StateManagerService] Disposing...");
    if (this._stateManager) {
      try {
        await this._stateManager.cleanup();
      } catch (err) {
        logger.warn("[StateManagerService] Error during cleanup:", err);
      }
      this._stateManager = null;
    }
    this.lifecycle = "disposed" /* DISPOSED */;
    logger.debug("[StateManagerService] Disposed");
  }
  /**
   * Get the underlying state manager instance
   */
  getStateManager() {
    if (!this._stateManager) {
      throw new Error("[StateManagerService] State manager not initialized");
    }
    return this._stateManager;
  }
  /**
   * Read the state from the file system
   */
  async readState() {
    return this.getStateManager().readState();
  }
  /**
   * Write the state to the file system
   */
  async writeState(state) {
    return this.getStateManager().writeState(state);
  }
  /**
   * Update state atomically using an updater function
   */
  async updateState(updater) {
    return this.getStateManager().updateState(updater);
  }
  /**
   * Add a new session to the state
   */
  async addSession(sessionId, param) {
    return this.getStateManager().addSession(sessionId, param);
  }
  /**
   * Remove a session from the state
   */
  async removeSession(sessionId) {
    return this.getStateManager().removeSession(sessionId);
  }
  /**
   * Update the heartbeat timestamp for a session
   */
  async updateHeartbeat(sessionId) {
    return this.getStateManager().updateHeartbeat(sessionId);
  }
  /**
   * Clean up stale sessions
   */
  async cleanupStaleSessions(timeoutMs) {
    return this.getStateManager().cleanupStaleSessions(timeoutMs);
  }
  /**
   * Get metrics about the current state
   */
  async getMetrics() {
    return this.getStateManager().getMetrics();
  }
  /**
   * Get the current browser server information
   */
  async getBrowserServer() {
    return this.getStateManager().getBrowserServer();
  }
  /**
   * Set the current browser server information
   */
  async setBrowserServer(port, pid, schedulerId, authSecret) {
    return this.getStateManager().setBrowserServer(port, pid, schedulerId, authSecret);
  }
  /**
   * Clear the browser server information
   */
  async clearBrowserServer() {
    return this.getStateManager().clearBrowserServer();
  }
  /**
   * Get the current embedding server information
   */
  async getEmbeddingServer() {
    return this.getStateManager().getEmbeddingServer();
  }
  /**
   * Clear the embedding server information
   */
  async clearEmbeddingServer() {
    return this.getStateManager().clearEmbeddingServer();
  }
  /**
   * Check if a process is alive
   */
  async isPidAlive(pid, expectedSchedulerId, skipLock) {
    return this.getStateManager().isPidAlive(pid, expectedSchedulerId, skipLock);
  }
  /**
   * Acquire the global GPU resource lock
   */
  async acquireGpuLock(sessionId, timeoutMs) {
    return this.getStateManager().acquireGpuLock(sessionId, timeoutMs);
  }
  /**
   * Release the global GPU resource lock
   */
  async releaseGpuLock(pid) {
    return this.getStateManager().releaseGpuLock(pid);
  }
  /**
   * Information about the current GPU owner
   */
  async getGpuOwner() {
    return this.getStateManager().getGpuOwner();
  }
  /**
   * Cleanup state manager resources
   */
  async cleanup() {
    return this.getStateManager().cleanup();
  }
  /**
   * Get the state file path
   */
  getStateFilePath() {
    return this.getStateManager().getStateFilePath();
  }
  /**
   * Get the lock file path
   */
  getLockFilePath() {
    return this.getStateManager().getLockFilePath();
  }
  /**
   * Get the backup directory path
   */
  getBackupDirPath() {
    return this.getStateManager().getBackupDirPath();
  }
};

// src/infrastructure/knowledge-store-service.ts
import * as path13 from "node:path";

// src/knowledge/index.ts
import * as fs10 from "node:fs";

// src/knowledge/store.ts
import * as lancedb2 from "@lancedb/lancedb";

// src/utils/circuit-breaker.ts
var CircuitBreaker = class {
  state = "CLOSED";
  failureCount = 0;
  successCount = 0;
  nextAttemptTime = 0;
  options;
  constructor(options = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeoutMs: options.resetTimeoutMs ?? 3e4,
      halfOpenMaxCalls: options.halfOpenMaxCalls ?? 1,
      name: options.name ?? "CircuitBreaker",
      isTransientError: options.isTransientError ?? (() => true)
    };
  }
  async execute(action) {
    const startTime = Date.now();
    metrics.increment("circuit_breaker_calls_total", 1, { breaker: this.options.name, state: this.state });
    if (this.state === "OPEN") {
      if (Date.now() >= this.nextAttemptTime) {
        this.transitionTo("HALF_OPEN");
      } else {
        metrics.increment("circuit_breaker_rejected_total", 1, { breaker: this.options.name, reason: "open" });
        throw new Error(`CircuitBreaker '${this.options.name}' is OPEN. Fast-failing to prevent cascading failure.`);
      }
    }
    try {
      const result = await action();
      const duration = Date.now() - startTime;
      metrics.observe("circuit_breaker_call_duration_ms", duration, { breaker: this.options.name, status: "success" });
      this.onSuccess();
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.observe("circuit_breaker_call_duration_ms", duration, { breaker: this.options.name, status: "error" });
      if (this.options.isTransientError(error)) {
        this.onFailure(error);
      }
      throw error;
    }
  }
  onSuccess() {
    metrics.increment("circuit_breaker_success_total", 1, { breaker: this.options.name, state: this.state });
    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.options.halfOpenMaxCalls) {
        this.transitionTo("CLOSED");
      }
    } else if (this.state === "CLOSED") {
      this.failureCount = 0;
    }
  }
  onFailure(error) {
    this.failureCount++;
    const errMsg = error instanceof Error ? error.message : String(error);
    metrics.increment("circuit_breaker_failures_total", 1, { breaker: this.options.name, state: this.state });
    if (this.state === "HALF_OPEN") {
      logger.warn(`[CircuitBreaker] '${this.options.name}' failed during HALF_OPEN state: ${errMsg}`);
      this.transitionTo("OPEN");
    } else if (this.state === "CLOSED") {
      if (this.failureCount >= this.options.failureThreshold) {
        logger.error(`[CircuitBreaker] '${this.options.name}' reached failure threshold (${this.failureCount}): ${errMsg}`);
        this.transitionTo("OPEN");
      }
    }
  }
  transitionTo(newState) {
    logger.warn(`[CircuitBreaker] '${this.options.name}' transitioning from ${this.state} to ${newState}`);
    metrics.increment("circuit_breaker_state_transitions_total", 1, { breaker: this.options.name, from: this.state, to: newState });
    metrics.setGauge("circuit_breaker_state", newState === "CLOSED" ? 0 : newState === "OPEN" ? 1 : 2, { breaker: this.options.name });
    this.state = newState;
    if (newState === "OPEN") {
      this.nextAttemptTime = Date.now() + this.options.resetTimeoutMs;
    } else if (newState === "HALF_OPEN") {
      this.successCount = 0;
    } else if (newState === "CLOSED") {
      this.failureCount = 0;
      this.successCount = 0;
    }
  }
  getState() {
    return this.state;
  }
  reset() {
    metrics.increment("circuit_breaker_resets_total", 1, { breaker: this.options.name });
    this.state = "CLOSED";
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptTime = 0;
    metrics.setGauge("circuit_breaker_state", 0, { breaker: this.options.name });
  }
};

// src/knowledge/store.ts
import * as fs9 from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path10 from "node:path";

// src/knowledge/store-schema.ts
import {
  Schema,
  Field,
  Float32,
  FixedSizeList,
  Utf8,
  Int64,
  Bool
} from "apache-arrow";
import * as lancedb from "@lancedb/lancedb";
var CURRENT_SCHEMA_VERSION = "4";
function createStoreSchema(dim, modelName) {
  return new Schema([
    new Field("vector", new FixedSizeList(dim, new Field("item", new Float32())), false),
    new Field("url", new Utf8(), false),
    new Field("text", new Utf8(), false),
    new Field("content", new Utf8(), true),
    // full page markdown, nullable
    new Field("metadata", new Utf8(), false),
    // JSON stringified
    new Field("workspace", new Utf8(), false),
    // local workspace path or 'global'
    new Field("is_global", new Bool(), false),
    // boolean indicating if it's shared globally
    new Field("ingestion_type", new Utf8(), false),
    // e.g. 'synthesis-description'
    new Field("timestamp", new Int64(), false)
  ], /* @__PURE__ */ new Map([
    ["embedding_model", modelName],
    ["schema_version", CURRENT_SCHEMA_VERSION]
  ]));
}
async function createStoreTable(db, name, dim, modelName) {
  const schema = createStoreSchema(dim, modelName);
  const table = await db.createTable({
    name,
    data: [],
    schema
  });
  await table.createIndex("text", { config: lancedb.Index.fts() });
  await table.createIndex("content", { config: lancedb.Index.fts() });
  await table.createIndex("url", { config: lancedb.Index.btree() });
  await table.createIndex("timestamp", { config: lancedb.Index.btree() });
  await table.createIndex("workspace", { config: lancedb.Index.btree() });
  await table.createIndex("is_global", { config: lancedb.Index.btree() });
  await table.createIndex("ingestion_type", { config: lancedb.Index.btree() });
  return table;
}

// src/knowledge/store-operations.ts
async function addDocumentsToStore(table, docs, embedder, isClosing, workspace, isGlobal) {
  if (docs.length === 0) return;
  if (isClosing()) {
    logger.warn("[store] Ignoring addDocuments during close");
    metrics.increment("knowledge_store_add_documents_total", 1, { status: "ignored_closing" });
    return;
  }
  const startTime = Date.now();
  try {
    const vectors = await embedder.embedMany(docs.map((d) => d.text));
    const data = docs.map((doc, i) => ({
      vector: vectors[i],
      url: doc.url,
      text: doc.text,
      content: doc.content ?? null,
      metadata: JSON.stringify(doc.metadata),
      workspace,
      is_global: isGlobal,
      ingestion_type: doc.ingestion_type || doc.metadata["ingestionType"] || "unknown",
      timestamp: BigInt(doc.timestamp)
    }));
    await table.add(data);
    const duration = Date.now() - startTime;
    metrics.observe("knowledge_store_add_documents_duration_ms", duration);
    metrics.increment("knowledge_store_add_documents_total", 1, { status: "success" });
    metrics.increment("knowledge_store_chunks_added_total", docs.length);
    logger.log(`[store] Added ${docs.length} chunk(s) for ${docs[0]?.url} [workspace=${workspace}, global=${isGlobal}]`);
  } catch (err) {
    const duration = Date.now() - startTime;
    metrics.observe("knowledge_store_add_documents_duration_ms", duration, { status: "error" });
    metrics.increment("knowledge_store_add_documents_total", 1, { status: "error" });
    logger.error("[store] Failed to add documents:", err);
    throw err;
  }
}
async function searchStore(table, embedder, query, getReranker, limit, scopeFilter) {
  const startTime = Date.now();
  const rowCount = scopeFilter ? await table.countRows(scopeFilter) : await table.countRows();
  if (rowCount === 0) {
    metrics.increment("knowledge_store_search_total", 1, { status: "empty" });
    return [];
  }
  const vector = await embedder.embed(query);
  let filter = "ingestion_type = 'synthesis-description'";
  if (scopeFilter) {
    filter = `(${filter}) AND (${scopeFilter})`;
  }
  const results = await table.query().nearestTo(vector).where(filter).fullTextSearch(query, { columns: ["text", "content"] }).rerank(await getReranker()).limit(limit).toArray();
  const filteredResults = results.map((r) => {
    let metadata;
    try {
      metadata = JSON.parse(r.metadata);
    } catch {
      logger.debug("[store-operations] Corrupted metadata in searchStore, skipping row");
      return null;
    }
    return {
      url: r.url,
      text: r.text,
      content: r.content ?? void 0,
      metadata,
      timestamp: Number(r.timestamp)
    };
  }).filter((doc) => doc !== null);
  const duration = Date.now() - startTime;
  metrics.observe("knowledge_store_search_duration_ms", duration);
  metrics.increment("knowledge_store_search_total", 1, { status: "success" });
  metrics.increment("knowledge_store_search_results_total", filteredResults.length);
  return filteredResults;
}
async function findDocumentsByUrl(table, url, scopeFilter) {
  const startTime = Date.now();
  const escapedUrl = url.replace(/'/g, "''");
  let filter = `url = '${escapedUrl}'`;
  if (scopeFilter) {
    filter = `(${filter}) AND (${scopeFilter})`;
  }
  const results = await table.query().where(filter).limit(1e3).toArray();
  const duration = Date.now() - startTime;
  metrics.observe("knowledge_store_query_duration_ms", duration, { operation: "find_by_url" });
  metrics.increment("knowledge_store_query_total", 1, { operation: "find_by_url" });
  if (results.length === 1e3) {
    logger.warn(`[store] findByUrl hit 1000-chunk cap for ${url} - some chunks may be missing`);
    metrics.increment("knowledge_store_query_cap_hits_total", 1);
  }
  return results.map((r) => {
    let metadata = {};
    try {
      metadata = JSON.parse(r.metadata);
    } catch {
      logger.debug("[store-operations] Corrupted metadata in findDocumentsByUrl, using empty object");
    }
    return {
      url: r.url,
      text: r.text,
      content: r.content ?? void 0,
      metadata,
      timestamp: Number(r.timestamp)
    };
  });
}
async function findRelevantUrls(table, embedder, query, getReranker, limit, scopeFilter) {
  const startTime = Date.now();
  const rowCount = scopeFilter ? await table.countRows(scopeFilter) : await table.countRows();
  if (rowCount === 0) {
    metrics.increment("knowledge_store_find_urls_total", 1, { status: "empty" });
    return [];
  }
  const vector = await embedder.embed(query);
  let filter = "ingestion_type = 'synthesis-description'";
  if (scopeFilter) {
    filter = `(${filter}) AND (${scopeFilter})`;
  }
  const results = await table.query().nearestTo(vector).where(filter).fullTextSearch(query, { columns: ["text", "content"] }).rerank(await getReranker()).limit(limit).toArray();
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  for (const r of results) {
    const url = r.url;
    if (seen.has(url)) continue;
    seen.add(url);
    let description = "";
    let provenance = "description-unverified";
    try {
      const meta = JSON.parse(r.metadata);
      description = meta.description ?? "";
      if (meta.provenance) provenance = meta.provenance;
      else if (meta.hasContent === true) provenance = "scraped-verified";
    } catch {
      logger.debug("[store-operations] Corrupted metadata in findRelevantUrls, skipping row");
    }
    if (!description) description = (r.text ?? "").substring(0, 300);
    const scope = r.is_global === true ? "Global Store" : `Local Project (${r.workspace || "unknown"})`;
    const finalProvenance = `${provenance} [${scope}]`;
    entries.push({ url, description, provenance: finalProvenance });
  }
  const duration = Date.now() - startTime;
  metrics.observe("knowledge_store_find_urls_duration_ms", duration);
  metrics.increment("knowledge_store_find_urls_total", 1, { status: "success" });
  metrics.increment("knowledge_store_urls_found_total", entries.length);
  return entries;
}

// src/knowledge/store.ts
function isConnectionRefused(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("ECONNREFUSED");
}
var KnowledgeStore = class {
  name = ServiceNames.KNOWLEDGE_STORE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  db = null;
  table = null;
  options;
  tableName = "knowledge";
  manifestPath;
  isClosing = false;
  activeWrites = /* @__PURE__ */ new Set();
  rrfReranker = null;
  circuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 15e3,
    name: "KnowledgeStore"
  });
  constructor(options) {
    this.options = options;
    this.manifestPath = path10.join(this.options.dbDir, "store-manifest.json");
  }
  getScopeFilter() {
    const ws = this.getWorkspace().replace(/'/g, "''");
    switch (this.options.knowledgeMode) {
      case "project":
        return `workspace = '${ws}'`;
      case "global":
        return "is_global = true";
      default:
        return "1 = 0";
    }
  }
  getWorkspace() {
    return normalizeWorkspacePath(this.options.workspace || process.cwd());
  }
  async initialize() {
    this.lifecycle = "initializing" /* INITIALIZING */;
    await this.loadManifest();
    await this.open();
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async loadManifest() {
    try {
      if (fs9.existsSync(this.manifestPath)) {
        const content = await fsPromises.readFile(this.manifestPath, "utf-8");
        const manifest = JSON.parse(content);
        if (manifest.activeTableName) {
          this.tableName = manifest.activeTableName;
          logger.debug(`[store] Loaded active table name from manifest: ${this.tableName}`);
        }
      }
    } catch (err) {
      logger.warn("[store] Failed to load manifest, using default table name:", err);
    }
  }
  async saveManifest() {
    const tempPath = `${this.manifestPath}.tmp`;
    try {
      const content = JSON.stringify({ activeTableName: this.tableName }, null, 2);
      await fsPromises.writeFile(tempPath, content, { encoding: "utf-8", mode: 384 });
      await fsPromises.rename(tempPath, this.manifestPath);
    } catch (err) {
      logger.warn("[store] Failed to save manifest:", err);
      if (fs9.existsSync(tempPath)) {
        try {
          await fsPromises.unlink(tempPath);
        } catch {
        }
      }
    }
  }
  async open() {
    if (this.db) return;
    if (this.options.withLock) {
      await this.options.withLock(() => this.openInternal());
    } else {
      await this.openInternal();
    }
  }
  async openInternal() {
    if (this.db) return;
    try {
      if (!fs9.existsSync(this.options.dbDir)) {
        fs9.mkdirSync(this.options.dbDir, { recursive: true });
      }
      this.db = await lancedb2.connect(this.options.dbDir);
      const tableNames = await this.db.tableNames();
      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName);
        try {
          const schema = await this.table.schema();
          const vectorField = schema.fields.find((f) => f.name === "vector");
          if (vectorField && vectorField.type.constructor.name === "FixedSizeList") {
            const dim = vectorField.type.listSize;
            if (this.options.embedder.getDimension() === null) {
              this.options.embedder.setDimension(dim);
              logger.debug(`[store] Extracted dimension ${dim} from existing table schema`);
            }
          }
          let storedModel = schema.metadata.get("embedding_model");
          let storedVersion = schema.metadata.get("schema_version");
          if (typeof storedModel === "object" && storedModel !== null && "byteLength" in storedModel) {
            storedModel = new TextDecoder().decode(storedModel);
          }
          if (typeof storedVersion === "object" && storedVersion !== null && "byteLength" in storedVersion) {
            storedVersion = new TextDecoder().decode(storedVersion);
          }
          const isModelMismatch = storedModel !== this.options.modelName;
          const isVersionMismatch = storedVersion !== CURRENT_SCHEMA_VERSION;
          if (isModelMismatch || isVersionMismatch) {
            const reason = isModelMismatch ? "Model change" : "Schema version change";
            logger.warn(`[store] ${reason} detected: ${storedModel} (v${storedVersion}) \u2192 ${this.options.modelName} (v${CURRENT_SCHEMA_VERSION})`);
            const strategy = this.options.migrationStrategy || "backup";
            try {
              await this.handleModelChange(storedModel || "unknown", this.options.modelName, strategy);
            } catch (err) {
              const errorMsg = `Model migration failed using strategy '${strategy}': ${err instanceof Error ? err.message : String(err)}`;
              logger.error(`[store] ${errorMsg}`);
              if (strategy !== "drop" && strategy !== "backup") {
                logger.warn("[store] Falling back to backup strategy after migration failure");
                await this.handleModelChange(storedModel || "unknown", this.options.modelName, "backup");
              } else if (strategy === "backup") {
                logger.warn("[store] Falling back to drop strategy after backup failure");
                await this.handleModelChange(storedModel || "unknown", this.options.modelName, "drop");
              } else {
                throw new Error(errorMsg, { cause: err });
              }
            }
          }
        } catch (schemaErr) {
          logger.warn("[store] Failed to read table schema:", schemaErr);
        }
      } else {
        this.table = await this.createTable();
      }
      await this.evictOldRecords();
      await this.pruneOrphanedMigrationDirs();
      await this.saveManifest();
    } catch (err) {
      logger.error("[store] Failed to open database:", err);
      throw err;
    }
  }
  async handleModelChange(oldModel, newModel, strategy) {
    logger.info(`[store] Executing migration strategy: ${strategy}`);
    logger.info(`[store] Old model: ${oldModel}, New model: ${newModel}`);
    switch (strategy) {
      case "drop":
        return this.migrationDrop(oldModel, newModel);
      case "re-embed":
        return this.migrationReEmbed(oldModel, newModel);
      case "backup":
        return this.migrationBackup(oldModel, newModel);
      default:
        logger.warn(`[store] Unknown migration strategy '${strategy}', falling back to 'backup'`);
        return this.migrationBackup(oldModel, newModel);
    }
  }
  async migrationBackup(_oldModel, newModel) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const backupTableName = `${this.tableName}_backup_${timestamp}`;
    logger.warn(`[store] Backing up table to ${backupTableName} and recreating with model ${newModel}`);
    if (!this.table || !this.db) {
      throw new Error("Table not connected");
    }
    const count = await this.table.countRows();
    this.table = null;
    const oldDir = path10.join(this.options.dbDir, `${this.tableName}.lance`);
    const backupDir = path10.join(this.options.dbDir, `${backupTableName}.lance`);
    try {
      if (fs9.existsSync(oldDir)) {
        await fsPromises.rename(oldDir, backupDir);
        logger.info(`[store] Successfully backed up database directory to ${backupDir}`);
      }
    } catch (err) {
      logger.error(`[store] Atomic backup failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    this.table = await this.createTable();
    await this.saveManifest();
    logger.info(`[store] Migration complete: ${count} documents backed up, fresh table created with model ${newModel}`);
    return { strategy: "backup", success: true, documentsProcessed: count };
  }
  async migrationDrop(_oldModel, newModel) {
    logger.warn(`[store] Dropping table and recreating with model ${newModel} (data will be lost)`);
    if (!this.table || !this.db) {
      throw new Error("Table not connected");
    }
    const count = await this.table.countRows();
    logger.warn(`[store] Deleting ${count} existing documents`);
    await this.db.dropTable(this.tableName);
    this.table = await this.createTable();
    await this.saveManifest();
    logger.info(`[store] Migration complete: ${count} documents removed, table recreated with model ${newModel}`);
    return { strategy: "drop", success: true, documentsProcessed: count };
  }
  async migrationReEmbed(_oldModel, newModel) {
    logger.info(`[store] Re-embedding documents with model ${newModel} (data will be preserved)`);
    if (!this.table || !this.db) {
      throw new Error("Table not connected");
    }
    const totalDocs = await this.table.countRows();
    logger.info(`[store] Processing ${totalDocs} documents for re-embedding...`);
    let embedded = 0;
    const batchSize = 50;
    const tempTableName = `${this.tableName}_migration_${Date.now()}`;
    try {
      logger.info(`[store] Creating new table ${tempTableName} for migration...`);
      const newTable = await this.createTable(tempTableName);
      for (let i = 0; i < totalDocs; i += batchSize) {
        const batchRows = await this.table.query().limit(batchSize).offset(i).toArray();
        const batchDocs = batchRows.flatMap((row) => {
          let metadata = {};
          try {
            metadata = JSON.parse(row.metadata);
          } catch {
            logger.warn("[store] Skipping row with corrupted metadata during re-embed migration");
          }
          return [{
            url: row.url,
            text: row.text,
            content: row.content,
            metadata,
            workspace: row.workspace || "global",
            is_global: !!row.is_global,
            ingestion_type: row.ingestion_type || metadata["ingestionType"] || "synthesis-description",
            timestamp: Number(row.timestamp)
          }];
        });
        const texts = batchDocs.map((d) => d.text);
        const vectors = await this.options.embedder.embedMany(texts);
        const records = batchDocs.map((doc, idx) => ({
          vector: Array.from(vectors[idx]),
          url: doc.url,
          text: doc.text,
          content: doc.content || null,
          metadata: JSON.stringify(doc.metadata),
          workspace: doc.workspace,
          is_global: doc.is_global,
          ingestion_type: doc.ingestion_type,
          timestamp: BigInt(doc.timestamp)
        }));
        await newTable.add(records);
        embedded += batchDocs.length;
        if (embedded % 100 === 0 || embedded === totalDocs) {
          logger.info(`[store] Re-embedded ${embedded}/${totalDocs} documents`);
        }
      }
      logger.info(`[store] Migration successful, dropping old table ${this.tableName}...`);
      const canonicalName = "knowledge";
      const oldTableName = this.tableName;
      await this.db.dropTable(oldTableName);
      logger.info(`[store] Renaming ${tempTableName} to ${canonicalName}...`);
      try {
        const tempDir = path10.join(this.options.dbDir, `${tempTableName}.lance`);
        const canonicalDir = path10.join(this.options.dbDir, `${canonicalName}.lance`);
        await fsPromises.rename(tempDir, canonicalDir);
        this.tableName = canonicalName;
        await this.saveManifest();
        this.table = await this.db.openTable(this.tableName);
      } catch (renameErr) {
        logger.warn(`[store] Directory rename failed, persisting temp table name in manifest: ${renameErr}`);
        this.tableName = tempTableName;
        await this.saveManifest();
        this.table = newTable;
        logger.info(`[store] Migrated data is safe in ${tempTableName} and tracked via manifest.`);
      }
      logger.info(`[store] Migration complete: ${embedded} documents re-embedded with model ${newModel}`);
      return { strategy: "re-embed", success: true, documentsProcessed: embedded };
    } catch (error) {
      logger.error(`[store] Migration failed at ${embedded}/${totalDocs}:`, error);
      logger.error(`[store] Original data is still intact in table ${this.tableName}`);
      throw error;
    }
  }
  async createTable(name = this.tableName) {
    if (!this.db) throw new Error("Database not connected");
    const dim = this.options.embedder.getDimension();
    if (dim === null) throw new Error("[store] Cannot create table: embedder dimension unknown (not yet initialized)");
    return createStoreTable(this.db, name, dim, this.options.modelName);
  }
  async withEmbedderReconnect(fn) {
    try {
      return await fn(this.options.embedder);
    } catch (err) {
      if (isConnectionRefused(err) && this.options.reconnectFactory) {
        logger.warn("[store] Embedder server unreachable, reconnecting and retrying...");
        this.options.embedder = await this.options.reconnectFactory();
        return fn(this.options.embedder);
      }
      throw err;
    }
  }
  /**
   * Internal helper to get a fresh table handle, ensuring we see the latest
   * documents added by other processes. Re-opening a table in LanceDB is 
   * a cheap manifest re-read.
   */
  async getFreshTable() {
    if (!this.db) throw new Error("Store not open");
    try {
      this.table = await this.db.openTable(this.tableName);
    } catch (err) {
      if (!this.table) throw err;
      logger.debug(`[store] Failed to refresh table handle, using existing: ${err}`);
    }
    return this.table;
  }
  async addDocuments(docs) {
    let writeResolve;
    const writePromise = new Promise((resolve5) => {
      writeResolve = resolve5;
    });
    this.activeWrites.add(writePromise);
    try {
      if (this.isClosing) {
        logger.warn(`[store] Skipping addDocuments \u2014 store is closing`);
        return;
      }
      const table = await this.getFreshTable();
      const workspace = this.getWorkspace();
      await this.withEmbedderReconnect(async (embedder) => {
        let retryCount = 0;
        const MAX_RETRIES = 5;
        const BASE_DELAY = 100;
        while (retryCount <= MAX_RETRIES) {
          try {
            const isGlobal = this.options.knowledgeMode === "global";
            await addDocumentsToStore(
              table,
              docs,
              embedder,
              () => this.isClosing,
              workspace,
              isGlobal
            );
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Version mismatch") || msg.includes("Lock error") || msg.includes("Commit error")) {
              retryCount++;
              if (retryCount > MAX_RETRIES) throw err;
              const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
              logger.debug(`[store] Write contention detected, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
              await new Promise((r) => setTimeout(r, delay));
              await this.getFreshTable();
              continue;
            }
            throw err;
          }
        }
      });
    } finally {
      this.activeWrites.delete(writePromise);
      writeResolve();
    }
  }
  async getReranker() {
    if (!this.rrfReranker) {
      this.rrfReranker = await lancedb2.rerankers.RRFReranker.create();
    }
    return this.rrfReranker;
  }
  async search(query, options = {}) {
    const table = await this.getFreshTable();
    const scopeFilter = this.getScopeFilter();
    return this.circuitBreaker.execute(
      () => this.withEmbedderReconnect(
        (embedder) => searchStore(table, embedder, query, this.getReranker.bind(this), options.limit ?? 5, scopeFilter)
      )
    );
  }
  async deleteByUrl(url) {
    let retryCount = 0;
    const MAX_RETRIES = 5;
    const BASE_DELAY = 100;
    const scopeFilter = this.getScopeFilter();
    while (retryCount <= MAX_RETRIES) {
      const table = await this.getFreshTable();
      const startTime = Date.now();
      try {
        const escapedUrl = url.replace(/'/g, "''");
        await table.delete(`url = '${escapedUrl}' AND (${scopeFilter})`);
        const duration = Date.now() - startTime;
        metrics.observe("knowledge_store_delete_duration_ms", duration);
        metrics.increment("knowledge_store_delete_total", 1, { operation: "by_url", status: "success" });
        logger.log(`[store] Deleted chunks for ${url} (scoped)`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Version mismatch") || msg.includes("Lock error") || msg.includes("Commit error")) {
          retryCount++;
          if (retryCount > MAX_RETRIES) throw err;
          const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
          logger.debug(`[store] Delete contention detected for ${url}, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        const duration = Date.now() - startTime;
        metrics.observe("knowledge_store_delete_duration_ms", duration, { status: "error" });
        metrics.increment("knowledge_store_delete_total", 1, { operation: "by_url", status: "error" });
        throw err;
      }
    }
  }
  async deleteByUrlAndType(url, ingestionType) {
    let retryCount = 0;
    const MAX_RETRIES = 5;
    const BASE_DELAY = 100;
    const scopeFilter = this.getScopeFilter();
    while (retryCount <= MAX_RETRIES) {
      const table = await this.getFreshTable();
      const startTime = Date.now();
      try {
        const escapedUrl = url.replace(/'/g, "''");
        const escapedType = ingestionType.replace(/'/g, "''");
        await table.delete(`url = '${escapedUrl}' AND ingestion_type = '${escapedType}' AND (${scopeFilter})`);
        const duration = Date.now() - startTime;
        metrics.observe("knowledge_store_delete_duration_ms", duration, { operation: "by_url_and_type" });
        metrics.increment("knowledge_store_delete_total", 1, { operation: "by_url_and_type", status: "success" });
        logger.log(`[store] Deleted ${ingestionType} chunks for ${url} (scoped)`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Version mismatch") || msg.includes("Lock error") || msg.includes("Commit error")) {
          retryCount++;
          if (retryCount > MAX_RETRIES) throw err;
          const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
          logger.debug(`[store] Delete-by-type contention detected for ${url}, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        const duration = Date.now() - startTime;
        metrics.observe("knowledge_store_delete_duration_ms", duration, { operation: "by_url_and_type", status: "error" });
        metrics.increment("knowledge_store_delete_total", 1, { operation: "by_url_and_type", status: "error" });
        throw err;
      }
    }
  }
  async findDocumentsByUrl(url) {
    const table = await this.getFreshTable();
    const scopeFilter = this.getScopeFilter();
    return findDocumentsByUrl(table, url, scopeFilter);
  }
  async exportForWeb(outputPath) {
    const table = await this.getFreshTable();
    const scopeFilter = this.getScopeFilter();
    logger.info(`[store] Exporting knowledge store for web to: ${outputPath} (scope=${scopeFilter})`);
    const results = await table.query().where(`ingestion_type = 'synthesis-description' AND (${scopeFilter})`).toArray();
    const exportData = results.map((r) => {
      let metadata = {};
      try {
        metadata = JSON.parse(r.metadata);
      } catch {
        logger.debug("[store] Corrupted metadata for row in rebuildDocument");
      }
      return {
        url: r.url,
        // The text is the summary/description
        text: r.text,
        // The vector is the model-dimension embedding
        v: Array.from(r.vector),
        // Minimal metadata needed for the UI
        m: {
          d: metadata["description"] || "",
          t: Number(r.timestamp)
        }
      };
    });
    try {
      const dir = path10.dirname(outputPath);
      await fs9.promises.mkdir(dir, { recursive: true });
      await fs9.promises.writeFile(outputPath, JSON.stringify(exportData), "utf-8");
      logger.info(`[store] Successfully exported ${exportData.length} entries to ${outputPath}`);
    } catch (err) {
      logger.error(`[store] Failed to export knowledge store for web:`, err);
      throw err;
    }
  }
  async findByUrl(url) {
    return this.findDocumentsByUrl(url);
  }
  async rebuildDocument(url) {
    const table = await this.getFreshTable();
    const scopeFilter = this.getScopeFilter();
    const startTime = Date.now();
    const escapedUrl = url.replace(/'/g, "''");
    const results = await table.query().where(`url = '${escapedUrl}' AND ingestion_type = 'synthesis-description' AND (${scopeFilter})`).limit(1).toArray();
    const duration = Date.now() - startTime;
    metrics.observe("knowledge_store_query_duration_ms", duration, { operation: "rebuild_document" });
    metrics.increment("knowledge_store_query_total", 1, { operation: "rebuild_document" });
    if (results.length === 0) {
      metrics.increment("knowledge_store_cache_hits_total", 1, { status: "miss" });
      return null;
    }
    const r = results[0];
    try {
      const metadata = JSON.parse(r.metadata);
      const description = typeof metadata.description === "string" ? metadata.description : null;
      const textToReturn = r.content || r.text || description || "";
      metrics.increment("knowledge_store_cache_hits_total", 1, { status: "hit" });
      logger.log(`[store] Cache hit: synthesis-description for ${url} (${textToReturn.length} chars)`);
      return { text: textToReturn, description, metadata };
    } catch {
      logger.debug(`[store] Parse error reading cached content for ${url}`);
      metrics.increment("knowledge_store_cache_hits_total", 1, { status: "parse_error" });
      return null;
    }
  }
  async findRelevantUrls(query, options = {}) {
    const table = await this.getFreshTable();
    const scopeFilter = this.getScopeFilter();
    return this.circuitBreaker.execute(
      () => this.withEmbedderReconnect(
        (embedder) => findRelevantUrls(table, embedder, query, this.getReranker.bind(this), options.limit ?? 20, scopeFilter)
      )
    );
  }
  async rebuildFtsIndex() {
    const table = await this.getFreshTable();
    try {
      const count = await table.countRows();
      if (count === 0) {
        logger.debug("[store] Skipping FTS index rebuild (table is empty)");
        return;
      }
      logger.info("[store] Rebuilding FTS indexes...");
      await table.createIndex("text", {
        config: lancedb2.Index.fts(),
        replace: true
      });
      await table.createIndex("content", {
        config: lancedb2.Index.fts(),
        replace: true
      });
      logger.info("[store] FTS indexes rebuilt (text + content).");
    } catch (err) {
      logger.warn("[store] FTS index rebuild failed:", err);
    }
  }
  async evictOldRecords() {
    const table = await this.getFreshTable();
    try {
      const scopeFilter = this.getScopeFilter();
      if (scopeFilter === "1 = 0") return;
      const ttlDays = this.options.ttlDays ?? 30;
      const cutoffTimestamp = Date.now() - ttlDays * 24 * 60 * 60 * 1e3;
      await table.delete(`timestamp < ${BigInt(cutoffTimestamp)} AND (${scopeFilter})`);
      logger.log(`[store] Ran eviction for records older than ${ttlDays} days [scope: ${scopeFilter}]`);
    } catch (err) {
      logger.warn("[store] Failed to evict old records:", err);
    }
  }
  async pruneOrphanedMigrationDirs() {
    try {
      const canonicalDir = `${this.tableName}.lance`;
      const entries = await fsPromises.readdir(this.options.dbDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name !== canonicalDir && name.endsWith(".lance") && (name.includes("_backup_") || name.includes("_migration_"))) {
          const fullPath = path10.join(this.options.dbDir, name);
          logger.info(`[store] Removing orphaned migration/backup directory: ${name}`);
          await fsPromises.rm(fullPath, { recursive: true, force: true });
        }
      }
    } catch (err) {
      logger.warn("[store] Failed to prune orphaned migration directories:", err);
    }
  }
  async count() {
    if (!this.db) return 0;
    const table = await this.getFreshTable();
    const scopeFilter = this.getScopeFilter();
    const count = await table.countRows(scopeFilter);
    metrics.setGauge("knowledge_store_total_documents", count);
    return count;
  }
  /**
   * Get granular counts for local vs global entries.
   * @param workspace - Optional workspace to filter project-specific counts.
   *                    Defaults to the store's configured workspace.
   */
  async countScoped(workspace) {
    if (!this.db) return { local: 0, global: 0, projects: 0 };
    let retryCount = 0;
    const MAX_RETRIES = 5;
    const BASE_DELAY = 100;
    while (retryCount <= MAX_RETRIES) {
      try {
        const table = await this.getFreshTable();
        const ws = normalizeWorkspacePath(workspace || this.getWorkspace());
        const escaped = ws.replace(/'/g, "''");
        const [local, global] = await Promise.all([
          table.countRows(`workspace = '${escaped}'`),
          table.countRows(`is_global = true`)
        ]);
        const allWorkspaces = await table.query().select(["workspace"]).toArray();
        const uniqueWorkspaces = /* @__PURE__ */ new Set();
        for (const row of allWorkspaces) {
          if (row.workspace) uniqueWorkspaces.add(row.workspace);
        }
        return { local, global, projects: uniqueWorkspaces.size };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Version mismatch") || msg.includes("Lock error") || msg.includes("Commit error")) {
          retryCount++;
          if (retryCount > MAX_RETRIES) throw err;
          const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
          logger.debug(`[store] Read contention detected in countScoped, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    return { local: 0, global: 0, projects: 0 };
  }
  async clear(filter) {
    if (!this.db) throw new Error("Store not open");
    let retryCount = 0;
    const MAX_RETRIES = 5;
    const BASE_DELAY = 100;
    while (retryCount <= MAX_RETRIES) {
      try {
        const table = await this.getFreshTable();
        const scopeFilter = filter || this.getScopeFilter();
        const startTime = Date.now();
        await table.delete(scopeFilter);
        const duration = Date.now() - startTime;
        metrics.observe("knowledge_store_clear_duration_ms", duration);
        metrics.increment("knowledge_store_clear_total", 1, { status: "success" });
        metrics.setGauge("knowledge_store_total_documents", 0);
        logger.info(`[store] Knowledge store cleared for scope: ${scopeFilter}`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Version mismatch") || msg.includes("Lock error") || msg.includes("Commit error")) {
          retryCount++;
          if (retryCount > MAX_RETRIES) {
            metrics.increment("knowledge_store_clear_total", 1, { status: "error" });
            throw err;
          }
          const delay = Math.floor(Math.random() * (BASE_DELAY * Math.pow(2, retryCount - 1)));
          logger.debug(`[store] Write contention detected in clear, retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        metrics.increment("knowledge_store_clear_total", 1, { status: "error" });
        logger.error("[store] Failed to clear knowledge store:", err);
        throw err;
      }
    }
  }
  isStoreClosed() {
    return this.isClosing;
  }
  async close() {
    this.isClosing = true;
    if (this.activeWrites.size > 0) {
      const maxWaitMs = 1e4;
      const writesCount = this.activeWrites.size;
      let timeoutId;
      try {
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Close timeout")), maxWaitMs);
        });
        timeoutPromise.catch((err) => logger.debug(`[store] Background timeout rejection: ${err.message}`));
        await Promise.race([
          Promise.allSettled(Array.from(this.activeWrites)),
          timeoutPromise
        ]);
      } catch (_err) {
        logger.warn(`[store] Closing with ${this.activeWrites.size} pending operations after timeout (started with ${writesCount})`);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    try {
      this.table = null;
      this.rrfReranker = null;
      if (this.db) {
        this.db.close();
        this.db = null;
      }
    } catch (err) {
      logger.error("[store] Error during close:", err);
    }
  }
};

// src/utils/url-utils.ts
function normalizeUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    if (url.length > 4096) return url.trim().split("#")[0].toLowerCase();
    const cleanUrl = url.trim().replace(/[*_~`]{1,20}$/, "").replace(/[,.)]{1,20}$/, "");
    const parsed = new URL(cleanUrl);
    parsed.protocol = "https:";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.port === "443" || parsed.port === "80") {
      parsed.port = "";
    }
    parsed.hash = "";
    parsed.searchParams.sort();
    while (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    let result = parsed.toString();
    if (result.endsWith("/")) {
      result = result.slice(0, -1);
    }
    if (result.endsWith("?")) {
      result = result.slice(0, -1);
    }
    return result;
  } catch (_err) {
    logger.debug(`[url-utils] normalizing unparseable URL (${url.slice(0, 200)}): ${_err instanceof Error ? _err.message : String(_err)}`);
    let cleaned = url.trim().replace(/^[*_~`"']+/, "").replace(/[*_~`"',.)}\]]+$/, "");
    const hashIdx = cleaned.indexOf("#");
    if (hashIdx >= 0) cleaned = cleaned.substring(0, hashIdx);
    if (cleaned.endsWith("/") && cleaned.length > 8) {
      cleaned = cleaned.slice(0, -1);
    }
    cleaned = cleaned.toLowerCase();
    if (!cleaned.startsWith("http") && cleaned.includes(".")) {
      cleaned = "https://" + cleaned.replace(/^\/{2,}/, "");
    }
    return cleaned;
  }
}
function validateUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) return false;
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
    if (hostname === "::1" || hostname === "[::1]") return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.)/.test(hostname)) return false;
    if (hostname.startsWith("fe80:") || hostname.startsWith("[fe80:")) return false;
    if (hostname.startsWith("fc") || hostname.startsWith("[fc")) return false;
    if (hostname.startsWith("fd") || hostname.startsWith("[fd")) return false;
    if (hostname.startsWith("::ffff:") || hostname.startsWith("[::ffff:")) return false;
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
    if (!hostname.includes(".")) return false;
    return true;
  } catch {
    return false;
  }
}

// src/knowledge/writer-queue.ts
import { createHash as createHash2 } from "node:crypto";
function isConnectionRefused2(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("ECONNREFUSED");
}
function isNoSpace(err) {
  const code = err?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === "ENOSPC" || msg.includes("ENOSPC") || msg.toLowerCase().includes("no space left");
}
var WriterQueue = class {
  name = ServiceNames.WRITER_QUEUE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  queue = [];
  processing = false;
  options;
  drainResolvers = [];
  // FIX (#2): Per-URL lock map to prevent TOCTOU races when concurrent writers
  // ingest the same URL. Key is the normalized URL; value is the in-flight promise.
  inflightByUrl = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
  }
  async initialize() {
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    await this.drain();
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  enqueue(item) {
    this.queue.push(item);
    this.process().catch((err) => {
      logger.error("[writer-queue] Error in process():", err);
    });
  }
  async process() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        const urlKey = normalizeUrl(item.url);
        const prev = this.inflightByUrl.get(urlKey) ?? Promise.resolve();
        const inflight = prev.then(() => this._ingestInner(item));
        this.inflightByUrl.set(urlKey, inflight);
        try {
          await inflight;
        } finally {
          if (this.inflightByUrl.get(urlKey) === inflight) {
            this.inflightByUrl.delete(urlKey);
          }
        }
      } catch (err) {
        if (isConnectionRefused2(err)) {
          logger.warn(`[writer-queue] Embedder unreachable for ${item.url}, retrying once after 2s...`);
          await new Promise((r) => setTimeout(r, 2e3));
          try {
            await this.ingest(item);
          } catch (retryErr) {
            logger.error(`[writer-queue] Retry failed for ${item.url}, dropping:`, retryErr);
          }
        } else if (isNoSpace(err)) {
          logger.error(`[writer-queue] ENOSPC: disk full \u2014 dropping ${item.url}. Free up disk space to resume knowledge ingestion.`);
        } else {
          logger.error(`[writer-queue] Failed to ingest ${item.url}:`, err);
        }
      }
    }
    this.processing = false;
    const resolvers = [...this.drainResolvers];
    this.drainResolvers = [];
    for (const resolve5 of resolvers) {
      resolve5();
    }
  }
  async ingest(item) {
    const urlKey = normalizeUrl(item.url);
    const prev = this.inflightByUrl.get(urlKey) ?? Promise.resolve();
    const inflight = prev.then(() => this._ingestInner(item));
    this.inflightByUrl.set(urlKey, inflight);
    try {
      await inflight;
    } finally {
      if (this.inflightByUrl.get(urlKey) === inflight) {
        this.inflightByUrl.delete(urlKey);
      }
    }
  }
  async _ingestInner(item) {
    const incomingType = item.metadata?.["ingestionType"] ?? "synthesis-description";
    if (!item.markdown) {
      logger.warn(`[writer-queue] Skipping ingest for ${item.url} \u2014 markdown is empty`);
      return;
    }
    if (!validateUrl(item.url)) {
      logger.warn(`[writer-queue] Skipping ingest \u2014 URL failed validation: ${item.url}`);
      return;
    }
    const normalizedUrl = normalizeUrl(item.url);
    const hash = createHash2("sha256").update(item.markdown).update(item.content ?? "").digest("hex");
    if (this.options.store.isStoreClosed?.()) {
      logger.warn(`[writer-queue] Skipping ingest for ${normalizedUrl} \u2014 store is closing`);
      return;
    }
    const hasContent = !!item.content;
    const provenanceCategory = hasContent ? "scraped-verified" : "description-unverified";
    const provenanceMeta = {
      provenance: provenanceCategory,
      hasContent,
      validatedAt: Date.now()
    };
    const existing = await this.options.store.findByUrl(normalizedUrl);
    const sameType = existing.filter((c) => c.metadata["ingestionType"] === incomingType);
    if (sameType.length > 0 && sameType[0].metadata["contentHash"] === hash) {
      logger.log(`[writer-queue] Skipping ${normalizedUrl} (${incomingType}) \u2014 content unchanged.`);
      return;
    }
    if (sameType.length > 0) {
      await this.options.store.deleteByUrlAndType(normalizedUrl, incomingType);
    }
    const rawChunks = this.options.chunker ? this.options.chunker.chunk(item.markdown) : [{ text: item.markdown, actual_overlap: 0 }];
    if (rawChunks.length === 0) return;
    const docs = rawChunks.map((chunk, i) => ({
      url: normalizedUrl,
      text: chunk.text,
      content: i === 0 ? item.content ?? void 0 : void 0,
      metadata: {
        ...item.metadata || {},
        // Preserve the original (pre-normalization) URL for debugging/display
        originalUrl: item.url !== normalizedUrl ? item.url : void 0,
        contentHash: hash,
        ingestionType: incomingType,
        ...provenanceMeta,
        chunkIndex: i,
        totalChunks: rawChunks.length
      },
      timestamp: Date.now()
    }));
    await this.options.store.addDocuments(docs);
  }
  async drain() {
    return new Promise((resolve5) => {
      if (!this.processing && this.queue.length === 0) {
        resolve5();
        return;
      }
      this.drainResolvers.push(resolve5);
    });
  }
};

// src/knowledge/chunker.ts
var Chunker = class {
  targetSize;
  overlap;
  constructor(options) {
    if (options.overlap >= options.targetSize) {
      throw new Error(
        `Chunker: overlap (${options.overlap}) must be less than targetSize (${options.targetSize}). This prevents infinite loops during chunking.`
      );
    }
    this.targetSize = options.targetSize;
    this.overlap = options.overlap;
  }
  chunk(text) {
    if (!text) {
      metrics.increment("chunker_operations_total", 1, { status: "empty" });
      return [];
    }
    const startTime = Date.now();
    const chunks = [];
    let start = 0;
    let prevEnd = 0;
    let codeBlockExtensions = 0;
    let headingExtensions = 0;
    let sentenceExtensions = 0;
    let newlineExtensions = 0;
    let spaceExtensions = 0;
    while (start < text.length) {
      let end = start + this.targetSize;
      if (end < text.length) {
        let slice = text.slice(start, end);
        let extendedForCodeBlock = false;
        const textBefore = text.slice(0, start);
        const codeBlockMatchesBefore = textBefore.match(/```/g);
        const startsInCodeBlock = codeBlockMatchesBefore && codeBlockMatchesBefore.length % 2 !== 0;
        const MAX_CHUNK_CHARS = Math.max(this.targetSize * 4, 2e3);
        if (startsInCodeBlock) {
          const nextEnd = text.indexOf("```", start);
          if (nextEnd !== -1 && nextEnd + 3 - start <= MAX_CHUNK_CHARS) {
            end = nextEnd + 3;
            slice = text.slice(start, end);
            extendedForCodeBlock = true;
            codeBlockExtensions++;
          }
        } else {
          const codeBlockMatchesInSlice = slice.match(/```/g);
          if (codeBlockMatchesInSlice && codeBlockMatchesInSlice.length % 2 !== 0) {
            const nextEnd = text.indexOf("```", start + slice.lastIndexOf("```") + 3);
            if (nextEnd !== -1 && nextEnd + 3 - start <= MAX_CHUNK_CHARS) {
              end = nextEnd + 3;
              slice = text.slice(start, end);
              extendedForCodeBlock = true;
              codeBlockExtensions++;
            }
          }
        }
        if (end < text.length && !extendedForCodeBlock) {
          const lastHeading = slice.lastIndexOf("\n#");
          if (lastHeading !== -1 && lastHeading > this.targetSize * 0.4) {
            end = start + lastHeading + 1;
            headingExtensions++;
          } else {
            const sentenceMatches = [...slice.matchAll(/[.!?](?=\s|\n)/g)];
            let lastSentencePos = -1;
            if (sentenceMatches.length > 0) {
              const lastMatch = sentenceMatches[sentenceMatches.length - 1];
              if (lastMatch && lastMatch.index !== void 0) {
                lastSentencePos = lastMatch.index + 1;
              }
            }
            if (lastSentencePos !== -1 && lastSentencePos > this.targetSize * 0.6) {
              end = start + lastSentencePos;
              sentenceExtensions++;
            } else {
              const lastNL = slice.lastIndexOf("\n");
              if (lastNL !== -1 && lastNL > this.targetSize * 0.7) {
                end = start + lastNL + 1;
                newlineExtensions++;
              } else {
                const lastSpace = slice.lastIndexOf(" ");
                if (lastSpace !== -1 && lastSpace > this.targetSize * 0.8) {
                  end = start + lastSpace + 1;
                  spaceExtensions++;
                }
              }
            }
          }
        }
      } else {
        end = text.length;
      }
      if (end <= start) end = Math.min(start + this.targetSize, text.length);
      const chunkText = text.slice(start, end);
      const actual_overlap = chunks.length === 0 ? 0 : Math.max(0, Math.min(chunkText.length, prevEnd - start));
      chunks.push({ text: chunkText, actual_overlap });
      if (end >= text.length) break;
      prevEnd = Math.max(prevEnd, end);
      start = end - this.overlap;
      if (start <= end - chunkText.length) {
        start = end - Math.min(this.overlap, chunkText.length - 1);
      }
      if (start < 0) start = 0;
      if (start >= end) start = end - 1;
    }
    const duration = Date.now() - startTime;
    metrics.observe("chunker_duration_ms", duration);
    metrics.increment("chunker_operations_total", 1, { status: "success" });
    metrics.increment("chunker_chunks_generated_total", chunks.length);
    metrics.increment("chunker_extensions_total", codeBlockExtensions, { type: "code_block" });
    metrics.increment("chunker_extensions_total", headingExtensions, { type: "heading" });
    metrics.increment("chunker_extensions_total", sentenceExtensions, { type: "sentence" });
    metrics.increment("chunker_extensions_total", newlineExtensions, { type: "newline" });
    metrics.increment("chunker_extensions_total", spaceExtensions, { type: "space" });
    for (const chunk of chunks) {
      metrics.observe("chunker_chunk_size_chars", chunk.text.length);
      if (chunk.actual_overlap > 0) {
        metrics.observe("chunker_overlap_chars", chunk.actual_overlap);
      }
    }
    return chunks;
  }
};

// src/knowledge/model-config.ts
var MODEL_CONFIG = {
  "Xenova/multilingual-e5-small": {
    pooling: "mean",
    chunkSize: 1500,
    overlapPct: 0.15,
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
    charsPerToken: 3.5,
    multilingual: true
  },
  "Xenova/multilingual-e5-base": {
    pooling: "mean",
    chunkSize: 1500,
    overlapPct: 0.15,
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
    charsPerToken: 3.5,
    multilingual: true
  },
  "Xenova/bge-m3": {
    pooling: "cls",
    chunkSize: 1500,
    overlapPct: 0.15,
    charsPerToken: 3.5,
    multilingual: true
  },
  "onnx-community/embeddinggemma-300m-ONNX": {
    pooling: "mean",
    chunkSize: 1600,
    overlapPct: 0.15,
    queryPrefix: "Instruct: Given a web search query, retrieve relevant passages that answer the query.\nQuery: ",
    charsPerToken: 3.5,
    multilingual: true
  },
  "onnx-community/Qwen3-Embedding-0.6B-ONNX": {
    pooling: "last_token",
    queryPrefix: "Instruct: Given a web search query, retrieve relevant passages.\nQuery: ",
    chunkSize: 1200,
    overlapPct: 0.15,
    maxTokens: 512,
    batchSize: 2,
    charsPerToken: 2.5,
    useCache: false,
    multilingual: true
  },
  "Xenova/all-MiniLM-L6-v2": {
    pooling: "mean",
    chunkSize: 800,
    overlapPct: 0.15,
    maxTokens: 256,
    multilingual: false
  },
  "Xenova/bge-small-en-v1.5": {
    pooling: "cls",
    chunkSize: 1500,
    overlapPct: 0.15,
    multilingual: false
  },
  "Xenova/all-mpnet-base-v2": {
    pooling: "mean",
    chunkSize: 1200,
    overlapPct: 0.15,
    maxTokens: 384,
    multilingual: false
  },
  "onnx-community/granite-embedding-small-english-r2-ONNX": {
    pooling: "cls",
    chunkSize: 1800,
    overlapPct: 0.15,
    maxTokens: 512,
    batchSize: 8,
    multilingual: false
  }
};
var SUPPORTED_MODELS = Object.entries(MODEL_CONFIG).map(([id, cfg]) => ({ id, multilingual: cfg.multilingual }));
var DEFAULT_CHUNK_SIZE = 1200;
var DEFAULT_OVERLAP_PCT = 0.15;
function getModelEmbedderConfig(modelId) {
  const cfg = MODEL_CONFIG[modelId];
  return cfg ? {
    pooling: cfg.pooling,
    queryPrefix: cfg.queryPrefix,
    documentPrefix: cfg.documentPrefix,
    maxTokens: cfg.maxTokens,
    batchSize: cfg.batchSize,
    charsPerToken: cfg.charsPerToken,
    useCache: cfg.useCache
  } : { pooling: "mean" };
}
function getModelChunkConfig(modelId) {
  const cfg = MODEL_CONFIG[modelId];
  return cfg ? { chunkSize: cfg.chunkSize, overlapPct: cfg.overlapPct } : { chunkSize: DEFAULT_CHUNK_SIZE, overlapPct: DEFAULT_OVERLAP_PCT };
}

// src/knowledge/index.ts
function getMigrationStrategy(config) {
  const strategy = config.MIGRATION_STRATEGY;
  if (!strategy) return void 0;
  const validStrategies = ["drop", "re-embed", "backup"];
  if (validStrategies.includes(strategy)) {
    return strategy;
  }
  logger.warn(`[knowledge] Invalid migration strategy '${strategy}'. Valid options: drop, re-embed, backup. Falling back to default (backup).`);
  return void 0;
}
var MAX_INIT_RETRIES = 5;
var BASE_RETRY_DELAY_MS = 1e3;
var MAX_RETRY_DELAY_MS = 3e4;
async function createKnowledgeStoreComponents(embedderFactory, reconnectFactory, withLock, config = getConfig(), workspace = process.cwd()) {
  if (config.KNOWLEDGE_STORE_MODE === "none") {
    logger.debug("[knowledge] Knowledge store is disabled in configuration");
    return null;
  }
  validateConfig(config);
  for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
    try {
      logger.info(`[knowledge] Creating Knowledge Store components (attempt ${attempt}/${MAX_INIT_RETRIES})...`);
      const embedder = await embedderFactory();
      const migrationStrategy = getMigrationStrategy(config);
      const store = new KnowledgeStore({
        dbDir: getDbDir(config, workspace),
        embedder,
        modelName: config.EMBEDDING_MODEL,
        migrationStrategy,
        reconnectFactory,
        withLock,
        workspace,
        knowledgeMode: config.KNOWLEDGE_STORE_MODE,
        ttlDays: config.KNOWLEDGE_STORE_CACHE_TTL_DAYS
      });
      const chunkCfg = getModelChunkConfig(config.EMBEDDING_MODEL);
      const chunkOverlap = Math.round(chunkCfg.chunkSize * chunkCfg.overlapPct);
      const chunker = new Chunker({ targetSize: chunkCfg.chunkSize, overlap: chunkOverlap });
      const writerQueue = new WriterQueue({ store, chunker });
      await store.initialize();
      return { embedder, store, writerQueue };
    } catch (err) {
      const givingUp = attempt === MAX_INIT_RETRIES;
      if (givingUp) {
        throw err;
      }
      const backoffDelay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_RETRY_DELAY_MS);
      const totalDelay = backoffDelay + Math.random() * 500;
      logger.warn(`[knowledge] Attempt ${attempt}/${MAX_INIT_RETRIES} failed. Retrying in ${(totalDelay / 1e3).toFixed(1)}s...`, err);
      await new Promise((resolve5) => setTimeout(resolve5, totalDelay));
    }
  }
  throw new Error("Failed to create knowledge store components");
}
async function forceDeleteKnowledgeStore(config, workspace) {
  const dbDir = getDbDir(config, workspace);
  if (fs10.existsSync(dbDir)) {
    try {
      fs10.rmSync(dbDir, { recursive: true, force: true });
      fs10.mkdirSync(dbDir, { recursive: true });
      logger.info(`[knowledge] Knowledge store at ${dbDir} forcefully deleted and recreated.`);
    } catch (err) {
      logger.error(`[knowledge] Failed to forcefully delete directory ${dbDir}:`, err);
      throw err;
    }
  }
}

// src/infrastructure/embedding/embedding-factory.ts
import * as crypto6 from "node:crypto";
import * as net2 from "node:net";

// src/utils/safe-unref.ts
function safeUnref(timer) {
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

// src/knowledge/embedder-utils.ts
import { env as hfEnv } from "@huggingface/transformers";
import path11 from "node:path";
import * as os6 from "node:os";

// src/web-research/retry-utils.ts
function createTimeoutSignal(timeoutMs, signal) {
  if (typeof AbortSignal.timeout === "function") {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (signal && typeof AbortSignal.any === "function") {
      try {
        return AbortSignal.any([signal, timeoutSignal]);
      } catch (e) {
        logger.warn(`[createTimeoutSignal] AbortSignal.any failed, falling back to manual combination: ${e}`);
      }
    }
    if (!signal) return timeoutSignal;
  }
  const controller = new AbortController();
  const combinedController = signal ? new AbortController() : controller;
  const timeoutId = setTimeout(() => {
    combinedController.abort("timeout");
  }, timeoutMs);
  if (typeof timeoutId.unref === "function") {
    safeUnref(timeoutId);
  }
  if (signal) {
    const abortHandler = () => {
      clearTimeout(timeoutId);
      combinedController.abort();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    combinedController.signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", abortHandler);
    }, { once: true });
  }
  return combinedController.signal;
}
function withTimeout(promise, timeoutMs, label, signal) {
  const combinedSignal = createTimeoutSignal(timeoutMs, signal);
  logger.debug(`[withTimeout] Starting ${timeoutMs}ms timeout guard (external signal: ${signal?.aborted ?? "no signal"})`);
  return new Promise((resolve5, reject) => {
    if (combinedSignal.aborted) {
      logger.error(`[withTimeout] ${label} ALREADY ABORTED at start`);
      return reject(new Error(`${label} cancelled or timed out`));
    }
    let settled = false;
    const abortHandler = () => {
      if (!settled) {
        settled = true;
        logger.error(`[withTimeout] ${label} ABORTED (timeout or external signal)`);
        reject(new Error(`${label} cancelled or timed out`));
      }
    };
    combinedSignal.addEventListener("abort", abortHandler, { once: true });
    promise.then(
      (val) => {
        if (!settled) {
          settled = true;
          combinedSignal.removeEventListener("abort", abortHandler);
          resolve5(val);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          combinedSignal.removeEventListener("abort", abortHandler);
          reject(err);
        }
      }
    );
  });
}
function isTransientError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  if (message.includes("econnrefused") || message.includes("enotfound") || message.includes("timeout") || message.includes("etimedout")) {
    return true;
  }
  if (message.includes("429") || message.includes("rate") || message.includes("quota")) {
    return true;
  }
  if (message.includes("503") || message.includes("500") || message.includes("502") || message.includes("504") || message.includes("temporarily") || message.includes("unavailable") || message.includes("http 5")) {
    return true;
  }
  return false;
}
async function retryWithBackoff(fn, options = {}) {
  const opts = {
    maxRetries: 3,
    initialDelay: 1e3,
    maxDelay: 1e4,
    label: "operation",
    isTransientError: options.isTransientError ?? isTransientError,
    ...options
  };
  const startTime = Date.now();
  let lastError = null;
  let attempt = 0;
  metrics.increment("retry_attempts_total", 1, { label: opts.label });
  while (attempt <= opts.maxRetries) {
    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      metrics.observe("retry_duration_ms", duration, { label: opts.label, status: "success" });
      if (attempt > 0) {
        metrics.increment("retry_successful_after_retries_total", 1, { attempt: String(attempt), label: opts.label });
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!opts.isTransientError(lastError) || attempt === opts.maxRetries) {
        const duration = Date.now() - startTime;
        metrics.observe("retry_duration_ms", duration, { label: opts.label, status: "exhausted" });
        metrics.increment("retry_exhausted_total", 1, { label: opts.label });
        if (!opts.isTransientError(lastError)) {
          metrics.increment("retry_non_transient_errors_total", 1, { label: opts.label });
        }
        throw lastError;
      }
      const baseDelay = opts.initialDelay * Math.pow(2, attempt);
      const jitter = Math.random() * 0.5 * baseDelay;
      const delay = Math.min(baseDelay + jitter, opts.maxDelay);
      metrics.increment("retry_backoff_total", 1, { attempt: String(attempt), label: opts.label });
      metrics.observe("retry_backoff_delay_ms", delay, { attempt: String(attempt), label: opts.label });
      logger.warn(`[Retry] ${opts.label} failed (attempt ${attempt + 1}/${opts.maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${lastError.message}`);
      await new Promise((resolve5) => {
        const timeoutId = setTimeout(resolve5, delay);
        timeoutId.unref?.();
      });
      attempt++;
    }
  }
  throw lastError ?? new Error("All retries exhausted");
}

// src/utils/shutdown-manager.ts
var ShutdownManager = class {
  tasks = [];
  eventListeners = [];
  cleanupPromise = null;
  register(task) {
    if (this.tasks.includes(task)) {
      return;
    }
    this.tasks.push(task);
  }
  registerEventListener(target, event, listener) {
    target.on(event, listener);
    this.eventListeners.push({ target, event, listener });
  }
  unregisterEventListener(target, event, listener) {
    if (target.off) {
      target.off(event, listener);
    } else if (target.removeListener) {
      target.removeListener(event, listener);
    }
    this.eventListeners = this.eventListeners.filter(
      (el) => el.target !== target || el.event !== event || el.listener !== listener
    );
  }
  async runCleanup(reason) {
    if (this.cleanupPromise !== null) {
      return this.cleanupPromise;
    }
    const tasksToRun = [...this.tasks].reverse();
    this.cleanupPromise = (async () => {
      if (tasksToRun.length === 0) {
        logger.log(`[ShutdownManager] No cleanup tasks registered (${reason}).`);
        return;
      }
      logger.log(`[ShutdownManager] Running cleanup tasks (${reason})...`);
      this.tasks = [];
      for (const task of tasksToRun) {
        try {
          await task();
        } catch (error) {
          logger.error("[ShutdownManager] Error during cleanup task:", error);
        }
      }
      logger.log("[ShutdownManager] Cleanup complete.");
    })();
    try {
      await this.cleanupPromise;
    } finally {
      for (const { target, event, listener } of this.eventListeners) {
        try {
          if (target.off) {
            target.off(event, listener);
          } else if (target.removeListener) {
            target.removeListener(event, listener);
          }
        } catch (error) {
          logger.error("[ShutdownManager] Error removing event listener:", error);
        }
      }
      this.eventListeners = [];
      this.cleanupPromise = null;
    }
  }
  /**
   * Force exit the process after a timeout if shutdown is hanging
   * This should be called after runCleanup() with a short delay
   */
  forceExitAfter(timeoutMs, code = 0) {
    const timer = setTimeout(() => {
      logger.warn(`[ShutdownManager] Forcing exit after ${timeoutMs}ms timeout`);
      process.env["PI_PROCESS_EXITING"] = "1";
      process.exit(code);
    }, timeoutMs);
    safeUnref(timer);
  }
};
var shutdownManager = new ShutdownManager();

// src/knowledge/embedder-utils.ts
function withTimeout2(promise, timeoutMs, errorMessage) {
  return withTimeout(Promise.resolve(promise), timeoutMs, errorMessage, void 0);
}
function getHFEnv() {
  return hfEnv;
}
function getModelCacheDir() {
  const xdgCache = process.env["XDG_CACHE_HOME"];
  const base = xdgCache ?? path11.join(os6.homedir(), ".cache");
  return path11.join(base, "pi-research", "models");
}
var hasWebGpuFallbackOccurred = false;
function hasWebGpuFallback() {
  return hasWebGpuFallbackOccurred;
}
function markWebGpuFallback() {
  hasWebGpuFallbackOccurred = true;
}
var globalEmbedderRef = null;
function registerGlobalEmbedder(e) {
  globalEmbedderRef = e;
  shutdownManager.register(async () => {
    if (globalEmbedderRef === e) {
      const ref = globalEmbedderRef;
      globalEmbedderRef = null;
      try {
        await ref.dispose();
      } catch {
      }
    }
  });
}
function unregisterGlobalEmbedder() {
  globalEmbedderRef = null;
}
var onnxInitialized = false;
function initializeONNXEnv() {
  if (onnxInitialized) return;
  hfEnv.cacheDir = getModelCacheDir();
  try {
    const envObj = hfEnv;
    if (envObj.backends?.onnx) {
      envObj.backends.onnx.logLevel = "error";
    }
    if (envObj.onnx) {
      envObj.onnx.logLevel = "error";
    }
  } catch (e) {
    logger.debug("[embedder] Failed to set ONNX logLevel:", e);
  }
  onnxInitialized = true;
}
var dawnInitialized = false;
async function initializeDawnWebGPU() {
  if (dawnInitialized) return true;
  try {
    const { create, globals } = await import("webgpu");
    Object.assign(globalThis, globals);
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: create([]) },
      writable: true,
      configurable: true
    });
    const adapter = await globalThis.navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (adapter?.info) {
      logger.info(`[embedder] WebGPU adapter: ${adapter.info.vendor} ${adapter.info.device}`);
    }
  } catch {
  }
  dawnInitialized = true;
  logger.info("[embedder] WebGPU ready via onnxruntime-node bundled Dawn (Vulkan on Linux)");
  return true;
}

// src/knowledge/embedder-init.ts
import { pipeline } from "@huggingface/transformers";
async function loadPipelineWithTimeout(model, device, timeoutMs, useCache) {
  const errorMessage = `Model load timed out after ${timeoutMs}ms. Check network connection or try a smaller model.`;
  const loadedPipeline = await logger.runCapturingStderr(async () => {
    const pipelinePromise = pipeline("feature-extraction", model, {
      device,
      ...useCache === false ? { use_cache: false } : {},
      // Clamp ONNX intra-op thread pool to 2 threads per session.
      // Default (0) = one thread per physical CPU core. With multiple concurrent
      // processes each loading their own pipeline, the default spawns N_cores * N_procs
      // threads that all busy-spin simultaneously, saturating the CPU.
      // 2 threads gives adequate within-op parallelism without thrashing.
      session_options: {
        intraOpNumThreads: 2,
        interOpNumThreads: 1
      }
    });
    return await withTimeout2(pipelinePromise, timeoutMs, errorMessage);
  });
  return { pipeline: loadedPipeline, errorMessage };
}
async function warmupPipeline(pipeline2, poolingMode, useCache) {
  try {
    const dummy = await withTimeout2(
      pipeline2("warmup", {
        pooling: poolingMode,
        normalize: false,
        ...useCache === false ? { use_cache: false } : {}
      }),
      2e4,
      "Model warmup timed out after 20000ms."
    );
    return { dummy, success: true };
  } catch (warmupErr) {
    return { dummy: null, success: false, error: warmupErr };
  }
}
function isWebGpuDeviceError(err) {
  if (!err) return false;
  let msg;
  let stack;
  if (err instanceof Error) {
    msg = err.message ?? "";
    stack = err.stack ?? "";
  } else if (typeof err === "object") {
    msg = String(err["message"] ?? "");
    stack = String(err["stack"] ?? "");
    if (!msg && !stack) {
      try {
        msg = JSON.stringify(err);
      } catch {
        msg = String(err);
      }
    }
  } else {
    msg = String(err);
    stack = "";
  }
  const combined = (msg + " " + stack).toLowerCase();
  return combined.includes("webgpu") || combined.includes("out_of_device_memory") || combined.includes("out of memory") || combined.includes("vk_error_out_of_device_memory") || combined.includes("vkallocatememory") || combined.includes("device lost") || combined.includes("devicelost") || combined.includes("validation failed") || combined.includes("invalid buffer") || combined.includes("bindgroup") || combined.includes("minbindingsize") || combined.includes("past_key_values") || combined.includes("unlabeled") || combined.includes("bufferbindingtype") || combined.includes("createdevice") || combined.includes("createbindgroup") || combined.includes("out-of-memory");
}
async function isModelCached(model) {
  try {
    const env = getHFEnv();
    const cacheDir = env.cacheDir;
    if (!cacheDir) return false;
    const { access: access2 } = await import("node:fs/promises");
    const path16 = await import("node:path");
    await access2(path16.default.join(cacheDir, model, "onnx", "model.onnx"));
    return true;
  } catch {
    return false;
  }
}
async function loadModelOnCPU(model, initializationTimeoutMs, useCache) {
  logger.info(`[embedder] Loading model on CPU after WebGPU error...`);
  const loadedPipeline = await logger.runCapturingStderr(async () => {
    const pipelinePromise = pipeline("feature-extraction", model, {
      device: "cpu",
      ...useCache === false ? { use_cache: false } : {},
      session_options: {
        intraOpNumThreads: 2,
        interOpNumThreads: 1
      }
    });
    return await withTimeout2(pipelinePromise, initializationTimeoutMs, "CPU fallback model load timed out");
  });
  return loadedPipeline;
}
async function releaseGpuLock(stateManager, gpuLockHeld) {
  if (gpuLockHeld && stateManager) {
    await stateManager.releaseGpuLock().catch((err) => {
      logger.warn("[embedder] Failed to release GPU lock:", err);
    });
  }
}
async function acquireGpuLock(stateManager) {
  if (!stateManager) {
    return { acquired: false, shouldFallback: false };
  }
  const gpuLockHeld = await stateManager.acquireGpuLock(void 0, 3e4);
  if (!gpuLockHeld) {
    logger.warn("[embedder] Failed to acquire GPU init lock within 30s \u2014 falling back to CPU");
    return { acquired: false, shouldFallback: true };
  }
  logger.debug("[embedder] Acquired GPU init lock");
  return { acquired: true, shouldFallback: false };
}
async function handleWebGPULoadError(loadErr, pipeline2, stateManager, gpuLockHeld, model, initializationTimeoutMs, useCache) {
  const errorMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
  const isValidationError = errorMsg.toLowerCase().includes("validation");
  markWebGpuFallback();
  if (isValidationError) {
    logger.warn("[embedder] WebGPU validation error during pipeline loading \u2014 falling back to CPU");
    logger.debug("[embedder] Validation error details:", errorMsg);
  } else {
    logger.warn("[embedder] WebGPU OOM during pipeline loading \u2014 falling back to CPU");
  }
  if (pipeline2) {
    try {
      if (typeof pipeline2.dispose === "function") await pipeline2.dispose();
    } catch (err) {
      logger.warn("[embedder] Error disposing pipeline:", err);
    }
  }
  await releaseGpuLock(stateManager, gpuLockHeld);
  try {
    const cpuPipeline = await loadModelOnCPU(model, initializationTimeoutMs, useCache);
    logger.info(`[embedder] Pipeline loaded (device: cpu)`);
    return { success: true, pipeline: cpuPipeline };
  } catch (cpuLoadErr) {
    logger.error("[embedder] CPU fallback pipeline load failed:", cpuLoadErr);
    const error = new Error(`WebGPU initialization failed and CPU fallback load also failed: ${cpuLoadErr instanceof Error ? cpuLoadErr.message : String(cpuLoadErr)}`, { cause: cpuLoadErr });
    return { success: false, error };
  }
}
async function handleWebGPUWarmupError(warmupErr, pipeline2, stateManager, gpuLockHeld, model, initializationTimeoutMs, useCache) {
  const isValidationError = warmupErr.message.toLowerCase().includes("validation");
  markWebGpuFallback();
  if (isValidationError) {
    logger.warn("[embedder] WebGPU validation error during warmup \u2014 falling back to CPU");
    logger.debug("[embedder] Validation error details:", warmupErr.message);
  } else {
    logger.warn("[embedder] WebGPU OOM during warmup \u2014 falling back to CPU");
  }
  if (pipeline2) {
    try {
      if (typeof pipeline2.dispose === "function") await pipeline2.dispose();
    } catch (err) {
      logger.warn("[embedder] Error disposing pipeline:", err);
    }
  }
  await releaseGpuLock(stateManager, gpuLockHeld);
  try {
    const cpuPipeline = await loadModelOnCPU(model, initializationTimeoutMs, useCache);
    logger.info("[embedder] CPU pipeline loaded successfully");
    const { dummy, success, error: cpuWarmupErr } = await warmupPipeline(cpuPipeline, "mean", useCache);
    if (!success || cpuWarmupErr) {
      logger.error("[embedder] CPU fallback pipeline warmup failed:", cpuWarmupErr);
      if (cpuPipeline) {
        try {
          if (typeof cpuPipeline.dispose === "function") await cpuPipeline.dispose();
        } catch (err) {
          logger.warn("[embedder] Error disposing fallback CPU pipeline:", err);
        }
      }
      const error = new Error(`WebGPU initialization failed and CPU fallback warmup also failed: ${cpuWarmupErr?.message || "Unknown error"}`, { cause: cpuWarmupErr });
      return { success: false, error };
    }
    logger.info(`[embedder] CPU pipeline warmup successful. Ready with device: cpu`);
    return { success: true, pipeline: cpuPipeline, dummy };
  } catch (cpuLoadErr) {
    logger.error("[embedder] CPU pipeline load failed:", cpuLoadErr);
    const error = new Error(`WebGPU initialization failed and CPU fallback load also failed: ${cpuLoadErr instanceof Error ? cpuLoadErr.message : String(cpuLoadErr)}`, { cause: cpuLoadErr });
    return { success: false, error };
  }
}

// src/knowledge/embedder.ts
var Embedder = class {
  state = "idle";
  pipeline = null;
  initializingPromise = null;
  disposePromise = null;
  recoveryPromise = null;
  model;
  poolingMode;
  queryPrefix;
  dimension = null;
  initializationTimeoutMs;
  device;
  maxTokens;
  batchSize;
  charsPerToken;
  documentPrefix;
  stateManager;
  gpuLockHeld = false;
  originalDevice;
  useCache;
  idleTimer = null;
  IDLE_TIMEOUT_MS = 60 * 1e3;
  activeEmbeddings = 0;
  constructor(options) {
    this.model = options.model;
    this.poolingMode = options.pooling ?? "mean";
    this.queryPrefix = options.queryPrefix ?? "";
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 3e5;
    this.originalDevice = options.device ?? "webgpu";
    const isWebGpu = this.originalDevice === "webgpu";
    if (hasWebGpuFallback() && isWebGpu) {
      this.device = "cpu";
      logger.info("[embedder] Skipping WebGPU (previous fallback detected), using CPU directly");
    } else {
      this.device = this.originalDevice;
    }
    this.maxTokens = options.maxTokens ?? 512;
    this.batchSize = options.batchSize ?? 8;
    this.charsPerToken = options.charsPerToken ?? 4;
    this.documentPrefix = options.documentPrefix ?? "";
    this.stateManager = options.stateManager ?? null;
    this.useCache = options.useCache ?? true;
    registerGlobalEmbedder(this);
  }
  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.activeEmbeddings > 0) {
        logger.debug(`[embedder] Idle timeout but ${this.activeEmbeddings} embeddings active, rescheduling...`);
        this.resetIdleTimer();
        return;
      }
      if (this.state === "ready") {
        logger.info(`[embedder] Idle timeout reached (${this.IDLE_TIMEOUT_MS}ms), releasing GPU memory...`);
        this.dispose().catch((err) => logger.warn("[embedder] Failed to dispose on idle:", err));
      }
    }, this.IDLE_TIMEOUT_MS);
    if (this.idleTimer) safeUnref(this.idleTimer);
  }
  stopIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  async initialize() {
    if (this.state === "ready") return;
    if (this.state === "disposing") {
      throw new Error("Cannot initialize while disposing");
    }
    initializeONNXEnv();
    if (this.initializingPromise) {
      return this.initializingPromise;
    }
    this.state = "initializing";
    this.initializingPromise = this._initializeInternal();
    try {
      await this.initializingPromise;
      const currentState = this.state;
      if (currentState === "disposing") {
        logger.warn("[embedder] Initialization finished but embedder was disposed in the meantime.");
        return;
      }
      this.state = "ready";
    } catch (err) {
      this.state = "failed";
      throw err;
    } finally {
      this.initializingPromise = null;
    }
  }
  async _initializeInternal() {
    try {
      if (this.device === "webgpu") {
        const { acquired, shouldFallback } = await acquireGpuLock(this.stateManager);
        if (shouldFallback) {
          this.device = "cpu";
        } else if (acquired) {
          this.gpuLockHeld = true;
        }
      }
      if (this.device === "webgpu") {
        await initializeDawnWebGPU();
      }
      const cached = await isModelCached(this.model);
      logger.info(
        `[embedder] Loading model: ${this.model} (${cached ? "from local cache" : "downloading from HuggingFace"})...`
      );
      const env = getHFEnv();
      const prevAllowRemote = env.allowRemoteModels;
      if (cached) {
        env.allowRemoteModels = false;
      }
      try {
        const timeoutMs = cached ? 3e4 : this.initializationTimeoutMs;
        const { pipeline: loadedPipeline } = await loadPipelineWithTimeout(this.model, this.device, timeoutMs, this.useCache);
        this.pipeline = loadedPipeline;
        logger.info(`[embedder] Pipeline loaded (device: ${this.device})`);
      } catch (loadErr) {
        if (this.device === "webgpu" && isWebGpuDeviceError(loadErr)) {
          const result = await handleWebGPULoadError(
            loadErr,
            this.pipeline,
            this.stateManager,
            this.gpuLockHeld,
            this.model,
            this.initializationTimeoutMs,
            this.useCache
          );
          if (!result.success) {
            throw result.error;
          }
          this.pipeline = result.pipeline ?? null;
          this.device = "cpu";
          this.gpuLockHeld = false;
        } else {
          throw loadErr;
        }
      } finally {
        env.allowRemoteModels = prevAllowRemote;
      }
      let dummy;
      try {
        const warmupResult = await warmupPipeline(this.pipeline, this.poolingMode, this.useCache);
        if (!warmupResult.success) {
          throw warmupResult.error;
        }
        dummy = warmupResult.dummy;
      } catch (warmupErr) {
        if (this.device === "webgpu" && isWebGpuDeviceError(warmupErr)) {
          const result = await handleWebGPUWarmupError(
            warmupErr,
            this.pipeline,
            this.stateManager,
            this.gpuLockHeld,
            this.model,
            this.initializationTimeoutMs,
            this.useCache
          );
          if (!result.success) {
            throw result.error;
          }
          this.pipeline = result.pipeline ?? null;
          this.device = "cpu";
          this.gpuLockHeld = false;
          dummy = result.dummy;
        } else {
          throw warmupErr;
        }
      }
      this.dimension = dummy.dims[dummy.dims.length - 1] ?? null;
      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;
      logger.info(`[embedder] Ready. Dimension: ${this.dimension}, device: ${this.device}`);
    } catch (err) {
      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;
      if (this.pipeline) {
        try {
          if (typeof this.pipeline.dispose === "function") await this.pipeline.dispose();
        } catch (err2) {
          logger.warn("[embedder] Error disposing pipeline:", err2);
        }
        this.pipeline = null;
      }
      logger.error(`[embedder] Failed to initialize:`, err);
      throw err;
    }
  }
  isInitialized() {
    return this.state === "ready" && this.pipeline !== null && this.dimension !== null;
  }
  getDevice() {
    return this.device;
  }
  getOriginalDevice() {
    return this.originalDevice;
  }
  getDimension() {
    return this.dimension;
  }
  /**
   * Set the embedding dimension explicitly.
   * Used by KnowledgeStore when restoring dimension from an existing table schema
   * before the embedder has been fully warmed up.
   */
  setDimension(dim) {
    this.dimension = dim;
  }
  pipelineOpts() {
    return {
      pooling: this.poolingMode,
      normalize: true,
      ...this.useCache === false ? { use_cache: false } : {}
    };
  }
  truncateText(text) {
    const maxChars = this.maxTokens * this.charsPerToken;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }
  async embed(text) {
    await this.initialize();
    this.stopIdleTimer();
    this.activeEmbeddings++;
    const input = this.truncateText(this.queryPrefix ? this.queryPrefix + text : text);
    let lockAcquired = false;
    if (this.device === "webgpu" && this.stateManager) {
      lockAcquired = await this.stateManager.acquireGpuLock(void 0, 15e3);
      if (!lockAcquired) {
        logger.warn("[embedder] GPU per-call lock timeout after 15s \u2014 proceeding without lock");
      }
    }
    try {
      const output = await logger.runCapturingStderr(async () => {
        return await this.pipeline(input, this.pipelineOpts());
      });
      return output.data;
    } catch (err) {
      if (isWebGpuDeviceError(err)) {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch((err2) => {
            logger.warn("[embedder] Failed to release GPU lock:", err2);
          });
          lockAcquired = false;
        }
        await this.recoverToCpu();
        const output = await logger.runCapturingStderr(async () => {
          return await this.pipeline(input, this.pipelineOpts());
        });
        return output.data;
      }
      throw err;
    } finally {
      if (lockAcquired && this.stateManager) {
        await this.stateManager.releaseGpuLock().catch((err) => logger.warn("[embedder] Failed to release per-call GPU lock:", err));
      }
      this.activeEmbeddings--;
      this.resetIdleTimer();
    }
  }
  async embedMany(texts) {
    await this.initialize();
    this.stopIdleTimer();
    this.activeEmbeddings++;
    return metrics.measure("embedMany_latency", async () => {
      const dim = this.getDimension();
      if (dim === null) throw new Error("Embedder not initialized (dimension unknown)");
      const results = [];
      let lockAcquired = false;
      if (this.device === "webgpu" && this.stateManager) {
        lockAcquired = await this.stateManager.acquireGpuLock(void 0, 45e3);
        if (!lockAcquired) {
          logger.warn("[embedder] GPU batch lock timeout after 45s \u2014 proceeding without lock");
        }
      }
      try {
        for (let i = 0; i < texts.length; i += this.batchSize) {
          const batch = texts.slice(i, i + this.batchSize).map((t) => {
            const truncated = this.truncateText(t);
            return this.documentPrefix ? this.documentPrefix + truncated : truncated;
          });
          let output;
          try {
            output = await logger.runCapturingStderr(async () => {
              return await this.pipeline(batch, this.pipelineOpts());
            });
          } catch (err) {
            if (isWebGpuDeviceError(err)) {
              if (lockAcquired && this.stateManager) {
                await this.stateManager.releaseGpuLock().catch((err2) => {
                  logger.warn("[embedder] Failed to release GPU lock:", err2);
                });
                lockAcquired = false;
              }
              await this.recoverToCpu();
              output = await logger.runCapturingStderr(async () => {
                return await this.pipeline(batch, this.pipelineOpts());
              });
            } else {
              throw err;
            }
          }
          for (let j = 0; j < batch.length; j++) {
            results.push(output.data.slice(j * dim, (j + 1) * dim));
          }
        }
      } finally {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch((err) => {
            logger.warn("[embedder] Failed to release GPU lock:", err);
          });
        }
        this.activeEmbeddings--;
        this.resetIdleTimer();
      }
      return results;
    });
  }
  async recoverToCpu() {
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.state === "disposing" || this.state === "idle") {
      logger.debug("[embedder] recoverToCpu called during disposal/idle \u2014 skipping");
      return;
    }
    this.recoveryPromise = (async () => {
      logger.warn("[embedder] WebGPU device error detected during operation \u2014 falling back to CPU for the remainder of this session");
      markWebGpuFallback();
      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;
      this.state = "initializing";
      const maxWaitMs = 15e3;
      const startTime = Date.now();
      while (this.activeEmbeddings > 1 && Date.now() - startTime < maxWaitMs) {
        await new Promise((resolve5) => setTimeout(resolve5, 50));
      }
      if (this.pipeline) {
        try {
          if (typeof this.pipeline.dispose === "function") await this.pipeline.dispose();
        } catch (err) {
          logger.warn("[embedder] Error disposing pipeline:", err);
        }
        this.pipeline = null;
      }
      this.device = "cpu";
      this.initializingPromise = this._initializeInternal();
      try {
        await this.initializingPromise;
        this.state = "ready";
      } catch (e) {
        this.state = "failed";
        throw e;
      } finally {
        this.initializingPromise = null;
      }
      logger.warn("[embedder] CPU fallback recovery complete.");
    })();
    try {
      await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }
  async dispose() {
    if (this.state === "idle") return;
    this.stopIdleTimer();
    if (this.state === "disposing" && this.disposePromise) {
      return this.disposePromise;
    }
    this.state = "disposing";
    this.disposePromise = (async () => {
      const maxWaitMs = 5e3;
      const startTime = Date.now();
      while (this.activeEmbeddings > 0 && Date.now() - startTime < maxWaitMs) {
        await new Promise((resolve5) => setTimeout(resolve5, 50));
      }
      if (this.activeEmbeddings > 0) {
        logger.warn(`[embedder] Disposing with ${this.activeEmbeddings} active embeddings (timed out)`);
      }
      if (this.initializingPromise) {
        try {
          await this.initializingPromise;
        } catch (_e) {
        }
      }
      if (this.pipeline) {
        try {
          if (typeof this.pipeline.dispose === "function") {
            await this.pipeline.dispose();
          }
        } catch (err) {
          logger.warn("[embedder] Error during pipeline dispose:", err);
        }
        this.pipeline = null;
      }
      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      if (this.stateManager) {
        await this.stateManager.releaseGpuLock().catch((err) => {
          logger.warn("[embedder] Failed to release GPU lock during dispose:", err);
        });
      }
      this.gpuLockHeld = false;
      this.state = "idle";
      this.disposePromise = null;
      unregisterGlobalEmbedder();
    })();
    return this.disposePromise;
  }
};

// src/infrastructure/embedding/embedding-server.ts
import * as http4 from "node:http";
import * as path12 from "node:path";
var SerialQueue = class {
  running = false;
  tasks = [];
  maxDepth;
  timeoutMs;
  constructor(maxDepth = 200, timeoutMs = 12e4) {
    this.maxDepth = maxDepth;
    this.timeoutMs = timeoutMs;
  }
  enqueue(fn) {
    if (this.tasks.length >= this.maxDepth) {
      return Promise.reject(new Error(`SerialQueue at capacity (${this.maxDepth}). Embed request dropped.`));
    }
    return new Promise((resolve5, reject) => {
      this.tasks.push(async () => {
        let timer;
        const timeoutPromise = new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`SerialQueue: embed request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        });
        try {
          resolve5(await Promise.race([fn(), timeoutPromise]));
        } catch (e) {
          reject(e);
        } finally {
          if (timer !== void 0) clearTimeout(timer);
        }
      });
      if (!this.running) void this.pump();
    });
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift();
        if (task) {
          await task();
        }
      }
    } finally {
      this.running = false;
      if (this.tasks.length > 0) {
        void this.pump();
      }
    }
  }
};
var EmbeddingServer = class {
  constructor(embedder, stateManager, serverId) {
    this.embedder = embedder;
    this.stateManager = stateManager;
    this.serverId = serverId;
  }
  embedder;
  stateManager;
  serverId;
  server = null;
  leadershipTimer = null;
  consecutiveLeadershipMisses = 0;
  LEADERSHIP_MISS_THRESHOLD = 3;
  isShuttingDown = false;
  queue = new SerialQueue();
  // Dimension field — set by store.ts from table schema before embedder is warmed up,
  // and updated after embedder gets its own dimension at initialization.
  dimension = null;
  // ---- IEmbedder ----
  getDevice() {
    return this.embedder.isInitialized() ? this.embedder.getDevice() : "unknown";
  }
  getOriginalDevice() {
    return this.embedder.isInitialized() ? this.embedder.getOriginalDevice() : "unknown";
  }
  getDimension() {
    if (this.dimension !== null) return this.dimension;
    return this.embedder.isInitialized() ? this.embedder.getDimension() : null;
  }
  setDimension(dim) {
    this.dimension = dim;
  }
  isInitialized() {
    return this.embedder.isInitialized();
  }
  async embed(text) {
    return this.queue.enqueue(() => this.embedder.embed(text));
  }
  async embedMany(texts) {
    return this.queue.enqueue(() => this.embedder.embedMany(texts));
  }
  async dispose() {
    return this.shutdown();
  }
  // ---- Server lifecycle ----
  async startServer() {
    const diskChecker = new DiskSpaceChecker();
    const logFile = buildDefaultDebugLogPath("embedding-server");
    await captureStdio(
      logFile,
      () => diskChecker.checkDiskSpace(path12.dirname(logFile)),
      () => this.embedder.initialize(),
      this.serverId
    );
    this.dimension = this.embedder.getDimension();
    return new Promise((resolve5, reject) => {
      this.server = http4.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          logger.info(`[EmbeddingServer] Listening on http://127.0.0.1:${addr.port} (serverId: ${this.serverId})`);
          resolve5(addr.port);
        } else {
          reject(new Error("[EmbeddingServer] Failed to get server port"));
        }
      });
      this.server.on("error", (err) => {
        logger.error("[EmbeddingServer] Server error:", err);
        reject(err);
      });
    });
  }
  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    if (this.leadershipTimer) {
      clearTimeout(this.leadershipTimer);
      this.leadershipTimer = null;
    }
    try {
      const serverInfo = await this.stateManager.getEmbeddingServer();
      if (serverInfo?.serverId === this.serverId) {
        await this.stateManager.clearEmbeddingServer().catch((err) => {
          logger.warn("[EmbeddingServer] Failed to clear embedding server state:", err);
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not initialized") || msg.includes("State manager")) {
        logger.debug("[EmbeddingServer] State manager already disposed during shutdown, skipping registration cleanup.");
      } else {
        logger.warn("[EmbeddingServer] Could not read embedding server state during shutdown:", err);
      }
    }
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((resolve5) => {
        this.server.close(() => {
          this.server = null;
          resolve5();
        });
      }).catch(() => {
        this.server = null;
      });
    }
    await this.embedder.dispose().catch((err) => {
      if (this.isShuttingDown) {
        logger.debug("[EmbeddingServer] Error disposing embedder during shutdown (expected):", err);
      } else {
        logger.warn("[EmbeddingServer] Error disposing embedder:", err);
      }
    });
  }
  async getEmbeddingServerWithRetry(retries = 2, delay = 300) {
    for (let i = 0; i <= retries; i++) {
      const serverInfo = await this.stateManager.getEmbeddingServer();
      if (serverInfo) return serverInfo;
      if (i < retries) {
        await new Promise((resolve5) => setTimeout(resolve5, delay));
      }
    }
    return null;
  }
  // ---- Leadership check ----
  startLeadershipCheck() {
    const check = async () => {
      if (this.isShuttingDown) return;
      try {
        const serverInfo = await this.getEmbeddingServerWithRetry();
        if (!serverInfo) {
          logger.warn("[EmbeddingServer] Leadership check: no embedding server found in state after retries. Skipping check.");
          return;
        }
        if (serverInfo.serverId !== this.serverId) {
          this.consecutiveLeadershipMisses++;
          logger.warn(
            `[EmbeddingServer] Leadership check failed (${this.consecutiveLeadershipMisses}/${this.LEADERSHIP_MISS_THRESHOLD}) \u2014 expected ${this.serverId}, found ${serverInfo?.serverId ?? "none"}`
          );
          if (this.consecutiveLeadershipMisses >= this.LEADERSHIP_MISS_THRESHOLD) {
            logger.error("[EmbeddingServer] Leadership lost, shutting down...");
            void this.shutdown();
            return;
          }
        } else {
          if (this.consecutiveLeadershipMisses > 0) {
            logger.log(`[EmbeddingServer] Leadership confirmed, resetting miss counter from ${this.consecutiveLeadershipMisses}`);
            this.consecutiveLeadershipMisses = 0;
          }
        }
      } catch (err) {
        logger.warn("[EmbeddingServer] Leadership check error:", err);
      } finally {
        if (!this.isShuttingDown) {
          this.leadershipTimer = setTimeout(check, 3e4);
          if (this.leadershipTimer.unref) this.leadershipTimer.unref();
        }
      }
    };
    this.leadershipTimer = setTimeout(check, 3e4);
    if (this.leadershipTimer.unref) this.leadershipTimer.unref();
  }
  // ---- HTTP request handler ----
  async handleRequest(req, res) {
    const MAX_BODY_SIZE = 50 * 1024 * 1024;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        req.destroy(new Error("Payload too large"));
      }
    });
    req.on("error", (err) => {
      logger.error("[EmbeddingServer] Request stream error:", err);
    });
    await new Promise((resolve5) => {
      req.on("end", async () => {
        try {
          if (req.method === "GET" && req.url === "/health") {
            const payload = {
              status: "ok",
              device: this.getDevice(),
              dimension: this.getDimension()
            };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(payload));
            resolve5();
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end("Method Not Allowed");
            resolve5();
            return;
          }
          const data = JSON.parse(body);
          switch (req.url) {
            case "/embed": {
              const result = await this.queue.enqueue(() => this.embedder.embed(data.text));
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ data: Array.from(result) }));
              break;
            }
            case "/embedMany": {
              const results = await this.queue.enqueue(() => this.embedder.embedMany(data.texts));
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ results: results.map((r) => Array.from(r)) }));
              break;
            }
            default:
              res.writeHead(404);
              res.end("Not Found");
          }
        } catch (error) {
          logger.error("[EmbeddingServer] Error handling request:", error);
          let errorMessage = "Unknown error";
          if (error instanceof Error && error.message) {
            errorMessage = (error.message.split("\n")[0] || "").trim();
          } else if (typeof error === "string") {
            errorMessage = (error.split("\n")[0] || "").trim();
          }
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errorMessage }));
        }
        resolve5();
      });
    });
  }
};

// src/infrastructure/embedding/embedding-client.ts
import * as http5 from "node:http";
var EmbeddingClient = class {
  constructor(port, _device = "unknown") {
    this.port = port;
    this._device = _device;
    logger.log(`[EmbeddingClient] Connecting to embedding server at http://127.0.0.1:${port}`);
  }
  port;
  _device;
  // Public so store.ts can set the dimension from existing table schema
  // before the embedder has been fully warmed up (see Embedder.setDimension).
  dimension = null;
  // ---- IEmbedder ----
  getDevice() {
    return this._device;
  }
  getOriginalDevice() {
    return this._device;
  }
  getDimension() {
    return this.dimension;
  }
  setDimension(dim) {
    this.dimension = dim;
  }
  isInitialized() {
    return true;
  }
  async embed(text) {
    const resp = await this.request("/embed", { text });
    return new Float32Array(resp.data);
  }
  async embedMany(texts) {
    const resp = await this.request("/embedMany", { texts });
    return resp.results.map((r) => new Float32Array(r));
  }
  async dispose() {
  }
  // ---- Health ----
  async fetchHealth() {
    const result = await this.getRequest("/health");
    this._device = result.device;
    if (result.dimension !== null) {
      this.dimension = result.dimension;
    }
  }
  // ---- Internal HTTP helpers ----
  getRequest(path16) {
    return new Promise((resolve5, reject) => {
      const timeoutMs = 12e4;
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`[EmbeddingClient] GET ${path16} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const req = http5.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: path16,
          method: "GET"
        },
        (res) => {
          clearTimeout(timer);
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            if (resolved) return;
            resolved = true;
            try {
              const parsed = JSON.parse(body);
              if (res.statusCode !== 200) {
                reject(new Error(`[EmbeddingClient] GET ${path16} returned HTTP ${res.statusCode}`));
              } else {
                resolve5(parsed);
              }
            } catch (_e) {
              reject(new Error(`[EmbeddingClient] Failed to parse GET ${path16} response: ${body}`));
            }
          });
          res.on("error", (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            reject(new Error(`[EmbeddingClient] GET ${path16} response error: ${err.message}`));
          });
        }
      );
      req.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`[EmbeddingClient] GET ${path16} request error: ${err.message}`));
      });
      req.end();
    });
  }
  request(path16, data) {
    return new Promise((resolve5, reject) => {
      const timeoutMs = 12e4;
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`[EmbeddingClient] POST ${path16} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const body = JSON.stringify(data);
      const req = http5.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: path16,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
          }
        },
        (res) => {
          clearTimeout(timer);
          let responseBody = "";
          res.on("data", (chunk) => {
            responseBody += chunk;
          });
          res.on("end", () => {
            if (resolved) return;
            resolved = true;
            try {
              const parsed = JSON.parse(responseBody);
              if (res.statusCode !== 200) {
                const msg = parsed?.["error"];
                reject(new Error(typeof msg === "string" ? msg : `HTTP ${res.statusCode}`));
              } else {
                resolve5(parsed);
              }
            } catch (_e) {
              reject(new Error(`[EmbeddingClient] Failed to parse POST ${path16} response: ${responseBody}`));
            }
          });
          res.on("error", (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            reject(new Error(`[EmbeddingClient] POST ${path16} response error: ${err.message}`));
          });
        }
      );
      req.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`[EmbeddingClient] POST ${path16} request error: ${err.message}`));
      });
      req.write(body);
      req.end();
    });
  }
};

// src/infrastructure/embedding/embedding-factory.ts
async function isPortListening2(port, timeoutMs = 2e3) {
  return new Promise((resolve5) => {
    const socket = new net2.Socket();
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve5(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, "127.0.0.1");
  });
}
function isPidAliveStatic(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
var _embeddingInstance = null;
var _embeddingInitPromise = null;
var _cachedModel = null;
var _cachedDevice = null;
async function getEmbedder(config) {
  const cfg = config ?? getConfig();
  if (_embeddingInstance) {
    if (_cachedModel === cfg.EMBEDDING_MODEL && _cachedDevice === cfg.EMBEDDING_DEVICE) {
      return _embeddingInstance;
    }
    logger.info(`[EmbeddingFactory] Configuration change detected (${_cachedModel} on ${_cachedDevice} -> ${cfg.EMBEDDING_MODEL} on ${cfg.EMBEDDING_DEVICE}). Disposing stale instance.`);
    await _embeddingInstance.dispose?.();
    _embeddingInstance = null;
  }
  if (_embeddingInitPromise) return _embeddingInitPromise;
  let p;
  const init = async () => {
    const serverId = crypto6.randomUUID();
    const stateManager = await getService(ServiceNames.STATE_MANAGER);
    let iAmCandidate = false;
    let fastPathPort = null;
    await stateManager.updateState(async (state) => {
      if (state.embeddingServer) {
        const alive = isPidAliveStatic(state.embeddingServer.pid);
        if (alive) {
          fastPathPort = state.embeddingServer.port;
          return state;
        }
        delete state.embeddingServer;
      }
      state.embeddingServer = { port: -1, pid: process.pid, serverId };
      iAmCandidate = true;
      return state;
    });
    if (!iAmCandidate) {
      const POLL_INTERVAL_MS = 500;
      const POLL_TIMEOUT_MS = 12e4;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      logger.info(`[EmbeddingFactory] Another process is initializing (port=${fastPathPort}), waiting...`);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const info = await stateManager.getEmbeddingServer();
        if (!info) {
          break;
        }
        if (!isPidAliveStatic(info.pid)) {
          await stateManager.clearEmbeddingServer().catch((err) => logger.debug("Swallowed clear embedding server error:", err));
          break;
        }
        if (info.port > 0) {
          const portOk = await isPortListening2(info.port);
          if (portOk) {
            logger.info(`[EmbeddingFactory] Connecting to embedding server on port ${info.port}`);
            const client = new EmbeddingClient(info.port);
            await client.fetchHealth();
            _embeddingInstance = client;
            _cachedModel = cfg.EMBEDDING_MODEL;
            _cachedDevice = cfg.EMBEDDING_DEVICE;
            return client;
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const secondCheck = await isPortListening2(info.port);
          if (!secondCheck) {
            logger.warn(`[EmbeddingFactory] Registered port ${info.port} is unreachable after two checks \u2014 clearing stale state`);
            await stateManager.clearEmbeddingServer().catch((err) => logger.debug("Swallowed clear embedding server error:", err));
            break;
          }
        }
      }
      logger.warn("[EmbeddingFactory] Wait for embedding leader timed out or leader died, retrying...");
      _embeddingInitPromise = null;
      return getEmbedder(cfg);
    }
    const modelCfg = getModelEmbedderConfig(cfg.EMBEDDING_MODEL);
    const embedder = new Embedder({
      model: cfg.EMBEDDING_MODEL,
      pooling: modelCfg.pooling,
      queryPrefix: modelCfg.queryPrefix,
      initializationTimeoutMs: cfg.EMBEDDING_MODEL_INIT_TIMEOUT_MS,
      device: cfg.EMBEDDING_DEVICE,
      maxTokens: modelCfg.maxTokens,
      batchSize: modelCfg.batchSize,
      charsPerToken: modelCfg.charsPerToken,
      documentPrefix: modelCfg.documentPrefix,
      stateManager,
      useCache: modelCfg.useCache
    });
    const server = new EmbeddingServer(embedder, stateManager, serverId);
    let port;
    try {
      port = await server.startServer();
    } catch (err) {
      await stateManager.clearEmbeddingServer().catch((err2) => logger.debug("Swallowed clear embedding server error:", err2));
      throw err;
    }
    await stateManager.updateState(async (state) => {
      if (state.embeddingServer?.serverId === serverId) {
        state.embeddingServer.port = port;
      }
      return state;
    });
    logger.info(`[EmbeddingFactory] Won election, serving as embedding leader on port ${port} (PID ${process.pid})`);
    server.startLeadershipCheck();
    _embeddingInstance = server;
    _cachedModel = cfg.EMBEDDING_MODEL;
    _cachedDevice = cfg.EMBEDDING_DEVICE;
    return server;
  };
  p = init();
  _embeddingInitPromise = p;
  p.then((r) => {
    _embeddingInstance = r;
    _embeddingInitPromise = null;
  }).catch(() => {
    _embeddingInitPromise = null;
  });
  return p;
}
async function clearEmbeddingInstance() {
  if (_embeddingInstance) {
    try {
      await _embeddingInstance.dispose?.();
    } catch (err) {
      logger.warn("[EmbeddingFactory] Error disposing old embedding instance:", err);
    }
  }
  _embeddingInstance = null;
  _embeddingInitPromise = null;
  _cachedModel = null;
  _cachedDevice = null;
}

// src/infrastructure/knowledge-store-service.ts
var KnowledgeStoreService = class {
  name = ServiceNames.KNOWLEDGE_STORE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  // Knowledge store components
  _embedder = null;
  _store = null;
  _writerQueue = null;
  _initLock = null;
  _cwd = process.cwd();
  // Initialization promise to prevent concurrent initialization
  _initializationPromise = null;
  async initialize(ctx) {
    const newCwd = ctx?.cwd || process.cwd();
    if ((this.lifecycle === "initialized" /* INITIALIZED */ || this.lifecycle === "disabled" /* DISABLED */) && this._cwd === newCwd) {
      return;
    }
    if ((this.lifecycle === "initialized" /* INITIALIZED */ || this.lifecycle === "disabled" /* DISABLED */) && this._cwd !== newCwd) {
      logger.log(`[KnowledgeStoreService] CWD changed from ${this._cwd} to ${newCwd}. Re-initializing store...`);
      await this.dispose();
    }
    if (this._initializationPromise && this._cwd === newCwd) {
      return this._initializationPromise;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    logger.debug("[KnowledgeStoreService] Initializing...");
    this._initializationPromise = (async () => {
      try {
        this._cwd = ctx?.cwd || process.cwd();
        const config = ctx?.config || getConfig(this._cwd);
        const embedderFactory = () => getEmbedder(config);
        const reconnectFactory = async () => {
          clearEmbeddingInstance();
          return getEmbedder(config);
        };
        const container = tryGetServiceContainerFromCtx(ctx);
        const pathConfig = await getService(ServiceNames.STATE_PATH_CONFIGURATION, void 0, container);
        const lockPath = path13.join(pathConfig.getLockDirPath(), "knowledge-store-init.lock");
        if (!this._initLock) {
          this._initLock = new FileLockService({
            lockFilePath: lockPath,
            lockStaleThreshold: 6e4
          });
          await this._initLock.initialize();
        }
        const initLock = this._initLock;
        let components;
        try {
          components = await initLock.withLock(async () => {
            return createKnowledgeStoreComponents(
              embedderFactory,
              reconnectFactory,
              (fn) => initLock.withLock(fn),
              config,
              this._cwd
            );
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (errorMsg.includes("Generic memory error") && errorMsg.includes("Invalid range 0..0")) {
            logger.warn("[KnowledgeStoreService] Detected corrupted Knowledge Store. Clearing and retrying initialization...");
            try {
              await forceDeleteKnowledgeStore(config, this._cwd);
              components = await initLock.withLock(async () => {
                return createKnowledgeStoreComponents(
                  embedderFactory,
                  reconnectFactory,
                  (fn) => initLock.withLock(fn),
                  config,
                  this._cwd
                );
              });
            } catch (retryErr) {
              logger.error("[KnowledgeStoreService] Retry after clearing store failed:", retryErr);
              throw retryErr;
            }
          } else {
            throw err;
          }
        }
        if (!components) {
          logger.debug("[KnowledgeStoreService] Knowledge store is disabled. Setting lifecycle to DISABLED.");
          this.lifecycle = "disabled" /* DISABLED */;
          this._embedder = null;
          this._store = null;
          this._writerQueue = null;
          return;
        }
        this._embedder = components.embedder;
        this._store = components.store;
        this._writerQueue = components.writerQueue;
        const originalDevice = this._embedder?.getOriginalDevice() ?? "(unknown)";
        const actualDevice = this._embedder?.isInitialized() ? this._embedder.getDevice() ?? "(deferred)" : "(deferred)";
        logger.debug(`[KnowledgeStoreService] Initialized. Device: ${actualDevice} (original: ${originalDevice})`);
        this.lifecycle = "initialized" /* INITIALIZED */;
      } catch (err) {
        logger.error("[KnowledgeStoreService] Initialization failed:", err);
        this.lifecycle = "uninitialized" /* UNINITIALIZED */;
        throw err;
      } finally {
        this._initializationPromise = null;
      }
    })();
    return this._initializationPromise;
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */ || this.lifecycle === "uninitialized" /* UNINITIALIZED */) {
      return;
    }
    this.lifecycle = "disposing" /* DISPOSING */;
    logger.debug("[KnowledgeStoreService] Disposing...");
    try {
      if (this._writerQueue) {
        await this._writerQueue.dispose?.();
      }
      if (this._store) {
        await this._store.close();
      }
      if (this._embedder) {
        await this._embedder.dispose?.();
      }
      if (this._initLock) {
        await this._initLock.dispose();
      }
      this._embedder = null;
      this._store = null;
      this._writerQueue = null;
      this._initLock = null;
      logger.debug("[KnowledgeStoreService] Disposed");
    } catch (err) {
      logger.error("[KnowledgeStoreService] Error during disposal:", err);
    } finally {
      this.lifecycle = "disposed" /* DISPOSED */;
    }
  }
  /**
   * Check if the knowledge store is ready
   */
  isReady() {
    return this._embedder !== null && this._store !== null && this._writerQueue !== null;
  }
  /**
   * Check if the embedder is initialized
   */
  isEmbedderInitialized() {
    return this._embedder !== null && this._embedder.isInitialized();
  }
  /**
   * Get the embedder instance
   */
  async getEmbedder() {
    await this.initialize();
    if (this.lifecycle === "disabled" /* DISABLED */) {
      return null;
    }
    if (!this._embedder) {
      throw new Error("[KnowledgeStoreService] Embedder not initialized");
    }
    return this._embedder;
  }
  /**
   * Get the knowledge store instance
   */
  async getStore() {
    await this.initialize();
    if (this.lifecycle === "disabled" /* DISABLED */) {
      return null;
    }
    if (!this._store) {
      throw new Error("[KnowledgeStoreService] Store not initialized");
    }
    return this._store;
  }
  /**
   * Get the writer queue instance
   */
  async getWriterQueue() {
    await this.initialize();
    if (this.lifecycle === "disabled" /* DISABLED */) {
      return null;
    }
    if (!this._writerQueue) {
      throw new Error("[KnowledgeStoreService] Writer queue not initialized");
    }
    return this._writerQueue;
  }
  /**
   * Get the embedder device
   */
  getDevice() {
    return this._embedder?.getDevice() ?? null;
  }
  /**
   * Get the original device preference
   */
  getOriginalDevice() {
    return this._embedder?.getOriginalDevice() ?? null;
  }
  /**
   * Embed a text string
   */
  async embed(text) {
    const embedder = await this.getEmbedder();
    if (!embedder) {
      throw new Error("[KnowledgeStoreService] Embedder not available (store disabled)");
    }
    const result = await embedder.embed(text);
    return Array.from(result);
  }
  /**
   * Embed multiple text strings
   */
  async embedMany(texts) {
    const embedder = await this.getEmbedder();
    if (!embedder) {
      throw new Error("[KnowledgeStoreService] Embedder not available (store disabled)");
    }
    const results = await embedder.embedMany(texts);
    return results.map((r) => Array.from(r));
  }
  /**
   * Clear the knowledge store entries for the current scope.
   *
   * In 'global' mode, clears only global entries (is_global = true).
   * In 'project' mode, clears only this workspace's entries.
   * In 'none' mode, no-op (store is disabled).
   */
  async clear() {
    const config = getConfig(this._cwd);
    if (config.KNOWLEDGE_STORE_MODE === "global") {
      await this.clearGlobal();
    } else if (config.KNOWLEDGE_STORE_MODE === "project") {
      await this.clearLocal();
    }
  }
  /**
   * Clear only local project entries (workspace-scoped, NOT global).
   * Entries that are both local AND global are left alone — use clearGlobal
   * for those.
   */
  async clearLocal() {
    const store = await this.getStore();
    if (!store) return;
    const workspace = normalizeWorkspacePath(this._cwd);
    const escaped = workspace.replace(/'/g, "''");
    await store.clear(`workspace = '${escaped}'`);
  }
  /**
   * Clear only global entries (cross-project, visible to all workspaces).
   */
  async clearGlobal() {
    const store = await this.getStore();
    if (store) {
      await store.clear("is_global = true");
    }
  }
  /**
   * Export the knowledge store for web use.
   */
  async exportForWeb(outputPath) {
    const store = await this.getStore();
    if (store) {
      await store.exportForWeb(outputPath);
    }
  }
  /**
   * Get supported models
   */
  getSupportedModels() {
    return SUPPORTED_MODELS;
  }
  /**
   * Get model embedder configuration
   */
  getModelEmbedderConfig(modelId) {
    return getModelEmbedderConfig(modelId);
  }
  /**
   * Get model chunk configuration
   */
  getModelChunkConfig(modelId) {
    return getModelChunkConfig(modelId);
  }
};

// src/infrastructure/metrics-service.ts
var MetricsService = class {
  name = ServiceNames.METRICS;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) return;
    this.lifecycle = "initializing" /* INITIALIZING */;
    logger.debug("[MetricsService] Initializing...");
    this.lifecycle = "initialized" /* INITIALIZED */;
    logger.debug("[MetricsService] Initialized");
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) return;
    this.lifecycle = "disposing" /* DISPOSING */;
    logger.debug("[MetricsService] Disposing...");
    this.lifecycle = "disposed" /* DISPOSED */;
    logger.debug("[MetricsService] Disposed");
  }
  increment(name, value = 1, labels) {
    metrics.increment(name, value, labels);
  }
  setGauge(name, value, labels) {
    metrics.setGauge(name, value, labels);
  }
  observe(name, value, labels) {
    metrics.observe(name, value, labels);
  }
  async measure(name, action, labels) {
    return metrics.measure(name, action, labels);
  }
  getSnapshot() {
    return metrics.getSessionSnapshot();
  }
  clear() {
    metrics.clearSession();
  }
  getCounters() {
    return metrics.getSessionSnapshot().counters ?? {};
  }
  getGauges() {
    return metrics.getSessionSnapshot().gauges ?? {};
  }
  getHistograms() {
    return metrics.getSessionSnapshot().histograms ?? {};
  }
  getCounter(name, labels) {
    const counters = this.getCounters();
    if (!labels) return counters[name] ?? 0;
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map((k) => `${k}="${labels[k]}"`).join(",");
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return counters[key] ?? 0;
  }
  getGauge(name, labels) {
    const gauges = this.getGauges();
    if (!labels) return gauges[name] ?? 0;
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map((k) => `${k}="${labels[k]}"`).join(",");
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return gauges[key] ?? 0;
  }
  getHistogramStats(name, labels) {
    const histograms = this.getHistograms();
    if (!labels) return histograms[name] ?? null;
    const keys = Object.keys(labels).sort();
    const labelStr = keys.map((k) => `${k}="${labels[k]}"`).join(",");
    const key = labelStr ? `${name}{${labelStr}}` : name;
    return histograms[key] ?? null;
  }
  exportPrometheus() {
    const snapshot = metrics.getSessionSnapshot();
    const lines = [];
    for (const [key, value] of Object.entries(snapshot.counters ?? {})) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of Object.entries(snapshot.gauges ?? {})) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, s] of Object.entries(snapshot.histograms ?? {})) {
      lines.push(`${key}_count ${s.count}`);
      lines.push(`${key}_sum ${(s.avg * s.count).toFixed(2)}`);
      lines.push(`${key}_min ${s.min}`);
      lines.push(`${key}_max ${s.max}`);
      lines.push(`${key}_avg ${s.avg.toFixed(2)}`);
      lines.push(`${key}_p50 ${s.p50.toFixed(2)}`);
      lines.push(`${key}_p90 ${s.p90.toFixed(2)}`);
      lines.push(`${key}_p95 ${s.p95.toFixed(2)}`);
      lines.push(`${key}_p99 ${s.p99.toFixed(2)}`);
    }
    return lines.join("\n");
  }
};

// src/infrastructure/process-lifecycle-service.ts
import * as fs11 from "node:fs/promises";
import { execFile } from "node:child_process";
var ProcessLifecycleService = class {
  name = ServiceNames.PROCESS_LIFECYCLE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  cachedStartTime = null;
  async initialize() {
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
  }
  /**
   * Get the start time of a process (Linux only).
   * Combined with PID, this provides a globally unique identifier for a process
   * even if PIDs are recycled by the OS.
   * 
   * @param pid Process ID
   * @returns Start time identifier (Linux: jiffies; cross-platform: epoch seconds) or null
   */
  async getProcessStartTime(pid) {
    if (process.platform === "linux") {
      try {
        const stat4 = await fs11.readFile(`/proc/${pid}/stat`, "utf8");
        const lastParenIndex = stat4.lastIndexOf(")");
        if (lastParenIndex === -1) return null;
        const partsAfterName = stat4.substring(lastParenIndex + 2).trim().split(/\s+/);
        const startTimeStr = partsAfterName[19];
        return startTimeStr ? parseInt(startTimeStr, 10) : null;
      } catch (_err) {
        return null;
      }
    }
    if (process.platform === "win32") {
      try {
        const output = await new Promise((resolve5, reject) => {
          const child = execFile(
            "powershell",
            ["-NoProfile", "-Command", `[Math]::Floor(([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeSeconds())`],
            { encoding: "utf8", timeout: 5e3 },
            (err, stdout) => err ? reject(err) : resolve5(stdout)
          );
          child.unref?.();
        });
        if (!output || !output.trim()) return null;
        const startTime = parseInt(output.trim(), 10);
        return isNaN(startTime) ? null : startTime;
      } catch {
        return null;
      }
    }
    try {
      const output = await new Promise((resolve5, reject) => {
        const child = execFile(
          "ps",
          ["-o", "etimes=", "-p", String(pid)],
          { encoding: "utf8", timeout: 3e3 },
          (err, stdout) => err ? reject(err) : resolve5(stdout)
        );
        child.unref?.();
      });
      if (!output || !output.trim()) return null;
      const elapsedSec = parseInt(output.trim(), 10);
      if (isNaN(elapsedSec)) return null;
      return Math.floor(Date.now() / 1e3) - elapsedSec;
    } catch {
      return null;
    }
  }
  /**
   * Get the start time for the current process
   */
  async getCurrentProcessStartTime() {
    if (this.cachedStartTime !== null) return this.cachedStartTime;
    this.cachedStartTime = await this.getProcessStartTime(process.pid);
    return this.cachedStartTime;
  }
  /**
   * Check if a process is alive by sending signal 0.
   * Optionally verifies that the start time matches to prevent PID reuse races.
   *
   * @param pid Process ID to check
   * @param expectedStartTime Optional start time to verify (from getProcessStartTime)
   * @returns true if process is alive (and matches start time if provided)
   */
  async isProcessAlive(pid, expectedStartTime) {
    try {
      process.kill(pid, 0);
      if (expectedStartTime !== void 0 && expectedStartTime !== null) {
        const actualStartTime = await this.getProcessStartTime(pid);
        if (actualStartTime === null) {
          return false;
        }
        return actualStartTime === expectedStartTime;
      }
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Sync version of basic liveness check (no start-time verification)
   */
  isProcessAliveSync(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Check if a process is alive with optional scheduler ID verification.
   * This method is designed to work with state that contains scheduler information.
   *
   * @param pid Process ID to check
   * @param expectedSchedulerId Optional scheduler ID to verify
   * @param getState Function to retrieve current state for scheduler ID verification
   * @param skipLock If true, skip locking when retrieving state (useful to prevent deadlocks)
   * @returns true if process is alive and (if provided) matches expected scheduler ID
   */
  async isPidAlive(pid, expectedSchedulerId, options) {
    const alive = await this.isProcessAlive(pid, options?.expectedStartTime);
    if (!alive) return false;
    if (expectedSchedulerId && options?.getState && options?.getSchedulerIdFromState) {
      const state = await options.getState(options.skipLock);
      const schedulerId = options.getSchedulerIdFromState(state);
      return schedulerId === expectedSchedulerId;
    }
    return true;
  }
  /**
   * Get the current process ID
   */
  getCurrentPid() {
    return process.pid;
  }
  /**
   * Wait for a process to terminate
   *
   * @param pid Process ID to wait for
   * @param timeoutMs Maximum time to wait in milliseconds
   * @param checkIntervalMs Interval between checks in milliseconds
   * @param expectedStartTime Optional start time to verify
   * @returns true if process terminated, false if timeout
   */
  async waitForProcessTermination(pid, timeoutMs = 5e3, checkIntervalMs = 100, expectedStartTime) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!await this.isProcessAlive(pid, expectedStartTime)) {
        return true;
      }
      await this.sleep(checkIntervalMs);
    }
    return false;
  }
  /**
   * Check if the current process is the one with the given PID
   *
   * @param pid Process ID to check
   * @returns true if the current process has the given PID
   */
  isCurrentProcess(pid) {
    return process.pid === pid;
  }
  /**
   * Get process information (platform-specific)
   *
   * @param pid Process ID to get information for
   * @returns Process information or null if not available
   */
  async getProcessInfo(pid) {
    const startTime = await this.getProcessStartTime(pid);
    const alive = await this.isProcessAlive(pid, startTime);
    return {
      pid,
      alive,
      startTime
    };
  }
  /**
   * Sleep for a specified number of milliseconds
   * @param ms The number of milliseconds to sleep
   */
  sleep(ms) {
    return new Promise((resolve5) => setTimeout(resolve5, ms));
  }
};

// src/infrastructure/gpu-resource-service.ts
var GPUResourceService = class {
  name = ServiceNames.GPU_RESOURCE_SERVICE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  processLifecycle = null;
  gpuLockStaleThresholdMs = 1e3 * 60 * 5;
  // 5 minutes default
  constructor(options) {
    if (options) {
      this.processLifecycle = options.processLifecycle;
      if (options.gpuLockStaleThresholdMs) {
        this.gpuLockStaleThresholdMs = options.gpuLockStaleThresholdMs;
      }
    }
  }
  async initialize(ctx) {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    logger.debug("[GPUResourceService] Initializing...");
    const container = tryGetServiceContainerFromCtx(ctx);
    if (!this.processLifecycle) {
      this.processLifecycle = await getService(ServiceNames.PROCESS_LIFECYCLE, ctx, container);
    }
    this.lifecycle = "initialized" /* INITIALIZED */;
    logger.debug("[GPUResourceService] Initialized");
  }
  async dispose() {
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  /**
   * Internal logic to acquire the GPU lock
   */
  async performAcquireGpuLock(updateState, sessionId, timeoutMs) {
    const start = Date.now();
    const pid = this.processLifecycle.getCurrentPid();
    const startTime = await this.processLifecycle.getCurrentProcessStartTime();
    while (true) {
      let acquired = false;
      let shouldRetry = false;
      await updateState(async (state) => {
        const currentOwner = state.gpuOwner;
        if (!currentOwner) {
          state.gpuOwner = { pid, startTime: startTime ?? void 0, startedAt: Date.now(), sessionId };
          acquired = true;
          return state;
        }
        if (currentOwner.pid === pid && currentOwner.startTime === (startTime ?? void 0)) {
          state.gpuOwner = { ...currentOwner, startedAt: Date.now(), sessionId: sessionId || currentOwner.sessionId };
          acquired = true;
          return state;
        }
        const isAlive = await this.processLifecycle.isProcessAlive(currentOwner.pid, currentOwner.startTime);
        if (!isAlive) {
          logger.warn(`[GPUResourceService] Reclaiming GPU lock from dead process ${currentOwner.pid}`);
          state.gpuOwner = { pid, startTime: startTime ?? void 0, startedAt: Date.now(), sessionId };
          acquired = true;
          return state;
        }
        const age = Date.now() - currentOwner.startedAt;
        if (age > this.gpuLockStaleThresholdMs) {
          logger.warn(`[GPUResourceService] Reclaiming stale GPU lock from process ${currentOwner.pid} (age: ${age}ms)`);
          state.gpuOwner = { pid, startTime: startTime ?? void 0, startedAt: Date.now(), sessionId };
          acquired = true;
          return state;
        }
        if (timeoutMs && Date.now() - start < timeoutMs) {
          shouldRetry = true;
        }
        return state;
      });
      if (acquired) return true;
      if (!shouldRetry) return false;
      await new Promise((resolve5) => setTimeout(resolve5, 50));
    }
  }
  /**
   * Acquire the global GPU lock
   */
  async acquireGpuLock(sessionId, timeoutMs, ctx) {
    if (typeof sessionId === "function") {
      const updateState = sessionId;
      const actualSessionId = timeoutMs;
      const actualTimeoutMs = ctx;
      return this.performAcquireGpuLock(updateState, actualSessionId, actualTimeoutMs);
    }
    const container = tryGetServiceContainerFromCtx(ctx);
    const stateManager = await getService(ServiceNames.STATE_MANAGER, ctx, container);
    return stateManager.acquireGpuLock(sessionId, timeoutMs);
  }
  /**
   * Release the global GPU lock
   */
  async releaseGpuLock(pid, ctx) {
    if (typeof pid === "function") {
      const updateState = pid;
      const actualPid = ctx;
      const targetPid = actualPid || this.processLifecycle.getCurrentPid();
      await updateState(async (state) => {
        if (state.gpuOwner && state.gpuOwner.pid === targetPid) {
          delete state.gpuOwner;
        }
        return state;
      });
      return;
    }
    const container = tryGetServiceContainerFromCtx(ctx);
    const stateManager = await getService(ServiceNames.STATE_MANAGER, ctx, container);
    return stateManager.releaseGpuLock(pid);
  }
};

// src/infrastructure/state/state-session-manager.ts
var StateSessionManager = class {
  constructor(processLifecycle) {
    this.processLifecycle = processLifecycle;
  }
  processLifecycle;
  name = ServiceNames.STATE_SESSION_MANAGER;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  /**
   * Add a new session to the state
   * @param state The current state
   * @param sessionId The session ID to add
   * @param pid The process ID
   * @param startTime Optional process start time (Linux)
   * @returns Updated state with new session
   */
  addSession(state, sessionId, pid, startTime) {
    state.sessions[sessionId] = {
      pid,
      startTime: startTime ?? void 0,
      lastSeen: Date.now(),
      connectedAt: Date.now()
    };
    return state;
  }
  /**
   * Remove a session from the state
   * @param state The current state
   * @param sessionId The session ID to remove
   * @returns Updated state without the session
   */
  removeSession(state, sessionId) {
    if (state.sessions[sessionId] !== void 0) {
      delete state.sessions[sessionId];
    }
    return state;
  }
  /**
   * Update the heartbeat timestamp for a session
   * @param state The current state
   * @param sessionId The session ID to update
   * @returns Updated state with updated heartbeat
   */
  updateHeartbeat(state, sessionId) {
    const session = state.sessions[sessionId];
    if (session !== void 0) {
      session.lastSeen = Date.now();
    }
    return state;
  }
  /**
   * Clean up stale sessions based on timeout and process liveness
   * @param state The current state
   * @param timeoutMs Timeout in milliseconds for session staleness
   * @returns Number of sessions to remove and their lastSeen timestamps
   */
  async classifyStaleSessions(state, timeoutMs) {
    const now = Date.now();
    const sessionsToRemove = /* @__PURE__ */ new Map();
    for (const [sessionId, sessionInfo] of Object.entries(state.sessions)) {
      const lastSeenAge = now - sessionInfo.lastSeen;
      if (lastSeenAge > timeoutMs) {
        sessionsToRemove.set(sessionId, sessionInfo.lastSeen);
        continue;
      }
      const isAlive = await this.processLifecycle.isProcessAlive(sessionInfo.pid, sessionInfo.startTime);
      if (!isAlive) {
        sessionsToRemove.set(sessionId, sessionInfo.lastSeen);
      }
    }
    return sessionsToRemove;
  }
  /**
   * Remove stale sessions from state
   * @param state The current state
   * @param sessionsToRemove Map of session IDs to their lastSeen timestamps
   * @returns Updated state with stale sessions removed
   */
  removeStaleSessions(state, sessionsToRemove) {
    for (const [sessionId, lastSeenAtClassify] of sessionsToRemove) {
      const current = state.sessions[sessionId];
      if (current && current.lastSeen === lastSeenAtClassify) {
        delete state.sessions[sessionId];
      }
    }
    return state;
  }
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposed" /* DISPOSED */;
  }
};

// src/infrastructure/state/state-browser-manager.ts
var StateBrowserManager = class {
  name = ServiceNames.STATE_BROWSER_MANAGER;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  /**
   * Get the current browser server information
   * @param state The current state
   * @returns Browser server info or null if not set
   */
  getBrowserServer(state) {
    return state.browserServer ?? null;
  }
  /**
   * Set the current browser server information
   * @param state The current state
   * @param port The browser server port
   * @param pid The browser server process ID
   * @param schedulerId Optional scheduler ID
   * @param startTime Optional process start time
   * @returns Updated state with browser server info
   */
  setBrowserServer(state, port, pid, schedulerId, startTime, authSecret) {
    state.browserServer = { port, pid, schedulerId, startTime: startTime ?? void 0, authSecret };
    return state;
  }
  /**
   * Clear the browser server information
   * @param state The current state
   * @returns Updated state without browser server info
   */
  clearBrowserServer(state) {
    delete state.browserServer;
    return state;
  }
  /**
   * Check if a process is alive and optionally verify scheduler ID
   * @param state The current state
   * @param pid The process ID to check
   * @param expectedSchedulerId Optional scheduler ID to verify
   * @param isPidAlive Function to check if PID is alive
   * @returns true if process is alive and scheduler ID matches (if provided)
   */
  isPidAlive(state, pid, expectedSchedulerId, isPidAlive) {
    const alive = isPidAlive(pid);
    if (!alive) return false;
    if (expectedSchedulerId) {
      return state.browserServer?.schedulerId === expectedSchedulerId;
    }
    return true;
  }
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposed" /* DISPOSED */;
  }
};

// src/infrastructure/state/state-metrics.ts
var StateMetricsCollector = class {
  name = ServiceNames.STATE_METRICS_COLLECTOR;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  /**
   * Get metrics about the current state
   * @param state The current state
   * @returns StateMetrics object with various statistics
   */
  getMetrics(state) {
    const now = Date.now();
    const sessionEntries = Object.entries(state.sessions);
    const totalSessions = sessionEntries.length;
    let activeSessions = 0;
    let oldestSession = null;
    let newestSession = null;
    let lastHeartbeatAge = null;
    for (const [, sessionInfo] of sessionEntries) {
      if (now - sessionInfo.lastSeen < 3e5) {
        activeSessions++;
      }
      if (oldestSession === null || sessionInfo.connectedAt < oldestSession) {
        oldestSession = sessionInfo.connectedAt;
      }
      if (newestSession === null || sessionInfo.connectedAt > newestSession) {
        newestSession = sessionInfo.connectedAt;
      }
      const heartbeatAge = now - sessionInfo.lastSeen;
      if (lastHeartbeatAge === null || heartbeatAge > lastHeartbeatAge) {
        lastHeartbeatAge = heartbeatAge;
      }
    }
    let containerUptime = null;
    if (state.containerId !== "") {
      containerUptime = now - state.lastUpdated;
    }
    metrics.setGauge("state_sessions_total", totalSessions);
    metrics.setGauge("state_sessions_active", activeSessions);
    metrics.setGauge("state_browser_server_exists", state.browserServer ? 1 : 0);
    metrics.setGauge("state_gpu_lock_owner_exists", state.gpuOwner ? 1 : 0);
    return {
      totalSessions,
      activeSessions,
      oldestSession,
      newestSession,
      containerUptime,
      lastHeartbeatAge
    };
  }
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposed" /* DISPOSED */;
  }
};

// src/infrastructure/types/state-types.ts
import { Type as Type3 } from "typebox";
var SessionInfoSchema = Type3.Object({
  pid: Type3.Number(),
  startTime: Type3.Optional(Type3.Number()),
  lastSeen: Type3.Number(),
  connectedAt: Type3.Number()
});
var SingletonStateSchema = Type3.Object({
  version: Type3.Literal(1),
  containerId: Type3.String(),
  containerName: Type3.String(),
  port: Type3.Number(),
  sessions: Type3.Record(Type3.String(), SessionInfoSchema),
  lastUpdated: Type3.Number(),
  browserServer: Type3.Optional(Type3.Object({
    port: Type3.Number(),
    pid: Type3.Number(),
    startTime: Type3.Optional(Type3.Number()),
    schedulerId: Type3.Optional(Type3.String()),
    authSecret: Type3.Optional(Type3.String())
  })),
  schedulerVersion: Type3.Optional(Type3.String()),
  gpuOwner: Type3.Optional(Type3.Object({
    pid: Type3.Number(),
    startTime: Type3.Optional(Type3.Number()),
    startedAt: Type3.Number(),
    sessionId: Type3.Optional(Type3.String())
  })),
  embeddingServer: Type3.Optional(Type3.Object({
    port: Type3.Number(),
    pid: Type3.Number(),
    startTime: Type3.Optional(Type3.Number()),
    serverId: Type3.String()
  }))
});

// src/infrastructure/state/state-validator.ts
import { Value as Value4 } from "typebox/value";
var StateValidator = class {
  name = ServiceNames.STATE_VALIDATOR;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  /**
   * Validate the structure and version of a state object
   * @param state The state object to validate
   * @returns The validated and potentially coerced SingletonState
   * @throws Error if state structure or version is invalid
   */
  validateState(state) {
    if (!state || typeof state !== "object") {
      throw new Error("Invalid state: not an object");
    }
    const coerced = Value4.Convert(SingletonStateSchema, state);
    if (!Value4.Check(SingletonStateSchema, coerced)) {
      const errors = [...Value4.Errors(SingletonStateSchema, coerced)];
      const errorMsg = errors.map((e) => {
        const path16 = String(e.path || "root");
        return `${path16}: ${e.message} (${JSON.stringify(e.value)})`;
      }).join(", ");
      throw new Error(`Invalid state: ${errorMsg}`);
    }
    if (coerced.port < 0 || coerced.port > 65535) {
      throw new Error(`Invalid state: port must be 0-65535, got ${coerced.port}`);
    }
    if (coerced.browserServer && (coerced.browserServer.port < 0 || coerced.browserServer.port > 65535)) {
      throw new Error(`Invalid state: browserServer.port must be 0-65535, got ${coerced.browserServer.port}`);
    }
    return coerced;
  }
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposed" /* DISPOSED */;
  }
};

// src/infrastructure/browser/worker-pool-manager.ts
import { dirname as dirname8, join as join12 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { FixedClusterPool, WorkerChoiceStrategies } from "poolifier";
var __filename2 = fileURLToPath2(import.meta.url);
var __dirname = dirname8(__filename2);
var WorkerPoolManager = class {
  constructor(onPoolError) {
    this.onPoolError = onPoolError;
  }
  onPoolError;
  name = ServiceNames.WORKER_POOL_MANAGER;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  pool = null;
  poolInitializationPromise = null;
  currentWorkerCount = null;
  consecutiveErrors = 0;
  isShuttingDown = false;
  // FIX (#12): Flag to indicate a pool reset is in progress
  _resetInProgress = false;
  /**
   * Ensure the pool is initialized with the current config.
   * Recreates the pool if the worker count has changed.
   */
  async ensurePool(config) {
    const maxWorkers = getMaxWorkers(config);
    if (this.isShuttingDown) {
      throw new Error("Worker pool is shutting down");
    }
    if (this._resetInProgress) {
      const maxWait = 3e3;
      const interval = 100;
      const deadline = Date.now() + maxWait;
      while (this._resetInProgress && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
      }
      if (this._resetInProgress) {
        throw new Error("Worker pool is being reset, please retry");
      }
      return this.ensurePool(config);
    }
    if (this.pool && this.currentWorkerCount === maxWorkers) {
      return this.pool;
    }
    if (this.poolInitializationPromise) {
      return this.poolInitializationPromise;
    }
    this.poolInitializationPromise = (async () => {
      try {
        if (this.pool && this.currentWorkerCount !== maxWorkers) {
          logger.log(`[WorkerPoolManager] Worker count changed from ${this.currentWorkerCount} to ${maxWorkers}, recreating pool...`);
          await this.pool.destroy();
          this.pool = null;
        }
        this.currentWorkerCount = maxWorkers;
        logger.log(`[WorkerPoolManager] Initializing Unified FixedClusterPool (Size: ${maxWorkers}) on PID ${process.pid}`);
        ensureBrowserCacheDir();
        const browserEnv = getBrowserEnv(config);
        const workerConcurrency = (config || getConfig()).WORKER_CONCURRENCY;
        this.pool = new FixedClusterPool(maxWorkers, join12(__dirname, "./thread-worker.mjs"), {
          env: browserEnv,
          // Prevent query leakage via process.argv in forked workers
          workerOptions: { execArgv: [] },
          errorHandler: (e) => {
            this.consecutiveErrors++;
            metrics.increment("browser_pool_errors_total", 1);
            logger.error("[WorkerPoolManager] Cluster Error:", e);
            if (this.consecutiveErrors >= 3) {
              metrics.increment("browser_pool_unhealthy_events_total", 1);
              logger.error(`[WorkerPoolManager] Worker pool may be unhealthy: ${this.consecutiveErrors} consecutive errors. Consider restarting.`);
              if (this.onPoolError) {
                this.onPoolError(e, this.consecutiveErrors);
              }
              this.schedulePoolReset();
            }
          },
          exitHandler: (code) => {
            if (code !== 0 && code !== null) {
              logger.error(`[WorkerPoolManager] Worker exited with code ${code}`);
              this.consecutiveErrors++;
              if (this.consecutiveErrors >= 3) {
                logger.error(`[WorkerPoolManager] Worker pool unhealthy due to 3 consecutive exits. Scheduling auto-recovery...`);
                if (this.onPoolError) {
                  this.onPoolError(new Error(`Worker exited with code ${code}`), this.consecutiveErrors);
                }
                this.schedulePoolReset();
              }
            }
          },
          workerChoiceStrategy: WorkerChoiceStrategies.ROUND_ROBIN,
          enableTasksQueue: true,
          tasksQueueOptions: {
            concurrency: workerConcurrency
            // configurable via PI_RESEARCH_WORKER_CONCURRENCY
          }
        });
        if (this.isShuttingDown) {
          logger.warn("[WorkerPoolManager] Pool initialized but is already shutting down. Destroying...");
          await this.pool.destroy().catch((err) => logger.debug("Swallowed pool destroy error:", err));
          this.pool = null;
          throw new Error("Worker pool is shutting down");
        }
        metrics.setGauge("browser_pool_workers", maxWorkers);
        metrics.increment("browser_pool_initializations_total", 1, { success: "true" });
        if (this.lifecycle === "uninitialized" /* UNINITIALIZED */) {
          this.lifecycle = "initialized" /* INITIALIZED */;
        }
        return this.pool;
      } catch (error) {
        metrics.increment("browser_pool_initializations_total", 1, { success: "false" });
        this.poolInitializationPromise = null;
        throw error;
      }
    })();
    return this.poolInitializationPromise;
  }
  /**
   * Get the current pool instance.
   */
  getPool() {
    return this.pool;
  }
  /**
   * Reset consecutive errors counter.
   */
  resetConsecutiveErrors() {
    this.consecutiveErrors = 0;
  }
  /**
   * Schedule an out-of-band pool reset. Called from poolifier event handlers
   * where destroying the pool synchronously would deadlock. Waits 1 s so the
   * current event-handler call-stack unwinds before the pool is destroyed.
   */
  schedulePoolReset() {
    if (this.isShuttingDown) return;
    const deadPool = this.pool;
    this._resetInProgress = true;
    this.currentWorkerCount = null;
    this.consecutiveErrors = 0;
    metrics.increment("browser_pool_auto_recoveries_total", 1);
    logger.info("[WorkerPoolManager] Pool scheduled for auto-recovery; next ensurePool() will wait for old pool destruction.");
    const t = setTimeout(async () => {
      try {
        if (deadPool) await deadPool.destroy();
        logger.info("[WorkerPoolManager] Auto-recovery: old pool destroyed.");
      } catch (err) {
        logger.warn("[WorkerPoolManager] Auto-recovery: error destroying old pool:", err);
      } finally {
        if (this.pool === deadPool) this.pool = null;
        this._resetInProgress = false;
      }
    }, 1e3);
    if (t.unref) t.unref();
  }
  /**
   * Check if the pool is shutting down.
   */
  isPoolShuttingDown() {
    return this.isShuttingDown;
  }
  /**
   * Destroy the pool and clean up resources.
   */
  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    if (this.pool) {
      try {
        const destroyPromise = this.pool.destroy();
        destroyPromise.catch((err) => logger.debug(`[WorkerPoolManager] Background pool destroy rejection: ${err.message}`));
        await Promise.race([
          destroyPromise,
          new Promise((resolve5) => setTimeout(resolve5, 5e3))
        ]);
      } catch (e) {
        logger.warn("[WorkerPoolManager] Pool destruction error:", e);
      }
      await new Promise((resolve5) => setTimeout(resolve5, 200));
      this.pool = null;
    }
    this.poolInitializationPromise = null;
    this.currentWorkerCount = null;
    this.consecutiveErrors = 0;
    this.isShuttingDown = false;
  }
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    logger.debug("[WorkerPoolManager] Initializing...");
    this.lifecycle = "initialized" /* INITIALIZED */;
    logger.debug("[WorkerPoolManager] Initialized");
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposing" /* DISPOSING */;
    logger.debug("[WorkerPoolManager] Disposing...");
    await this.shutdown();
    this.lifecycle = "disposed" /* DISPOSED */;
    logger.debug("[WorkerPoolManager] Disposed");
  }
};

// src/infrastructure/state/state-path-configuration.ts
import * as os7 from "node:os";
import * as path14 from "node:path";
var StatePathConfiguration = class {
  name = ServiceNames.STATE_PATH_CONFIGURATION;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  _initialized = false;
  stateDir;
  stateFilePath;
  lockDirPath;
  backupDirPath;
  lockFilePath;
  projectSettingsPath;
  constructor(stateDir) {
    const resolvedStateDir = stateDir || path14.join(os7.homedir(), ".pi", "state");
    this.stateDir = resolvedStateDir;
    this.stateFilePath = path14.join(resolvedStateDir, "research-state.json");
    this.lockDirPath = path14.join(resolvedStateDir, ".locks");
    this.backupDirPath = path14.join(resolvedStateDir, "backups");
    this.lockFilePath = path14.join(this.lockDirPath, "research-state.lock");
    this.projectSettingsPath = path14.join(resolvedStateDir, "project-settings.json");
  }
  async initialize() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  /**
   * Get all state paths
   */
  getPaths() {
    return {
      stateFilePath: this.stateFilePath,
      lockDirPath: this.lockDirPath,
      backupDirPath: this.backupDirPath,
      lockFilePath: this.lockFilePath,
      projectSettingsPath: this.projectSettingsPath
    };
  }
  /**
   * Get the state directory
   */
  getStateDir() {
    return this.stateDir;
  }
  /**
   * Get the state file path
   */
  getStateFilePath() {
    return this.stateFilePath;
  }
  /**
   * Get the lock directory path
   */
  getLockDirPath() {
    return this.lockDirPath;
  }
  /**
   * Get the backup directory path
   */
  getBackupDirPath() {
    return this.backupDirPath;
  }
  /**
   * Get the lock file path
   */
  getLockFilePath() {
    return this.lockFilePath;
  }
  /**
   * Get the project settings file path
   */
  getProjectSettingsPath() {
    return this.projectSettingsPath;
  }
};

// src/infrastructure/state/state-backup-manager.ts
import * as fs12 from "node:fs/promises";
import * as crypto7 from "node:crypto";
import * as path15 from "node:path";
var StateBackupManager = class {
  name = ServiceNames.STATE_BACKUP_MANAGER;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  _initialized = false;
  stateFilePath;
  backupDirPath;
  maxBackups;
  constructor(stateFilePath, backupDirPath, maxBackups = 5) {
    this.stateFilePath = stateFilePath;
    this.backupDirPath = backupDirPath;
    this.maxBackups = maxBackups;
  }
  async initialize() {
    if (this._initialized) {
      return;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    await fs12.mkdir(this.backupDirPath, { recursive: true, mode: 448 });
    this._initialized = true;
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  /**
   * Create a backup of the current state file
   * @throws Error if unable to create backup
   */
  async createBackup() {
    try {
      try {
        await fs12.access(this.stateFilePath);
      } catch {
        return;
      }
      await fs12.mkdir(this.backupDirPath, { recursive: true, mode: 448 });
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const backupFileName = `research-state-${timestamp}.json`;
      const backupFilePath = path15.join(this.backupDirPath, backupFileName);
      await fs12.copyFile(this.stateFilePath, backupFilePath);
    } catch (error) {
      throw new Error(`Failed to create backup: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  /**
   * Clean up old backups, keeping only the most recent maxBackups
   */
  async cleanupOldBackups() {
    try {
      const entries = await fs12.readdir(this.backupDirPath);
      if (entries.length <= this.maxBackups) {
        return;
      }
      const backupFiles = [];
      for (const entry of entries) {
        const filePath = path15.join(this.backupDirPath, entry);
        const stats = await fs12.stat(filePath);
        if (stats.isFile() && entry.startsWith("research-state-") && entry.endsWith(".json")) {
          backupFiles.push({ name: entry, mtime: stats.mtime });
        }
      }
      backupFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      const backupsToRemove = backupFiles.slice(this.maxBackups);
      for (const backupFile of backupsToRemove) {
        const filePath = path15.join(this.backupDirPath, backupFile.name);
        await fs12.unlink(filePath);
      }
    } catch (error) {
      logger.error(`Failed to cleanup old backups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Recover from corruption by restoring a backup or writing a default state.
   */
  async recoverFromCorruption() {
    try {
      let newestBackup = null;
      try {
        const entries = await fs12.readdir(this.backupDirPath);
        for (const entry of entries) {
          const filePath = path15.join(this.backupDirPath, entry);
          const stats = await fs12.stat(filePath);
          if (stats.isFile() && entry.startsWith("research-state-") && entry.endsWith(".json")) {
            if (newestBackup === null || stats.mtime > newestBackup.mtime) {
              newestBackup = { name: entry, mtime: stats.mtime };
            }
          }
        }
      } catch {
      }
      if (newestBackup !== null) {
        const backupPath = path15.join(this.backupDirPath, newestBackup.name);
        await fs12.copyFile(backupPath, this.stateFilePath);
        logger.log(`[StateManager] Recovered state from backup: ${newestBackup.name}`);
      } else {
        await this.writeDefaultState();
        logger.log("[StateManager] Recovered with default state (no backups available)");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[StateManager] Failed to recover from corruption: ${message}`);
      throw error;
    }
  }
  /**
   * Write a default state to the state file
   */
  async writeDefaultState() {
    const defaultState = this.getDefaultState();
    defaultState.lastUpdated = Date.now();
    const stateDir = path15.dirname(this.stateFilePath);
    await fs12.mkdir(stateDir, { recursive: true, mode: 448 });
    const tempFile = `research-state-${crypto7.randomBytes(16).toString("hex")}.tmp`;
    const tempPath = path15.join(stateDir, tempFile);
    await fs12.writeFile(tempPath, JSON.stringify(defaultState, null, 2), "utf-8");
    try {
      await fs12.rename(tempPath, this.stateFilePath);
    } catch (renameErr) {
      if (process.platform === "win32") {
        await fs12.copyFile(tempPath, this.stateFilePath);
        await fs12.unlink(tempPath);
      } else {
        throw renameErr;
      }
    }
  }
  /**
   * Get the default state object
   */
  getDefaultState() {
    return {
      version: 1,
      containerId: "",
      containerName: "",
      port: 0,
      sessions: {},
      lastUpdated: Date.now()
    };
  }
};

// src/infrastructure/service-initialization.ts
function registerInfrastructureServices(container = getServiceContainer()) {
  logger.debug("[InfrastructureServiceInit] Registering infrastructure services...");
  registerService(
    ServiceNames.PROCESS_LIFECYCLE,
    () => new ProcessLifecycleService(),
    {
      lazyInitialization: false,
      // Core infrastructure
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.STATE_PATH_CONFIGURATION,
    () => new StatePathConfiguration(process.env["PI_RESEARCH_STATE_DIR"]),
    {
      lazyInitialization: false,
      // Core infrastructure
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.FILE_LOCK_SERVICE,
    async () => {
      const pathConfig = await getService(ServiceNames.STATE_PATH_CONFIGURATION, void 0, container);
      return new FileLockService({
        lockFilePath: pathConfig.getLockFilePath()
      });
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.STATE_BACKUP_MANAGER,
    async () => {
      const pathConfig = await getService(ServiceNames.STATE_PATH_CONFIGURATION, void 0, container);
      return new StateBackupManager(
        pathConfig.getStateFilePath(),
        pathConfig.getBackupDirPath(),
        10
        // maxBackups
      );
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.SCHEDULER_FACTORY,
    () => new SchedulerFactoryService(),
    {
      lazyInitialization: false,
      // Always available
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.STATE_MANAGER,
    () => new StateManagerService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.KNOWLEDGE_STORE,
    () => new KnowledgeStoreService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.METRICS,
    () => new MetricsService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.WRITER_QUEUE,
    async () => {
      const storeService = await getService(ServiceNames.KNOWLEDGE_STORE, void 0, container);
      const queue = await storeService.getWriterQueue();
      if (!queue) {
        throw new Error("Writer queue is disabled in configuration");
      }
      return queue;
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.GPU_RESOURCE_SERVICE,
    async () => {
      const processLifecycle = await getService(ServiceNames.PROCESS_LIFECYCLE, void 0, container);
      return new GPUResourceService({ processLifecycle });
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.STATE_SESSION_MANAGER,
    async () => {
      const processLifecycle = await getService(ServiceNames.PROCESS_LIFECYCLE, void 0, container);
      return new StateSessionManager(processLifecycle);
    },
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.STATE_BROWSER_MANAGER,
    () => new StateBrowserManager(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.STATE_METRICS_COLLECTOR,
    () => new StateMetricsCollector(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.STATE_VALIDATOR,
    () => new StateValidator(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.WORKER_POOL_MANAGER,
    () => new WorkerPoolManager(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  logger.debug("[InfrastructureServiceInit] Infrastructure services registered");
}
async function shutdownInfrastructureServices(container = getServiceContainer()) {
  logger.log("[InfrastructureServiceInit] Shutting down infrastructure services...");
  await disposeAllServices(container);
}

// src/core/llm/research-model-resolver.ts
function resolveResearchModel(options) {
  const { modelRegistry, config, modelId, hostModel, cwd } = options;
  const activeConfig = config || getConfig(cwd);
  if (modelId) {
    const found = modelRegistry.getAll().find((m) => m.id === modelId);
    if (found) {
      return found;
    }
    logger.warn(`[ModelResolver] Explicit model '${modelId}' not found in registry; falling back.`);
  }
  if (activeConfig.RESEARCH_MODEL) {
    const target = activeConfig.RESEARCH_MODEL;
    const found = modelRegistry.getAll().find(
      (m) => `${m.provider}/${m.id}` === target || m.id === target
    );
    if (found) {
      return found;
    }
    logger.warn(`[ModelResolver] RESEARCH_MODEL '${target}' not found in registry; falling back.`);
  }
  if (hostModel) {
    return hostModel;
  }
  const available = modelRegistry.getAvailable();
  if (available.length > 0) return available[0];
  throw new Error("No LLM model available for research. Please configure your model registry (~/.pi/agent/models.json).");
}

// src/infrastructure/browser/browser-error-utils.ts
function isTransientSocketError(error) {
  if (!error || typeof error !== "object") return false;
  const err = error;
  return typeof err.message === "string" && (err.message.includes("ECONNREFUSED") || err.message.includes("ECONNRESET") || err.message.includes("socket hang up") || err.message.includes("EPIPE") || err.message.includes("ETIMEDOUT") || err.message.includes("timed out") || err.message.includes("pool busy") || err.message.includes("unreachable") || // WorkerPoolManager throws this during the window between forceSchedulerRestart
  // clearing the scheduler reference and the old pool's 1500ms drain completing.
  // It is a transient state — retry after a short delay succeeds once drain finishes.
  err.message.includes("Worker pool is shutting down") || // Poolifier throws this when pool.execute() is called while the pool is being
  // destroyed (e.g., during scheduler restart). Treat as transient — the pool will
  // be ready for new tasks once destruction completes and a new pool is initialized.
  err.message.includes("Cannot execute a task on destroying pool") || err.message.includes("destroying pool"));
}
function isCloudflareBlockError(error) {
  if (!error || typeof error !== "object") return false;
  const err = error;
  return typeof err.message === "string" && (err.message.includes("Fetch blocked: Cloudflare") || err.message.includes("Cloudflare challenge"));
}
function isTaskTimeoutError(error) {
  if (!error || typeof error !== "object") return false;
  const err = error;
  return typeof err.message === "string" && (err.message.includes("timed out after") || err.message.includes("Search task timed out") || err.message.includes("Scrape task timed out") || err.message.includes("Health check timed out") || err.message.includes("[BrowserClient] Request to"));
}
function isPoolShutdownError(error) {
  if (!error || typeof error !== "object") return false;
  const err = error;
  return typeof err.message === "string" && (err.message.includes("Worker pool is shutting down") || err.message.includes("Cannot execute a task on destroying pool") || err.message.includes("destroying pool"));
}
var sessionCircuitBreakers = /* @__PURE__ */ new Map();
var DEFAULT_BREAKER_CONFIG = {
  // Raised from 3→8: parallel search bursts of 20 queries frequently produce
  // simultaneous timeouts on slow/CF-protected sites. A threshold of 3 caused
  // the breaker to open mid-burst, blocking all subsequent requests for the round.
  failureThreshold: 8,
  // Raised from 15s→45s: enough time for one full search burst + retry window
  // to complete before the breaker attempts to half-open.
  resetTimeoutMs: 45e3,
  name: "BrowserPool",
  isTransientError: (error) => {
    if (isPoolShutdownError(error)) return false;
    if (isCloudflareBlockError(error)) return false;
    if (isTaskTimeoutError(error)) return false;
    return isTransientSocketError(error);
  }
};
function getBrowserCircuitBreaker(sessionId) {
  let breaker = sessionCircuitBreakers.get(sessionId);
  if (!breaker) {
    breaker = new CircuitBreaker({ ...DEFAULT_BREAKER_CONFIG, name: `BrowserPool-${sessionId}` });
    sessionCircuitBreakers.set(sessionId, breaker);
  }
  return breaker;
}
function clearSessionCircuitBreaker(sessionId) {
  sessionCircuitBreakers.delete(sessionId);
}
var browserCircuitBreaker = new CircuitBreaker(DEFAULT_BREAKER_CONFIG);

// src/infrastructure/browser/browser-lifecycle.ts
async function waitForBrowserPoolIdle(maxWaitMs = 15e3) {
  const start = Date.now();
  const schedulerService = tryGetService(ServiceNames.SCHEDULER);
  const pendingShutdown = schedulerService?.getPendingShutdownPromise();
  if (pendingShutdown) {
    const remainingMs = maxWaitMs - (Date.now() - start);
    if (remainingMs > 0) {
      let timeoutId;
      const timeoutPromise = new Promise((resolve5) => {
        timeoutId = setTimeout(() => resolve5("timeout"), remainingMs);
      });
      const pendingPromise = pendingShutdown.then(() => "done");
      pendingPromise.catch((err) => logger.debug(`[BrowserLifecycle] Background pending shutdown rejection: ${err instanceof Error ? err.message : String(err)}`));
      const winner = await Promise.race([
        pendingPromise,
        timeoutPromise
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (winner === "timeout") {
        logger.warn("[BrowserLifecycle] waitForBrowserPoolIdle: timed out awaiting pendingShutdown after", maxWaitMs, "ms");
        return;
      }
    }
  }
  const poolManager = tryGetService(ServiceNames.WORKER_POOL_MANAGER);
  if (!poolManager || !poolManager.isPoolShuttingDown()) return;
  const deadline = Date.now() + (maxWaitMs - (Date.now() - start));
  while (Date.now() < deadline) {
    await new Promise((resolve5) => setTimeout(resolve5, 100));
    if (!poolManager.isPoolShuttingDown()) return;
  }
  logger.warn("[BrowserLifecycle] waitForBrowserPoolIdle: pool still shutting down after", maxWaitMs, "ms");
}

// src/infrastructure/browser/task-execution-service.ts
var lastRestartTime = 0;
var RESTART_COOLDOWN_MS = 1e4;
async function getScheduler2(config, container = getServiceContainer()) {
  try {
    const factory = await getService(ServiceNames.SCHEDULER_FACTORY, void 0, container);
    return await factory.getScheduler(config);
  } catch {
    return await getScheduler(config, container);
  }
}
async function forceSchedulerRestart2(forceClearRemoteState = false, container = getServiceContainer()) {
  try {
    const factory = await getService(ServiceNames.SCHEDULER_FACTORY, void 0, container);
    return await factory.forceSchedulerRestart(forceClearRemoteState);
  } catch {
    return await forceSchedulerRestart(forceClearRemoteState, container);
  }
}
async function runBrowserTask(taskOrUrl, type = "scrape", config, signal, retries = 1, container = getServiceContainer()) {
  if (signal?.aborted) throw new Error("Aborted");
  const sessionId = typeof taskOrUrl === "object" ? taskOrUrl.sessionId : void 0;
  const breaker = sessionId ? getBrowserCircuitBreaker(sessionId) : browserCircuitBreaker;
  try {
    return await breaker.execute(async () => {
      if (signal?.aborted) throw new Error("Aborted");
      const scheduler = await getScheduler2(config, container);
      if (type === "search") {
        const query = typeof taskOrUrl === "string" ? taskOrUrl : taskOrUrl.query;
        if (!query) throw new Error("Search task requires a query");
        return await scheduler.runSearch(query, config, signal);
      }
      const url = typeof taskOrUrl === "string" ? taskOrUrl : taskOrUrl.url;
      if (url) {
        return await scheduler.runScrape(url, config, signal);
      }
      throw new Error("Unified browser manager requires data-driven tasks (URLs/Queries)");
    });
  } catch (error) {
    if (signal?.aborted || error instanceof Error && error.message === "Aborted") throw new Error("Aborted", { cause: error });
    if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
      errorTracker.trackError(error, {
        component: "browser-manager",
        operation: type,
        taskType: type,
        errorType: "transient_socket_error"
      });
      logger.warn(`[BrowserManager] Transient socket error during ${type} task (retries left: ${retries}): ${(error instanceof Error ? error.message : String(error)).substring(0, 100)}...`);
      if (isPoolShutdownError(error)) {
        logger.warn(`[BrowserManager] Pool is draining \u2014 waiting for pool idle before retry...`);
        await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
      } else {
        const now = Date.now();
        if (now - lastRestartTime > RESTART_COOLDOWN_MS) {
          lastRestartTime = now;
          logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
          await forceSchedulerRestart2(true, container);
          await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
        } else {
          logger.warn(`[BrowserManager] Scheduler restart recently triggered, waiting for pool idle...`);
          await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
        }
      }
      const jitter = 100 + Math.floor(Math.random() * 400);
      await new Promise((resolve5) => setTimeout(resolve5, jitter));
      return runBrowserTask(taskOrUrl, type, config, signal, retries - 1, container);
    }
    throw error;
  }
}
async function runBrowserHealthCheck(config, retries = 1, signal, container = getServiceContainer()) {
  try {
    return await browserCircuitBreaker.execute(async () => {
      const scheduler = await getScheduler2(config, container);
      return await scheduler.runHealthCheck(config, signal);
    });
  } catch (error) {
    if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
      errorTracker.trackError(error, {
        component: "browser-manager",
        operation: "healthcheck",
        errorType: "transient_socket_error"
      });
      logger.warn(`[BrowserManager] Transient socket error during healthcheck (retries left: ${retries}): ${(error instanceof Error ? error.message : String(error)).substring(0, 100)}...`);
      if (isPoolShutdownError(error)) {
        await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
      } else {
        const now = Date.now();
        if (now - lastRestartTime > RESTART_COOLDOWN_MS) {
          lastRestartTime = now;
          logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
          await forceSchedulerRestart2(true, container);
          await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
        } else {
          await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
        }
      }
      const jitter = 100 + Math.floor(Math.random() * 400);
      await new Promise((resolve5) => setTimeout(resolve5, jitter));
      return runBrowserHealthCheck(config, retries - 1, signal, container);
    }
    throw error;
  }
}
async function runWorkerSearch(query, config, signal, retries = 1, sessionId, container = getServiceContainer()) {
  if (signal?.aborted) throw new Error("Aborted");
  const breaker = sessionId ? getBrowserCircuitBreaker(sessionId) : browserCircuitBreaker;
  try {
    return await breaker.execute(async () => {
      if (signal?.aborted) throw new Error("Aborted");
      const scheduler = await getScheduler2(config, container);
      return await scheduler.runSearch(query, config, signal);
    });
  } catch (error) {
    if (signal?.aborted || error instanceof Error && error.message === "Aborted") throw new Error("Aborted", { cause: error });
    if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
      errorTracker.trackError(error, {
        component: "browser-manager",
        operation: "search",
        query,
        errorType: "transient_socket_error"
      });
      logger.warn(`[BrowserManager] Transient socket error during search (retries left: ${retries}): ${(error instanceof Error ? error.message : String(error)).substring(0, 100)}...`);
      if (isPoolShutdownError(error)) {
        await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
      } else {
        const now = Date.now();
        if (now - lastRestartTime > RESTART_COOLDOWN_MS) {
          lastRestartTime = now;
          logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
          await forceSchedulerRestart2(true, container);
          await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
        } else {
          await waitForBrowserPoolIdle(15e3).catch((err) => logger.debug("Wait for browser idle timed out or failed:", err));
        }
      }
      const jitter = 100 + Math.floor(Math.random() * 400);
      await new Promise((resolve5) => setTimeout(resolve5, jitter));
      return runWorkerSearch(query, config, signal, retries - 1, sessionId, container);
    }
    throw error;
  }
}

// src/web-research/browser-search.ts
async function performSearch(queries, config, signal, onProgress, container = getServiceContainer()) {
  const startTime = Date.now();
  const resultMap = /* @__PURE__ */ new Map();
  const seenUrls = /* @__PURE__ */ new Set();
  const fullMockMode = process.env["PI_RESEARCH_MOCK_SEARCH"] === "true" && process.env["PI_RESEARCH_MOCK_SCRAPE"] === "true";
  if (fullMockMode) {
    logger.log("[Search] FULL_MOCK_MODE enabled \u2014 returning mock results without worker pool");
    for (const q of queries) {
      const domain = q.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 30);
      resultMap.set(q, [{
        title: `Mock result for: ${q}`,
        url: `https://mock.example.com/${domain}`,
        content: `This is a mock search result for query "${q}".`
      }]);
    }
    return resultMap;
  }
  const maxWorkers = getMaxWorkers(config);
  metrics.setGauge("browser_search_max_workers", maxWorkers);
  metrics.increment("browser_search_orchestrations_total", 1);
  logger.log(`[Search] Orchestrating ${queries.length} queries across ${maxWorkers} worker processes...`);
  if (onProgress) onProgress(0);
  const QUERY_TIMEOUT_MS = 4e4;
  const filteredQueries = queries.filter((q) => q.trim());
  let timeoutCount = 0;
  let errorCount = 0;
  const searchTasks = filteredQueries.map(async (query) => {
    const queryStartTime = Date.now();
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), QUERY_TIMEOUT_MS);
    safeUnref(timeoutId);
    try {
      if (signal?.aborted) {
        resultMap.set(query, []);
        return;
      }
      const querySignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
      const results = await runWorkerSearch(query, config, querySignal, 1, void 0, container);
      const queryDuration = Date.now() - queryStartTime;
      metrics.observe("browser_search_query_duration_ms", queryDuration);
      if (results?.length > 0) {
        metrics.increment("browser_search_queries_total", 1, { status: "success" });
        metrics.increment("browser_search_results_total", results.length);
        logger.debug(`[Search] Worker returned ${results.length} results for: ${query}`);
        const uniqueResults = [];
        const localSeen = /* @__PURE__ */ new Set();
        for (const r of results) {
          if (r.url && !localSeen.has(r.url)) {
            localSeen.add(r.url);
            uniqueResults.push(r);
            seenUrls.add(r.url);
          }
        }
        resultMap.set(query, uniqueResults);
      } else {
        metrics.increment("browser_search_queries_total", 1, { status: "no_results" });
        resultMap.set(query, []);
      }
    } catch (error) {
      const queryDuration = Date.now() - queryStartTime;
      const isTimeout = timeoutController.signal.aborted && !signal?.aborted;
      const status = isTimeout ? "timeout" : "error";
      if (isTimeout) timeoutCount++;
      else errorCount++;
      metrics.observe("browser_search_query_duration_ms", queryDuration, { status });
      metrics.increment("browser_search_queries_total", 1, { status });
      if (isTimeout) {
        logger.warn(`[Search] Query timed out after ${QUERY_TIMEOUT_MS}ms (likely blocked or slow startup): "${query}"`);
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg !== "Aborted") {
          logger.error(`[Search] Worker failed for "${query}": ${msg}`);
        }
      }
      resultMap.set(query, []);
    } finally {
      clearTimeout(timeoutId);
      if (onProgress) onProgress(seenUrls.size);
    }
  });
  await Promise.all(searchTasks);
  const totalResults = Array.from(resultMap.values()).reduce((sum, r) => sum + r.length, 0);
  if (totalResults === 0 && filteredQueries.length > 0) {
    metrics.increment("browser_search_total_failures_total", 1);
    let reason = `all ${filteredQueries.length} queries returned no results`;
    if (timeoutCount === filteredQueries.length) {
      reason = `all ${filteredQueries.length} queries timed out after ${QUERY_TIMEOUT_MS}ms`;
    } else if (errorCount === filteredQueries.length) {
      reason = `all ${filteredQueries.length} queries encountered worker errors`;
    } else if (timeoutCount + errorCount === filteredQueries.length) {
      reason = `${timeoutCount} queries timed out and ${errorCount} queries failed`;
    }
    throw new Error(
      `Search completely failed: ${reason}. Browser workers may be unavailable, DuckDuckGo is unreachable, or the system is under extreme load.`
    );
  }
  const totalDuration = Date.now() - startTime;
  metrics.observe("browser_search_total_duration_ms", totalDuration);
  metrics.increment("browser_search_unique_urls_total", seenUrls.size);
  return resultMap;
}

// src/web-research/search.ts
async function search(queries, config, signal, onProgress, container = getServiceContainer()) {
  if (queries.length === 0) return [];
  logger.log(`[Search] Orchestrating ${queries.length} queries via Browser Queue...`);
  metrics.observe("search_query_count_per_request", queries.length);
  const searchStart = Date.now();
  try {
    const resultMap = await performSearch(queries, config, signal, onProgress, container);
    const searchDuration = Date.now() - searchStart;
    metrics.observe("search_latency_ms", searchDuration);
    let totalResults = 0;
    let successfulQueries = 0;
    let failedQueries = 0;
    const results = queries.map((q) => {
      const qResults = resultMap.get(q) || [];
      const result = { query: q, results: qResults };
      if (qResults.length > 0) {
        totalResults += qResults.length;
        successfulQueries++;
        metrics.observe("search_results_per_query", qResults.length);
      } else {
        result.error = {
          type: "empty_results",
          message: "Browser-based search returned no results. This may indicate an IP block or lack of relevant data."
        };
        failedQueries++;
      }
      return result;
    });
    metrics.observe("search_results_total", totalResults);
    metrics.increment("search_queries_total", successfulQueries, { status: "success" });
    metrics.increment("search_queries_total", failedQueries, { status: "failed" });
    metrics.observe("search_success_ratio", successfulQueries / queries.length);
    return results;
  } catch (error) {
    const searchDuration = Date.now() - searchStart;
    metrics.observe("search_latency_ms", searchDuration, { status: "error" });
    metrics.increment("search_queries_total", queries.length, { status: "error" });
    metrics.increment("search_errors_total", 1, { error_type: "search_failed" });
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Search completely failed")) {
      metrics.increment("search_errors_total", 1, { error_type: "total_search_failure" });
      throw error;
    }
    logger.error(`[Search] Orchestration failed:`, error);
    metrics.increment("search_errors_total", 1, { error_type: "orchestration_error" });
    return queries.map((q) => ({
      query: q,
      results: [],
      error: { type: "unknown", message }
    }));
  }
}

// src/healthcheck/registry.ts
var HealthCheckRegistry = class {
  name = ServiceNames.HEALTH_REGISTRY;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  checks = [];
  async initialize() {
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    this.checks = [];
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  register(name, check, options = {}) {
    this.checks.push({
      name,
      check,
      timeoutMs: options.timeoutMs ?? 15e3,
      critical: options.critical ?? true
    });
  }
  isCritical(componentName) {
    return this.checks.some((c) => c.name === componentName && c.critical);
  }
  async runAll(options) {
    const promises2 = this.checks.map(async (registeredCheck) => {
      const start = process.hrtime.bigint();
      const status = {
        component: registeredCheck.name,
        healthy: false,
        durationMs: 0,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      try {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`Health check timed out after ${registeredCheck.timeoutMs}ms`)), registeredCheck.timeoutMs);
        });
        const checkPromise = registeredCheck.check(options);
        checkPromise.catch((err) => logger.debug(`[HealthCheck] Background check rejection: ${err instanceof Error ? err.message : String(err)}`));
        const result = await Promise.race([checkPromise, timeoutPromise]);
        if (timeoutId) clearTimeout(timeoutId);
        status.healthy = result.healthy;
        status.error = result.error;
        status.diagnostic = result.diagnostic;
      } catch (error) {
        status.healthy = false;
        status.error = error instanceof Error ? error.message : String(error);
      } finally {
        const end = process.hrtime.bigint();
        status.durationMs = Number(end - start) / 1e6;
      }
      return { status, critical: registeredCheck.critical };
    });
    const results = await Promise.all(promises2);
    let overallStatus = "healthy";
    for (const res of results) {
      if (!res.status.healthy) {
        if (res.critical) {
          overallStatus = "unhealthy";
          break;
        } else {
          overallStatus = "degraded";
        }
      }
    }
    return {
      status: overallStatus,
      components: results.map((r) => r.status),
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
};
var healthRegistry = new HealthCheckRegistry();
healthRegistry.initialize().catch(() => {
});

// src/healthcheck/index.ts
function registerHealthChecks(registry, container = getServiceContainer()) {
  const config = getConfig();
  const healthTimeoutMs = config.HEALTH_CHECK_TIMEOUT_MS;
  registry.register("BrowserCapability", async () => {
    const mockMode = process.env["PI_RESEARCH_MOCK_SEARCH"] === "true" && process.env["PI_RESEARCH_MOCK_SCRAPE"] === "true";
    if (isBrowserAvailable() || mockMode) {
      return { healthy: true, diagnostic: { status: mockMode ? "mocked" : "available" } };
    } else {
      return { healthy: false, error: 'Camoufox (browser) not found. Run "npm run setup" to install browser binaries.' };
    }
  }, { timeoutMs: healthTimeoutMs, critical: true });
  registry.register("BrowserRuntime", async (options) => {
    try {
      const scheduler = await getService(ServiceNames.SCHEDULER, { container }, container);
      if (!scheduler.isReady() && !options?.force) {
        return { healthy: true, diagnostic: { status: "ready (idle)" } };
      }
      const searchResult = await runBrowserHealthCheck(void 0, 1, void 0, container);
      if (searchResult.success) {
        return { healthy: true, diagnostic: { status: options?.force && !scheduler.isReady() ? "initialized & active" : "active" } };
      } else {
        return { healthy: false, error: "Browser healthcheck failed: worker reported failure or page failed to load." };
      }
    } catch (e) {
      return { healthy: false, error: `Browser healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, { timeoutMs: 15e4, critical: true });
  registry.register("KnowledgeStore", async (options) => {
    const cwd = container._cwd || process.cwd();
    const config2 = getConfig(cwd);
    if (config2.KNOWLEDGE_STORE_MODE === "none") {
      return { healthy: true, diagnostic: { status: "disabled in config" } };
    }
    try {
      const service = await getService(ServiceNames.KNOWLEDGE_STORE, { container }, container);
      const store = await service.getStore();
      const counts = store ? await store.countScoped() : { local: 0, global: 0, projects: 0 };
      const embedder = await service.getEmbedder();
      if (!embedder) {
        return { healthy: false, error: "Embedder service not available" };
      }
      if (!embedder.isInitialized() && !options?.force) {
        return {
          healthy: true,
          diagnostic: {
            status: "ready (idle)",
            device: embedder.getOriginalDevice(),
            localEntries: counts.local,
            globalEntries: counts.global
          }
        };
      }
      if (options?.force && !embedder.isInitialized()) {
        await embedder.embed(" ");
      }
      const device = embedder.getDevice();
      return {
        healthy: true,
        diagnostic: {
          status: "initialized",
          device,
          model: config2.EMBEDDING_MODEL,
          localEntries: counts.local,
          globalEntries: counts.global,
          totalProjects: counts.projects
        }
      };
    } catch (e) {
      return { healthy: false, error: `Knowledge store healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, { timeoutMs: Math.max(healthTimeoutMs, 45e3) });
  registry.register("StateManager", async () => {
    try {
      const stateManager = await getService(ServiceNames.STATE_MANAGER, { container }, container);
      const stats = await stateManager.getMetrics();
      const gpuOwner = await stateManager.getGpuOwner();
      return {
        healthy: true,
        diagnostic: {
          status: "operational",
          sessions: stats.activeSessions,
          gpuLocked: !!gpuOwner,
          gpuOwner: gpuOwner?.sessionId || "none"
        }
      };
    } catch (e) {
      return { healthy: false, error: `State manager healthcheck failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, { timeoutMs: healthTimeoutMs });
}
registerHealthChecks(healthRegistry);
async function runHealthCheck(options) {
  const container = tryGetServiceContainerFromCtx(options?.ctx);
  let registry;
  try {
    registry = await getService(ServiceNames.HEALTH_REGISTRY, options?.ctx, container);
  } catch {
    registry = healthRegistry;
  }
  const result = await registry.runAll(options);
  return {
    success: result.status !== "unhealthy",
    status: result.status,
    components: result.components,
    error: result.status === "unhealthy" ? result.components.find((c) => !c.healthy && registry.isCritical(c.component))?.error : void 0
  };
}

// src/utils/shared-links.ts
import { randomUUID as randomUUID4 } from "node:crypto";
var sessionLinks = /* @__PURE__ */ new Map();
var sessionScrapedContent = /* @__PURE__ */ new Map();
var researcherScrapes = /* @__PURE__ */ new Map();
var sessionTimestamps = /* @__PURE__ */ new Map();
var SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1e3;
var MAX_CACHED_CONTENT_PER_SESSION = 500;
var cleanupInterval = null;
function startCleanupTimer() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [researchId, createdAt] of sessionTimestamps.entries()) {
      if (now - createdAt > SESSION_MAX_AGE_MS) {
        sessionLinks.delete(researchId);
        sessionScrapedContent.delete(researchId);
        sessionTimestamps.delete(researchId);
        researcherScrapes.delete(researchId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[Shared Links] Cleaned up ${cleaned} orphaned session(s) older than ${SESSION_MAX_AGE_MS / 6e4} minutes`);
    }
  }, 15 * 60 * 1e3);
  if (cleanupInterval) safeUnref(cleanupInterval);
}
startCleanupTimer();
function cacheScrapedContent(researchId, url, content) {
  if (!sessionScrapedContent.has(researchId)) {
    sessionScrapedContent.set(researchId, /* @__PURE__ */ new Map());
    sessionTimestamps.set(researchId, Date.now());
  }
  const cache = sessionScrapedContent.get(researchId);
  if (cache.size >= MAX_CACHED_CONTENT_PER_SESSION) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== void 0) cache.delete(firstKey);
  }
  cache.set(normalizeUrl(url), content);
}
function getCachedScrapedContent(researchId, url) {
  return sessionScrapedContent.get(researchId)?.get(normalizeUrl(url));
}
function registerScrapedLinks(researchId, links) {
  if (!sessionLinks.has(researchId)) {
    sessionLinks.set(researchId, /* @__PURE__ */ new Set());
    sessionTimestamps.set(researchId, Date.now());
  }
  const pool = sessionLinks.get(researchId);
  links.forEach((l) => pool.add(normalizeUrl(l)));
}
function deduplicateUrls(urls, researchId) {
  const pool = sessionLinks.get(researchId) || /* @__PURE__ */ new Set();
  const kept = [];
  const duplicates = [];
  urls.forEach((url) => {
    const normalized = normalizeUrl(url);
    if (pool.has(normalized)) {
      duplicates.push(url);
    } else {
      kept.push(url);
    }
  });
  return { kept, duplicates };
}
function cleanupSharedLinks(researchId) {
  sessionLinks.delete(researchId);
  sessionScrapedContent.delete(researchId);
  sessionTimestamps.delete(researchId);
  researcherScrapes.delete(researchId);
  logger.debug(`[Shared Links] Cleaned up session: ${researchId}`);
}
function clearAllSharedLinks() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  sessionLinks.clear();
  sessionScrapedContent.clear();
  sessionTimestamps.clear();
  researcherScrapes.clear();
  logger.debug("[Shared Links] All global state cleared");
}
function registerResearcherScrapes(researchId, researcherId, urls) {
  if (!researcherScrapes.has(researchId)) {
    researcherScrapes.set(researchId, /* @__PURE__ */ new Map());
  }
  const map = researcherScrapes.get(researchId);
  if (!map.has(researcherId)) {
    map.set(researcherId, /* @__PURE__ */ new Set());
  }
  const set = map.get(researcherId);
  urls.forEach((url) => set.add(normalizeUrl(url)));
}
var MAX_FOOTER_URLS = 20;
function buildSessionPoolFooter(researchId, currentBatchUrls, researcherId) {
  const pool = sessionLinks.get(researchId);
  if (!pool || pool.size === 0) return "";
  const currentNormalized = new Set(currentBatchUrls.map((u) => normalizeUrl(u)));
  if (researcherId) {
    const ownScrapes = researcherScrapes.get(researchId)?.get(researcherId);
    if (ownScrapes) {
      for (const url of ownScrapes) {
        currentNormalized.add(url);
      }
    }
  }
  const eligible = Array.from(pool).filter((u) => !currentNormalized.has(u));
  if (eligible.length === 0) return "";
  const capped = eligible.slice(-MAX_FOOTER_URLS);
  const overflow = eligible.length - capped.length;
  let footer = "\n---\n## Session URL Pool\n";
  footer += "Info only \u2014 URLs scraped by other researchers in this session. Do NOT use these in your report.\n";
  for (const url of capped) {
    footer += `- ${url}
`;
  }
  if (overflow > 0) {
    footer += `*...and ${overflow} more*
`;
  }
  return footer;
}

// src/orchestration/researcher.ts
import { createAgentSession, SessionManager, SettingsManager as SettingsManagerClass } from "@earendil-works/pi-coding-agent";

// src/tools/index.ts
import { createReadTool } from "@earendil-works/pi-coding-agent";

// src/tools/search.ts
import { Type as Type4 } from "typebox";
import { Value as Value5 } from "typebox/value";
function createSearchTool(options) {
  const SearchParamsSchema = Type4.Object({
    queries: Type4.Array(Type4.String(), {
      minItems: 1,
      maxItems: 50,
      description: "A list of 5-30 search queries to execute (minimum 1)."
    })
  });
  return {
    name: "search",
    label: "Search",
    description: "Search the web using a list of queries (5-30, minimum 1) for targeted coverage.",
    promptSnippet: "Web search (5-30 queries, minimum 1)",
    promptGuidelines: [
      "CRITICAL: Provide 5-30 queries per call (minimum 1).",
      "COVERAGE: Include query variations, related concepts, and specific data points.",
      "EFFICIENT: The system processes all queries in one call \u2014 maximize each call.",
      "Agents are limited to EXACTLY ONE search call. Make it count by covering everything remaining.",
      "Return results are high-fidelity snippets. Use the scrape tool for full deep-dives."
    ],
    parameters: SearchParamsSchema,
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const startTime = Date.now();
      if (!Value5.Check(SearchParamsSchema, params)) {
        metrics.increment("tool_search_calls_total", 1, { status: "invalid_params" });
        return {
          content: [{ type: "text", text: "Invalid parameters for search tool. Expected an array of 5-30 queries (minimum 1)." }],
          details: { error: "invalid_parameters" }
        };
      }
      const p = params;
      let queries = p.queries;
      metrics.increment("tool_search_queries_total", queries.length);
      if (queries.length < 1) {
        metrics.increment("tool_search_calls_total", 1, { status: "insufficient_queries" });
        throw new Error(`Insufficient queries: ${queries.length}. Provide at least 1 highly specific queries.`);
      }
      if (queries.length > 40) {
        logger.warn(`[search tool] Capping tool call queries: ${queries.length} \u2192 40`);
        metrics.increment("tool_search_capped_queries_total", queries.length - 40);
        queries = queries.slice(0, 40);
      }
      const allowed = options.tracker.recordCall("search");
      if (!allowed) {
        metrics.increment("tool_search_calls_total", 1, { status: "rate_limited" });
        return {
          content: [{ type: "text", text: options.tracker.getLimitMessage("search") }],
          details: { blocked: true, reason: "limit_reached" }
        };
      }
      try {
        const container = tryGetServiceContainerFromCtx(ctx);
        const results = await search(queries, options.config, signal, (links) => {
          if (options.onProgress) options.onProgress(links);
        }, container);
        const elapsed = Date.now() - startTime;
        const totalResults = results.reduce((sum, r) => sum + r.results.length, 0);
        metrics.observe("tool_search_duration_ms", elapsed, { status: "success" });
        metrics.increment("tool_search_calls_total", 1, { status: "success" });
        metrics.increment("tool_search_results_total", totalResults);
        metrics.increment("tool_search_successful_queries_total", results.filter((r) => r.results.length > 0).length);
        let markdown = `# Web Search Results (${queries.length} queries)

`;
        markdown += `**Source: Web Search**

`;
        results.forEach((r, i) => {
          markdown += `## Query ${i + 1}: ${r.query}
`;
          if (r.results.length === 0) {
            markdown += `*No results found.*

`;
          } else {
            r.results.forEach((item, j) => {
              markdown += `[${j + 1}] **${item.title}**
${item.url}
${item.content}

`;
            });
          }
        });
        return {
          content: [{ type: "text", text: markdown }],
          details: { queryCount: queries.length, duration: elapsed }
        };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        metrics.observe("tool_search_duration_ms", elapsed, { status: "error" });
        metrics.increment("tool_search_calls_total", 1, { status: "error" });
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `# Search Failed

${msg}` }],
          details: { error: msg, duration: elapsed }
        };
      }
    }
  };
}

// src/tools/scrape.ts
import { Type as Type5 } from "typebox";
import { Value as Value6 } from "typebox/value";

// src/web-research/utils.ts
import { existsSync as existsSync8 } from "node:fs";
function checkModule(name) {
  try {
    import.meta.resolve(name);
    return true;
  } catch {
    return false;
  }
}

// src/utils/user-agent.ts
var USER_AGENTS = [
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

// src/web-research/scraper-types.ts
var MAX_HTML_SIZE = 25 * 1024 * 1024;
var MAX_PDF_SIZE = 100 * 1024 * 1024;
var INTERNAL_NETWORK_PATTERNS = [
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
var FILTERED_TAGS = [
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
var BOT_PATTERNS = [
  ["_cf_chl_", "Cloudflare challenge"],
  ["cf_chl_opt", "Cloudflare challenge opt"],
  ["cdn-cgi/challenge-platform", "Cloudflare challenge platform"],
  ["ddos-guard", "DDoS-Guard challenge"],
  ["Just a moment...", "Cloudflare interstitial"],
  ["Checking your browser before accessing", "Cloudflare interstitial"]
];
var IMAGE_LINK_PATTERN = /\[([^\]]*)\]\((data:image\/[^)]+|[^)\s]+\.(?:svg|png|jpe?g|gif|webp|bmp|ico)(?:\?[^)]*)?)\)/gi;
var MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\((?:data:image\/[^)]+|[^)\s]+)\)/gi;

// src/web-research/types.ts
var FETCH_LAYER_TIMEOUT = 1e4;

// src/web-research/scraper-utils.ts
import * as dns from "node:dns/promises";
import crypto8 from "node:crypto";
import { NodeHtmlMarkdown } from "node-html-markdown";
function getRandomUserAgent() {
  try {
    const index = crypto8.randomInt(0, USER_AGENTS.length);
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

// src/web-research/web-scraper.ts
var playwrightAvailable = false;
var markdownConverterPromise = null;
function initScraperDependencies() {
  playwrightAvailable = checkModule("playwright-core") && checkModule("camoufox-js");
}
initScraperDependencies();
async function getMarkdownConverter() {
  if (markdownConverterPromise !== null) return markdownConverterPromise;
  markdownConverterPromise = (async () => {
    try {
      const nativeModule = await import("@kreuzberg/html-to-markdown-node");
      if (nativeModule && typeof nativeModule.convert === "function") {
        logger.debug("[Scrapers] Using native HTML-to-Markdown converter");
        return createNativeMarkdownConverter(nativeModule);
      }
      throw new Error("Native module exported invalid structure");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[Scrapers] Native HTML-to-Markdown unavailable, falling back to pure JS converter: ${errorMessage}`);
      return createJsMarkdownConverter();
    }
  })();
  markdownConverterPromise.catch(() => {
    markdownConverterPromise = null;
  });
  return markdownConverterPromise;
}
async function convertToMarkdown(html) {
  const converter = await getMarkdownConverter();
  return converter(html);
}
async function extractPdfToMarkdown(bytes) {
  if (bytes.length > MAX_PDF_SIZE) {
    const sizeMB = Math.round(bytes.length / 1024 / 1024);
    logger.warn(`[Scrapers] PDF too large (${sizeMB}MB, max 100MB), skipping extraction`);
    metrics.increment("scrape_pdf_errors_total", 1, { error_type: "size_exceeded" });
    return `*Error: PDF too large (${sizeMB}MB, max 100MB).*`;
  }
  const pdfExtractionStart = Date.now();
  try {
    const { WasmPdfDocument } = await import("pdf-oxide-wasm");
    const doc = new WasmPdfDocument(bytes);
    const pageCount = doc.pageCount();
    let markdown = `# PDF Document

**Pages:** ${pageCount}

`;
    try {
      markdown += doc.toMarkdownAll();
    } catch {
      for (let i = 0; i < pageCount; i++) {
        markdown += `## Page ${i + 1}

${doc.toMarkdown(i)}

`;
      }
    }
    doc.free();
    const pdfExtractionDuration = Date.now() - pdfExtractionStart;
    metrics.observe("scrape_pdf_conversion_ms", pdfExtractionDuration);
    metrics.increment("scrape_pdf_conversions_total", 1, { status: "success", pages: String(pageCount) });
    return markdown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[Scrapers] PDF extraction failed: ${msg}`);
    metrics.increment("scrape_pdf_errors_total", 1, { error_type: "extraction_failed" });
    errorTracker.trackError(e instanceof Error ? e : String(e), {
      component: "scrapers",
      operation: "pdf-extract",
      contentType: "pdf",
      errorType: "extraction_failed"
    });
    return `*Error: Could not extract content from PDF (${msg}).*`;
  }
}
async function scrapeWithFetch(url, signal) {
  await validateUrlForSSRF(url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_LAYER_TIMEOUT);
  safeUnref(timeoutId);
  const onAbort = () => {
    clearTimeout(timeoutId);
    controller.abort();
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const fetchStart = Date.now();
  try {
    const MAX_REDIRECTS = 10;
    let currentUrl = url;
    let response;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": getRandomUserAgent(),
          "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8"
        }
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        const resolved = new URL(location, currentUrl).href;
        await validateUrlForSSRF(resolved);
        currentUrl = resolved;
        continue;
      }
      break;
    }
    if (!response.ok) {
      metrics.increment("scrape_errors_total", 1, { error_type: "http_error", status_code: String(response.status) });
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const fetchDuration = Date.now() - fetchStart;
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
        if (size > MAX_PDF_SIZE) {
          const sizeMB = Math.round(size / 1024 / 1024);
          logger.warn(`[Scrapers] PDF too large (Content-Length: ${sizeMB}MB, max 100MB), skipping`);
          metrics.increment("scrape_pdf_errors_total", 1, { error_type: "size_exceeded" });
          throw new Error(`PDF too large (${sizeMB}MB, max 100MB)`);
        }
      } else if (size > MAX_HTML_SIZE) {
        const sizeMB = Math.round(size / 1024 / 1024);
        logger.warn(`[Scrapers] HTML response too large (Content-Length: ${sizeMB}MB, max 25MB), skipping`);
        metrics.increment("scrape_errors_total", 1, { error_type: "size_exceeded", content_type: contentType.split(";")[0] || "unknown" });
        throw new Error(`HTML response too large (${sizeMB}MB, max 25MB)`);
      }
    }
    if (contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
      const buffer = await response.arrayBuffer();
      const markdown2 = await extractPdfToMarkdown(new Uint8Array(buffer));
      validateContent("", markdown2, url);
      metrics.increment("scrape_operations_total", 1, { layer: "fetch", content_type: "pdf", status: "success" });
      metrics.observe("scrape_latency_ms", fetchDuration, { layer: "fetch", content_type: "pdf", status: "success" });
      return { source: "fetch", layer: "fetch", markdown: markdown2 };
    }
    const html = await response.text();
    if (html.length > MAX_HTML_SIZE) {
      const sizeMB = Math.round(html.length / 1024 / 1024);
      logger.warn(`[Scrapers] HTML response too large (actual: ${sizeMB}MB, max 25MB), truncating`);
      metrics.increment("scrape_errors_total", 1, { error_type: "size_exceeded", content_type: "html" });
      errorTracker.trackError(new Error(`HTML response too large (${sizeMB}MB, max 25MB)`), {
        component: "scrapers",
        operation: "fetch",
        url,
        domain: extractDomain(url),
        layer: "fetch",
        contentType: "html"
      });
      throw new Error(`HTML response too large (${sizeMB}MB, max 25MB)`);
    }
    let markdown;
    try {
      markdown = await convertToMarkdown(html);
    } catch (e) {
      logger.error(`[Scrapers] Markdown conversion failed for ${url}: ${String(e)}`);
      throw new Error(`Markdown conversion failed: ${String(e)}`, { cause: e });
    }
    validateContent(html, markdown, url);
    metrics.increment("scrape_operations_total", 1, { layer: "fetch", content_type: "html", status: "success" });
    metrics.observe("scrape_latency_ms", fetchDuration, { layer: "fetch", content_type: "html", status: "success" });
    return { source: "fetch", layer: "fetch", markdown };
  } catch (error) {
    if (error instanceof Error && error.message.includes("not allowed")) {
      metrics.increment("scrape_operations_total", 1, { layer: "fetch", status: "ssrf_blocked" });
      metrics.observe("scrape_latency_ms", Date.now() - fetchStart, { layer: "fetch", status: "ssrf_blocked" });
      errorTracker.trackError(error, {
        component: "scrapers",
        operation: "fetch",
        url,
        domain: extractDomain(url),
        layer: "fetch",
        errorType: "ssrf_blocked"
      });
      throw error;
    }
    metrics.increment("scrape_operations_total", 1, { layer: "fetch", status: "error" });
    errorTracker.trackError(error instanceof Error ? error : String(error), {
      component: "scrapers",
      operation: "fetch",
      url,
      domain: extractDomain(url),
      layer: "fetch"
    });
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
async function scrapeWithStealthBrowser(_url, config, signal, sessionId, container = getServiceContainer()) {
  const browserStart = Date.now();
  try {
    const result = await runBrowserTask({ url: _url, sessionId }, "scrape", config, signal, 1, container);
    const browserDuration = Date.now() - browserStart;
    if (result.buffer) {
      const markdown2 = await extractPdfToMarkdown(new Uint8Array(result.buffer));
      metrics.increment("scrape_operations_total", 1, { layer: "playwright", content_type: "pdf", status: "success" });
      metrics.observe("scrape_latency_ms", browserDuration, { layer: "playwright", content_type: "pdf", status: "success" });
      return { source: "playwright", layer: "playwright+camoufox", markdown: markdown2 };
    }
    let html = result.html || "";
    let markdown;
    try {
      markdown = await convertToMarkdown(html);
    } catch (e) {
      logger.error(`[Scrapers] Browser markdown conversion failed for ${_url}: ${String(e)}`);
      throw new Error(`Browser markdown conversion failed: ${String(e)}`, { cause: e });
    }
    validateContent(html, markdown, _url);
    metrics.increment("scrape_operations_total", 1, { layer: "playwright", content_type: "html", status: "success" });
    metrics.observe("scrape_latency_ms", browserDuration, { layer: "playwright", content_type: "html", status: "success" });
    return { source: "playwright", layer: "playwright+camoufox", markdown };
  } catch (error) {
    const browserDuration = Date.now() - browserStart;
    metrics.increment("scrape_operations_total", 1, { layer: "playwright", status: "error" });
    metrics.observe("scrape_latency_ms", browserDuration, { layer: "playwright", status: "error" });
    errorTracker.trackError(error, {
      component: "scrapers",
      operation: "scrape",
      url: _url,
      domain: extractDomain(_url),
      layer: "playwright+camoufox"
    });
    throw error;
  }
}
async function scrapeSingle(url, signal, config, sessionId, container = getServiceContainer()) {
  if (typeof url !== "string" || url.includes("[") || url.includes("]")) {
    metrics.increment("scrape_errors_total", 1, { error_type: "invalid_url_format" });
    return { url, success: false, error: "Invalid URL format (array passed as string?)", markdown: "" };
  }
  try {
    await validateUrlForSSRF(url);
  } catch (ssrfError) {
    metrics.increment("scrape_errors_total", 1, { error_type: "ssrf_blocked" });
    errorTracker.trackError(ssrfError, {
      component: "scrapers",
      operation: "scrape",
      url,
      domain: extractDomain(url),
      layer: "entry_point",
      errorType: "ssrf_blocked"
    });
    return { url, success: false, error: String(ssrfError), markdown: "" };
  }
  const start = Date.now();
  try {
    const res = await scrapeWithFetch(url, signal);
    const duration = Date.now() - start;
    logger.log(`[Scrapers] fetch success for ${url} in ${duration}ms`);
    metrics.increment("scrape_results_total", 1, { outcome: "fetch_success" });
    if (sessionId && res.markdown) {
      cacheScrapedContent(sessionId, url, res.markdown);
    }
    return { ...res, url, success: true };
  } catch (e1) {
    const fetchDuration = Date.now() - start;
    logger.debug(`[Scrapers] fetch failed for ${url} in ${fetchDuration}ms: ${String(e1)}`);
    errorTracker.trackError(e1, {
      component: "scrapers",
      operation: "fetch",
      url,
      domain: extractDomain(url),
      layer: "fetch"
    });
    if (playwrightAvailable) {
      try {
        const browserStart = Date.now();
        const res = await scrapeWithStealthBrowser(url, config, signal, sessionId, container);
        const browserDuration = Date.now() - browserStart;
        const totalDuration = Date.now() - start;
        logger.log(`[Scrapers] browser success for ${url} in ${browserDuration}ms (total: ${totalDuration}ms)`);
        metrics.increment("scrape_layer_fallbacks_total", 1, { from_layer: "fetch", to_layer: "playwright" });
        metrics.increment("scrape_results_total", 1, { outcome: "browser_success" });
        if (sessionId && res.markdown) {
          cacheScrapedContent(sessionId, url, res.markdown);
        }
        return { ...res, url, success: true };
      } catch (e2) {
        const totalDuration = Date.now() - start;
        logger.error(`[Scrapers] Browser fallback failed for ${url} in ${totalDuration}ms:`, e2);
        metrics.increment("scrape_errors_total", 1, { error_type: "fallback_failed", layer: "playwright" });
        metrics.increment("scrape_results_total", 1, { outcome: "total_failure" });
        errorTracker.trackError(e2, {
          component: "scrapers",
          operation: "scrape",
          url,
          domain: extractDomain(url),
          layer: "playwright+camoufox",
          errorType: "fallback_failed"
        });
        return { url, success: false, error: String(e2), markdown: "" };
      }
    }
    metrics.increment("scrape_errors_total", 1, { error_type: "no_fallback_available", layer: "fetch" });
    metrics.increment("scrape_results_total", 1, { outcome: "total_failure" });
    return { url, success: false, error: String(e1), markdown: "" };
  }
}
async function scrape(urls, maxConcurrency = 5, signal, config, sessionId, onUrlComplete, container = getServiceContainer()) {
  metrics.increment("scrape_batches_total", 1);
  metrics.observe("scrape_urls_per_batch", urls.length);
  const batchStart = Date.now();
  const results = [];
  for (let i = 0; i < urls.length; i += maxConcurrency) {
    const batch = urls.slice(i, i + maxConcurrency);
    const batchRes = await Promise.all(
      batch.map(async (url) => {
        const result = await scrapeSingle(url, signal, config, sessionId, container);
        onUrlComplete?.(result);
        return result;
      })
    );
    results.push(...batchRes);
  }
  const batchDuration = Date.now() - batchStart;
  metrics.observe("scrape_batch_latency_ms", batchDuration);
  return results;
}

// src/tools/scrape.ts
function createScrapeTool(options) {
  const config = options.config || getConfig(options.ctx.cwd);
  const maxScrapeBatches = getMaxScrapeBatches(config);
  const container = tryGetServiceContainerFromCtx(options.ctx);
  const fallbackState = {
    version: 1,
    researchId: "standalone",
    rootQuery: "",
    complexity: 1,
    currentRound: 1,
    status: "researching",
    lastUpdated: Date.now(),
    initialAgenda: [],
    allScrapedLinks: [],
    aspects: {}
  };
  const getGlobalState = options.getGlobalState ?? (() => fallbackState);
  const updateGlobalLinks = options.updateGlobalLinks ?? ((links) => {
    fallbackState.allScrapedLinks = [.../* @__PURE__ */ new Set([...fallbackState.allScrapedLinks, ...links])];
  });
  const ScrapeParamsSchema = Type5.Object({
    urls: Type5.Array(Type5.String({ description: "The URLs to scrape" }), { minItems: 1, maxItems: 20 }),
    maxConcurrency: Type5.Optional(Type5.Number({ default: config.MAX_CONCURRENT_SCRAPES, minimum: 1, maximum: 20 }))
  });
  const trackerLimit = options.tracker?.getToolLimit("scrape");
  const effectiveLimit = trackerLimit !== void 0 && trackerLimit < maxScrapeBatches ? trackerLimit : maxScrapeBatches;
  let batchProtocolText;
  if (effectiveLimit > 6) {
    batchProtocolText = `PROTOCOL: Batch 1 \u2192 Batch 2 \u2192 ... (up to ${effectiveLimit} batches)`;
  } else {
    const batchNumbers = Array.from({ length: effectiveLimit }, (_, i) => `Batch ${i + 1}`).join(" \u2192 ");
    batchProtocolText = `PROTOCOL: ${batchNumbers} (up to ${MAX_SCRAPE_URLS} URLs each).`;
  }
  return {
    name: "scrape",
    label: "Scrape Web Pages",
    description: `Fetch and extract the main content (as markdown) from one or more URLs. Use this to read the full text of relevant search results. Supports PDFs. Up to ${maxScrapeBatches} batches.`,
    promptSnippet: `Read full content of web pages or PDFs (up to ${maxScrapeBatches} batches)`,
    promptGuidelines: [
      batchProtocolText,
      `Up to ${MAX_SCRAPE_URLS} URLs per batch.`,
      "Handshake is ELIMINATED. Start scraping immediately.",
      "PDFs are auto-detected and extracted with high fidelity."
    ],
    parameters: ScrapeParamsSchema,
    async execute(_callId, params, signal, _onUpdate) {
      const callStartTime = Date.now();
      if (options.tracker) {
        const callCount2 = options.tracker.getToolCallCount("scrape");
        const limit = options.tracker.getToolLimit("scrape") ?? maxScrapeBatches;
        if (callCount2 >= limit) {
          metrics.increment("tool_scrape_calls_total", 1, { status: "rate_limited" });
          return {
            content: [{ type: "text", text: options.tracker.getLimitMessage("scrape") }],
            details: { blocked: true, reason: "limit_reached" }
          };
        }
      }
      if (!Value6.Check(ScrapeParamsSchema, params)) {
        metrics.increment("tool_scrape_calls_total", 1, { status: "invalid_params" });
        return {
          content: [{ type: "text", text: "Invalid parameters for scrape tool. Expected an array of URLs." }],
          details: { error: "invalid_params" }
        };
      }
      const p = params;
      const rawUrls = p.urls.map((u) => u.trim()).filter((u) => u.length > 0);
      if (rawUrls.length === 0) {
        metrics.increment("tool_scrape_calls_total", 1, { status: "no_valid_urls" });
        return {
          content: [{ type: "text", text: "No valid URLs provided for scraping." }],
          details: { error: "no_urls" }
        };
      }
      if (options.getTokensUsed) {
        const ctxWindow = options.contextWindowSize ?? DEFAULT_MODEL_CONTEXT_WINDOW;
        const tokensUsed = options.getTokensUsed();
        const projected = (tokensUsed + rawUrls.length * config.AVG_TOKENS_PER_SCRAPE) / ctxWindow;
        if (projected >= config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING) {
          const pct = Math.round(config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING * 100);
          metrics.increment("tool_scrape_calls_total", 1, { status: "context_limit" });
          return {
            content: [{
              type: "text",
              text: `# Scrape Blocked \u2014 Context Limit Reached

Projected context usage (${Math.round(projected * 100)}%) would exceed the ${pct}% threshold. Synthesize your findings from what you have gathered so far.`
            }],
            details: { blocked: true, reason: "context_limit" }
          };
        }
      }
      const callCount = options.tracker?.getToolCallCount("scrape") ?? 0;
      const batchLabel = `Batch ${callCount + 1}`;
      options.tracker?.recordCall("scrape");
      const scrapeStartTime = Date.now();
      const { kept: dedupedUrls, duplicates } = deduplicateUrls(rawUrls, getGlobalState().researchId);
      const dedupNote = duplicates.length > 0 ? `**Global Cache Hit**: ${duplicates.length} URL(s) retrieved from session memory (already scraped).

` : "";
      metrics.increment("tool_scrape_duplicates_total", duplicates.length);
      const duplicateResults = [];
      for (const url of duplicates) {
        const cachedContent = getCachedScrapedContent(getGlobalState().researchId, url);
        if (cachedContent) {
          duplicateResults.push({ url, markdown: cachedContent, success: true });
          options.onUrlScrapeResult?.(url, true);
        }
      }
      if (dedupedUrls.length === 0 && duplicateResults.length === 0) {
        metrics.increment("tool_scrape_calls_total", 1, { status: "all_duplicates_no_content" });
        const earlyFooter = buildSessionPoolFooter(getGlobalState().researchId, rawUrls, options.researcherId);
        return {
          content: [{ type: "text", text: `# ${batchLabel} Skipped

All URLs were already in the global pool, but no cached content was available.${earlyFooter}` }],
          details: { all_duplicates: true }
        };
      }
      const finalUrls = dedupedUrls.slice(0, MAX_SCRAPE_URLS);
      const defaultConcurrency = callCount >= 1 ? BATCH_2_DEFAULT_CONCURRENCY : config.MAX_CONCURRENT_SCRAPES;
      const urlsToFetch = [...finalUrls];
      const cachedResults = [];
      if (config.KNOWLEDGE_STORE_MODE !== "none") {
        try {
          const ksService = await getService(ServiceNames.KNOWLEDGE_STORE, options.ctx, container);
          const store = await ksService.getStore();
          if (store) {
            for (const url of finalUrls) {
              const normalized = normalizeUrl(url);
              const cacheHit = await store.rebuildDocument(normalized);
              if (cacheHit) {
                const advisoryHint = cacheHit.description && cacheHit.description !== cacheHit.text ? `> **Advisory Hint (from previous session):** ${cacheHit.description}

` : "";
                cachedResults.push({ url, markdown: advisoryHint + cacheHit.text });
                options.onUrlScrapeResult?.(url, true);
                const idx = urlsToFetch.indexOf(url);
                if (idx !== -1) urlsToFetch.splice(idx, 1);
              }
            }
          }
          if (cachedResults.length > 0) {
            metrics.increment("tool_scrape_cache_hits_total", cachedResults.length);
            logger.log(`[scrape] Cache: ${cachedResults.length} full-text hit(s) out of ${finalUrls.length} URL(s)`);
          }
        } catch (err) {
          const service = await getService(ServiceNames.KNOWLEDGE_STORE, options.ctx, container).catch(() => null);
          if (!service?.isReady()) {
            metrics.increment("tool_scrape_cache_errors_total", 1, { reason: "store_not_ready" });
            logger.warn(`[scrape] Knowledge store not initialized \u2014 all ${finalUrls.length} URL(s) will be scraped fresh`);
          } else {
            metrics.increment("tool_scrape_cache_errors_total", 1, { reason: "lookup_failed" });
            logger.warn("[scrape] Knowledge store cache lookup failed (non-fatal):", err);
          }
        }
      }
      let freshResults;
      const concurrency = p.maxConcurrency || defaultConcurrency;
      try {
        const results = await scrape(urlsToFetch, concurrency, signal, options.config, getGlobalState().researchId, (result) => {
          options.onUrlScrapeResult?.(result.url, result.success);
        }, container);
        freshResults = Array.isArray(results) ? results : [];
      } catch (error) {
        logger.error(`[scrape tool] Scrape failed: ${error instanceof Error ? error.message : String(error)}`);
        metrics.increment("tool_scrape_calls_total", 1, { status: "error" });
        return {
          content: [{ type: "text", text: `# Scrape Failed

${error instanceof Error ? error.message : String(error)}` }],
          details: { error: String(error) }
        };
      }
      const successfulFresh = freshResults.filter((r) => r.success);
      const failedFresh = freshResults.filter((r) => !r.success);
      const successfullyScrapedUrls = successfulFresh.map((r) => r.url);
      if (successfullyScrapedUrls.length > 0) {
        updateGlobalLinks(successfullyScrapedUrls);
      }
      if (options.researcherId && successfullyScrapedUrls.length > 0) {
        registerResearcherScrapes(getGlobalState().researchId, options.researcherId, successfullyScrapedUrls);
      }
      const allSuccessful = [
        ...duplicateResults.map((r) => ({ ...r, error: void 0, source: "session-cache" })),
        ...cachedResults.map((r) => ({ ...r, success: true, error: void 0, source: "knowledge-store" })),
        ...successfulFresh
      ];
      const totalDuration = Date.now() - callStartTime;
      const scrapeDuration = Date.now() - scrapeStartTime;
      metrics.observe("tool_scrape_total_duration_ms", totalDuration, { status: "success" });
      metrics.observe("tool_scrape_fetch_duration_ms", scrapeDuration);
      metrics.increment("tool_scrape_calls_total", 1, { status: "success" });
      metrics.increment("tool_scrape_successful_total", allSuccessful.length);
      metrics.increment("tool_scrape_failed_total", failedFresh.length);
      const successText = allSuccessful.length === 1 ? "1 successful" : `${allSuccessful.length} successful`;
      const failText = failedFresh.length === 1 ? "1 failed" : `${failedFresh.length} failed`;
      let markdown = `# URL Scrape Results (${successText})

${dedupNote}`;
      markdown += `**Successful:** ${allSuccessful.length}, **Failed:** ${failedFresh.length}, **Duration:** ${(totalDuration / 1e3).toFixed(2)}s

`;
      for (const res of allSuccessful) {
        let sourceLabel;
        if (res.source === "session-cache") {
          sourceLabel = "Source: Session Memory (Already scraped by sibling/previous round)";
        } else if (res.source === "knowledge-store") {
          sourceLabel = "Source: Knowledge Store (Local Cache)";
        } else {
          sourceLabel = "Source: Scrape";
        }
        markdown += `### ${res.url}
`;
        markdown += `**${sourceLabel}**

`;
        markdown += `${res.markdown || ""}

---

`;
      }
      if (failedFresh.length > 0) {
        markdown += `## Failed to Scrape (${failText})

`;
        for (const res of failedFresh) {
          const error = typeof res.error === "string" && res.error.length > 0 ? res.error : "Unknown error";
          markdown += `- ${res.url}: ${error}
`;
        }
        markdown += "\n";
      }
      markdown += buildSessionPoolFooter(getGlobalState().researchId, rawUrls, options.researcherId);
      return {
        content: [{ type: "text", text: markdown }],
        details: {
          total: finalUrls.length,
          successful: allSuccessful.length,
          failed: failedFresh.length,
          cached: cachedResults.length,
          fresh: successfulFresh.length
        }
      };
    }
  };
}

// src/tools/security.ts
import { Type as Type6 } from "typebox";
import { Value as Value7 } from "typebox/value";

// src/security/nvd-types.ts
function isWeaknessDescription(value) {
  return typeof value === "object" && value !== null && "value" in value;
}
function isWeakness(value) {
  return typeof value === "object" && value !== null && "description" in value;
}
function isReference(value) {
  return typeof value === "object" && value !== null && "url" in value;
}
function isCPEMatch(value) {
  return typeof value === "object" && value !== null && "criteria" in value;
}
function isNode(value) {
  return typeof value === "object" && value !== null && "cpeMatch" in value;
}
function isConfiguration(value) {
  return typeof value === "object" && value !== null && "nodes" in value;
}
function isDescription(value) {
  return typeof value === "object" && value !== null && "value" in value;
}
function isNVDEntry(value) {
  return typeof value === "object" && value !== null && "cve" in value;
}
function isNVDApiResponse(value) {
  return typeof value === "object" && value !== null && "vulnerabilities" in value;
}

// src/security/nvd-client.ts
var nvdCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 1e4,
  name: "NVD API",
  isTransientError
});
var NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
var DEFAULT_MAX_RESULTS = 20;
var MAX_RESULTS_PER_PAGE = 2e3;
var NVDRateLimiter = class {
  lastRequest = 0;
  minInterval = 6e3;
  // 6 seconds between requests
  async acquire() {
    const now = Date.now();
    const waitTime = Math.max(0, this.minInterval - (now - this.lastRequest));
    this.lastRequest = now + waitTime;
    if (waitTime > 0) {
      await new Promise((resolve5) => {
        const timeoutId = setTimeout(resolve5, waitTime);
        safeUnref(timeoutId);
      });
      metrics.increment("nvd_ratelimiter_wait_total", 1);
      metrics.observe("nvd_ratelimiter_wait_duration_ms", waitTime);
    }
  }
};
var nvdRateLimiter = new NVDRateLimiter();
function extractCVSSScore(metrics2) {
  let cvssScore;
  let cvssVector;
  let severity = "UNKNOWN";
  if (metrics2?.cvssMetricV31 && metrics2.cvssMetricV31.length > 0) {
    const firstMetric = metrics2.cvssMetricV31[0];
    const cvssData = firstMetric?.cvssData;
    cvssScore = cvssData?.baseScore;
    cvssVector = cvssData?.vectorString;
    severity = cvssData?.baseSeverity ?? "UNKNOWN";
  } else if (metrics2?.cvssMetricV30 && metrics2.cvssMetricV30.length > 0) {
    const firstMetric = metrics2.cvssMetricV30[0];
    const cvssData = firstMetric?.cvssData;
    cvssScore = cvssData?.baseScore;
    cvssVector = cvssData?.vectorString;
    severity = cvssData?.baseSeverity ?? "UNKNOWN";
  }
  return { score: cvssScore, vector: cvssVector, severity };
}
function extractCWEs(cve) {
  const cwes = [];
  if (cve.weaknesses) {
    for (const weakness of cve.weaknesses) {
      if (isWeakness(weakness) && weakness.description) {
        for (const desc of weakness.description) {
          if (isWeaknessDescription(desc) && typeof desc.value === "string" && desc.value.startsWith("CWE-")) {
            cwes.push(desc.value);
          }
        }
      }
    }
  }
  return cwes;
}
function extractReferences(cve) {
  const references = [];
  if (cve.references) {
    for (const ref of cve.references) {
      if (isReference(ref) && typeof ref.url === "string") {
        references.push(ref.url);
      }
    }
  }
  return references;
}
function extractAffectedProducts(cve) {
  const affectedProducts = [];
  if (cve.configurations) {
    for (const config of cve.configurations) {
      if (isConfiguration(config) && config.nodes) {
        for (const node of config.nodes) {
          if (isNode(node) && node.cpeMatch) {
            for (const match of node.cpeMatch) {
              if (isCPEMatch(match) && typeof match.criteria === "string") {
                affectedProducts.push(match.criteria);
              }
            }
          }
        }
      }
    }
  }
  return affectedProducts;
}
function getCVEDescription(cve) {
  if (cve.descriptions && cve.descriptions.length > 0) {
    const firstDesc = cve.descriptions[0];
    if (isDescription(firstDesc) && typeof firstDesc.value === "string" && firstDesc.value.length > 0) {
      return firstDesc.value;
    }
  }
  return "No description available";
}
function parseNVDEntry(nvdEntry, options) {
  const cve = nvdEntry.cve;
  const metrics2 = cve.metrics;
  const { score: cvssScore, vector: cvssVector, severity } = extractCVSSScore(metrics2);
  const cwes = extractCWEs(cve);
  const references = extractReferences(cve);
  const affectedProducts = extractAffectedProducts(cve);
  const knownExploited = options?.includeExploited === true;
  return {
    id: cve.id ?? "UNKNOWN",
    source: "nvd",
    severity,
    description: getCVEDescription(cve),
    published: cve.published,
    modified: cve.lastModified,
    cvssScore,
    cvssVector,
    cwes,
    references,
    affectedProducts,
    fixes: [],
    knownExploited
  };
}
function parseNVDResponse(data, options) {
  if (!isNVDApiResponse(data)) {
    return [];
  }
  if (Array.isArray(data.vulnerabilities)) {
    return data.vulnerabilities.filter(isNVDEntry).map((entry) => parseNVDEntry(entry, options));
  }
  return [];
}
function buildURL(term, options, maxResults, startIndex = 0) {
  const params = new URLSearchParams();
  params.append("keywordSearch", term);
  if (options?.severity) {
    params.append("cvssV3Severity", options.severity);
  }
  if (options?.includeExploited) {
    params.append("hasKev", "");
  }
  if (options?.cweId) {
    params.append("cweId", options.cweId);
  }
  if (options?.startDate && options.endDate) {
    params.append("pubStartDate", options.startDate);
    params.append("pubEndDate", options.endDate);
  }
  params.append("resultsPerPage", maxResults.toString());
  params.append("startIndex", startIndex.toString());
  return `${NVD_BASE_URL}?${params.toString()}`;
}
function createFetchOptions() {
  return {
    headers: {
      "User-Agent": "pi-research/2.0",
      "Accept": "application/json"
    },
    signal: createTimeoutSignal(3e4)
  };
}
function handleFetchError(error) {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "DOMException") {
      throw new Error(`NVD API timeout: ${error.message}`);
    }
    throw new Error(`NVD API network error: ${error.message}`);
  }
  throw new Error(`NVD API network error: ${String(error)}`);
}
function handleResponseStatus(response) {
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("NVD API rate limit exceeded (HTTP 429). Retrying with backoff...");
    }
    if (response.status >= 500) {
      throw new Error(`NVD server error (HTTP ${response.status}). Retrying with backoff...`);
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
}
function fetchWithRetry(url) {
  const retryOptions = {
    maxRetries: 3,
    initialDelay: 2e3,
    maxDelay: 1e4
  };
  const endpoint = new URL(url).pathname;
  return nvdCircuitBreaker.execute(async () => {
    return retryWithBackoff(async () => {
      let response;
      try {
        response = await fetch(url, createFetchOptions());
        metrics.increment("nvd_requests_total", 1, { endpoint, status: "success" });
        metrics.increment("nvd_ratelimiter_used_total", 1, { endpoint });
      } catch (error) {
        const errorType = error instanceof Error ? error.name : "unknown";
        metrics.increment("nvd_requests_total", 1, { endpoint, status: "error" });
        metrics.increment("nvd_errors_total", 1, { endpoint, error_type: errorType });
        handleFetchError(error);
      }
      handleResponseStatus(response);
      return response;
    }, retryOptions);
  });
}
async function searchSingleTerm(term, options, maxResults) {
  const allVulnerabilities = [];
  const maxPages = options?.maxPages ?? 5;
  const pageSize = Math.min(20, maxResults);
  let startIndex = 0;
  let totalPagesFetched = 0;
  while (totalPagesFetched < maxPages && allVulnerabilities.length < maxResults) {
    const url = buildURL(term, options, pageSize, startIndex);
    await nvdRateLimiter.acquire();
    const response = await fetchWithRetry(url);
    const data = await response.json();
    const vulnerabilities = parseNVDResponse(data, options);
    if (vulnerabilities.length === 0) {
      metrics.increment("nvd_cache_misses_total", 1, { term });
    } else {
      metrics.increment("nvd_cache_hits_total", 1, { term });
    }
    if (vulnerabilities.length === 0) {
      break;
    }
    allVulnerabilities.push(...vulnerabilities);
    const responseData = data;
    if (responseData?.["totalResults"] !== void 0 && typeof responseData["totalResults"] === "number" && startIndex + pageSize >= responseData["totalResults"]) {
      break;
    }
    startIndex += pageSize;
    totalPagesFetched++;
  }
  metrics.increment("nvd_pagination_requests_total", totalPagesFetched);
  metrics.observe("nvd_pagination_pages_fetched", totalPagesFetched);
  return allVulnerabilities.slice(0, maxResults);
}
function deduplicateVulnerabilities(vulnerabilityArrays) {
  const uniqueVulns = /* @__PURE__ */ new Map();
  for (const termResults of vulnerabilityArrays) {
    for (const vuln of termResults) {
      if (!uniqueVulns.has(vuln.id)) {
        uniqueVulns.set(vuln.id, vuln);
      }
    }
  }
  return Array.from(uniqueVulns.values());
}
async function searchNVD(terms, options) {
  const startTime = Date.now();
  const maxResults = Math.min(options?.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_PER_PAGE);
  const vulnerabilities = [];
  let totalResults = 0;
  let error = void 0;
  try {
    const searchPromises = terms.map(
      (term) => searchSingleTerm(term, options, maxResults)
    );
    const allResults = await Promise.all(searchPromises);
    const uniqueVulns = deduplicateVulnerabilities(allResults);
    totalResults = uniqueVulns.length;
    vulnerabilities.push(...uniqueVulns.slice(0, maxResults));
  } catch (err) {
    const errorType = err instanceof Error ? err.name : "unknown";
    error = err instanceof Error ? err.message : String(err);
    metrics.increment("nvd_search_errors_total", 1, { error_type: errorType });
  } finally {
    const duration = Date.now() - startTime;
    metrics.observe("nvd_search_duration_ms", duration, { has_error: error ? "true" : "false" });
  }
  return {
    count: totalResults,
    vulnerabilities,
    error
  };
}
async function getCVEById(cveId) {
  const startTime = Date.now();
  try {
    const results = await searchNVD([cveId], { maxResults: 1 });
    const duration = Date.now() - startTime;
    metrics.observe("nvd_cve_fetch_duration_ms", duration, { found: results.vulnerabilities.length > 0 ? "true" : "false" });
    return results.vulnerabilities[0] ?? null;
  } catch (err) {
    const duration = Date.now() - startTime;
    metrics.observe("nvd_cve_fetch_duration_ms", duration, { found: "false", error: "true" });
    metrics.increment("nvd_cve_fetch_errors_total", 1);
    logger.error(`[NVD] Error fetching CVE ${cveId}:`, err);
    return null;
  }
}

// src/security/cisa-kev.ts
var CISA_KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
var cisaCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 1e4,
  name: "CISA KEV API",
  isTransientError
});
function isCisaKevItem(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const item = value;
  return typeof item["cveID"] === "string" || typeof item["cve_id"] === "string" || typeof item["id"] === "string";
}
function isCisaKevItemArray(value) {
  return Array.isArray(value) && value.every(isCisaKevItem);
}
function isCisaKevResponse(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const response = value;
  return typeof response === "object" && (response["vulnerabilities"] === void 0 || Array.isArray(response["vulnerabilities"]));
}
function extractCisaKevItems(data) {
  if (isCisaKevItemArray(data)) {
    return data;
  }
  if (isCisaKevResponse(data) && data.vulnerabilities) {
    return data.vulnerabilities.filter(isCisaKevItem);
  }
  return [];
}
async function fetchWithRetryImpl(url, options) {
  const endpoint = "cisa_kev_feed";
  return cisaCircuitBreaker.execute(async () => {
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, options);
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
          error.status = response.status;
          metrics.increment("cisa_kev_errors_total", 1, { endpoint, status_code: response.status.toString() });
          throw error;
        }
        metrics.increment("cisa_kev_requests_total", 1, { endpoint, status: "success" });
        return response;
      },
      {
        maxRetries: 3,
        initialDelay: 1e3,
        maxDelay: 1e4,
        label: "CISA KEV API",
        isTransientError: (error) => {
          const status = error?.status;
          if (typeof status === "number") {
            return status === 429 || status === 403 || status >= 500;
          }
          return isTransientError(error);
        }
      }
    );
  });
}
async function searchCisaKev(terms = [], options) {
  const startTime = Date.now();
  const maxResults = options?.maxResults ?? 100;
  const vulnerabilities = [];
  let error = void 0;
  try {
    const response = await fetchWithRetryImpl(CISA_KEV_URL, {
      headers: {
        "User-Agent": "pi-research/2.0",
        "Accept": "application/json"
      },
      signal: createTimeoutSignal(3e4)
      // 30s timeout
    });
    const data = await response.json();
    const cisaData = extractCisaKevItems(data);
    metrics.increment(cisaData.length > 0 ? "cisa_kev_cache_hits_total" : "cisa_kev_cache_misses_total", 1);
    for (const item of cisaData) {
      const vuln = mapCisaItemToVulnerability(item);
      if (terms.length > 0 && !terms.some(
        (term) => vuln.id.toLowerCase().includes(term.toLowerCase()) || vuln.description.toLowerCase().includes(term.toLowerCase())
      )) {
        continue;
      }
      if (options?.vendor !== void 0) {
        const vendorLower = vuln.vendor?.toLowerCase() ?? "";
        if (!vendorLower.includes(options.vendor.toLowerCase())) {
          continue;
        }
      }
      if (options?.product !== void 0) {
        const productLower = vuln.product?.toLowerCase() ?? "";
        if (!productLower.includes(options.product.toLowerCase())) {
          continue;
        }
      }
      vulnerabilities.push(vuln);
    }
    vulnerabilities.sort((a, b) => {
      if (a.dueDate === void 0) {
        return 1;
      }
      if (b.dueDate === void 0) {
        return -1;
      }
      const aTime = new Date(a.dueDate).getTime();
      const bTime = new Date(b.dueDate).getTime();
      const aSafe = Number.isFinite(aTime) ? aTime : Infinity;
      const bSafe = Number.isFinite(bTime) ? bTime : Infinity;
      return aSafe - bSafe;
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    metrics.increment("cisa_kev_search_errors_total", 1, { error_type: err instanceof Error ? err.name : "unknown" });
  } finally {
    const duration = Date.now() - startTime;
    metrics.observe("cisa_kev_fetch_duration_ms", duration, { has_error: error ? "true" : "false" });
  }
  return {
    count: vulnerabilities.length,
    vulnerabilities: vulnerabilities.slice(0, maxResults),
    error
  };
}
function safeString(value, defaultValue = "") {
  if (typeof value === "string") {
    return value;
  }
  return defaultValue;
}
function mapCisaItemToVulnerability(item) {
  const cveId = [item.cveID, item.cve_id, item.id].map((v) => safeString(v)).find((s) => s.length > 0) ?? "";
  const vendor = [item.vendorProject, item.vendor].map((v) => safeString(v)).find((s) => s.length > 0) ?? "";
  const product = [item.product, item.vulnerabilityName].map((v) => safeString(v)).find((s) => s.length > 0) ?? "";
  const description = [item.shortDescription, item.description].map((v) => safeString(v)).find((s) => s.length > 0) ?? "";
  const dateAdded = [item.dateAdded, item.addedDate].map((v) => safeString(v)).find((s) => s.length > 0) ?? "";
  const dueDate = safeString(item.dueDate);
  const requiredAction = [item.requiredAction, item.action].map((v) => safeString(v)).find((s) => s.length > 0) ?? "";
  const affectedProducts = [vendor, product].filter(
    (value) => value.length > 0
  );
  return {
    id: cveId,
    source: "cisa_kev",
    severity: "CRITICAL",
    // All KEV entries are critical priority
    description,
    published: dateAdded.length > 0 ? dateAdded : void 0,
    modified: dateAdded.length > 0 ? dateAdded : void 0,
    cvssScore: void 0,
    // CISA doesn't include CVSS score
    cwes: [],
    references: [],
    affectedProducts,
    fixes: [],
    vendor: vendor.length > 0 ? vendor : void 0,
    product: product.length > 0 ? product : void 0,
    knownExploited: true,
    dueDate: dueDate.length > 0 ? dueDate : void 0,
    requiredAction: requiredAction.length > 0 ? requiredAction : void 0
  };
}

// src/security/github-advisory-types.ts
function isGitHubAdvisoryRaw(value) {
  return typeof value === "object" && value !== null;
}
function isArray(value) {
  return Array.isArray(value);
}
function isString(value) {
  return typeof value === "string";
}
function isObject(value) {
  return typeof value === "object" && value !== null && !isArray(value);
}
function isGitHubAdvisoryPackage(value) {
  if (!isObject(value)) {
    return false;
  }
  return true;
}
function isGitHubAdvisoryAffected(value) {
  if (!isObject(value)) {
    return false;
  }
  return true;
}
function isGitHubAdvisoryVulnerability(value) {
  if (!isObject(value)) {
    return false;
  }
  return true;
}
function isGitHubAdvisoryListResponse(value) {
  if (!isObject(value)) {
    return false;
  }
  return "items" in value;
}
function isGitHubAdvisoryArray(value) {
  if (!isArray(value)) {
    return false;
  }
  return value.every(isGitHubAdvisoryRaw);
}
function isSingleGitHubAdvisory(value) {
  if (!isGitHubAdvisoryRaw(value)) {
    return false;
  }
  return "ghsa_id" in value || "summary" in value;
}
function extractAffectedPackages(item) {
  const affectedPackages = [];
  if (item.vulnerabilities !== void 0 && isArray(item.vulnerabilities)) {
    for (const vuln of item.vulnerabilities) {
      if (!isGitHubAdvisoryVulnerability(vuln)) {
        continue;
      }
      if (vuln.package !== void 0) {
        if (isGitHubAdvisoryPackage(vuln.package)) {
          const ecosystem = vuln.package.ecosystem ?? "";
          const name = vuln.package.name;
          if (isString(name) && name !== "") {
            if (ecosystem !== "") {
              affectedPackages.push(`${ecosystem}/${name}`);
            } else {
              affectedPackages.push(name);
            }
          }
        }
      } else if (vuln.affected !== void 0 && isArray(vuln.affected)) {
        for (const aff of vuln.affected) {
          if (isGitHubAdvisoryAffected(aff) && aff.package !== void 0) {
            const pkg = aff.package;
            if (isGitHubAdvisoryPackage(pkg)) {
              const ecosystem = pkg.ecosystem ?? "";
              const name = pkg.name;
              if (isString(name) && name !== "") {
                if (ecosystem !== "") {
                  affectedPackages.push(`${ecosystem}/${name}`);
                } else {
                  affectedPackages.push(name);
                }
              }
            }
          }
        }
      }
    }
  }
  if (affectedPackages.length === 0 && item.affected !== void 0 && isArray(item.affected)) {
    for (const aff of item.affected) {
      if (isGitHubAdvisoryAffected(aff) && aff.package !== void 0) {
        const pkg = aff.package;
        if (isGitHubAdvisoryPackage(pkg)) {
          const ecosystem = pkg.ecosystem ?? "";
          const name = pkg.name;
          if (isString(name) && name !== "") {
            if (ecosystem !== "") {
              affectedPackages.push(`${ecosystem}/${name}`);
            } else {
              affectedPackages.push(name);
            }
          }
        }
      }
    }
  }
  return affectedPackages;
}
function extractReferences2(item) {
  const references = [];
  if (item.html_url !== void 0 && item.html_url !== "") {
    references.push(item.html_url);
  }
  if (item.advisory_url !== void 0 && item.advisory_url !== "") {
    references.push(item.advisory_url);
  }
  return references;
}
function mapGitHubAdvisory(item) {
  const ghsaId = item.ghsa_id ?? item.id ?? "";
  const summary = item.summary ?? "";
  const description = item.description ?? "";
  const severityRaw = item.severity ?? "UNKNOWN";
  const severity = severityRaw.toUpperCase();
  const published = item.published_at ?? "";
  const modified = item.updated_at ?? "";
  const cveId = item.cve_id ?? "";
  const affectedPackages = extractAffectedPackages(item);
  const references = extractReferences2(item);
  return {
    id: ghsaId,
    source: "github",
    severity,
    summary,
    description,
    published,
    modified,
    cveId,
    references,
    affectedPackages
  };
}

// src/security/github-advisories.ts
var githubCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 1e4,
  name: "GitHub API",
  isTransientError
});
var GITHUB_API_BASE = "https://api.github.com";
var DEFAULT_MAX_RESULTS2 = 20;
async function searchGitHubAdvisories(terms, options) {
  const startTime = Date.now();
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS2;
  const advisories = [];
  let error = void 0;
  try {
    let allAdvisories = [];
    if (options?.repo !== void 0 && options.repo !== "") {
      const repoParts = options.repo.split("/");
      if (repoParts.length !== 2 || repoParts[0] === "" || repoParts[1] === "") {
        throw new Error(`Invalid repo format: "${options.repo}". Expected "owner/name".`);
      }
      const [owner, name] = repoParts;
      const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/security-advisories?per_page=${maxResults}`;
      const response = await githubCircuitBreaker.execute(() => retryWithBackoff(async () => {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "pi-research/2.0",
            "Accept": "application/vnd.github.v3+json"
          },
          signal: createTimeoutSignal(1e4)
        });
        if (!resp.ok) {
          if (resp.status === 404) {
            throw new Error(`Repository "${owner}/${name}" not found or no access to security advisories.`);
          }
          if (resp.status === 403) {
            metrics.increment("github_ratelimit_hits_total", 1, { endpoint: "repo_advisories" });
            throw new Error("GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...");
          }
          if (resp.status >= 500) {
            throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
          }
          throw new Error(`GitHub API error (${resp.status}): ${resp.statusText}`);
        }
        const rateLimitRemaining = resp.headers?.get ? resp.headers.get("X-RateLimit-Remaining") : null;
        const rateLimitLimit = resp.headers?.get ? resp.headers.get("X-RateLimit-Limit") : null;
        if (rateLimitRemaining !== null) {
          metrics.setGauge("github_ratelimit_remaining", parseInt(rateLimitRemaining, 10), { endpoint: "repo_advisories" });
        }
        if (rateLimitLimit !== null) {
          metrics.setGauge("github_ratelimit_limit", parseInt(rateLimitLimit, 10), { endpoint: "repo_advisories" });
        }
        metrics.increment("github_requests_total", 1, { endpoint: "repo_advisories", status: "success" });
        return resp;
      }, {
        maxRetries: 2,
        initialDelay: 1e3,
        maxDelay: 5e3
      }));
      const data = await response.json();
      let repoAdvisories = [];
      if (isGitHubAdvisoryArray(data)) {
        repoAdvisories = data;
      } else if (isGitHubAdvisoryListResponse(data) && isArray(data.items)) {
        repoAdvisories = data.items.filter(isGitHubAdvisoryRaw);
      } else if (isSingleGitHubAdvisory(data)) {
        repoAdvisories = [data];
      }
      allAdvisories = repoAdvisories.map(mapGitHubAdvisory);
    } else {
      const termResults = [];
      for (const term of terms) {
        const termUpper = term.toUpperCase();
        let apiUrl;
        let endpointType;
        if (termUpper.startsWith("CVE-")) {
          apiUrl = `${GITHUB_API_BASE}/advisories?cve_id=${encodeURIComponent(termUpper)}&per_page=${maxResults}`;
          endpointType = "cve_lookup";
        } else if (termUpper.startsWith("GHSA-")) {
          apiUrl = `${GITHUB_API_BASE}/advisories/${encodeURIComponent(term)}`;
          endpointType = "ghsa_lookup";
        } else {
          apiUrl = `${GITHUB_API_BASE}/advisories?per_page=${maxResults}&state=published&direction=desc`;
          endpointType = "search";
        }
        const response = await retryWithBackoff(async () => {
          const resp = await fetch(apiUrl, {
            headers: {
              "User-Agent": "pi-research/2.0",
              "Accept": "application/vnd.github.v3+json"
            },
            signal: createTimeoutSignal(1e4)
          });
          if (!resp.ok) {
            if (resp.status === 404) {
              throw new Error("Advisory not found (HTTP 404)");
            }
            if (resp.status === 403) {
              metrics.increment("github_ratelimit_hits_total", 1, { endpoint: endpointType });
              throw new Error("GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...");
            }
            if (resp.status >= 500) {
              throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
            }
            throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
          }
          const rateLimitRemaining = resp.headers?.get ? resp.headers.get("X-RateLimit-Remaining") : null;
          const rateLimitLimit = resp.headers?.get ? resp.headers.get("X-RateLimit-Limit") : null;
          if (rateLimitRemaining !== null) {
            metrics.setGauge("github_ratelimit_remaining", parseInt(rateLimitRemaining, 10), { endpoint: endpointType });
          }
          if (rateLimitLimit !== null) {
            metrics.setGauge("github_ratelimit_limit", parseInt(rateLimitLimit, 10), { endpoint: endpointType });
          }
          metrics.increment("github_requests_total", 1, { endpoint: endpointType, status: "success" });
          return resp;
        }, {
          maxRetries: 2,
          initialDelay: 1e3,
          maxDelay: 5e3
        });
        const data = await response.json();
        let items = [];
        if (isGitHubAdvisoryArray(data)) {
          items = data;
        } else if (isSingleGitHubAdvisory(data)) {
          items = [data];
        } else if (isGitHubAdvisoryListResponse(data) && isArray(data.items)) {
          items = data.items.filter(isGitHubAdvisoryRaw);
        }
        metrics.increment(items.length > 0 ? "github_cache_hits_total" : "github_cache_misses_total", 1, { term, endpoint: endpointType });
        termResults.push(...items.map(mapGitHubAdvisory));
      }
      const seen = /* @__PURE__ */ new Set();
      for (const adv of termResults) {
        if (adv.id && !seen.has(adv.id)) {
          seen.add(adv.id);
          allAdvisories.push(adv);
        } else if (!adv.id) {
          allAdvisories.push(adv);
        }
      }
    }
    if (terms.length > 0) {
      allAdvisories = allAdvisories.filter((adv) => {
        if (terms.length === 0) return true;
        return terms.some((term) => {
          const t = term.toLowerCase();
          const advId = (adv.id || "").toLowerCase();
          const advSummary = (adv.summary || "").toLowerCase();
          const advDescription = (adv.description || "").toLowerCase();
          const advCveId = (adv.cveId || "").toLowerCase();
          if (advId === t || advCveId === t) return true;
          return advId.includes(t) || advCveId.includes(t) || advSummary.includes(t) || advDescription.includes(t);
        });
      });
    }
    if (options?.severity !== void 0 && options.severity !== "") {
      const severity = options.severity.toUpperCase();
      const githubSeverity = severity === "MEDIUM" ? "MODERATE" : severity;
      allAdvisories = allAdvisories.filter(
        (adv) => adv.severity === githubSeverity
      );
    }
    advisories.push(...allAdvisories.slice(0, maxResults));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    metrics.increment("github_search_errors_total", 1, { error_type: err instanceof Error ? err.name : "unknown" });
  } finally {
    const duration = Date.now() - startTime;
    metrics.observe("github_search_duration_ms", duration, { has_error: error ? "true" : "false" });
  }
  return {
    count: advisories.length,
    advisories,
    error
  };
}
async function getAdvisoryById(id) {
  const startTime = Date.now();
  try {
    if (id === "") {
      return null;
    }
    const url = `${GITHUB_API_BASE}/advisories/${encodeURIComponent(id)}`;
    const response = await githubCircuitBreaker.execute(() => retryWithBackoff(async () => {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "pi-research/2.0",
          "Accept": "application/vnd.github.v3+json"
        },
        signal: createTimeoutSignal(1e4)
      });
      if (!resp.ok) {
        if (resp.status === 404) {
          throw new Error("Advisory not found (HTTP 404)");
        }
        if (resp.status === 403) {
          metrics.increment("github_ratelimit_hits_total", 1, { endpoint: "advisory_by_id" });
          throw new Error("GitHub API rate limit exceeded (HTTP 403). Retrying with backoff...");
        }
        if (resp.status >= 500) {
          throw new Error(`GitHub server error (HTTP ${resp.status}). Retrying with backoff...`);
        }
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const rateLimitRemaining = resp.headers.get("X-RateLimit-Remaining");
      const rateLimitLimit = resp.headers.get("X-RateLimit-Limit");
      if (rateLimitRemaining !== null) {
        metrics.setGauge("github_ratelimit_remaining", parseInt(rateLimitRemaining, 10), { endpoint: "advisory_by_id" });
      }
      if (rateLimitLimit !== null) {
        metrics.setGauge("github_ratelimit_limit", parseInt(rateLimitLimit, 10), { endpoint: "advisory_by_id" });
      }
      metrics.increment("github_requests_total", 1, { endpoint: "advisory_by_id", status: "success" });
      return resp;
    }, {
      maxRetries: 2,
      initialDelay: 1e3,
      maxDelay: 5e3
    }));
    const data = await response.json();
    if (isGitHubAdvisoryRaw(data)) {
      const duration2 = Date.now() - startTime;
      metrics.observe("github_advisory_fetch_duration_ms", duration2, { found: "true" });
      return mapGitHubAdvisory(data);
    }
    const duration = Date.now() - startTime;
    metrics.observe("github_advisory_fetch_duration_ms", duration, { found: "false" });
    return null;
  } catch (err) {
    const duration = Date.now() - startTime;
    metrics.observe("github_advisory_fetch_duration_ms", duration, { found: "false", error: "true" });
    metrics.increment("github_advisory_fetch_errors_total", 1);
    if (err instanceof Error && err.message.includes("HTTP 404")) {
      logger.warn(`[GitHub Advisories] Advisory ${id} not found`);
      return null;
    }
    logger.error(`[GitHub Advisories] Error fetching advisory ${id}:`, err);
    return null;
  }
}

// src/security/osv-types.ts
function isOsvVulnerability(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const obj = value;
  return typeof obj["id"] === "string";
}
function isOsvQueryResponse(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const obj = value;
  return Array.isArray(obj["vulns"]);
}
function mapOsvItemToVulnerability(item) {
  const osvId = item.id;
  const summary = item.summary ?? item.details ?? "";
  const details = item.details ?? "";
  const published = item.published;
  const modified = item.modified ?? "";
  let severityStr;
  if (item.database_specific !== void 0 && typeof item.database_specific.severity === "string") {
    severityStr = item.database_specific.severity;
  }
  const severity = mapOsvSeverity(severityStr);
  const aliases = item.aliases ?? [];
  const references = [...aliases];
  if (item.references !== void 0) {
    for (const ref of item.references) {
      if (ref.url !== void 0 && ref.url !== "") {
        references.push(ref.url);
      }
    }
  }
  const affectedProducts = [];
  const fixes = [];
  if (item.affected !== void 0) {
    for (const affectedEntry of item.affected) {
      const pkg = affectedEntry.package;
      if (pkg !== void 0) {
        const pkgName = pkg.name ?? (pkg.ecosystem_specific !== void 0 && typeof pkg.ecosystem_specific.name === "string" ? pkg.ecosystem_specific.name : "");
        if (pkgName !== "") {
          affectedProducts.push(pkgName);
        }
        if (affectedEntry.ranges !== void 0) {
          for (const range of affectedEntry.ranges) {
            const events = range.events;
            const introducedEvent = events.find(
              (e) => e.introduced !== void 0
            );
            const fixedEvent = events.find(
              (e) => e.fixed !== void 0
            );
            const lastAffectedEvent = events.find(
              (e) => e.last_affected !== void 0
            );
            const versionInfo = [];
            if (introducedEvent?.introduced !== void 0) {
              versionInfo.push(`introduced: ${introducedEvent.introduced}`);
            }
            if (fixedEvent?.fixed !== void 0) {
              versionInfo.push(`fixed: ${fixedEvent.fixed}`);
            }
            if (lastAffectedEvent?.last_affected !== void 0) {
              versionInfo.push(`last affected: ${lastAffectedEvent.last_affected}`);
            }
            if (versionInfo.length > 0 && pkgName !== "") {
              fixes.push(`${pkgName}: ${versionInfo.join(", ")}`);
            }
          }
        }
      }
    }
  }
  const cwes = [];
  if (item.database_specific !== void 0) {
    if (item.database_specific.cwe !== void 0 && Array.isArray(item.database_specific.cwe)) {
      for (const cwe of item.database_specific.cwe) {
        if (typeof cwe === "string") {
          cwes.push(cwe);
        } else if (typeof cwe === "object" && typeof cwe.id === "string") {
          cwes.push(cwe.id);
        }
      }
    }
  }
  return {
    id: osvId,
    source: "osv",
    severity,
    description: summary !== "" ? summary : details,
    published,
    modified,
    cvssScore: void 0,
    cvssVector: void 0,
    cwes,
    references,
    affectedProducts,
    fixes,
    knownExploited: false
  };
}
function mapOsvSeverity(severity) {
  if (severity === void 0 || severity === "") {
    return "UNKNOWN";
  }
  const upper = severity.toUpperCase();
  if (upper === "CRITICAL") {
    return "CRITICAL";
  }
  if (upper === "HIGH") {
    return "HIGH";
  }
  if (upper === "MEDIUM" || upper === "MODERATE") {
    return "MEDIUM";
  }
  if (upper === "LOW") {
    return "LOW";
  }
  return "UNKNOWN";
}

// src/security/osv-client.ts
var osvCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 1e4,
  name: "OSV API",
  isTransientError
});
var OSV_BASE_URL = "https://api.osv.dev/v1";
var DEFAULT_MAX_RESULTS3 = 20;
async function fetchWithRetry2(url, options) {
  const endpoint = new URL(url).pathname;
  return osvCircuitBreaker.execute(async () => {
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, options);
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
          error.status = response.status;
          metrics.increment("osv_errors_total", 1, { endpoint, status_code: response.status.toString() });
          if (response.status === 429) {
            metrics.increment("osv_ratelimit_hits_total", 1, { endpoint });
          }
          throw error;
        }
        metrics.increment("osv_requests_total", 1, { endpoint, status: "success" });
        return response;
      },
      {
        maxRetries: DEFAULT_MAX_RETRIES,
        initialDelay: DEFAULT_INITIAL_DELAY_MS,
        maxDelay: DEFAULT_MAX_DELAY_MS,
        label: `OSV API: ${url}`,
        isTransientError: (error) => {
          const status = error?.status;
          if (typeof status === "number") {
            return status === 429 || status === 403 || status >= 500;
          }
          return isTransientError(error);
        }
      }
    );
  });
}
async function searchOSV(terms, options) {
  const startTime = Date.now();
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS3;
  const vulnerabilities = [];
  let error = void 0;
  try {
    const allVulns = [];
    let skippedNoEcosystem = 0;
    for (const term of terms) {
      let response;
      const termUpper = term.toUpperCase();
      if (termUpper.startsWith("CVE-") || termUpper.startsWith("GHSA-") || termUpper.startsWith("OSV-")) {
        const normalizedId = termUpper.startsWith("GHSA-") ? `GHSA-${term.slice(term.indexOf("-") + 1).toLowerCase()}` : termUpper;
        const url = `${OSV_BASE_URL}/vulns/${encodeURIComponent(normalizedId)}`;
        response = await fetchWithRetry2(url, {
          headers: { "User-Agent": "pi-research/2.0", "Accept": "application/json" },
          signal: createTimeoutSignal(OSV_TIMEOUT_MS)
        });
      } else {
        if (options?.ecosystem === void 0 || options.ecosystem === "") {
          skippedNoEcosystem++;
          continue;
        }
        const body = { package: { name: term, ecosystem: options.ecosystem } };
        response = await fetchWithRetry2(`${OSV_BASE_URL}/query`, {
          method: "POST",
          headers: {
            "User-Agent": "pi-research/2.0",
            "Accept": "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal: createTimeoutSignal(OSV_TIMEOUT_MS)
        });
      }
      if (!response.ok) {
        logger.warn(`OSV query failed for "${term}": ${response.status}`);
        continue;
      }
      const data = await response.json();
      let items;
      if (isOsvVulnerability(data)) {
        items = [data];
      } else if (isOsvQueryResponse(data)) {
        items = data.vulns ?? [];
      } else {
        logger.warn(`OSV returned unexpected format for "${term}"`);
        continue;
      }
      const endpoint = termUpper.startsWith("CVE-") || termUpper.startsWith("GHSA-") || termUpper.startsWith("OSV-") ? "vulns_by_id" : "query";
      metrics.increment(items.length > 0 ? "osv_cache_hits_total" : "osv_cache_misses_total", 1, { term, endpoint });
      for (const item of items) {
        const vuln = mapOsvItemToVulnerability(item);
        if (options?.severity !== void 0 && options.severity !== "") {
          const severity = options.severity.toUpperCase();
          if (vuln.severity !== severity) {
            continue;
          }
        }
        allVulns.push(vuln);
      }
    }
    const uniqueVulns = /* @__PURE__ */ new Map();
    for (const vuln of allVulns) {
      if (!uniqueVulns.has(vuln.id)) {
        uniqueVulns.set(vuln.id, vuln);
      }
    }
    vulnerabilities.push(...Array.from(uniqueVulns.values()));
    if (skippedNoEcosystem > 0) {
      error = `${skippedNoEcosystem} term(s) require the ecosystem parameter for OSV package search (e.g., ecosystem: "npm"). CVE/GHSA/OSV IDs work without it.`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    metrics.increment("osv_search_errors_total", 1, { error_type: err instanceof Error ? err.name : "unknown" });
  } finally {
    const duration = Date.now() - startTime;
    metrics.observe("osv_search_duration_ms", duration, { has_error: error ? "true" : "false" });
  }
  return {
    count: vulnerabilities.length,
    vulnerabilities: vulnerabilities.slice(0, maxResults),
    error
  };
}
async function getOSVById(osvId) {
  const startTime = Date.now();
  try {
    const url = `${OSV_BASE_URL}/vulns/${encodeURIComponent(osvId)}`;
    const response = await fetchWithRetry2(url, {
      headers: {
        "User-Agent": "pi-research/2.0",
        "Accept": "application/json"
      },
      signal: createTimeoutSignal(OSV_TIMEOUT_MS)
    });
    const data = await response.json();
    if (!isOsvVulnerability(data)) {
      const duration2 = Date.now() - startTime;
      metrics.observe("osv_vuln_fetch_duration_ms", duration2, { found: "false" });
      logger.error(`OSV ${osvId} returned unexpected format`);
      return null;
    }
    const duration = Date.now() - startTime;
    metrics.observe("osv_vuln_fetch_duration_ms", duration, { found: "true" });
    return mapOsvItemToVulnerability(data);
  } catch (err) {
    const duration = Date.now() - startTime;
    metrics.observe("osv_vuln_fetch_duration_ms", duration, { found: "false", error: "true" });
    metrics.increment("osv_vuln_fetch_errors_total", 1);
    logger.error(`Error fetching OSV ${osvId}:`, err);
    return null;
  }
}

// src/security/index.ts
function isValidSeverity(value) {
  return typeof value === "string" && (value === "LOW" || value === "MEDIUM" || value === "HIGH" || value === "CRITICAL");
}
function getSeverityParam(params) {
  if (params.severity === void 0) return void 0;
  return isValidSeverity(params.severity) ? params.severity : void 0;
}
function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
var DEFAULT_CONFIG = {
  nvdClient: void 0,
  cisaKevClient: void 0,
  githubAdvisoriesClient: void 0,
  osvClient: void 0,
  requestDelay: -1
  // Use database-specific logic by default
};
var SecuritySearcher = class {
  config;
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  async search(params) {
    const startTime = Date.now();
    const results = {};
    const errors = [];
    let totalVulnerabilities = 0;
    const searchPromises = [];
    if (params.databases.includes("nvd")) {
      searchPromises.push((async () => {
        try {
          const nvdResult = await this.searchNVD(params.terms, {
            severity: getSeverityParam(params),
            maxResults: params.maxResults,
            includeExploited: params.includeExploited
          });
          results.nvd = nvdResult;
          totalVulnerabilities += nvdResult.count;
        } catch (err) {
          errors.push(`NVD: ${getErrorMessage(err)}`);
        }
      })());
    }
    if (params.databases.includes("cisa_kev")) {
      searchPromises.push((async () => {
        try {
          const cisaResult = await this.searchCisaKev(params.terms, { maxResults: params.maxResults });
          results.cisa_kev = cisaResult;
          totalVulnerabilities += cisaResult.count;
        } catch (err) {
          errors.push(`CISA KEV: ${getErrorMessage(err)}`);
        }
      })());
    }
    if (params.databases.includes("github")) {
      searchPromises.push((async () => {
        try {
          const githubResult = await this.searchGitHub(params.terms, {
            ecosystem: params.ecosystem,
            severity: params.severity,
            maxResults: params.maxResults,
            repo: params.githubRepo
          });
          results.github = githubResult;
          totalVulnerabilities += githubResult.count;
        } catch (err) {
          errors.push(`GitHub: ${getErrorMessage(err)}`);
        }
      })());
    }
    if (params.databases.includes("osv")) {
      searchPromises.push((async () => {
        try {
          const osvResult = await this.searchOSV(params.terms, {
            ecosystem: params.ecosystem,
            severity: params.severity,
            maxResults: params.maxResults
          });
          results.osv = osvResult;
          totalVulnerabilities += osvResult.count;
        } catch (err) {
          errors.push(`OSV: ${getErrorMessage(err)}`);
        }
      })());
    }
    await Promise.all(searchPromises);
    let delay = this.config.requestDelay ?? -1;
    if (delay === -1) {
      delay = params.databases.includes("nvd") ? REQUEST_DELAY_MS_NVD : REQUEST_DELAY_MS_OTHER;
    }
    if (delay > 0) {
      await new Promise((resolve5) => {
        const timeoutId = setTimeout(resolve5, delay);
        safeUnref(timeoutId);
      });
    }
    return { results, totalDatabases: Object.keys(results).length, totalVulnerabilities, duration: Date.now() - startTime };
  }
  async searchNVD(terms, options) {
    const client = this.config.nvdClient ?? createDefaultNVDClient();
    return client.search(terms, options);
  }
  async searchCisaKev(terms, options) {
    const client = this.config.cisaKevClient ?? createDefaultCisaKevClient();
    return client.search(terms, options);
  }
  async searchGitHub(terms, options) {
    const client = this.config.githubAdvisoriesClient ?? createDefaultGitHubClient();
    return client.search(terms, options);
  }
  async searchOSV(terms, options) {
    const client = this.config.osvClient ?? createDefaultOSVClient();
    return client.search(terms, options);
  }
};
var DefaultNVDClient = class {
  async search(terms, options) {
    return searchNVD(terms, options);
  }
  async getById(cveId) {
    return getCVEById(cveId);
  }
};
var DefaultCisaKevClient = class {
  async search(terms, options) {
    return searchCisaKev(terms, options);
  }
};
var DefaultGitHubClient = class {
  async search(terms, options) {
    return searchGitHubAdvisories(terms, options);
  }
  async getById(id) {
    return getAdvisoryById(id);
  }
};
var DefaultOSVClient = class {
  async search(terms, options) {
    return searchOSV(terms, options);
  }
  async getById(osvId) {
    return getOSVById(osvId);
  }
};
function createDefaultNVDClient() {
  return new DefaultNVDClient();
}
function createDefaultCisaKevClient() {
  return new DefaultCisaKevClient();
}
function createDefaultGitHubClient() {
  return new DefaultGitHubClient();
}
function createDefaultOSVClient() {
  return new DefaultOSVClient();
}
var globalSearcher = null;
function getSecuritySearcher() {
  if (!globalSearcher) globalSearcher = new SecuritySearcher();
  return globalSearcher;
}
async function searchSecurityDatabases(params) {
  return getSecuritySearcher().search(params);
}

// src/tools/security.ts
function createSecuritySearchTool(options) {
  const SecuritySearchParamsSchema = Type6.Object({
    databases: Type6.Optional(Type6.Array(Type6.String({
      description: "Databases to search (default: all): nvd, cisa_kev, github, osv"
    }))),
    terms: Type6.Array(Type6.String({
      description: "Search terms: CVE IDs (e.g., CVE-2024-1234), package names, keywords"
    }), { minItems: 1 }),
    severity: Type6.Optional(Type6.String({
      description: "Filter by severity: LOW, MEDIUM, HIGH, CRITICAL"
    })),
    maxResults: Type6.Optional(Type6.Number({
      description: "Max results per database (default: 20)",
      default: 20,
      minimum: 1,
      maximum: 100
    })),
    includeExploited: Type6.Optional(Type6.Boolean({
      description: "Only include actively exploited vulnerabilities",
      default: false
    })),
    ecosystem: Type6.Optional(Type6.String({
      description: "Package ecosystem for OSV: npm, pip, maven, go, rust, cargo, etc."
    })),
    githubRepo: Type6.Optional(Type6.String({
      description: 'GitHub repository for advisories: "owner/repo" format'
    }))
  });
  return {
    name: "security_search",
    label: "Security Search",
    description: "Search security vulnerability databases (NVD, CISA KEV, GitHub Advisories, OSV). Returns CVEs, advisories, and vulnerability details. Filter by severity, CVE ID, package name, or include only actively exploited vulnerabilities.",
    promptSnippet: "Search security vulnerability databases for CVEs and advisories",
    promptGuidelines: [
      "Available for looking up CVE IDs, package vulnerabilities, or security advisories.",
      "Supports databases: NVD (340k+ CVEs), CISA KEV (actively exploited), GitHub Advisories (open source), OSV (packages).",
      "Filter by severity, CVE ID, package name, or include only actively exploited vulnerabilities.",
      `CRITICAL: You are allowed a maximum of ${MAX_GATHERING_CALLS} gathering calls total across ALL tools. Use them for breadth.`
    ],
    parameters: SecuritySearchParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      const startTime = Date.now();
      metrics.increment("tool_security_search_calls_total", 1);
      const allowed = options.tracker.recordCall("security_search");
      if (!allowed) {
        metrics.increment("tool_security_search_calls_total", 1, { status: "rate_limited" });
        return {
          content: [{ type: "text", text: options.tracker.getLimitMessage("security_search") }],
          details: { blocked: true, reason: "limit_reached" }
        };
      }
      if (!Value7.Check(SecuritySearchParamsSchema, params)) {
        metrics.increment("tool_security_search_calls_total", 1, { status: "invalid_params" });
        return {
          content: [{ type: "text", text: "Invalid parameters for security_search tool." }],
          details: { error: "invalid_parameters" }
        };
      }
      const p = params;
      const terms = p.terms;
      if (terms.length === 0) {
        metrics.increment("tool_security_search_calls_total", 1, { status: "no_terms" });
        throw new Error("At least one search term is required");
      }
      const databases = p.databases !== void 0 && p.databases.length > 0 ? p.databases : ["nvd", "cisa_kev", "github", "osv"];
      const maxResults = p.maxResults ?? 20;
      metrics.increment("tool_security_search_terms_total", terms.length);
      metrics.increment("tool_security_search_databases_total", databases.length);
      let results;
      try {
        const searchParams = {
          terms,
          databases,
          severity: p.severity,
          maxResults,
          includeExploited: p.includeExploited ?? false,
          ecosystem: p.ecosystem,
          githubRepo: p.githubRepo
        };
        results = await searchSecurityDatabases(searchParams);
      } catch (error) {
        const duration = Date.now() - startTime;
        metrics.observe("tool_security_search_duration_ms", duration, { status: "error" });
        metrics.increment("tool_security_search_calls_total", 1, { status: "error" });
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `# Security Vulnerability Search Failed

**Error:** ${errorMsg}

**Databases:** ${databases.join(", ")}

**Terms:** ${terms.join(", ")}

Unable to search security databases. This may be a temporary issue - try again later.`
            }
          ],
          details: {
            error: errorMsg,
            databases,
            terms,
            duration
          }
        };
      }
      const elapsed = Date.now() - startTime;
      metrics.observe("tool_security_search_duration_ms", elapsed, { status: "success" });
      metrics.increment("tool_security_search_calls_total", 1, { status: "success" });
      metrics.increment("tool_security_search_vulnerabilities_total", results.totalVulnerabilities);
      if (results.results.nvd?.count) {
        metrics.increment("tool_security_search_vulnerabilities_total", results.results.nvd.count, { database: "nvd" });
      }
      if (results.results.cisa_kev?.count) {
        metrics.increment("tool_security_search_vulnerabilities_total", results.results.cisa_kev.count, { database: "cisa_kev" });
      }
      if (results.results.github?.count) {
        metrics.increment("tool_security_search_vulnerabilities_total", results.results.github.count, { database: "github" });
      }
      if (results.results.osv?.count) {
        metrics.increment("tool_security_search_vulnerabilities_total", results.results.osv.count, { database: "osv" });
      }
      let markdown = "# Security Vulnerability Search Results\n\n";
      markdown += `**Source: Security Databases**

`;
      markdown += `**Searched:** ${databases.join(", ")}
`;
      markdown += `**Terms:** ${terms.join(", ")}
`;
      markdown += `**Duration:** ${(elapsed / 1e3).toFixed(2)}s

`;
      markdown += `**Total Vulnerabilities Found:** ${results.totalVulnerabilities}

`;
      if (results.results.nvd !== void 0) {
        markdown += "## NIST NVD\n\n";
        if (results.results.nvd.error !== void 0) {
          markdown += `[Error] ${results.results.nvd.error}

`;
        } else {
          markdown += `Found: ${results.results.nvd.count} vulnerabilities

`;
          for (const vuln of results.results.nvd.vulnerabilities.slice(0, 20)) {
            markdown += `### ${vuln.id}
`;
            markdown += `- **Severity:** ${vuln.severity}
`;
            if (vuln.cvssScore !== void 0) {
              markdown += `- **CVSS Score:** ${vuln.cvssScore}
`;
              if (vuln.cvssVector !== void 0) {
                markdown += `- **CVSS Vector:** ${vuln.cvssVector}
`;
              }
            }
            const description = vuln.description;
            markdown += `- **Description:** ${description.length > 300 ? `${description.substring(0, 300)}...` : description}
`;
            if (vuln.knownExploited === true) {
              markdown += "- **[Actively Exploited]**\n";
            }
            if (vuln.published !== void 0) {
              markdown += `- **Published:** ${vuln.published}
`;
            }
            if (vuln.cwes !== void 0 && vuln.cwes.length > 0) {
              markdown += `- **CWEs:** ${vuln.cwes.join(", ")}
`;
            }
            if (vuln.references !== void 0 && vuln.references.length > 0) {
              markdown += `- **References:** ${vuln.references.slice(0, 3).join(", ")}
`;
            }
            markdown += "\n";
          }
          if (results.results.nvd.vulnerabilities.length > 20) {
            const moreCount = results.results.nvd.vulnerabilities.length - 20;
            const moreText = moreCount === 1 ? "vulnerability" : "vulnerabilities";
            markdown += `
*... and ${moreCount} more ${moreText} not shown.*
`;
          }
        }
        markdown += "\n---\n\n";
      }
      if (results.results.cisa_kev !== void 0) {
        markdown += "## CISA Known Exploited Vulnerabilities\n\n";
        if (results.results.cisa_kev.error !== void 0) {
          markdown += `[Error] ${results.results.cisa_kev.error}

`;
        } else {
          markdown += `Found: ${results.results.cisa_kev.count} actively exploited vulnerabilities

`;
          for (const vuln of results.results.cisa_kev.vulnerabilities.slice(0, 20)) {
            markdown += `### ${vuln.id}
`;
            if (vuln.vendor !== void 0) {
              markdown += `- **Vendor:** ${vuln.vendor}
`;
            }
            if (vuln.product !== void 0) {
              markdown += `- **Product:** ${vuln.product}
`;
            }
            const description = vuln.description;
            markdown += `- **Description:** ${description.length > 300 ? `${description.substring(0, 300)}...` : description}
`;
            if (vuln.dueDate !== void 0) {
              markdown += `- **Due Date:** ${vuln.dueDate}
`;
            }
            if (vuln.requiredAction !== void 0) {
              markdown += `- **Required Action:** ${vuln.requiredAction}
`;
            }
            markdown += "\n";
          }
          if (results.results.cisa_kev.vulnerabilities.length > 20) {
            const moreCount = results.results.cisa_kev.vulnerabilities.length - 20;
            const moreText = moreCount === 1 ? "vulnerability" : "vulnerabilities";
            markdown += `
*... and ${moreCount} more ${moreText} not shown.*
`;
          }
        }
        markdown += "\n---\n\n";
      }
      if (results.results.github !== void 0) {
        markdown += "## GitHub Security Advisories\n\n";
        if (results.results.github.error !== void 0) {
          markdown += `[Error] ${results.results.github.error}

`;
        } else {
          markdown += `Found: ${results.results.github.count} advisories

`;
          for (const adv of results.results.github.advisories.slice(0, 20)) {
            markdown += `### ${adv.id}
`;
            markdown += `- **Severity:** ${adv.severity}
`;
            if (adv.cveId) {
              markdown += `- **CVE ID:** ${adv.cveId}
`;
            }
            markdown += `- **Summary:** ${adv.summary}
`;
            const description = adv.description ?? "";
            markdown += `- **Description:** ${description.length > 300 ? `${description.substring(0, 300)}...` : description}
`;
            if (adv.published) {
              markdown += `- **Published:** ${adv.published}
`;
            }
            if (adv.affectedPackages && adv.affectedPackages.length > 0) {
              markdown += `- **Affected:** ${adv.affectedPackages.join(", ")}
`;
            }
            markdown += "\n";
          }
          if (results.results.github.advisories.length > 20) {
            const moreCount = results.results.github.advisories.length - 20;
            const moreText = moreCount === 1 ? "advisory" : "advisories";
            markdown += `
*... and ${moreCount} more ${moreText} not shown.*
`;
          }
        }
        markdown += "\n---\n\n";
      }
      if (results.results.osv !== void 0) {
        markdown += "## Open Source Vulnerabilities (OSV)\n\n";
        if (results.results.osv.error !== void 0) {
          markdown += `[Error] ${results.results.osv.error}

`;
        } else {
          markdown += `Found: ${results.results.osv.count} vulnerabilities

`;
          for (const vuln of results.results.osv.vulnerabilities.slice(0, 20)) {
            markdown += `### ${vuln.id}
`;
            markdown += `- **Severity:** ${vuln.severity}
`;
            const description = vuln.description;
            markdown += `- **Description:** ${description.length > 300 ? `${description.substring(0, 300)}...` : description}
`;
            if (vuln.affectedProducts && vuln.affectedProducts.length > 0) {
              markdown += `- **Affected:** ${vuln.affectedProducts.join(", ")}
`;
            }
            if (vuln.fixes && vuln.fixes.length > 0) {
              markdown += `- **Fixes:** ${vuln.fixes.slice(0, 3).join("; ")}
`;
            }
            markdown += "\n";
          }
          if (results.results.osv.vulnerabilities.length > 20) {
            const moreCount = results.results.osv.vulnerabilities.length - 20;
            const moreText = moreCount === 1 ? "vulnerability" : "vulnerabilities";
            markdown += `
*... and ${moreCount} more ${moreText} not shown.*
`;
          }
        }
        markdown += "\n---\n\n";
      }
      return {
        content: [{ type: "text", text: markdown }],
        details: {
          results,
          totalDatabases: results.totalDatabases,
          totalVulnerabilities: results.totalVulnerabilities,
          duration: elapsed
        }
      };
    }
  };
}

// src/tools/stackexchange.ts
import { Type as Type7 } from "typebox";
import { Value as Value8 } from "typebox/value";

// src/stackexchange/rest-client.ts
var API_BASE = "https://api.stackexchange.com/2.3";
var StackExchangeClient = class {
  _apiKey;
  _timeout;
  quotaRemaining = 300;
  quotaMax = 300;
  requestCount = 0;
  lastBackoff = null;
  circuitBreaker;
  constructor(apiKey, timeout) {
    this._apiKey = apiKey;
    this._timeout = timeout;
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 1e4,
      name: "StackExchange API",
      isTransientError: (err) => {
        if (err instanceof Error) {
          const msg = err.message.toLowerCase();
          return msg.includes("timeout") || msg.includes("network") || msg.includes("econn") || msg.includes("50") || msg.includes("429");
        }
        return true;
      }
    });
  }
  async request(options, signal) {
    const startTime = Date.now();
    return this.circuitBreaker.execute(async () => {
      if (this.lastBackoff && this.lastBackoff > Date.now()) {
        const waitTime = Math.ceil((this.lastBackoff - Date.now()) / 1e3);
        metrics.increment("stackexchange_backoff_wait_total", 1);
        throw new Error(
          `Rate limited. Please wait ${waitTime} seconds before making more requests.`
        );
      }
      const url = new URL(`${API_BASE}${options.endpoint}`);
      url.search = options.params.toString();
      if (this._apiKey) {
        url.searchParams.set("key", this._apiKey);
      }
      if (!url.searchParams.has("site") && !options.endpoint.startsWith("/sites")) {
        url.searchParams.set("site", "stackoverflow.com");
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this._timeout);
      const abortHandler = () => {
        clearTimeout(timeoutId);
        controller.abort();
      };
      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      try {
        const response = await fetch(url.toString(), {
          method: options.method,
          signal: controller.signal,
          headers: {
            "Accept": "application/json"
          }
        });
        clearTimeout(timeoutId);
        const data = await response.json();
        if (data.error_id) {
          const errorName = data.error_name ?? "unknown";
          metrics.increment("stackexchange_errors_total", 1, {
            endpoint: options.endpoint,
            error_id: data.error_id.toString(),
            error_name: errorName
          });
          throw new Error(
            `Stack Exchange API Error (${data.error_id} - ${data.error_name}): ${data.error_message}`
          );
        }
        this.quotaRemaining = data.quota_remaining;
        this.quotaMax = data.quota_max;
        this.requestCount++;
        metrics.setGauge("stackexchange_quota_remaining", this.quotaRemaining);
        metrics.setGauge("stackexchange_quota_max", this.quotaMax);
        metrics.setGauge("stackexchange_quota_used", this.quotaMax - this.quotaRemaining);
        if (data.backoff) {
          this.lastBackoff = Date.now() + data.backoff * 1e3;
          metrics.increment("stackexchange_backoff_total", 1, { seconds: data.backoff.toString() });
          metrics.observe("stackexchange_backoff_duration_seconds", data.backoff);
          logger.warn(`[StackExchange] Backoff required: ${data.backoff} seconds`);
        }
        metrics.increment("stackexchange_requests_total", 1, { endpoint: options.endpoint, status: "success" });
        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        metrics.observe("stackexchange_request_duration_ms", duration, { endpoint: options.endpoint, status: "error" });
        metrics.increment("stackexchange_requests_total", 1, { endpoint: options.endpoint, status: "error" });
        if (error instanceof Error && error.name === "AbortError") {
          metrics.increment("stackexchange_timeouts_total", 1, { endpoint: options.endpoint });
          throw new Error(`Request timeout after ${this._timeout}ms`, { cause: error });
        }
        throw error;
      } finally {
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
      }
    });
  }
  getQuotaInfo() {
    const info = {
      remaining: this.quotaRemaining,
      max: this.quotaMax,
      requestCount: this.requestCount,
      lastBackoff: this.lastBackoff
    };
    if (this.isQuotaExhausted()) {
      metrics.increment("stackexchange_quota_exhausted_total", 1);
    }
    if (this.isQuotaLow()) {
      metrics.increment("stackexchange_quota_low_total", 1);
    }
    return info;
  }
  isQuotaExhausted() {
    return this.quotaRemaining <= 0;
  }
  isQuotaLow() {
    return this.quotaRemaining < 30;
  }
};

// src/stackexchange/queries.ts
function buildSearchParams(params) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === void 0 || value === null) {
      continue;
    }
    if (typeof value === "boolean") {
      searchParams.set(key, value ? "true" : "false");
    } else if (Array.isArray(value)) {
      searchParams.set(key, value.join(";"));
    } else {
      searchParams.set(key, String(value));
    }
  }
  return searchParams;
}
function buildSearchQuery(params) {
  return buildSearchParams(params);
}
function buildQuestionsQuery(params) {
  const searchParams = new URLSearchParams();
  searchParams.set("order", params.order ?? "desc");
  searchParams.set("sort", params.sort ?? "activity");
  searchParams.set("site", params.site ?? "stackoverflow.com");
  if (params.filter) {
    searchParams.set("filter", params.filter);
  }
  if (params.page) {
    searchParams.set("page", String(params.page));
  }
  if (params.pagesize) {
    searchParams.set("pagesize", String(params.pagesize));
  }
  return searchParams;
}
function buildUserQuery(params) {
  const searchParams = new URLSearchParams();
  searchParams.set("site", params.site ?? "stackoverflow.com");
  searchParams.set("order", params.order ?? "desc");
  searchParams.set("sort", params.sort ?? "reputation");
  if (params.filter) {
    searchParams.set("filter", params.filter);
  }
  if (params.page) {
    searchParams.set("page", String(params.page));
  }
  if (params.pagesize) {
    searchParams.set("pagesize", String(params.pagesize));
  }
  return searchParams;
}
function buildSitesQuery(params) {
  const searchParams = new URLSearchParams();
  if (params?.page) {
    searchParams.set("page", String(params.page));
  }
  if (params?.pagesize) {
    searchParams.set("pagesize", String(params.pagesize));
  }
  return searchParams;
}
var Filters = {
  // Get question body and answers with body
  WITH_BODY: "!9_bDDxJY5",
  // Minimal info - just title and score
  MINIMAL: "!-*f(6rL6Wq",
  // Minimal info - title, score, tags, owner
  // Full details including comments
  FULL: "!*S15IVPvS5",
  // Get answers with body
  ANSWERS_WITH_BODY: "!9_bDE(fI5"
};

// src/stackexchange/output/table.ts
function formatQuestionsTable(questions) {
  if (questions.length === 0) {
    return "No questions found.\n";
  }
  let output = "# Stack Exchange Questions\n\n";
  output += `Found: ${questions.length} question${questions.length !== 1 ? "s" : ""}

`;
  for (const q of questions) {
    output += `## ${q.title}

`;
    output += `- **Score:** ${q.score}
`;
    output += `- **Views:** ${q.view_count}
`;
    output += `- **Answers:** ${q.answer_count}${q.accepted_answer_id ? " [accepted]" : ""}
`;
    output += `- **Tags:** ${q.tags.join(", ")}
`;
    if (q.owner) {
      output += `- **Author:** ${q.owner.display_name} (rep: ${q.owner.reputation})
`;
    }
    output += `- **Link:** ${q.link}
`;
    output += `- **Created:** ${new Date(q.creation_date * 1e3).toLocaleString()}
`;
    if (q.body && q.body.length < 1e3) {
      output += `- **Body:** ${q.body.substring(0, 500)}...
`;
    }
    output += "\n---\n\n";
  }
  return output;
}
function formatAnswersTable(answers) {
  if (answers.length === 0) {
    return "No answers found.\n";
  }
  let output = "# Stack Exchange Answers\n\n";
  output += `Found: ${answers.length} answer${answers.length !== 1 ? "s" : ""}

`;
  for (const a of answers) {
    const authorName = a.owner?.display_name ?? "Unknown";
    output += `## Answer by ${authorName}

`;
    output += `- **Score:** ${a.score}${a.is_accepted ? " [Accepted]" : ""}
`;
    if (a.owner) {
      output += `- **Author:** ${a.owner.display_name} (rep: ${a.owner.reputation})
`;
    }
    output += `- **Question ID:** ${a.question_id}
`;
    output += `- **Created:** ${new Date(a.creation_date * 1e3).toLocaleString()}
`;
    if (a.body && a.body.length < 2e3) {
      output += `
### Answer Body

${a.body}
`;
    }
    output += "\n---\n\n";
  }
  return output;
}
function formatUsersTable(users) {
  if (users.length === 0) {
    return "No users found.\n";
  }
  let output = "# Stack Exchange Users\n\n";
  output += `Found: ${users.length} user${users.length !== 1 ? "s" : ""}

`;
  for (const u of users) {
    output += `## ${u.display_name}

`;
    output += `- **Reputation:** ${u.reputation}
`;
    output += `- **Badges:** gold:${u.badge_counts.gold} silver:${u.badge_counts.silver} bronze:${u.badge_counts.bronze}
`;
    output += `- **User ID:** ${u.user_id}
`;
    output += `- **Member since:** ${new Date(u.creation_date * 1e3).toLocaleDateString()}
`;
    if (u.location) {
      output += `- **Location:** ${u.location}
`;
    }
    if (u.website_url) {
      output += `- **Website:** ${u.website_url}
`;
    }
    output += `- **Profile:** ${u.link}
`;
    output += "\n---\n\n";
  }
  return output;
}
function formatSitesTable(sites) {
  if (sites.length === 0) {
    return "No sites found.\n";
  }
  let output = "# Stack Exchange Sites\n\n";
  output += `Found: ${sites.length} site${sites.length !== 1 ? "s" : ""}

`;
  output += "| Site | API Parameter | Audience |\n";
  output += "|------|---------------|----------|\n";
  for (const s of sites) {
    output += `| ${s.name} | \`${s.api_site_parameter}\` | ${s.audience || "N/A"} |
`;
  }
  return `${output}
`;
}
function formatCompactQuestions(questions) {
  if (questions.length === 0) {
    return "No questions found.\n";
  }
  let output = "";
  let index = 1;
  for (const q of questions) {
    const accepted = q.accepted_answer_id ? "[accepted]" : "";
    output += `${index}. [${q.title}](${q.link}) ${accepted} (score: ${q.score}, answers: ${q.answer_count})
`;
    index++;
  }
  return output;
}

// src/stackexchange/output/compact.ts
function formatUsersCompact(users) {
  if (users.length === 0) {
    return "No users found.";
  }
  const lines = [];
  let index = 1;
  for (const u of users) {
    const bc = u.badge_counts ?? { gold: 0, silver: 0, bronze: 0 };
    lines.push(`${index}. ${u.display_name} (rep: ${u.reputation}, gold:${bc.gold} silver:${bc.silver} bronze:${bc.bronze})`);
    index++;
  }
  return lines.join("\n");
}
function formatSitesCompact(sites) {
  if (sites.length === 0) {
    return "No sites found.";
  }
  const lines = [];
  let index = 1;
  for (const s of sites) {
    lines.push(`${index}. ${s.name} (\`${s.api_site_parameter}\`) - ${s.audience || "N/A"}`);
    index++;
  }
  return lines.join("\n");
}

// src/stackexchange/index.ts
function notify(ctx, message, type) {
  ctx.ui?.notify?.(message, type);
}
function loadConfig() {
  return {
    defaultSite: "stackoverflow.com",
    apiKey: process.env["STACKEXCHANGE_API_KEY"] ?? null,
    requestTimeout: 1e4
    // 10 seconds
  };
}
async function stackexchangeCommand(options) {
  const { command, params, ctx, signal, onUpdate: _onUpdate } = options;
  const config = loadConfig();
  const client = new StackExchangeClient(
    config.apiKey,
    config.requestTimeout
  );
  try {
    if (client.isQuotaExhausted()) {
      const quota2 = client.getQuotaInfo();
      notify(
        ctx,
        `Stack Exchange API quota exhausted (${quota2.remaining}/${quota2.max} remaining)`,
        "error"
      );
      return {
        content: [{ type: "text", text: `[Error] Stack Exchange API quota exhausted (${quota2.remaining}/${quota2.max} remaining). Please wait until the quota resets.` }],
        details: {
          quota: quota2,
          command
        }
      };
    }
    if (client.isQuotaLow()) {
      const quota2 = client.getQuotaInfo();
      notify(
        ctx,
        `Stack Exchange API quota low: ${quota2.remaining}/${quota2.max} remaining`,
        "warning"
      );
    }
    let result;
    switch (command) {
      case "search":
        result = await executeSearch(params, client, config, signal);
        break;
      case "get":
        result = await executeGet(params, client, config, signal);
        break;
      case "user":
        result = await executeUser(params, client, config, signal);
        break;
      case "site":
        result = await executeSite(params, client, config, signal);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
    const format = params["format"] ?? "table";
    let output;
    if (format === "json") {
      output = JSON.stringify(result, null, 2);
    } else if (format === "compact") {
      output = formatCompact(result);
    } else {
      output = formatTable(result);
    }
    const quota = client.getQuotaInfo();
    output += `
---
**Source: Stack Exchange**
**API Quota:** ${quota.remaining}/${quota.max} remaining
`;
    return {
      content: [{ type: "text", text: output }],
      details: {
        quota,
        command
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Stack Exchange error: ${message}`, "error");
    return {
      content: [{ type: "text", text: `[Error] Stack Exchange error: ${message}` }],
      details: {
        quota: client.getQuotaInfo(),
        command
      }
    };
  }
}
async function executeSearch(params, client, config, signal) {
  const query = params["query"];
  const site = params["site"] ?? config.defaultSite;
  const limit = Math.min(params["limit"] ?? 10, 100);
  const maxPages = params["maxPages"] ?? 5;
  const tagsInput = params["tags"];
  const tags = tagsInput ? tagsInput.split(",").map((t) => t.trim()).filter((t) => t.length > 0).join(";") : void 0;
  const allQuestions = [];
  const pageSize = Math.min(30, Math.ceil(limit / maxPages));
  for (let page = 1; page <= maxPages && allQuestions.length < limit; page++) {
    const queryParams = {
      order: "desc",
      sort: "relevance",
      q: query ?? void 0,
      tagged: tags ?? void 0,
      pagesize: pageSize,
      page,
      site
    };
    const searchParams = buildSearchQuery(queryParams);
    const response = await client.request(
      { method: "GET", endpoint: "/search/advanced", params: searchParams },
      signal
    );
    if (response.items.length === 0) {
      break;
    }
    allQuestions.push(...response.items);
  }
  return allQuestions.slice(0, limit);
}
async function executeGet(params, client, config, signal) {
  const id = params["id"];
  const site = params["site"] ?? config.defaultSite;
  if (id === void 0) {
    throw new Error("ID parameter is required for get command");
  }
  const questionParams = buildQuestionsQuery({
    ids: id,
    site,
    filter: Filters.WITH_BODY
  });
  const response = await client.request(
    { method: "GET", endpoint: `/questions/${encodeURIComponent(id)}`, params: questionParams },
    signal
  );
  if (response.items.length === 0) {
    throw new Error(`Question not found: ${id}`);
  }
  const question = response.items[0];
  if (question === void 0) {
    throw new Error("Question not found");
  }
  const answersParams = buildQuestionsQuery({
    ids: id,
    site,
    filter: Filters.ANSWERS_WITH_BODY
  });
  const answersResponse = await client.request(
    { method: "GET", endpoint: `/questions/${encodeURIComponent(id)}/answers`, params: answersParams },
    signal
  );
  return { question, answers: answersResponse.items };
}
async function executeUser(params, client, config, signal) {
  const id = params["id"];
  const site = params["site"] ?? config.defaultSite;
  const limit = Math.min(params["limit"] ?? 1, 100);
  if (id === void 0) {
    throw new Error("ID parameter is required for user command");
  }
  const userParams = buildUserQuery({
    ids: id,
    site,
    pagesize: limit
  });
  const response = await client.request(
    { method: "GET", endpoint: `/users/${id}`, params: userParams },
    signal
  );
  if (response.items.length === 0) {
    throw new Error(`User not found: ${id}`);
  }
  return response.items;
}
async function executeSite(_params, client, _config, signal) {
  const sitesParams = buildSitesQuery({ pagesize: 100 });
  const response = await client.request(
    { method: "GET", endpoint: "/sites", params: sitesParams },
    signal
  );
  return response.items;
}
function formatTable(result) {
  if (Array.isArray(result)) {
    const first = result[0];
    if (first && typeof first === "object") {
      if ("badge_counts" in first) {
        return formatUsersTable(result);
      }
      if ("api_site_parameter" in first) {
        return formatSitesTable(result);
      }
      if ("question_id" in first || "answer_id" in first) {
        if ("answer_id" in first) {
          return formatAnswersTable(result);
        }
        return formatQuestionsTable(result);
      }
    }
  } else if (typeof result === "object" && result !== null) {
    if ("question" in result && "answers" in result) {
      const r = result;
      let output = formatQuestionsTable([r.question]);
      if (r.answers.length > 0) {
        output += `
${formatAnswersTable(r.answers)}`;
      }
      return output;
    }
  }
  return JSON.stringify(result, null, 2);
}
function formatCompact(result) {
  if (Array.isArray(result)) {
    const first = result[0];
    if (first && typeof first === "object") {
      if ("badge_counts" in first) {
        return formatUsersCompact(result);
      }
      if ("api_site_parameter" in first) {
        return formatSitesCompact(result);
      }
      if ("question_id" in first) {
        return formatCompactQuestions(result);
      }
    }
  }
  return JSON.stringify(result);
}

// src/tools/stackexchange.ts
function createStackexchangeTool(options) {
  const { tracker } = options;
  const StackExchangeParamsSchema = Type7.Object({
    command: Type7.String({
      description: "Command: search, get, user, or site"
    }),
    query: Type7.Optional(Type7.String({
      description: "Search query (for search command)"
    })),
    id: Type7.Optional(Type7.Union([Type7.String(), Type7.Number()])),
    site: Type7.Optional(Type7.String({
      description: "Stack Exchange site (default: stackoverflow.com)"
    })),
    limit: Type7.Optional(Type7.Number({
      description: "Results count (1-100, default: 10)",
      default: 10,
      minimum: 1,
      maximum: 100
    })),
    maxPages: Type7.Optional(Type7.Number({
      description: "Maximum pages to fetch for pagination (1-10, default: 5)",
      default: 5,
      minimum: 1,
      maximum: 10
    })),
    format: Type7.Optional(Type7.String({
      description: "Output format: table, json, or compact (default: table)",
      default: "table"
    })),
    tags: Type7.Optional(Type7.String({
      description: "Filter by tags (comma-separated)"
    }))
  });
  return {
    name: "stackexchange",
    label: "Stack Exchange Search",
    description: "Search and retrieve data from Stack Exchange network via REST API v2.3 with pagination support (anonymous: 300 requests/day, with key: 10,000 requests/day)",
    promptSnippet: "Search Stack Overflow and other Stack Exchange sites for questions, answers, and user information",
    promptGuidelines: [
      "Available for finding technical answers on Stack Overflow",
      "Great for finding code solutions, debugging help, and best practices",
      "Works with any Stack Exchange site (Stack Overflow, SuperUser, AskUbuntu, etc.)",
      "Anonymous access: 300 requests/day. Set STACKEXCHANGE_API_KEY env var for 10,000/day.",
      "Use tags to filter by specific topics.",
      "Use maxPages parameter to control pagination for search results (default: 5 pages).",
      `CRITICAL: You are allowed a maximum of ${MAX_GATHERING_CALLS} gathering calls total across ALL tools. Use them for breadth.`
    ],
    parameters: StackExchangeParamsSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, extensionCtx) {
      const allowed = tracker.recordCall("stackexchange");
      if (!allowed) {
        return {
          content: [{ type: "text", text: tracker.getLimitMessage("stackexchange") }],
          details: { blocked: true, reason: "limit_reached" }
        };
      }
      if (!Value8.Check(StackExchangeParamsSchema, params)) {
        return {
          content: [{ type: "text", text: "Invalid parameters for stackexchange tool." }],
          details: { error: "invalid_parameters" }
        };
      }
      const p = params;
      const command = p.command;
      if (!command || typeof command !== "string") {
        throw new Error("Stack Exchange command is required and must be a string");
      }
      try {
        return await stackexchangeCommand({
          command,
          params: p,
          ctx: extensionCtx,
          signal
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `# Stack Exchange Search Failed

**Error:** ${errorMsg}

**Command:** ${command}

Failed to query Stack Exchange. This may be due to API rate limiting (300/day anonymous, 10,000/day with key), network issues, or invalid query parameters.`
            }
          ],
          details: {
            command,
            error: errorMsg
          }
        };
      }
    }
  };
}

// src/tools/grep.ts
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value as Value9 } from "typebox/value";
function createGrepTool(options) {
  const cwd = options.cwd ?? process.cwd();
  const sdkGrep = createGrepToolDefinition(cwd);
  const { execute: sdkExecute } = sdkGrep;
  return {
    ...sdkGrep,
    label: "Code Search",
    promptGuidelines: [
      "Available for fast recursive text search in codebases.",
      'Pattern supports regex. Use glob to scope to file types (e.g., "**/*.ts").',
      "Options: ignoreCase, literal (disable regex), context (lines around match), limit (max matches).",
      `CRITICAL: You are allowed a maximum of ${MAX_GATHERING_CALLS} gathering calls total across ALL tools.`
    ],
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (!Value9.Check(sdkGrep.parameters, params)) {
        return {
          content: [{ type: "text", text: "Invalid parameters for grep tool." }],
          details: { error: "invalid_parameters" }
        };
      }
      if (!options.tracker.recordCall("grep")) {
        return {
          content: [{ type: "text", text: options.tracker.getLimitMessage("grep") }],
          details: { blocked: true, reason: "limit_reached" }
        };
      }
      try {
        return await sdkExecute(toolCallId, params, signal, onUpdate, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: { error: "execution_error", message: msg }
        };
      }
    }
  };
}

// src/tools/index.ts
function createResearchTools(options) {
  const createFallbackState = () => ({
    version: 1,
    researchId: "fallback",
    rootQuery: "",
    complexity: 1,
    currentRound: 1,
    status: "researching",
    lastUpdated: Date.now(),
    initialAgenda: [],
    allScrapedLinks: [],
    aspects: {}
  });
  const fallbackState = createFallbackState();
  const resolvedOptions = {
    ...options,
    getGlobalState: options.getGlobalState ?? (() => fallbackState),
    updateGlobalLinks: options.updateGlobalLinks ?? ((links) => {
      fallbackState.allScrapedLinks = [.../* @__PURE__ */ new Set([...fallbackState.allScrapedLinks, ...links])];
    })
  };
  return [
    createReadTool(options.cwd),
    createSearchTool({
      ...resolvedOptions,
      onProgress: options.onSearchProgress
    }),
    createScrapeTool({
      ...resolvedOptions,
      onUrlScrapeResult: options.onUrlScrapeResult,
      getTokensUsed: options.getTokensUsed,
      contextWindowSize: options.contextWindowSize
    }),
    createSecuritySearchTool(resolvedOptions),
    createStackexchangeTool(resolvedOptions),
    createGrepTool({ tracker: resolvedOptions.tracker, cwd: resolvedOptions.cwd })
  ];
}

// src/utils/make-resource-loader.ts
function makeResourceLoader(systemPromptText) {
  const mockRuntime = {
    flagValues: /* @__PURE__ */ new Map(),
    pendingProviderRegistrations: [],
    registerProvider: () => {
    },
    unregisterProvider: () => {
    },
    sendMessage: async () => {
    },
    sendUserMessage: async () => {
    },
    appendEntry: async () => {
    },
    setSessionName: () => void 0,
    getSessionName: () => void 0,
    setLabel: async () => {
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {
    },
    refreshTools: () => {
    },
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {
    },
    assertActive: () => {
    },
    invalidate: () => {
    }
  };
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: mockRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPromptText,
    getAppendSystemPrompt: () => [],
    extendResources: () => {
    },
    reload: async () => {
    }
  };
}

// src/utils/tool-usage-tracker.ts
var ToolUsageTracker = class {
  usage = /* @__PURE__ */ new Map();
  limits;
  constructor(limits) {
    this.limits = limits;
  }
  /**
   * Get category for a tool
   */
  getCategory(toolName) {
    const gatheringTools = ["search", "security_search", "stackexchange", "grep"];
    if (gatheringTools.includes(toolName)) {
      return "gathering";
    }
    return toolName;
  }
  /**
   * Record a tool call and enforce limits gracefully
   * Returns true if call is allowed and recorded, false if limit is reached.
   * On block: counter is NOT incremented, tool should return a limit message.
   */
  recordCall(toolName) {
    const category = this.getCategory(toolName);
    const catLimit = this.limits[category];
    const toolLimit = this.limits[toolName];
    const usage = this.getUsage(category);
    if (catLimit !== void 0 && usage.callCount >= catLimit) {
      logger.debug(
        `[tool-usage] category=${category} blocked tool=${toolName} (limit=${catLimit})`
      );
      return false;
    }
    const toolCount = usage.toolCounts.get(toolName) || 0;
    if (toolLimit !== void 0 && toolCount >= toolLimit) {
      logger.debug(
        `[tool-usage] tool=${toolName} blocked (limit=${toolLimit})`
      );
      return false;
    }
    usage.callCount++;
    usage.toolCounts.set(toolName, toolCount + 1);
    logger.debug(
      `[tool-usage] category=${category} calls=${usage.callCount}/${catLimit ?? "unlimited"} tool=${toolName} count=${toolCount + 1}/${toolLimit ?? "unlimited"}`
    );
    return true;
  }
  /**
   * Get current call count for a tool's category
   */
  getCallCount(toolName) {
    const category = this.getCategory(toolName);
    return this.getUsage(category).callCount;
  }
  /**
   * Get current call count for a specific tool
   */
  getToolCallCount(toolName) {
    const category = this.getCategory(toolName);
    const usage = this.getUsage(category);
    return usage.toolCounts.get(toolName) || 0;
  }
  /**
   * Get the specific limit configured for a tool
   */
  getToolLimit(toolName) {
    return this.limits[toolName];
  }
  /**
   * Get limit-reached message for a blocked tool
   */
  getLimitMessage(toolName) {
    const category = this.getCategory(toolName);
    const usage = this.getUsage(category);
    const toolLimit = this.limits[toolName];
    const catLimit = usage.limit;
    if (toolName === "search" && toolLimit === 1) {
      return `SEARCH LIMIT REACHED: You have already used your one search call. Proceed to scraping: use the scrape tool for full deep-dives into your best search results.`;
    }
    if (category === "scrape") {
      const limit2 = catLimit ?? getMaxScrapeBatches();
      const effectiveText = limit2 > 99 ? "unlimited" : `${limit2} batch${limit2 === 1 ? "" : "es"}`;
      const displayLimit = Math.min(limit2, 6);
      const batchList = displayLimit <= 3 ? "Batch 1, Batch 2, Batch 3" : Array.from({ length: displayLimit }, (_, i) => `Batch ${i + 1}`).join(", ") + (limit2 > 6 ? ", ..." : "");
      return `SCRAPE PROTOCOL COMPLETE: You have completed all ${effectiveText} (${batchList}). This tool cannot be used again. Proceed immediately to synthesis: compile your findings and submit your full report.`;
    }
    const limit = catLimit ?? MAX_GATHERING_CALLS;
    return `GATHERING LIMIT REACHED: All ${limit} gathering calls have been used. This tool and all other gathering tools cannot be used again. Proceed to Step 2: call scrape with your collected URLs now.`;
  }
  /**
   * Get current usage for a category
   */
  getUsage(category) {
    if (!this.usage.has(category)) {
      this.usage.set(category, {
        category,
        callCount: 0,
        limit: this.limits[category],
        toolCounts: /* @__PURE__ */ new Map()
      });
    }
    return this.usage.get(category);
  }
  /**
   * Get usage statistics for all categories
   */
  getStats() {
    return new Map(this.usage);
  }
  /**
   * Reset all usage
   */
  reset() {
    this.usage.clear();
  }
};
function createDefaultToolLimits(config) {
  return {
    gathering: MAX_GATHERING_CALLS,
    scrape: getMaxScrapeBatches(config),
    search: 1,
    read: void 0
  };
}

// src/orchestration/researcher.ts
async function createResearcherSession(options) {
  const {
    cwd,
    ctxModel,
    modelRegistry,
    systemPrompt,
    extensionCtx,
    getGlobalState,
    updateGlobalLinks,
    researcherId,
    onSearchProgress,
    onUrlScrapeResult,
    excludeTools = [],
    config
  } = options;
  if (!systemPrompt || typeof systemPrompt !== "string") {
    throw new Error("Invalid system prompt: must be a non-empty string");
  }
  const sessionRef = { session: null };
  const modelToUse = resolveResearchModel({
    modelRegistry,
    config,
    hostModel: ctxModel,
    cwd
  });
  logger.info(`[Researcher] Using model for researcher ${researcherId}: ${modelToUse.provider}/${modelToUse.id}`);
  try {
    const tracker = new ToolUsageTracker(createDefaultToolLimits(config));
    const globalLinks = updateGlobalLinks || (() => {
    });
    const customTools = createResearchTools({
      cwd,
      ctx: extensionCtx,
      tracker,
      getGlobalState,
      updateGlobalLinks: globalLinks,
      researcherId,
      onSearchProgress,
      onUrlScrapeResult,
      getTokensUsed: () => {
        if (!sessionRef.session) return 0;
        if (typeof sessionRef.session.getContextUsage === "function") {
          const usage = sessionRef.session.getContextUsage();
          if (usage && typeof usage.tokens === "number") return usage.tokens;
        }
        if (typeof sessionRef.session.getUsage === "function") {
          const usage = sessionRef.session.getUsage();
          return (usage.input || 0) + (usage.output || 0);
        }
        return 0;
      },
      contextWindowSize: modelToUse.contextWindow,
      config
    });
    const defaultExclude = ["bash", "write", "edit", "repl", "git", "terminal"];
    const mergedExclude = [.../* @__PURE__ */ new Set([...defaultExclude, ...excludeTools])];
    const tools = customTools.map((t) => t.name).filter((name) => !mergedExclude.includes(name));
    const researcherSettings = SettingsManagerClass.inMemory({ retry: { provider: { maxRetries: 2 } } });
    const result = await createAgentSession({
      cwd,
      customTools,
      tools,
      // Explicit allowlist (BUG-1 fix)
      sessionManager: SessionManager.inMemory(),
      // Each researcher gets its own isolated session
      settingsManager: researcherSettings,
      model: modelToUse,
      modelRegistry,
      resourceLoader: makeResourceLoader(systemPrompt),
      // Thinking/reasoning is disabled for researcher agents: they do retrieval and
      // synthesis from scraped pages, not open-ended reasoning. Keeping it off
      // reduces latency and token cost with no quality benefit for this use case.
      thinkingLevel: "off"
    });
    if (extensionCtx.hasUI && typeof extensionCtx.ui.setHiddenThinkingLabel === "function") {
      extensionCtx.ui.setHiddenThinkingLabel(
        researcherId ? `Researcher ${researcherId}` : void 0
      );
    }
    logger.log(`[Researcher] Created session with model=${modelToUse?.id || "unknown"}`);
    if (!result || !result.session) {
      throw new Error("Session creation returned invalid result");
    }
    sessionRef.session = result.session;
    return { session: result.session, resolvedModel: modelToUse };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create researcher session: ${errorMsg}`, {
      cause: error
    });
  }
}

// src/orchestration/session/session-state.ts
import { randomUUID as randomUUID5 } from "node:crypto";
var piSessions = /* @__PURE__ */ new Map();
function normalizeSessionId(piSessionId) {
  if (!piSessionId || piSessionId === "undefined" || piSessionId === "null") {
    return "default";
  }
  return piSessionId;
}
function getPiState(piSessionId) {
  const sid = normalizeSessionId(piSessionId);
  let state = piSessions.get(sid);
  if (!state) {
    state = {
      failures: /* @__PURE__ */ new Map(),
      order: [],
      panels: /* @__PURE__ */ new Map(),
      aborts: /* @__PURE__ */ new Map(),
      subscribers: [],
      refreshTimeout: null,
      masterUpdate: null,
      steeringMessages: [],
      lastAbortAt: 0
    };
    piSessions.set(sid, state);
  }
  return state;
}
function getSteeringMessages(piSessionId) {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  return [...state.steeringMessages.filter((m) => m.status !== "popped")];
}
function getActiveSteeringMessages(piSessionId) {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  return state.steeringMessages.filter((m) => m.status === "active");
}
function consumeQueuedMessages(piSessionId) {
  const sid = normalizeSessionId(piSessionId);
  const state = piSessions.get(sid);
  if (!state) return [];
  const now = Date.now();
  const consumed = [];
  for (const msg of state.steeringMessages) {
    if (msg.status === "queued") {
      msg.status = "active";
      msg.consumedAt = now;
      consumed.push(msg);
    }
  }
  if (consumed.length > 0) {
    logger.debug(`[session-state] Consumed ${consumed.length} queued steering messages for session ${sid}`);
    refreshAllSessions(sid);
  }
  return consumed;
}
function refreshAllSessions(piSessionId) {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  if (state.refreshTimeout) {
    clearTimeout(state.refreshTimeout);
  }
  const debounceMs = getConfig().TUI_REFRESH_DEBOUNCE_MS;
  state.refreshTimeout = setTimeout(() => {
    try {
      const validIds = state.order.filter((id) => state.panels.has(id));
      if (validIds.length !== state.order.length) {
        for (const id of state.order) {
          if (!validIds.includes(id)) {
            state.failures.delete(id);
            state.panels.delete(id);
          }
        }
        state.order.length = 0;
        state.order.push(...validIds);
      }
      if (state.masterUpdate) {
        try {
          state.masterUpdate();
        } catch (error) {
          logger.error(`[session-state] Error updating Master Widget for ${sid}:`, error);
        }
      }
    } finally {
      state.refreshTimeout = null;
    }
  }, debounceMs);
}
function clearAllSessionState() {
  for (const [, state] of piSessions.entries()) {
    if (state.refreshTimeout) {
      clearTimeout(state.refreshTimeout);
      state.refreshTimeout = null;
    }
    for (const abort of state.aborts.values()) {
      try {
        abort.abort();
      } catch {
      }
    }
  }
  piSessions.clear();
  clearAllSharedLinks();
  logger.log("[session-state] All session state cleared");
}
function recordResearcherFailure(piSessionId, researchId, researcherId) {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  const failures = state.failures.get(researchId) || [];
  failures.push(researcherId);
  state.failures.set(researchId, failures);
}
function getFailedResearchers(piSessionId, researchId) {
  const sid = normalizeSessionId(piSessionId);
  const state = getPiState(sid);
  const failures = state.failures.get(researchId) || [];
  return [...new Set(failures)];
}
var MAX_FAILED_RESEARCHERS = 2;
function shouldStopResearch(piSessionId, researchId) {
  const sid = normalizeSessionId(piSessionId);
  return getFailedResearchers(sid, researchId).length >= MAX_FAILED_RESEARCHERS;
}
function getResearchStopMessage(piSessionId, researchId) {
  const sid = normalizeSessionId(piSessionId);
  const failed = getFailedResearchers(sid, researchId);
  const count = failed.length;
  return [
    `Research stopped: ${count} researcher(s) failed: ${failed.join(", ")}.`,
    "",
    "This indicates infrastructure failure \u2014 multiple researchers could not complete research.",
    "Possible causes: network unavailable, search engine blocking automated requests.",
    "",
    "\u258E If the health check passed (search and scrape verified), this failure is at the AI session layer \u2014",
    "   check model availability, API key, and context settings.",
    "",
    "Troubleshooting:",
    "\u2022 Verify network connection is active",
    "\u2022 Check browser logs for automation detection signals",
    "\u2022 Check PI_RESEARCH_TIMEOUT_MS if set (default: 5 minutes)",
    "",
    "Partial results may be available below."
  ].join("\n");
}

// src/orchestration/researcher-executor.ts
async function runResearcher(options) {
  const {
    config: researcherConfig,
    initialLinks,
    historicalUrls,
    researchId,
    round,
    query,
    complexity,
    ctx,
    model,
    researchConfig: config,
    planningService,
    observer,
    signal,
    sessionId
  } = options;
  const id = String(researcherConfig.id);
  const container = tryGetServiceContainerFromCtx(ctx);
  observer?.onResearcherStart?.(id, researcherConfig.name, researcherConfig.goal, round);
  metrics.increment("researchers_launched_total", 1, { mode: "deep", complexity: String(complexity), round: String(round) });
  const currentPlan = planningService.getCurrentPlan(researchId);
  const previousQueriesSection = currentPlan?.allQueries && currentPlan.allQueries.length > 0 ? `
### Previous Queries (Sibling Researchers)
${currentPlan.allQueries.map((q) => `- ${q}`).join("\n")}
` : "";
  let storeSection = "";
  if (historicalUrls.length > 0) {
    storeSection = "\n## Knowledge Store\nThe following URLs were found in the knowledge store from previous research sessions. Scrape each URL to retrieve its full current content. The summary below describes what was previously found at that URL \u2014 use it as a guide for what to expect.\n" + historicalUrls.map((e) => `- ${e.url}
  Previous summary: ${e.description}`).join("\n");
  }
  const researcherPromptTemplate = loadPrompt("researcher");
  if (initialLinks.length === 0 && historicalUrls.length === 0) {
    logger.warn(`[ResearcherExecutor] Researcher ${id} has no initial search results or historical links; skipping.`);
    recordResearcherFailure(ctx.sessionId, researchId, id);
    metrics.increment("researcher_skipped_total", 1, { mode: "deep", complexity: String(complexity), reason: "no_initial_links" });
    observer?.onResearcherFailure?.(id, "No initial search results or historical links available");
    return;
  }
  let evidenceSection = "";
  if (initialLinks.length > 0) {
    evidenceSection = `## Evidence Provided
Initial search results provided the following URLs to investigate:
${initialLinks.map((l) => `- ${l}`).join("\n")}`;
  }
  const maxAttempts = config.RESEARCHER_MAX_RETRIES + 1;
  let lastError;
  const researcherExecutionStartMs = Date.now();
  const deliveredSteeringIds = /* @__PURE__ */ new Set();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = Math.min(1e3 * Math.pow(2, attempt - 2), config.RESEARCHER_MAX_RETRY_DELAY_MS);
      logger.warn(`[ResearcherExecutor] Researcher ${id} retry ${attempt - 1}/${config.RESEARCHER_MAX_RETRIES} after ${delay}ms`);
      observer?.onResearcherProgress?.(id, "retry");
      await new Promise((r) => setTimeout(r, delay));
    }
    const allSteering = getSteeringMessages(sessionId);
    let steeringSection = "";
    if (allSteering.length > 0) {
      steeringSection = "\n\n### ADDITIONAL USER GUIDANCE (Mandatory directional rules for your research)\n" + allSteering.map((m) => {
        deliveredSteeringIds.add(m.id);
        return `- ${m.text}`;
      }).join("\n");
    }
    const prompt = injectCurrentDate(researcherPromptTemplate, "researcher").replace("{{goal}}", researcherConfig.goal).replace("{{store_section}}", storeSection).replace("{{evidence_section}}", evidenceSection).replace("{{coordination_section}}", previousQueriesSection).replace("{{extra_tool_guidelines}}", "").trim() + steeringSection;
    logger.debug(`[ResearcherExecutor] Researcher ${id} attempt ${attempt} System Prompt:
${prompt}`);
    const workerExclude = ["search"];
    const mergedExclude = [.../* @__PURE__ */ new Set([...workerExclude, ...options.excludeTools || []])];
    const { session, resolvedModel } = await createResearcherSession({
      cwd: ctx.cwd,
      ctxModel: model,
      modelRegistry: ctx.modelRegistry,
      systemPrompt: prompt,
      extensionCtx: ctx,
      excludeTools: mergedExclude,
      researcherId: id,
      getGlobalState: () => ({
        version: 1,
        researchId,
        rootQuery: query,
        complexity,
        currentRound: round,
        status: "researching",
        lastUpdated: Date.now(),
        initialAgenda: [],
        allScrapedLinks: [],
        aspects: {}
      }),
      updateGlobalLinks: (links) => registerScrapedLinks(researchId, links),
      onSearchProgress: (links) => {
        observer?.onResearcherProgress?.(id, `${links} results`);
      },
      onUrlScrapeResult: (_url, success) => {
        observer?.onToolResult?.(id, success);
      }
    });
    const sessionService = await getService(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
    sessionService.registerSession(researchId, id, session, () => session.abort().catch((err) => logger.warn("[ResearcherExecutor] Session abort failed:", err)));
    let lastSteeringCheck = Date.now();
    const subscription = session.subscribe((event) => {
      const now = Date.now();
      if (now - lastSteeringCheck > 500) {
        lastSteeringCheck = now;
        const allSteering2 = getSteeringMessages(sessionId);
        for (const msg of allSteering2) {
          if (!deliveredSteeringIds.has(msg.id)) {
            deliveredSteeringIds.add(msg.id);
            session.steer(msg.text).catch((e) => logger.warn("[ResearcherExecutor] Failed to deliver steering:", e));
            logger.debug(`[ResearcherExecutor] Delivered mid-flight steering message to ${id}: ${msg.text}`);
          }
        }
      }
      if (event.type === "message_update") {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "start") {
          const inputTokens = ame.partial?.usage?.input ?? 0;
          if (inputTokens > 0) {
            observer?.onResearcherTokensHint?.(id, inputTokens);
          }
        }
      } else if (event.type === "message_end") {
        const msg = event.message;
        if (msg?.["role"] !== "assistant") return;
        const rawUsage = msg["usage"];
        if (rawUsage) {
          const { tokens, cost } = extractUsage(resolvedModel, rawUsage);
          if (tokens > 0 || cost > 0) {
            metrics.increment("llm_tokens_total", tokens, { component: "researcher", complexity: String(complexity) });
            metrics.increment("llm_cost_total", cost, { component: "researcher", complexity: String(complexity) });
            observer?.onResearcherProgress?.(id, void 0, tokens, cost);
            observer?.onTokensConsumed?.(tokens, cost);
          }
        }
      } else if (event.type === "tool_execution_start") {
        observer?.onResearcherProgress?.(id, `${event.toolName}`);
      } else if (event.type === "tool_execution_end") {
        observer?.onResearcherProgress?.(id, `done:${event.toolName}`);
        if (event.toolName !== "scrape") {
          observer?.onToolResult?.(id, !event.isError);
        }
      }
    });
    try {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const msg = `Researcher ${id} (${researcherConfig.name}) timed out after ${config.RESEARCHER_TIMEOUT_MS}ms`;
          session.abort().catch((err) => {
            logger.warn("[ResearcherExecutor] Failed to abort timed-out researcher session:", err);
          }).finally(() => reject(new Error(msg)));
        }, config.RESEARCHER_TIMEOUT_MS);
      });
      let abortCleanup;
      try {
        const promptPromise = session.prompt(`Topic: ${researcherConfig.name}
Goal: ${researcherConfig.goal}

Perform your research and submit your full report now.`);
        promptPromise.catch((err) => logger.debug(`[ResearcherExecutor] Background session prompt rejection: ${err.message}`));
        await Promise.race([
          promptPromise,
          timeoutPromise,
          ...signal ? [
            new Promise((_, reject) => {
              const onAbort = () => {
                session.abort().catch((err) => logger.warn("[ResearcherExecutor] Failed to abort session on signal:", err));
                reject(new Error("Aborted"));
              };
              if (signal.aborted) {
                onAbort();
              } else {
                signal.addEventListener("abort", onAbort, { once: true });
                abortCleanup = () => signal.removeEventListener("abort", onAbort);
              }
            })
          ] : []
        ]);
      } finally {
        clearTimeout(timeoutId);
        abortCleanup?.();
      }
      const responseText = ensureAssistantResponse(session, id);
      const researcherDuration = Date.now() - researcherExecutionStartMs;
      metrics.observe("researcher_execution_latency_ms", researcherDuration, { mode: "deep", complexity: String(complexity), round: String(round) });
      logger.debug(`[ResearcherExecutor] Researcher ${id} Final Response:
${responseText}`);
      const synthesisService = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      synthesisService.storeReport(researchId, `${round}.${id}`, responseText);
      observer?.onResearcherComplete?.(id, responseText);
      return;
    } catch (err) {
      const researcherDuration = Date.now() - researcherExecutionStartMs;
      metrics.observe("researcher_execution_latency_ms", researcherDuration, { mode: "deep", complexity: String(complexity), round: String(round), status: "error" });
      metrics.increment("researcher_errors_total", 1, { mode: "deep", complexity: String(complexity), round: String(round) });
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        const partialResponse = ensureAssistantResponse(session, id);
        if (partialResponse && partialResponse.trim().length > 50) {
          const synthesisService = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
          synthesisService.storeReport(researchId, `${round}.${id}`, partialResponse + "\n\n---\n*\u26A0 This report was truncated due to a timeout/error. Content may be incomplete.*");
          logger.log(`[ResearcherExecutor] Researcher ${id} salvaged partial content (${partialResponse.length} chars) after error: ${errMsg}`);
          observer?.onResearcherComplete?.(id, partialResponse);
          return;
        }
      } catch (salvageErr) {
        logger.debug(`[ResearcherExecutor] Researcher ${id} salvage attempt failed:`, salvageErr);
      }
      if (signal?.aborted || errMsg === "Aborted") {
        logger.debug(`[ResearcherExecutor] Researcher ${id} was aborted, skipping retries.`);
        break;
      }
      if (attempt < maxAttempts) {
        logger.warn(`[ResearcherExecutor] Researcher ${id} attempt ${attempt} failed: ${errMsg}; will retry`);
      } else {
        logger.error(`[ResearcherExecutor] Researcher ${id} failed all ${maxAttempts} attempts: ${errMsg}`);
        metrics.increment("researcher_retries_exhausted_total", 1, { mode: "deep", complexity: String(complexity) });
      }
    } finally {
      subscription();
      await session.abort().catch((err) => {
        logger.warn(`[ResearcherExecutor] Failed to abort researcher session ${id}:`, err);
      });
      sessionService.unregisterSession(researchId, id);
      if (ctx.hasUI && typeof ctx.ui.setHiddenThinkingLabel === "function") {
        ctx.ui.setHiddenThinkingLabel();
      }
    }
  }
  throw lastError;
}

// src/orchestration/headless-observer.ts
var HeadlessObserver = class {
  constructor(options = {}) {
    this.options = options;
  }
  options;
  emit(event, data) {
    if (this.options.enableLogging) {
      logger.debug(`[HeadlessObserver] ${event}`, data);
    }
    this.options.onProgress?.(event, data);
  }
  onStart(query, complexity) {
    this.emit("start", { query, complexity });
  }
  onPlanningStart(attempt) {
    this.emit("planning_start", { attempt });
  }
  onPlanningProgress(status) {
    this.emit("planning_progress", { status });
  }
  onPlanningTokens(tokens, cost) {
    this.emit("planning_tokens", { tokens, cost });
  }
  onPlanningSuccess(plan) {
    this.emit("planning_success", { plan });
  }
  onRoundStart(round) {
    this.emit("round_start", { round });
  }
  onSearchStart(queries) {
    this.emit("search_start", { queries });
  }
  onSearchProgress(resultsCount) {
    this.emit("search_progress", { resultsCount });
  }
  onSearchComplete(resultsCount) {
    this.emit("search_complete", { resultsCount });
  }
  onResearcherStart(id, name, goal, roundNumber) {
    this.emit("researcher_start", { id, name, goal, roundNumber });
  }
  onResearcherProgress(id, status, tokens, cost) {
    this.emit("researcher_progress", { id, status, tokens, cost });
  }
  onResearcherComplete(id, report) {
    this.emit("researcher_complete", { id, report });
  }
  onResearcherFailure(id, error) {
    this.emit("researcher_failure", { id, error });
  }
  onToolResult(researcherId, success) {
    this.emit("tool_result", { researcherId, success });
  }
  onEvaluationStart(round) {
    this.emit("evaluation_start", { round });
  }
  onEvaluationProgress(status) {
    this.emit("evaluation_progress", { status });
  }
  onEvaluationTokens(tokens, cost) {
    this.emit("evaluation_tokens", { tokens, cost });
  }
  onEvaluationDecision(action, plan, round) {
    this.emit("evaluation_decision", { action, plan, round });
  }
  onComplete(result) {
    this.emit("complete", { result });
  }
  onError(error) {
    this.emit("error", { message: error.message });
  }
  onTokensConsumed(tokens, cost) {
    this.emit("tokens_consumed", { tokens, cost });
  }
};

// src/orchestration/quick-research-orchestrator.ts
var QuickResearchOrchestrator = class {
  constructor(options) {
    this.options = options;
    this.config = options.config || getConfig(options.ctx.cwd);
    if (options.observer && typeof options.observer.onProgress === "function" && !(options.observer instanceof HeadlessObserver)) {
      this.observer = new HeadlessObserver(options.observer);
    } else {
      this.observer = options.observer;
    }
  }
  options;
  config;
  observer;
  async run(signal) {
    const { query, model, ctx, researchId } = this.options;
    const observer = this.observer;
    const container = tryGetServiceContainerFromCtx(ctx);
    const sessionStart = Date.now();
    logger.log(`[QuickOrchestrator] Starting research: "${query}"`);
    observer?.onStart?.(query, 0);
    let subscription;
    try {
      const health = await runHealthCheck({ ctx });
      if (!health.success) {
        const error = health.error || "Unknown health check failure";
        logger.error(`[QuickOrchestrator] Health check failed: ${error}`);
        metrics.increment("research_sessions_total", 1, { mode: "quick", complexity: "0", status: "health_check_failed" });
        throw new Error(`Research cannot start: ${error}`);
      }
      let storeSection = "";
      try {
        const ksService = await getService(ServiceNames.KNOWLEDGE_STORE, ctx, container);
        if (ksService.isReady()) {
          const store = await ksService.getStore();
          if (store && typeof store.findRelevantUrls === "function") {
            const historicalEntries = await store.findRelevantUrls(query, { limit: 5 });
            if (historicalEntries.length > 0) {
              storeSection = "\n## Historical Knowledge Store (Discovery)\nThe following URLs were found in your local knowledge store from previous research sessions. Scrape them to retrieve their full current content. Each summary describes what was previously found:\n" + historicalEntries.map(
                (e) => `- ${e.url}
  Previous summary: ${e.description}`
              ).join("\n");
            }
          }
        }
      } catch (err) {
        logger.warn("[QuickOrchestrator] Failed to fetch historical URLs (non-fatal):", err);
      }
      const researcherPromptTemplate = loadPrompt("researcher");
      const maxScrapeBatches = getMaxScrapeBatches(this.config);
      const maxScrapeBatchesDisplay = maxScrapeBatches > 99 ? "unlimited" : maxScrapeBatches.toString();
      const quickEvidenceSection = `## Search
You have access to the \`search\` tool. You get EXACTLY ONE search call \u2014 make it count.
Submit **5\u201310 diverse, specific, and non-overlapping queries** covering the most important angles of the topic.
Each query must target a distinct piece of information. Avoid generic queries.
Your goal is to gather a focused, high-quality pool of initial links.

## Scrape
After searching, scrape the best sources using the \`scrape\` tool (up to ${maxScrapeBatchesDisplay} batches, up to 4 URLs each).
Prioritize primary sources and authoritative data.`;
      consumeQueuedMessages(this.options.sessionId);
      const steeringMessages = getSteeringMessages(this.options.sessionId);
      let steeringSection = "";
      if (steeringMessages.length > 0) {
        steeringSection = "\n\n### ADDITIONAL CONSIDERATIONS\n" + steeringMessages.map((m) => `- ${m.text}`).join("\n");
      }
      const evidenceLines = [];
      if (this.options.initialLinks && this.options.initialLinks.length > 0) {
        evidenceLines.push("## Initial Links\nInvestigate these provided URLs first:\n" + this.options.initialLinks.map((l) => `- ${l}`).join("\n"));
      }
      evidenceLines.push(quickEvidenceSection);
      const prompt = injectCurrentDate(researcherPromptTemplate, "researcher").replace("{{goal}}", query + steeringSection).replace("{{store_section}}", storeSection).replace("{{evidence_section}}", evidenceLines.join("\n\n")).replace("{{coordination_section}}", "").replace("{{extra_tool_guidelines}}", "- `search`: Perform broad web searches (Round 1 only).");
      logger.debug(`[QuickOrchestrator] System Prompt:
${prompt}`);
      let lastSeenSearchCount = 0;
      const { session, resolvedModel } = await createResearcherSession({
        cwd: ctx.cwd,
        ctxModel: model,
        modelRegistry: ctx.modelRegistry,
        systemPrompt: prompt,
        extensionCtx: ctx,
        excludeTools: this.options.excludeTools || ["grep"],
        config: this.config,
        getGlobalState: () => ({
          version: 1,
          researchId: this.options.researchId,
          rootQuery: query,
          complexity: 1,
          currentRound: 1,
          status: "researching",
          lastUpdated: Date.now(),
          initialAgenda: [],
          allScrapedLinks: [],
          aspects: {}
        }),
        updateGlobalLinks: (links) => registerScrapedLinks(this.options.researchId, links),
        onSearchProgress: (links) => {
          lastSeenSearchCount = links;
          observer?.onSearchProgress?.(links);
        },
        onUrlScrapeResult: (_url, success) => {
          observer?.onToolResult?.("quick", success);
        }
      });
      const sessionService = await getService(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
      sessionService.registerSession(this.options.researchId, "quick", session, () => session.abort().catch((err) => logger.warn("[QuickOrchestrator] Session abort failed:", err)));
      let lastSteeringCheck = Date.now();
      subscription = session.subscribe((event) => {
        const now = Date.now();
        if (now - lastSteeringCheck > 500) {
          lastSteeringCheck = now;
          const newSteering = consumeQueuedMessages(this.options.sessionId);
          for (const msg of newSteering) {
            session.steer(msg.text).catch((e) => logger.warn("[QuickOrchestrator] Failed to deliver steering:", e));
            logger.debug(`[QuickOrchestrator] Delivered mid-flight steering message: ${msg.text}`);
          }
        }
        if (event.type === "message_end") {
          const msg = event.message;
          if (msg?.["role"] !== "assistant") return;
          const rawUsage = msg["usage"];
          if (rawUsage) {
            const { tokens, cost } = extractUsage(resolvedModel, rawUsage);
            if (tokens > 0 || cost > 0) {
              metrics.increment("llm_tokens_total", tokens, { component: "quick_researcher", complexity: "0" });
              metrics.increment("llm_cost_total", cost, { component: "quick_researcher", complexity: "0" });
              observer?.onResearcherProgress?.("quick", void 0, tokens, cost);
              observer?.onTokensConsumed?.(tokens, cost);
            }
          }
        } else if (event.type === "tool_execution_start") {
          observer?.onResearcherProgress?.("quick", event.toolName);
          if (event.toolName === "search") {
            metrics.increment("research_searches_total", 1, { mode: "quick" });
            observer?.onSearchStart?.(event.args.queries || []);
          }
        } else if (event.type === "tool_execution_end") {
          observer?.onResearcherProgress?.("quick", `done:${event.toolName}`);
          if (event.toolName !== "scrape") {
            observer?.onToolResult?.("quick", !event.isError);
          }
          if (event.toolName === "search") {
            observer?.onSearchComplete?.(lastSeenSearchCount);
          }
        }
      });
      try {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            const msg = `Quick research timed out after ${this.config.RESEARCHER_TIMEOUT_MS}ms`;
            session.abort().catch((err) => {
              logger.warn("[QuickOrchestrator] Failed to abort timed-out session:", err);
            }).finally(() => reject(new Error(msg)));
          }, this.config.RESEARCHER_TIMEOUT_MS);
        });
        let abortCleanup;
        try {
          const promptPromise = session.prompt(query);
          promptPromise.catch((err) => logger.debug(`[QuickOrchestrator] Background session prompt rejection: ${err.message}`));
          await Promise.race([
            promptPromise,
            timeoutPromise,
            ...signal ? [
              new Promise((_, reject) => {
                const onAbort = () => {
                  session.abort().catch((err) => logger.warn("[QuickOrchestrator] Failed to abort session on signal:", err));
                  reject(new Error("Aborted"));
                };
                if (signal.aborted) {
                  onAbort();
                } else {
                  signal.addEventListener("abort", onAbort, { once: true });
                  abortCleanup = () => signal.removeEventListener("abort", onAbort);
                }
              })
            ] : []
          ]);
        } finally {
          clearTimeout(timeoutId);
          if (abortCleanup) abortCleanup();
        }
        let result = ensureAssistantResponse(session, "Quick");
        const synthesisService = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
        synthesisService.storeReport(this.options.researchId, "quick", result);
        result = synthesisService.ensureCitedLinks(this.options.researchId, result);
        const finalSteeringMessages = getActiveSteeringMessages(this.options.sessionId);
        result = synthesisService.appendSteeringGuidance(result, finalSteeringMessages);
        const sessionDuration = Date.now() - sessionStart;
        metrics.observe("research_session_duration_ms", sessionDuration, { mode: "quick", complexity: "0", status: "success" });
        logger.debug(`[QuickOrchestrator] Researcher Final Response:
${result}`);
        try {
          const ksService = await getService(ServiceNames.KNOWLEDGE_STORE, ctx, container);
          if (ksService.isReady()) {
            const writer = await getService(ServiceNames.WRITER_QUEUE, ctx, container);
            const citations = parseCitations(result);
            if (citations.length === 0) {
              logger.warn("[QuickOrchestrator] Researcher produced no parseable CITED LINKS \u2014 no descriptions stored for this session");
            }
            let enqueued = 0;
            for (const cit of citations) {
              if (cit.url) {
                const fullContent = getCachedScrapedContent(this.options.researchId, cit.url);
                const markdown = cit.description || `(source: ${cit.url})`;
                writer.enqueue({
                  url: normalizeUrl(cit.url),
                  markdown,
                  content: fullContent,
                  metadata: {
                    ingestionType: "synthesis-description",
                    source: "researcher",
                    synthesizedAt: (/* @__PURE__ */ new Date()).toISOString(),
                    description: cit.description || "",
                    fullContentSnippet: fullContent?.substring(0, 5e3)
                  }
                });
                enqueued++;
              }
            }
            if (enqueued > 0) await writer.drain();
          }
        } catch (err) {
          logger.warn("[QuickOrchestrator] Failed to store link descriptions (non-fatal):", err);
        }
        metrics.increment("research_sessions_total", 1, { mode: "quick", complexity: "0", status: "success" });
        observer?.onComplete?.(result);
        return result;
      } catch (error) {
        const sessionDuration = Date.now() - sessionStart;
        metrics.observe("research_session_duration_ms", sessionDuration, { mode: "quick", complexity: "0", status: "error" });
        metrics.increment("research_sessions_total", 1, { mode: "quick", complexity: "0", status: "error" });
        observer?.onError?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    } finally {
      if (subscription) subscription();
      if (ctx.hasUI && typeof ctx.ui.setHiddenThinkingLabel === "function") {
        ctx.ui.setHiddenThinkingLabel();
      }
      try {
        const orch = await getService(ServiceNames.RESEARCH_ORCHESTRATION, ctx, container);
        await orch.cleanupResearchServices(void 0, researchId);
      } catch (err) {
        logger.warn("[QuickOrchestrator] Failed to cleanup research services:", err);
      }
    }
  }
};

// src/orchestration/deep-research-orchestrator.ts
var DeepResearchOrchestrator = class {
  constructor(options) {
    this.options = options;
    this.config = options.config || getConfig(options.ctx.cwd);
    if (options.observer && typeof options.observer.onProgress === "function" && !(options.observer instanceof HeadlessObserver)) {
      this.observer = new HeadlessObserver(options.observer);
    } else {
      this.observer = options.observer;
    }
    if (options.orchestrationService) {
      this.orchestrationService = options.orchestrationService;
    }
    if (!options.ctx) {
      throw new Error("DeepResearchOrchestrator requires ExtensionContext (ctx) to be provided");
    }
  }
  options;
  currentRound = 0;
  observer;
  startTime = Date.now();
  config;
  sessionStart = Date.now();
  orchestrationService = null;
  async getOrchestrationService() {
    if (this.orchestrationService) return this.orchestrationService;
    const container = tryGetServiceContainerFromCtx(this.options.ctx);
    this.orchestrationService = await getService(ServiceNames.RESEARCH_ORCHESTRATION, this.options.ctx, container);
    return this.orchestrationService;
  }
  async getPlanningService() {
    const container = tryGetServiceContainerFromCtx(this.options.ctx);
    return await getService(ServiceNames.PLANNING, this.options.ctx, container);
  }
  elapsed() {
    const s = Math.round((Date.now() - this.startTime) / 1e3);
    return `+${s}s`;
  }
  /**
   * Run the multi-round research loop
   */
  async run(signal) {
    const { model, query, complexity, researchId, ctx } = this.options;
    const observer = this.observer;
    const container = tryGetServiceContainerFromCtx(ctx);
    const orchestrationService = await this.getOrchestrationService();
    const planningService = await this.getPlanningService();
    await orchestrationService.cleanupResearchServices(void 0, researchId);
    logger.log(`[DeepOrchestrator] Starting multi-round research (complexity ${complexity}) for: "${query}" (Run: ${researchId})`);
    metrics.increment("research_sessions_total", 1, { mode: "deep", complexity: String(complexity) });
    observer?.onStart?.(query, complexity);
    consumeQueuedMessages(this.options.sessionId);
    const baseMaxRounds = getMaxRounds(complexity);
    const queuedAtStart = getSteeringMessages(this.options.sessionId).length;
    const steeringBonusRounds = Math.min(queuedAtStart, MAX_EXTRA_ROUNDS_WITH_STEERING);
    let maxRounds = baseMaxRounds + steeringBonusRounds;
    let totalSteeringExtraRounds = steeringBonusRounds;
    if (steeringBonusRounds > 0) {
      logger.log(
        `[DeepOrchestrator] Extending round budget from ${baseMaxRounds} to ${maxRounds} (${steeringBonusRounds} extra round(s) for ${queuedAtStart} queued steering message(s), cap ${MAX_EXTRA_ROUNDS_WITH_STEERING})`
      );
    }
    const MAX_WAIT_RETRIES = 5;
    let waitRetryCount = 0;
    let loopSynthesisPlan = null;
    try {
      while (this.currentRound < maxRounds) {
        if (signal?.aborted) throw new Error("Research aborted");
        this.currentRound++;
        this.startTime = Date.now();
        const beforeConsume = getSteeringMessages(this.options.sessionId).filter((m) => m.status === "active").length;
        consumeQueuedMessages(this.options.sessionId);
        const steeringMessages = getSteeringMessages(this.options.sessionId);
        const steeringTexts = steeringMessages.map((m) => m.text);
        const newlyConsumed = steeringMessages.filter((m) => m.status === "active").length - beforeConsume;
        if (newlyConsumed > 0 && totalSteeringExtraRounds < MAX_EXTRA_ROUNDS_WITH_STEERING) {
          const additionalRounds = Math.min(newlyConsumed, MAX_EXTRA_ROUNDS_WITH_STEERING - totalSteeringExtraRounds);
          maxRounds += additionalRounds;
          totalSteeringExtraRounds += additionalRounds;
          if (additionalRounds > 0) {
            logger.log(
              `[DeepOrchestrator] Extended round budget from ${maxRounds - additionalRounds} to ${maxRounds} (${additionalRounds} extra round(s) for ${newlyConsumed} newly consumed steering message(s), total steering extra: ${totalSteeringExtraRounds}/${MAX_EXTRA_ROUNDS_WITH_STEERING})`
            );
          }
        }
        const roundLabel = this.currentRound > baseMaxRounds ? `Round ${this.currentRound}/${maxRounds} (extra, steering-driven, base=${baseMaxRounds})` : `Round ${this.currentRound}/${maxRounds}`;
        logger.log(`[DeepOrchestrator] ${roundLabel} ${this.elapsed()}`);
        observer?.onRoundStart?.(this.currentRound);
        const healthy = await orchestrationService.checkHealth(this.currentRound, researchId, ctx);
        if (!healthy && this.currentRound > 1) {
          logger.warn(`[DeepOrchestrator] Infrastructure unhealthy at Round ${this.currentRound}, attempting to continue with existing data...`);
        }
        let plan;
        if (this.currentRound === 1) {
          observer?.onPlanningStart?.(1);
          observer?.onPlanningProgress?.("planning");
          plan = await planningService.generatePlan({
            sessionId: researchId,
            query,
            complexity,
            model,
            modelRegistry: ctx.modelRegistry,
            cwd: ctx.cwd,
            signal,
            observer,
            excludeTools: this.options.excludeTools,
            steeringMessages: steeringTexts
          });
        } else {
          const synthesisService2 = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
          observer?.onEvaluationStart?.(this.currentRound);
          observer?.onEvaluationProgress?.("evaluating");
          plan = await planningService.updatePlanForRound({
            sessionId: researchId,
            query,
            complexity,
            round: this.currentRound,
            model,
            modelRegistry: ctx.modelRegistry,
            cwd: ctx.cwd,
            reports: synthesisService2.getAllReports(researchId),
            previousPlan: planningService.getCurrentPlan(researchId),
            totalResearchersPlanned: planningService.getTotalResearchersPlanned(researchId),
            signal,
            observer,
            excludeTools: this.options.excludeTools,
            steeringMessages: steeringTexts
          });
        }
        if (plan.action === "delegate") {
          if (this.currentRound === 1) {
            observer?.onPlanningSuccess?.(plan);
          } else {
            observer?.onEvaluationDecision?.("delegate", plan, this.currentRound);
          }
        }
        if (plan.action === "synthesize" || this.currentRound >= maxRounds) {
          logger.log(`[DeepOrchestrator] Synthesis phase reached at Round ${this.currentRound} ${this.elapsed()}`);
          if (plan.action === "synthesize") {
            loopSynthesisPlan = plan;
            observer?.onEvaluationDecision?.("synthesize", plan, this.currentRound);
          }
          break;
        }
        if (plan.action === "wait") {
          waitRetryCount++;
          observer?.onPlanningProgress?.("planning");
          if (waitRetryCount > MAX_WAIT_RETRIES) {
            logger.error(`[DeepOrchestrator] Max wait retries (${MAX_WAIT_RETRIES}) exceeded at Round ${this.currentRound}, stopping research`);
            observer?.onError?.(new Error("Max wait retries exceeded"));
            throw new Error(`Max wait retries (${MAX_WAIT_RETRIES}) exceeded. The research coordinator was unable to proceed after multiple wait requests.`);
          }
          logger.debug(`[DeepOrchestrator] AI requested wait, retrying Round ${this.currentRound} in 5s (retry ${waitRetryCount}/${MAX_WAIT_RETRIES})...`);
          if (signal?.aborted) {
            throw new Error("Research cancelled");
          }
          await new Promise((resolve5, reject) => {
            const onAbort = () => {
              clearTimeout(timeout);
              reject(new Error("Research cancelled"));
            };
            const timeout = setTimeout(() => {
              signal?.removeEventListener("abort", onAbort);
              resolve5();
            }, 5e3);
            safeUnref(timeout);
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          this.currentRound--;
          continue;
        }
        waitRetryCount = 0;
        if (plan.action === "delegate" && plan.researchers && plan.researchers.length > 0) {
          planningService.incrementTotalResearchersPlanned(researchId, plan.researchers.length);
        }
        if (plan.allQueries && plan.allQueries.length > 0) {
          planningService.addToQueryHistory(researchId, plan.allQueries);
        }
        let researcherLinks;
        let storeLinks;
        const searchTask = plan.allQueries && plan.allQueries.length > 0 ? (async () => {
          observer?.onSearchStart?.(plan.allQueries);
          const results = await orchestrationService.runSearchBurst(plan.allQueries, this.config, signal, (links) => {
            observer?.onSearchProgress?.(links);
          }, ctx);
          observer?.onSearchComplete?.(results.reduce((sum, r) => sum + (r.results?.length || 0), 0));
          researcherLinks = await orchestrationService.distributeSearchResults(plan, results);
          if (this.currentRound === 1 && this.options.initialLinks && this.options.initialLinks.length > 0) {
            if (!researcherLinks) researcherLinks = /* @__PURE__ */ new Map();
            for (const researcher of plan.researchers || []) {
              const id = String(researcher.id);
              const existing = researcherLinks.get(id) || [];
              researcherLinks.set(id, [.../* @__PURE__ */ new Set([...existing, ...this.options.initialLinks])]);
            }
          }
        })() : (async () => {
          if (this.currentRound === 1 && this.options.initialLinks && this.options.initialLinks.length > 0) {
            researcherLinks = /* @__PURE__ */ new Map();
            for (const researcher of plan.researchers || []) {
              researcherLinks.set(String(researcher.id), [...this.options.initialLinks]);
            }
          }
        })();
        const storeTask = this.config.KNOWLEDGE_STORE_MODE !== "none" && plan.researchers && plan.researchers.length > 0 ? (async () => {
          try {
            const ksService = await getService(ServiceNames.KNOWLEDGE_STORE, ctx, container);
            if (!ksService.isReady()) {
              logger.debug("[DeepOrchestrator] Knowledge store service not ready, skipping per-researcher store queries");
              return;
            }
            const store = await ksService.getStore();
            if (store && typeof store.findRelevantUrls === "function") {
              const storeMap = /* @__PURE__ */ new Map();
              await Promise.all((plan.researchers ?? []).map(async (researcher) => {
                const entries = await store.findRelevantUrls(researcher.goal, { limit: 4 });
                if (entries.length > 0) {
                  storeMap.set(String(researcher.id), entries);
                  logger.debug(`[DeepOrchestrator] Researcher ${researcher.id}: ${entries.length} store URL(s) from goal query`);
                }
              }));
              if (storeMap.size > 0) storeLinks = storeMap;
            }
          } catch (err) {
            logger.warn("[DeepOrchestrator] Per-researcher store queries failed (non-fatal):", err);
          }
        })() : Promise.resolve();
        await Promise.all([searchTask, storeTask]);
        if (plan.researchers && plan.researchers.length > 0) {
          await orchestrationService.runResearchers({
            plan,
            options: {
              ...this.options,
              config: this.config,
              excludeTools: this.options.excludeTools || ["grep"],
              observer: this.observer
            },
            currentRound: this.currentRound,
            signal
          }, researcherLinks, storeLinks);
        }
        observer?.onEvaluationProgress?.("embedding");
        await orchestrationService.storeLinkDescriptions(researchId, this.currentRound, researchId, this.config, ctx);
        observer?.onEvaluationProgress?.("evaluating");
      }
      logger.log(`[DeepOrchestrator] Final synthesis ${this.elapsed()}`);
      observer?.onRoundStart?.(maxRounds + 1);
      observer?.onEvaluationStart?.(maxRounds);
      observer?.onEvaluationProgress?.("evaluating");
      let finalReport;
      if (loopSynthesisPlan !== null) {
        finalReport = loopSynthesisPlan;
      } else {
        consumeQueuedMessages(this.options.sessionId);
        const finalSteeringTexts = getSteeringMessages(this.options.sessionId).map((m) => m.text);
        const synthesisServiceFinal = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
        finalReport = await planningService.updatePlanForRound({
          sessionId: researchId,
          query,
          complexity,
          round: maxRounds,
          model,
          modelRegistry: ctx.modelRegistry,
          cwd: ctx.cwd,
          reports: synthesisServiceFinal.getAllReports(researchId),
          previousPlan: planningService.getCurrentPlan(researchId),
          totalResearchersPlanned: planningService.getTotalResearchersPlanned(researchId),
          mustSynthesize: true,
          signal,
          observer,
          excludeTools: this.options.excludeTools,
          steeringMessages: finalSteeringTexts
        });
      }
      observer?.onEvaluationDecision?.("synthesize", finalReport, maxRounds);
      let result = finalReport.content || "";
      if (!result.trim()) {
        const synthesisService2 = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
        if (synthesisService2.hasReports(researchId)) {
          logger.warn(`[DeepOrchestrator] LLM returned empty synthesis for ${researchId}, building fallback from ${synthesisService2.getReportCount(researchId)} reports`);
          result = synthesisService2.buildFallbackSynthesis(researchId, this.currentRound);
        } else {
          result = "Research completed but no summary was generated.";
        }
      }
      try {
        const parsed = JSON.parse(result);
        if (parsed && typeof parsed === "object" && typeof parsed["content"] === "string") {
          result = parsed["content"];
        }
      } catch {
      }
      const synthesisService = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      result = synthesisService.ensureCitedLinks(researchId, result);
      const finalSteeringMessages = getActiveSteeringMessages(this.options.sessionId);
      if (finalSteeringMessages.length > 0) {
        logger.debug(`[DeepOrchestrator] Appending guidance from ${finalSteeringMessages.length} steering messages to final report`);
        result = synthesisService.appendSteeringGuidance(result, finalSteeringMessages);
      }
      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe("research_session_duration_ms", sessionDuration, { mode: "deep", complexity: String(complexity), status: "success" });
      observer?.onComplete?.(result);
      return result;
    } catch (error) {
      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe("research_session_duration_ms", sessionDuration, { mode: "deep", complexity: String(complexity), status: "error" });
      logger.error(`[DeepOrchestrator] Research failed: ${error instanceof Error ? error.message : String(error)}`);
      observer?.onError?.(error instanceof Error ? error : new Error(String(error)));
      try {
        const synthesisService = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
        if (synthesisService.hasReports(researchId)) {
          let fallback = synthesisService.buildFallbackSynthesis(researchId, this.currentRound);
          fallback = synthesisService.ensureCitedLinks(researchId, fallback);
          logger.log(`[DeepOrchestrator] Returning fallback synthesis (${fallback.length} chars) from ${synthesisService.getReportCount(researchId)} collected reports`);
          const finalSteeringMessages = getActiveSteeringMessages(this.options.sessionId);
          const result = synthesisService.appendSteeringGuidance(fallback, finalSteeringMessages);
          observer?.onComplete?.(result);
          return result;
        }
      } catch (fallbackErr) {
        logger.warn(`[DeepOrchestrator] Fallback synthesis also failed:`, fallbackErr);
      }
      throw error;
    } finally {
      const orch = await this.getOrchestrationService();
      await orch.cleanupResearchServices(void 0, researchId, ctx);
    }
  }
};

// src/orchestration/research-orchestration-service.ts
var ResearchOrchestrationService = class {
  name = ServiceNames.RESEARCH_ORCHESTRATION;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  async initialize() {
    this.lifecycle = "initialized" /* INITIALIZED */;
  }
  async dispose() {
    this.lifecycle = "disposed" /* DISPOSED */;
  }
  /**
   * Resolve the model for research based on options and config.
   */
  async resolveResearchModel(options) {
    const { ctx, model, config } = options;
    return resolveResearchModel({
      modelRegistry: ctx.modelRegistry,
      config: config || getConfig(ctx.cwd),
      modelId: model?.id,
      hostModel: ctx.model,
      cwd: ctx.cwd
    });
  }
  /**
   * Run a research task (Quick or Deep)
   */
  async runResearch(options, signal) {
    const { ctx, query, depth = 0, observer, onUpdate, sessionId, researchId, config, excludeTools } = options;
    const researchConfig = config || getConfig(ctx.cwd);
    const selectedModel = await this.resolveResearchModel(options);
    logger.info(`[ResearchOrchestrationService] Using model: ${selectedModel.provider}/${selectedModel.id}`);
    const researchStart = Date.now();
    let result;
    try {
      if (depth === 0) {
        const orchestrator = new QuickResearchOrchestrator({
          ctx,
          model: selectedModel,
          query,
          sessionId,
          researchId,
          observer,
          onUpdate,
          config: researchConfig,
          excludeTools,
          initialLinks: options.initialLinks
        });
        result = await orchestrator.run(signal);
      } else {
        const orchestrator = new DeepResearchOrchestrator({
          ctx,
          model: selectedModel,
          query,
          complexity: depth,
          sessionId,
          researchId,
          observer,
          onUpdate,
          config: researchConfig,
          excludeTools,
          orchestrationService: this,
          initialLinks: options.initialLinks
        });
        result = await orchestrator.run(signal);
      }
      const researchDuration = Date.now() - researchStart;
      metrics.observe("research_manager_latency_ms", researchDuration, { depth: String(depth), status: "success", source: "extension" });
      metrics.increment("research_manager_requests_total", 1, { depth: String(depth), status: "success", source: "extension" });
      return result;
    } catch (error) {
      const researchDuration = Date.now() - researchStart;
      metrics.observe("research_manager_latency_ms", researchDuration, { depth: String(depth), status: "error", source: "extension" });
      metrics.increment("research_manager_requests_total", 1, { depth: String(depth), status: "error", source: "extension" });
      throw error;
    }
  }
  /**
   * Cleanup and reset services for the current research run
   */
  async cleanupResearchServices(sessionId, researchId, ctx) {
    const targetId = researchId || sessionId;
    const container = tryGetServiceContainerFromCtx(ctx);
    try {
      const sessionService = await getService(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
      if (sessionService && targetId) {
        await sessionService.cleanup(targetId);
      }
      const ksService = await getService(ServiceNames.KNOWLEDGE_STORE, ctx, container);
      if (ksService && ksService.isReady()) {
        const store = await ksService.getStore();
        if (store) {
          logger.info("[ResearchOrchestrationService] Rebuilding FTS index after research run");
          await store.rebuildFtsIndex();
        }
      }
    } catch (_err) {
      logger.debug("[ResearchOrchestrationService] Service cleanup failed:", _err);
    }
    try {
      const synthesisService = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      if (synthesisService && targetId) {
        synthesisService.clearReports(targetId);
      }
    } catch (_err) {
      logger.debug("[ResearchOrchestrationService] ResearchSynthesisService not available for cleanup");
    }
    const planningService = tryGetService(ServiceNames.PLANNING, container);
    if (planningService && targetId) {
      planningService.clearPlanningState(targetId);
      logger.debug(`[ResearchOrchestrationService] Cleared planning state for ${targetId}`);
    }
    if (targetId) {
      cleanupSharedLinks(targetId);
      resetLogger(targetId);
      clearSessionCircuitBreaker(targetId);
    }
    logger.debug(`[ResearchOrchestrationService] Cleaned up research services for ${targetId}`);
  }
  /**
   * Distribute search results to researchers based on query matching
   * @param plan - Research plan with researchers and queries
   * @param results - Search results from queries
   * @param _ctx - Optional context for container isolation
   * @returns Map of researcher ID -> array of URLs
   */
  async distributeSearchResults(plan, results, _ctx) {
    const startTime = Date.now();
    const queryToResults = new Map(results.map((r) => [r.query, r.results || []]));
    const linkMap = /* @__PURE__ */ new Map();
    for (const researcher of plan.researchers || []) {
      const researcherUrls = /* @__PURE__ */ new Set();
      for (const query of researcher.queries || []) {
        const queryResults = queryToResults.get(query) || [];
        for (const res of queryResults) {
          researcherUrls.add(res.url);
        }
      }
      linkMap.set(String(researcher.id), Array.from(researcherUrls));
    }
    logger.debug(`[ResearchOrchestrationService] Distributed ${results.length} results in ${Date.now() - startTime}ms`);
    return linkMap;
  }
  /**
   * Run researchers concurrently with launch delay
   * @param options - Run options
   * @param researcherLinks - Optional map of researcher ID -> search results
   * @param storeLinks - Optional map of researcher ID -> store results
   * @param _ctx - Optional context for container isolation
   */
  async runResearchers(options, researcherLinks, storeLinks, _ctx) {
    const { plan, options: orchestratorOptions, currentRound, signal } = options;
    const { sessionId, researchId, observer, ctx } = orchestratorOptions;
    const container = tryGetServiceContainerFromCtx(ctx);
    let planningService;
    try {
      planningService = await getService(ServiceNames.PLANNING, ctx, container);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("during container disposal") || options.signal?.aborted) {
        logger.info("[ResearchOrchestrationService] Service container disposing \u2014 skipping researchers gracefully");
        return;
      }
      logger.error("[ResearchOrchestrationService] Failed to get planning service:", err);
      throw new Error("Planning service not available. Research cannot continue.", { cause: err });
    }
    const researchers = plan.researchers || [];
    const active = /* @__PURE__ */ new Set();
    const maxConcurrent = orchestratorOptions.config?.MAX_CONCURRENT_RESEARCHERS ?? 3;
    for (const configItem of researchers) {
      if (signal?.aborted) break;
      if (active.size >= maxConcurrent) {
        if (signal?.aborted) break;
        await Promise.race([
          ...active,
          ...signal ? [new Promise((_, reject) => {
            const onAbort = () => reject(new Error("Aborted"));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          })] : []
        ]).catch((err) => {
          if (err.message !== "Aborted") throw err;
        });
        if (signal?.aborted) break;
      }
      const promise = (async () => {
        const id = String(configItem.id);
        try {
          const initialLinks = researcherLinks?.get(id) || [];
          const historicalUrls = storeLinks?.get(id) || [];
          await runResearcher({
            ...orchestratorOptions,
            // Correct field mappings — orchestratorOptions.config is the app Config;
            // the per-researcher plan item goes into 'config' (overriding the spread),
            // and the app Config moves to 'researchConfig'.
            config: configItem,
            researchConfig: orchestratorOptions.config ?? getConfig(ctx.cwd),
            round: currentRound,
            planningService,
            initialLinks,
            historicalUrls,
            signal,
            excludeTools: orchestratorOptions.excludeTools
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[ResearchOrchestrationService] Researcher ${id} failed: ${errMsg}`);
          recordResearcherFailure(sessionId, researchId, id);
          observer?.onResearcherFailure?.(id, errMsg);
        }
      })();
      promise.finally(() => active.delete(promise));
      active.add(promise);
      if (RESEARCHER_LAUNCH_DELAY_MS > 0 && researchers.indexOf(configItem) < researchers.length - 1) {
        await new Promise((resolve5) => setTimeout(resolve5, RESEARCHER_LAUNCH_DELAY_MS));
      }
      if (shouldStopResearch(sessionId, researchId)) {
        const sessionService = await getService(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
        await sessionService.abortAllSessions(researchId);
        const stopMessage = getResearchStopMessage(sessionId, researchId);
        throw new Error(stopMessage);
      }
    }
    await Promise.all(active);
  }
  /**
   * Run a search burst for the given queries
   * @param queries - Array of search queries
   * @param config - Research configuration
   * @param signal - Optional abort signal
   * @param onProgress - Optional progress callback
   * @param ctx - Optional context for container isolation
   * @returns Search results
   */
  async runSearchBurst(queries, config, signal, onProgress, ctx) {
    const container = tryGetServiceContainerFromCtx(ctx);
    const results = await search(queries, config, signal, onProgress, container);
    const totalResults = results.reduce((sum, r) => sum + (r.results?.length || 0), 0);
    logger.info(`[ResearchOrchestrationService] Search burst completed. Total results: ${totalResults}`);
    return results;
  }
  /**
   * Store link descriptions to knowledge store for a specific round
   * @param sessionId - Session identifier
   * @param round - Round number
   * @param researchId - Research ID
   * @param config - Research configuration
   * @param ctx - Optional extension context for container isolation
   */
  async storeLinkDescriptions(_sessionId, round, researchId, _config, ctx) {
    const container = tryGetServiceContainerFromCtx(ctx);
    try {
      const ksService = await getService(ServiceNames.KNOWLEDGE_STORE, ctx, container);
      if (!ksService.isReady()) {
        logger.debug("[ResearchOrchestrationService] Knowledge store not ready, skipping link descriptions");
        return;
      }
      const synthesisService = await getService(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      const writer = await getService(ServiceNames.WRITER_QUEUE, ctx, container);
      const roundPrefix = `${round}.`;
      let enqueued = 0;
      let researcherCount = 0;
      const allReports = synthesisService.getAllReports(researchId);
      if (allReports.size === 0) {
        logger.warn(`[ResearchOrchestrationService] No reports found in synthesis service for researchId ${researchId} round ${round}`);
      }
      for (const [key, report] of allReports.entries()) {
        if (!key.startsWith(roundPrefix)) continue;
        researcherCount++;
        const links = parseCitations(report);
        if (links.length === 0) {
          logger.warn(`[ResearchOrchestrationService] Researcher ${key} produced no parseable CITED LINKS - no descriptions stored`);
          continue;
        }
        logger.debug(`[ResearchOrchestrationService] Storing ${links.length} citations for researcher ${key}`);
        for (const link2 of links) {
          if (link2.url) {
            const cachedContent = getCachedScrapedContent(researchId, link2.url) ?? void 0;
            const markdown = link2.description || `(source: ${link2.url})`;
            writer.enqueue({
              url: normalizeUrl(link2.url),
              markdown,
              content: cachedContent,
              metadata: {
                researchId,
                round,
                researcherId: key,
                description: link2.description || "",
                sourceOrigin: link2.url,
                source: link2.source || "unknown"
              }
            });
            enqueued++;
          }
        }
      }
      if (enqueued > 0) {
        logger.info(`[ResearchOrchestrationService] Enqueued ${enqueued} citations from ${researcherCount} researchers for round ${round}`);
        await writer.drain();
      } else if (researcherCount > 0) {
        logger.warn(`[ResearchOrchestrationService] No valid citations found among ${researcherCount} researchers in round ${round}`);
      }
    } catch (err) {
      logger.warn("[ResearchOrchestrationService] Failed to store link descriptions (non-fatal):", err);
    }
  }
  // Tracks consecutive health check failures per researchId
  failureCounts = /* @__PURE__ */ new Map();
  /**
   * Run health check and log status
   * @param round - Current round number
   * @param researchId - Research ID (optional)
   * @param ctx - Optional extension context for container isolation
   * @returns Promise<boolean> - True if healthy or degraded, false if unhealthy
   */
  async checkHealth(round, researchId, ctx) {
    if (round <= 1) return true;
    try {
      const container = tryGetServiceContainerFromCtx(ctx);
      let registry;
      try {
        registry = await getService(ServiceNames.HEALTH_REGISTRY, ctx, container);
      } catch {
        registry = healthRegistry;
      }
      const health = await registry.runAll();
      const isHealthy = health.status === "healthy";
      const isDegraded = health.status === "degraded";
      if (isHealthy || isDegraded) {
        if (researchId) {
          this.failureCounts.set(researchId, 0);
        }
        if (isHealthy) {
          logger.debug(`[ResearchOrchestrationService] Health status at Round ${round}: [OK] All systems operational`);
        } else {
          const degraded = health.components.filter((c) => !c.healthy).map((c) => c.component);
          logger.warn(`[ResearchOrchestrationService] Health status at Round ${round}: [WARN] Degraded (${degraded.join(", ")})`);
        }
        return true;
      } else {
        if (researchId) {
          const failures = (this.failureCounts.get(researchId) || 0) + 1;
          this.failureCounts.set(researchId, failures);
          if (failures >= 3) {
            const failed = health.components.filter((c) => !c.healthy).map((c) => c.component);
            logger.error(`[ResearchOrchestrationService] Health status at Round ${round}: [ERROR] Unhealthy after ${failures} attempts (${failed.join(", ")})`);
            return false;
          } else {
            logger.warn(`[ResearchOrchestrationService] Health status at Round ${round}: [WARN] Unhealthy (${failures}/3). Continuing.`);
            return true;
          }
        }
        return false;
      }
    } catch (err) {
      logger.warn("[ResearchOrchestrationService] Failed to check health status:", err);
      return true;
    }
  }
};

// src/orchestration/research-session-service.ts
var ResearchSessionService = class {
  name = ServiceNames.RESEARCH_SESSION_SERVICE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  // Map of sessionId -> Map<id, SessionEntry>
  sessions = /* @__PURE__ */ new Map();
  getSessionMap(sessionId) {
    let sessionMap = this.sessions.get(sessionId);
    if (!sessionMap) {
      sessionMap = /* @__PURE__ */ new Map();
      this.sessions.set(sessionId, sessionMap);
    }
    return sessionMap;
  }
  /**
   * Register an active researcher session
   */
  registerSession(sessionId, id, session, abortFn) {
    this.getSessionMap(sessionId).set(id, { session, abort: abortFn });
  }
  /**
   * Get an active session by ID
   */
  getSession(sessionId, id) {
    return this.getSessionMap(sessionId).get(id);
  }
  /**
   * Check if a session is active
   */
  hasSession(sessionId, id) {
    return this.getSessionMap(sessionId).has(id);
  }
  /**
   * Unregister a session (no abort)
   */
  unregisterSession(sessionId, id) {
    this.getSessionMap(sessionId).delete(id);
  }
  /**
   * Abort and unregister a specific session
   */
  async abortSession(sessionId, id) {
    const sessionMap = this.getSessionMap(sessionId);
    const entry = sessionMap.get(id);
    if (!entry) return;
    try {
      await entry.abort();
    } catch (err) {
      logger.warn(`[ResearchSessionService] Failed to abort session ${id}:`, err);
    }
    sessionMap.delete(id);
  }
  /**
   * Abort all active sessions for a specific sessionId, or all sessions if sessionId is omitted
   */
  async abortAllSessions(sessionId) {
    if (sessionId) {
      const sessionMap = this.getSessionMap(sessionId);
      const aborts = Array.from(sessionMap.values()).map(
        (entry, index) => entry.abort().catch((err) => {
          logger.warn(`[ResearchSessionService] Failed to abort session ${index}:`, err);
        })
      );
      await Promise.all(aborts);
      sessionMap.clear();
      this.sessions.delete(sessionId);
    } else {
      const aborts = [];
      for (const sessionMap of this.sessions.values()) {
        aborts.push(...Array.from(sessionMap.values()).map(
          (entry, index) => entry.abort().catch((err) => {
            logger.warn(`[ResearchSessionService] Failed to abort session ${index}:`, err);
          })
        ));
      }
      await Promise.all(aborts);
      this.sessions.clear();
    }
  }
  /**
   * Get count of active sessions
   */
  getActiveSessionCount(sessionId) {
    return this.getSessionMap(sessionId).size;
  }
  /**
   * Get all active session IDs
   */
  getActiveSessionIds(sessionId) {
    return Array.from(this.getSessionMap(sessionId).keys());
  }
  /**
   * Clean up all sessions (alias for abortAllSessions)
   */
  async cleanup(sessionId) {
    await this.abortAllSessions(sessionId);
  }
  /**
   * Reset service state
   */
  reset() {
    this.sessions.clear();
  }
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    logger.debug("[ResearchSessionService] Initializing...");
    this.lifecycle = "initialized" /* INITIALIZED */;
    logger.debug("[ResearchSessionService] Initialized");
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposing" /* DISPOSING */;
    logger.debug("[ResearchSessionService] Disposing...");
    await this.cleanup();
    this.lifecycle = "disposed" /* DISPOSED */;
    logger.debug("[ResearchSessionService] Disposed");
  }
};

// src/utils/citation-utils.ts
function normalizeCitations(reports) {
  const globalCitations = [];
  const urlToGlobalId = /* @__PURE__ */ new Map();
  const normalizedReports = /* @__PURE__ */ new Map();
  for (const report of reports.values()) {
    const citations = parseCitations(report);
    for (const cit of citations) {
      const normUrl = normalizeUrl(cit.url);
      if (!urlToGlobalId.has(normUrl)) {
        const id = globalCitations.length + 1;
        urlToGlobalId.set(normUrl, id);
        globalCitations.push({
          id,
          url: cit.url,
          description: cit.description,
          source: cit.source
        });
      }
    }
  }
  for (const [id, report] of reports.entries()) {
    const localCitations = parseCitations(report);
    const localToGlobal = /* @__PURE__ */ new Map();
    localCitations.forEach((cit, index) => {
      const globalId = urlToGlobalId.get(normalizeUrl(cit.url));
      if (globalId !== void 0) {
        localToGlobal.set(index + 1, globalId);
      }
    });
    const parts = report.split(/###\s*CITED LINKS/i);
    let content = parts[0] || "";
    content = content.replace(/\[(\d+)\]/g, (match, p1) => {
      const localId = parseInt(p1, 10);
      const globalId = localToGlobal.get(localId);
      return globalId !== void 0 ? `[${globalId}]` : match;
    });
    normalizedReports.set(id, content.trim());
  }
  return { normalizedReports, globalCitations };
}
function formatCitedLinks(citations) {
  if (citations.length === 0) return "";
  const links = citations.map((cit) => {
    const sourcePart = cit.source ? ` [Source: ${cit.source}]` : "";
    const descPart = cit.description ? ` \u2014 ${cit.description}` : "";
    return `[${cit.id}] ${cit.url}${sourcePart}${descPart}`;
  });
  return `### CITED LINKS
${links.join("\n")}`;
}

// src/orchestration/research-synthesis-service.ts
var ResearchSynthesisService = class _ResearchSynthesisService {
  name = ServiceNames.RESEARCH_SYNTHESIS_SERVICE;
  lifecycle = "uninitialized" /* UNINITIALIZED */;
  // Map of sessionId -> Map<reportId, reportContent>
  sessions = /* @__PURE__ */ new Map();
  // FIX (New Issue D): Maximum number of sessions to prevent unbounded growth
  // from orphaned sessions during long-lived Pi sessions.
  static MAX_SESSIONS = 50;
  getSessionReports(sessionId) {
    let reports = this.sessions.get(sessionId);
    if (!reports) {
      if (this.sessions.size >= _ResearchSynthesisService.MAX_SESSIONS) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey !== void 0) {
          logger.warn(`[ResearchSynthesisService] Session limit (${_ResearchSynthesisService.MAX_SESSIONS}) reached, evicting oldest: ${oldestKey}`);
          this.sessions.delete(oldestKey);
        }
      }
      reports = /* @__PURE__ */ new Map();
      this.sessions.set(sessionId, reports);
    }
    return reports;
  }
  /**
   * Store a researcher report
   * @param sessionId - Session identifier
   * @param id - Report identifier (typically "round.researcherId")
   * @param report - The researcher's report content
   */
  storeReport(sessionId, id, report) {
    this.getSessionReports(sessionId).set(id, report);
  }
  /**
   * Get a report by ID
   */
  getReport(sessionId, id) {
    return this.getSessionReports(sessionId).get(id);
  }
  /**
   * Get all reports
   */
  getAllReports(sessionId) {
    return new Map(this.getSessionReports(sessionId));
  }
  /**
   * Get reports for a specific round
   */
  getReportsForRound(sessionId, round) {
    const roundReports = /* @__PURE__ */ new Map();
    const prefix = `${round}.`;
    for (const [key, report] of this.getSessionReports(sessionId).entries()) {
      if (key.startsWith(prefix)) {
        roundReports.set(key, report);
      }
    }
    return roundReports;
  }
  /**
   * Get total number of reports
   */
  getReportCount(sessionId) {
    return this.getSessionReports(sessionId).size;
  }
  /**
   * Check if there are any reports
   */
  hasReports(sessionId) {
    return this.getSessionReports(sessionId).size > 0;
  }
  /**
   * Clear reports for a session, or all reports if no sessionId provided
   */
  clearReports(sessionId) {
    if (sessionId) {
      this.sessions.delete(sessionId);
    } else {
      this.sessions.clear();
    }
  }
  /**
   * Build fallback synthesis from collected reports
   * @param sessionId - Session identifier
   * @param currentRound - Current research round number
   * @returns Fallback synthesis string
   */
  buildFallbackSynthesis(sessionId, currentRound = 0) {
    const reports = this.getSessionReports(sessionId);
    const reportCount = reports.size;
    const roundInfo = currentRound > 0 ? ` (up to Round ${currentRound})` : "";
    let synthesis = `# Research Findings${roundInfo}

`;
    if (reportCount === 0) {
      synthesis += "_No researcher reports were generated before the process stopped._";
    } else {
      synthesis += `*This is an automated synthesis of ${reportCount} individual researcher report(s) gathered before the process was interrupted.*

`;
      synthesis += Array.from(reports.entries()).map(([id, report]) => `## Researcher ${id}

${report}`).join("\n\n---\n\n");
    }
    return synthesis;
  }
  /**
   * Append research metadata (model used) to the end of the synthesis
   */
  appendMetadata(synthesis, modelId) {
    const metadataSection = [
      "---",
      `*Research performed using ${modelId}*`
    ].join("\n");
    return `${synthesis.trim()}

${metadataSection}`;
  }
  /**
   * Ensure the synthesis has an accurate and consistent ### CITED LINKS section.
   * Rebuilds the section from all researcher reports to guarantee sequential numbering [1], [2], [3]...
   * and unique URLs, regardless of what the LLM produced.
   * 
   * @param sessionId - Session identifier
   * @param synthesis - The synthesis text to check and potentially augment
   * @returns Synthesis with guaranteed and verified CITED LINKS section
   */
  ensureCitedLinks(sessionId, synthesis) {
    const reports = this.getSessionReports(sessionId);
    if (reports.size === 0) return synthesis;
    const { globalCitations } = normalizeCitations(reports);
    if (globalCitations.length === 0) return synthesis;
    const verifiedLinksSection = formatCitedLinks(globalCitations);
    if (/###\s*CITED LINKS/i.test(synthesis)) {
      logger.debug("[ResearchSynthesisService] Replacing existing CITED LINKS with verified version");
      return synthesis.replace(/###\s*CITED LINKS[\s\S]*$/i, verifiedLinksSection);
    }
    logger.warn("[ResearchSynthesisService] Synthesis missing CITED LINKS - appending verified version");
    return `${synthesis.trim()}

${verifiedLinksSection}`;
  }
  /**
   * Append steering guidance to the end of the synthesis
   * 
   * Accepts either string[] (backward compat) or SteeringMessage[] (new).
   * When SteeringMessage[] is passed, only active (consumed) messages are included.
   * When string[] is passed, all are included (legacy behavior for SDK).
   * 
   * @param synthesis - The synthesis text
   * @param steeringMessages - Array of steering messages (strings or SteeringMessage objects)
   * @returns Synthesis with steering guidance appended
   */
  appendSteeringGuidance(synthesis, steeringMessages) {
    let texts;
    if (steeringMessages && steeringMessages.length > 0) {
      const first = steeringMessages[0];
      if (typeof first === "object" && "text" in first && "status" in first) {
        texts = steeringMessages.filter((m) => m.status === "active").map((m) => m.text);
      } else {
        texts = steeringMessages;
      }
    } else {
      texts = [];
    }
    if (texts.length === 0) {
      return synthesis;
    }
    const guidanceSection = [
      "---",
      "The following guidance was provided by the user during the research process and influenced these results:",
      ...texts.map((m) => `- ${m}`)
    ].join("\n");
    return `${synthesis.trim()}

${guidanceSection}`;
  }
  /**
   * Extract all citations from all reports
   * @param sessionId - Session identifier
   * @returns Array of unique citations across all reports
   */
  extractAllCitations(sessionId) {
    const seen = /* @__PURE__ */ new Set();
    const allCitations = [];
    const reports = this.getSessionReports(sessionId);
    for (const report of reports.values()) {
      const citations = parseCitations(report);
      for (const cit of citations) {
        if (!seen.has(cit.url)) {
          seen.add(cit.url);
          allCitations.push(cit);
        }
      }
    }
    return allCitations;
  }
  /**
   * Get citations for a specific round
   * @param sessionId - Session identifier
   * @param round - Round number
   * @returns Array of citations from reports in the specified round
   */
  extractCitationsForRound(sessionId, round) {
    const seen = /* @__PURE__ */ new Set();
    const citations = [];
    const roundReports = this.getReportsForRound(sessionId, round);
    for (const report of roundReports.values()) {
      const parsedCitations = parseCitations(report);
      for (const cit of parsedCitations) {
        if (!seen.has(cit.url)) {
          seen.add(cit.url);
          citations.push(cit);
        }
      }
    }
    return citations;
  }
  /**
   * Reset service state
   */
  reset() {
    this.sessions.clear();
  }
  async initialize() {
    if (this.lifecycle === "initialized" /* INITIALIZED */) {
      return;
    }
    this.lifecycle = "initializing" /* INITIALIZING */;
    logger.debug("[ResearchSynthesisService] Initializing...");
    this.lifecycle = "initialized" /* INITIALIZED */;
    logger.debug("[ResearchSynthesisService] Initialized");
  }
  async dispose() {
    if (this.lifecycle === "disposed" /* DISPOSED */) {
      return;
    }
    this.lifecycle = "disposing" /* DISPOSING */;
    logger.debug("[ResearchSynthesisService] Disposing...");
    this.sessions.clear();
    this.lifecycle = "disposed" /* DISPOSED */;
    logger.debug("[ResearchSynthesisService] Disposed");
  }
};

// src/orchestration/service-initialization.ts
function registerOrchestrationServices(container = getServiceContainer()) {
  logger.debug("[OrchestrationServiceInit] Registering orchestration services...");
  registerService(
    ServiceNames.RESEARCH_ORCHESTRATION,
    () => new ResearchOrchestrationService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.RESEARCH_SESSION_SERVICE,
    () => new ResearchSessionService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.RESEARCH_SYNTHESIS_SERVICE,
    () => new ResearchSynthesisService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  registerService(
    ServiceNames.HEALTH_REGISTRY,
    async () => {
      const registry = new HealthCheckRegistry();
      await registry.initialize();
      registerHealthChecks(registry, container);
      return registry;
    },
    {
      lazyInitialization: false,
      // Eagerly register checks
      allowOverwrite: false,
      enableLogging: true
    },
    container
  );
  logger.debug("[OrchestrationServiceInit] Orchestration services registered");
}

// src/utils/research-export.ts
import { promises as fs13 } from "node:fs";
import { homedir as homedir7, tmpdir as tmpdir3, platform as platform3 } from "node:os";
import { join as join15, resolve as resolve3, normalize, sep as sep2 } from "node:path";
import { randomBytes as randomBytes6 } from "node:crypto";
var PREFERRED_SUBDIRS = [
  "research",
  "docs",
  "doc",
  "ref",
  "references",
  "notes"
];
var UNIX_SYSTEM_PREFIXES = [
  "/",
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib32",
  "/lib64",
  "/etc",
  "/var",
  "/opt",
  "/root",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/boot",
  "/srv",
  "/Applications",
  "/Library",
  "/System"
  // macOS
];
var WIN_SYSTEM_PREFIXES_LC = [
  "c:\\windows",
  "c:\\program files",
  "c:\\program files (x86)",
  "c:\\programdata",
  "c:\\recovery"
];
function isSafeToWriteDirectly(dir) {
  const normalized = normalize(resolve3(dir));
  const home = normalize(resolve3(homedir7()));
  if (normalized === home) return false;
  if (platform3() === "win32") {
    if (/^[a-zA-Z]:\\?$/.test(normalized)) return false;
    const lc = normalized.toLowerCase();
    for (const prefix of WIN_SYSTEM_PREFIXES_LC) {
      if (lc === prefix || lc.startsWith(prefix + sep2) || lc.startsWith(prefix + "/")) {
        return false;
      }
    }
  } else {
    for (const prefix of UNIX_SYSTEM_PREFIXES) {
      if (normalized === prefix || normalized.startsWith(prefix + sep2)) {
        return false;
      }
    }
  }
  return true;
}
async function findPreferredSubdir(cwd) {
  let entries;
  try {
    entries = await fs13.readdir(cwd);
  } catch {
    return null;
  }
  for (const target of PREFERRED_SUBDIRS) {
    const match = entries.find((e) => e.toLowerCase() === target);
    if (match === void 0) continue;
    const candidate = join15(cwd, match);
    try {
      const stat4 = await fs13.stat(candidate);
      if (stat4.isDirectory()) return candidate;
    } catch {
    }
  }
  return null;
}
async function resolveExportDir(cwd) {
  if (!isSafeToWriteDirectly(cwd)) {
    logger.log(`[export] cwd "${cwd}" is home/system \u2014 using tmpdir`);
    return tmpdir3();
  }
  const subdir = await findPreferredSubdir(cwd);
  if (subdir !== null) {
    logger.log(`[export] Using preferred subdir: ${subdir}`);
    return subdir;
  }
  return cwd;
}
function sanitizeQuery(query) {
  return query.toLowerCase().trim().slice(0, MAX_FILENAME_QUERY_LENGTH).replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function generateHash() {
  return randomBytes6(3).toString("hex");
}
async function exportResearchReport(query, result, _mode, cwd) {
  const sanitizedQuery = sanitizeQuery(query);
  const baseFilename = `pi-research-${sanitizedQuery}`;
  const targetDir = await resolveExportDir(cwd ?? tmpdir3());
  for (let attempt = 0; attempt < MAX_EXPORT_RETRIES; attempt++) {
    const hash = generateHash();
    const filename = `${baseFilename}-${hash}.md`;
    const filepath = join15(targetDir, filename);
    try {
      await fs13.writeFile(filepath, result, { flag: "wx" });
      logger.log(`[export] Research report saved to: ${filepath}`);
      return filepath;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      logger.error(`[export] Failed to save research report:`, error);
      return null;
    }
  }
  logger.error(`[export] Failed to save research report after ${MAX_EXPORT_RETRIES} attempts (hash collision)`);
  return null;
}

// src/tools/research-knowledge-search.ts
import { Type as Type9 } from "typebox";
import { Value as Value10 } from "typebox/value";
import { completeSimple as completeSimple2 } from "@earendil-works/pi-ai";

// src/tools/research-knowledge-types.ts
import { Type as Type8 } from "typebox";
var AnswerStatusEnum = Type8.Union([
  Type8.Literal("yes"),
  Type8.Literal("maybe"),
  Type8.Literal("no")
]);
var ResearchKnowledgeSynthesisResponseSchema = Type8.Object({
  answer_status: AnswerStatusEnum,
  synthesis: Type8.Optional(Type8.String({
    description: "Synthesized answer with inline citation markers [1], [2], etc."
  })),
  citations: Type8.Array(Type8.String(), {
    description: "Source URLs used to construct the answer."
  })
});
var ResearchKnowledgeSynthesisResponseSchemaAsTSchema = ResearchKnowledgeSynthesisResponseSchema;

// src/orchestration/session-context.ts
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation
} from "@earendil-works/pi-coding-agent";
async function formatParentContext(ctx) {
  const branch = ctx.sessionManager.getBranch();
  const sessionContext = buildSessionContext(branch);
  const allMessages = sessionContext.messages;
  if (allMessages.length === 0) {
    return "No previous context available.";
  }
  const MAX_CONTEXT_MESSAGES = 15;
  const recentMessages = allMessages.length > MAX_CONTEXT_MESSAGES ? allMessages.slice(-MAX_CONTEXT_MESSAGES) : allMessages;
  const llmMessages = convertToLlm(recentMessages);
  const serialized = serializeConversation(llmMessages);
  return [
    "## Parent Conversation History",
    "The following is the recent history of the conversation branch for your reference:",
    "",
    serialized
  ].join("\n");
}

// src/tui/knowledge-search-panel.ts
var SEARCHING_MESSAGE = "searching knowledge store";
function createKnowledgeSearchPanel() {
  return (_tui, theme) => {
    const component = {
      render(width) {
        if (width < 4) return [];
        const innerWidth = Math.max(0, width - 2);
        const contentText = SEARCHING_MESSAGE;
        const displayText = contentText.length > innerWidth ? contentText.slice(0, Math.max(0, innerWidth)) : contentText;
        const paddedContent = displayText.padEnd(innerWidth);
        const topBorder = theme.fg("accent", "\u250C" + "\u2500".repeat(innerWidth) + "\u2510");
        const contentLine = theme.fg("accent", "\u2502") + theme.fg("muted", paddedContent) + theme.fg("accent", "\u2502");
        const bottomBorder = theme.fg("accent", "\u2514" + "\u2500".repeat(innerWidth) + "\u2518");
        return [topBorder, contentLine, bottomBorder];
      },
      invalidate() {
        const comp = component;
        if (comp.parent && typeof comp.parent.invalidate === "function") {
          comp.parent.invalidate();
        }
      }
    };
    return component;
  };
}

// src/tools/research-knowledge-search.ts
var ResearchKnowledgeSearchParams = Type9.Object({
  queries: Type9.Array(Type9.String(), {
    minItems: 1,
    maxItems: 5,
    description: "Search queries for the knowledge database (1-5 queries)."
  })
});
var MAX_REFERENCE_CHARS = 12e4;
var MAX_DOCUMENTS = 10;
var KNOWLEDGE_WIDGET_ID = "pi-research-knowledge-search";
var RESEARCH_KNOWLEDGE_MISS_STRING = "No results found. Live research can get the info.";
var RESEARCH_KNOWLEDGE_MAYBE_STRING = "Partial results found in knowledge store. Live research can fill gaps.";
function showKnowledgeSearchWidget(ctx) {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  try {
    const panelFactory = createKnowledgeSearchPanel();
    ctx.ui.setWidget(KNOWLEDGE_WIDGET_ID, panelFactory, { placement: "aboveEditor" });
  } catch (err) {
    logger.debug(`[research-knowledge-search] Failed to show TUI widget: ${err}`);
  }
}
function hideKnowledgeSearchWidget(ctx) {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  try {
    ctx.ui.setWidget(KNOWLEDGE_WIDGET_ID, void 0, { placement: "aboveEditor" });
  } catch (err) {
    logger.debug(`[research-knowledge-search] Failed to hide TUI widget: ${err}`);
  }
}
async function assembleReferenceDocuments(queries, store) {
  const allUrls = /* @__PURE__ */ new Map();
  const provenanceByUrl = /* @__PURE__ */ new Map();
  for (const query of queries) {
    try {
      const results = await store.findRelevantUrls(query, { limit: 20 });
      for (const entry of results) {
        if (!allUrls.has(entry.url)) {
          allUrls.set(entry.url, allUrls.size);
          provenanceByUrl.set(entry.url, entry.provenance || "unknown");
        }
      }
    } catch (err) {
      logger.debug(`[research-knowledge-search] Vector search failed for query "${query}": ${err}`);
    }
  }
  if (allUrls.size === 0) {
    return { text: "", urls: [] };
  }
  const sortedUrls = [...allUrls.keys()].sort((a, b) => (allUrls.get(a) ?? Infinity) - (allUrls.get(b) ?? Infinity)).slice(0, MAX_DOCUMENTS);
  const documentParts = [];
  let totalChars = 0;
  for (const url of sortedUrls) {
    try {
      const rebuilt = await store.rebuildDocument(url);
      if (!rebuilt) {
        logger.debug(`[research-knowledge-search] Could not rebuild document for ${url}`);
        continue;
      }
      const provenance = provenanceByUrl.get(url) || "unknown";
      const header = `
---
### Source: ${url}
#### Provenance: ${provenance}
`;
      const docText = rebuilt.text || "";
      const entry = header + docText;
      if (totalChars + entry.length > MAX_REFERENCE_CHARS) {
        const remaining = MAX_REFERENCE_CHARS - totalChars - header.length;
        if (remaining > 500) {
          documentParts.push(header + docText.slice(0, remaining) + "\n[TRUNCATED]");
        }
        break;
      }
      documentParts.push(entry);
      totalChars += entry.length;
    } catch (err) {
      logger.debug(`[research-knowledge-search] Failed to rebuild ${url}: ${err}`);
    }
  }
  return { text: documentParts.join("\n"), urls: sortedUrls };
}
async function serializeConversationHistory(ctx) {
  try {
    return await formatParentContext(ctx);
  } catch (err) {
    logger.debug(`[research-knowledge-search] Failed to serialize conversation history: ${err}`);
    return "(Conversation context unavailable)";
  }
}
function resolveSynthesisModel(ctx) {
  try {
    const model = resolveResearchModel({
      modelRegistry: ctx.modelRegistry,
      hostModel: ctx.model,
      cwd: ctx.cwd
    });
    return { model };
  } catch (err) {
    return { error: String(err) };
  }
}
function validateResponse(raw) {
  if (!raw || typeof raw !== "object") return null;
  try {
    const coerced = Value10.Convert(ResearchKnowledgeSynthesisResponseSchema, raw);
    if (Value10.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)) {
      return coerced;
    }
  } catch {
  }
  return null;
}
async function runBackgroundExtraction(model, auth, conversationHistory, referenceDocuments, signal) {
  const promptTemplate = loadPrompt("research-knowledge-search-extractor");
  if (!promptTemplate) {
    throw new Error("research-knowledge-search prompt template not found");
  }
  const systemPrompt = promptTemplate.replace("{{conversation_history}}", conversationHistory).replace("{{reference_documents}}", referenceDocuments);
  const userMessage = "Analyze the reference documents above and extract the answer using the required JSON format.";
  const llmTimeout = getConfig().LLM_TIMEOUT_MS;
  const response = await Promise.race([
    completeSimple2(model, {
      systemPrompt,
      messages: [
        { role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }
      ]
    }, buildSafeOptions(model, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal
    }, 4096)),
    createTimeout(llmTimeout, "knowledge-search-extraction")
  ]);
  const rawUsage = response.usage;
  if (rawUsage) {
    const { tokens, cost } = extractUsage(model, rawUsage);
    if (tokens > 0 || cost > 0) {
      metrics.increment("llm_tokens_total", tokens, { component: "knowledge_search" });
      metrics.increment("llm_cost_total", cost, { component: "knowledge_search" });
    }
  }
  const responseText = validateAndExtractText(response, "Knowledge Extraction");
  const extracted = extractJson(responseText, "object");
  if (extracted.success && extracted.value) {
    const validated = validateResponse(extracted.value);
    if (validated) {
      return validated;
    }
    try {
      const errors = [...Value10.Errors(ResearchKnowledgeSynthesisResponseSchema, extracted.value)];
      const errorDetail = errors.map((e) => `${e.path}: ${e.message}`).join(", ");
      logger.debug(`[research-knowledge-search] Schema validation failed: ${errorDetail}`);
    } catch (validationErr) {
      logger.debug(`[research-knowledge-search] TypeBox validation error: ${validationErr}`);
    }
  }
  logger.warn("[research-knowledge-search] Background LLM response malformed, attempting agentic repair");
  const repaired = await repairJsonWithLlm(
    responseText,
    completeSimple2,
    auth,
    {
      model,
      schema: ResearchKnowledgeSynthesisResponseSchemaAsTSchema,
      context: "Knowledge search extraction \u2014 synthesizing answer from reference documents",
      serviceName: "ResearchKnowledgeSearch",
      signal
    }
  );
  if (repaired) {
    const validated = validateResponse(repaired);
    if (validated) return validated;
  }
  logger.error("[research-knowledge-search] Agentic repair failed, returning NOT_FOUND");
  return { answer_status: "no", synthesis: "", citations: [] };
}
function buildSteeringResult(result, urls) {
  const status = result.answer_status;
  if (status === "no") {
    metrics.increment("research_knowledge_search_total", 1, { status: "not_found" });
    return {
      content: [{ type: "text", text: RESEARCH_KNOWLEDGE_MISS_STRING }],
      details: { source: "research_knowledge_search", found: false, answerStatus: "no" }
    };
  }
  const synthesis = result.synthesis || "";
  let report = synthesis;
  if (result.citations.length > 0) {
    report += "\n\n### Sources\n";
    for (let i = 0; i < result.citations.length; i++) {
      report += `${i + 1}. ${result.citations[i]}
`;
    }
    report += "\n---";
  }
  if (status === "maybe") {
    metrics.increment("research_knowledge_search_total", 1, { status: "partial" });
    report += "\n\n" + RESEARCH_KNOWLEDGE_MAYBE_STRING;
    return {
      content: [{ type: "text", text: report }],
      details: {
        source: "research_knowledge_search",
        found: true,
        answerStatus: "maybe",
        citations: result.citations,
        documentsSearched: urls.length
      }
    };
  }
  metrics.increment("research_knowledge_search_total", 1, { status: "found" });
  metrics.increment("research_knowledge_search_citations_total", result.citations.length);
  return {
    content: [{ type: "text", text: report }],
    details: {
      source: "research_knowledge_search",
      found: true,
      answerStatus: "yes",
      citations: result.citations,
      documentsSearched: urls.length
    }
  };
}
function missResult(reason) {
  metrics.increment("research_knowledge_search_total", 1, { status: reason });
  logger.info("[research-knowledge-search] Knowledge store miss:", reason);
  let text = RESEARCH_KNOWLEDGE_MISS_STRING;
  switch (reason) {
    case "store_empty":
      text = "No results found (knowledge store is empty). Live research can get the info.";
      break;
    case "store_disabled":
      text = "No results found (knowledge store is disabled in settings). Live research can get the info.";
      break;
    case "store_not_ready":
      text = "No results found (knowledge store is initializing). Live research can get the info.";
      break;
    case "store_unavailable":
      text = "No results found (knowledge store unavailable). Live research can get the info.";
      break;
    case "no_results":
      text = "No results found (no matching content). Live research can get the info.";
      break;
    case "no_model":
      text = "No results found (no model configured). Live research can get the info.";
      break;
    case "auth_failed":
      text = "No results found (authentication error). Live research can get the info.";
      break;
  }
  return {
    content: [{ type: "text", text }],
    details: { source: "research_knowledge_search", found: false, answerStatus: "no", reason }
  };
}
function createResearchKnowledgeSearchTool() {
  return {
    name: "research_knowledge_search",
    label: "Research Knowledge Search",
    description: "Search the research knowledge database for previously investigated information. Use this before performing live web research.",
    promptSnippet: "Search research knowledge database",
    promptGuidelines: [
      "Query `research_knowledge_search` first for research tasks.",
      'If status is "no", proceed with `research` for live investigation.',
      'If status is "maybe", use the synthesis and fill gaps with live research.',
      'If status is "yes", the answer is complete; no live research needed.',
      "Do not call both knowledge search and research for the same query simultaneously."
    ],
    parameters: ResearchKnowledgeSearchParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const startTime = Date.now();
      const p = params;
      const container = tryGetServiceContainerFromCtx(ctx);
      showKnowledgeSearchWidget(ctx);
      try {
        let storeService;
        try {
          storeService = await getService(ServiceNames.KNOWLEDGE_STORE, ctx, container);
        } catch {
          return missResult("store_unavailable");
        }
        if (!storeService.isReady()) {
          const lifecycle = storeService.lifecycle;
          return missResult(lifecycle === "disabled" ? "store_disabled" : "store_not_ready");
        }
        const store = await storeService.getStore();
        if (!store) {
          return missResult("store_disabled");
        }
        const count = await store.count();
        if (count === 0) {
          return missResult("store_empty");
        }
        const { text: referenceText, urls } = await assembleReferenceDocuments(p.queries, store);
        if (!referenceText || referenceText.length === 0) {
          return missResult("no_results");
        }
        const conversationHistory = await serializeConversationHistory(ctx);
        const { model, error: modelError } = resolveSynthesisModel(ctx);
        if (modelError || !model) {
          return missResult(modelError || "no_model");
        }
        const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!authResult.ok) {
          logger.warn(`[research-knowledge-search] Model auth failed: ${authResult.error}`);
          return missResult("auth_failed");
        }
        const result = await runBackgroundExtraction(
          model,
          { apiKey: authResult.apiKey || "", headers: authResult.headers },
          conversationHistory,
          referenceText,
          signal
        );
        const durationMs = Date.now() - startTime;
        metrics.observe("research_knowledge_search_duration_ms", durationMs);
        return buildSteeringResult(result, urls);
      } catch (error) {
        const durationMs = Date.now() - startTime;
        metrics.observe("research_knowledge_search_duration_ms", durationMs, { status: "error" });
        metrics.increment("research_knowledge_search_total", 1, { status: "error" });
        logger.error("[research-knowledge-search] Tool execution failed:", error);
        return {
          content: [{ type: "text", text: RESEARCH_KNOWLEDGE_MISS_STRING }],
          details: { source: "research_knowledge_search", found: false, answerStatus: "no", error: String(error) }
        };
      } finally {
        hideKnowledgeSearchWidget(ctx);
      }
    }
  };
}

// src/openclaw-entry.ts
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
var OpenClawConfigSchema = Type10.Object({
  apiKey: Type10.Optional(Type10.String({ description: "LLM API key" })),
  provider: Type10.Optional(Type10.String({ description: "LLM provider name" })),
  model: Type10.Optional(Type10.String({ description: "Model ID override for researcher sub-agents" })),
  timeoutMs: Type10.Optional(Type10.Number({ minimum: 18e4, maximum: 18e5, default: 3e5 })),
  maxResearchers: Type10.Optional(Type10.Number({ minimum: 1, maximum: 5, default: 3 })),
  defaultDepth: Type10.Optional(Type10.Number({ minimum: 0, maximum: 3, default: 1 })),
  maxScrapeBatches: Type10.Optional(Type10.Number({ minimum: 0, maximum: 99, default: 2 })),
  maxConcurrentScrapes: Type10.Optional(Type10.Number({ minimum: 1, maximum: 20, default: 3 })),
  workerThreads: Type10.Optional(Type10.Number({ minimum: 1, maximum: 10, default: 4 })),
  workerConcurrency: Type10.Optional(Type10.Number({ minimum: 1, maximum: 10, default: 2 })),
  knowledgeEnabled: Type10.Optional(Type10.Boolean({ default: true })),
  embeddingModel: Type10.Optional(Type10.String({ description: "Embedding model (defaults to user config)" })),
  embeddingDevice: Type10.Optional(Type10.Union([Type10.Literal("webgpu"), Type10.Literal("cpu")], { default: "webgpu" })),
  migrationStrategy: Type10.Optional(Type10.Union([Type10.Literal("drop"), Type10.Literal("re-embed"), Type10.Literal("backup")], { default: "backup" })),
  cacheTtlDays: Type10.Optional(Type10.Number({ minimum: 1, maximum: 365, default: 30 })),
  scrapeTimeoutMs: Type10.Optional(Type10.Number({ minimum: 5e3, maximum: 12e4, default: 15e3 })),
  stackexchangeApiKey: Type10.Optional(Type10.String({ description: "Stack Exchange API key for higher rate limits" })),
  reportExportEnabled: Type10.Optional(Type10.Boolean({ default: false }))
});
var isInitialized = false;
var globalContainer = null;
var globalRegistry = null;
var globalModel = null;
var globalConfig = null;
var globalDefaultDepth = 1;
var _headlessObserver = null;
async function ensureInitialized(pluginConfig) {
  if (isInitialized) return;
  const cwd = process.cwd();
  globalConfig = { ...getConfig(cwd) };
  if (pluginConfig.timeoutMs !== void 0) globalConfig.RESEARCHER_TIMEOUT_MS = pluginConfig.timeoutMs;
  if (pluginConfig.maxResearchers !== void 0) globalConfig.MAX_CONCURRENT_RESEARCHERS = pluginConfig.maxResearchers;
  if (pluginConfig.maxScrapeBatches !== void 0) globalConfig.MAX_SCRAPE_BATCHES = pluginConfig.maxScrapeBatches;
  if (pluginConfig.maxConcurrentScrapes !== void 0) globalConfig.MAX_CONCURRENT_SCRAPES = pluginConfig.maxConcurrentScrapes;
  if (pluginConfig.workerThreads !== void 0) globalConfig.WORKER_THREADS = pluginConfig.workerThreads;
  if (pluginConfig.workerConcurrency !== void 0) globalConfig.WORKER_CONCURRENCY = pluginConfig.workerConcurrency;
  if (pluginConfig.embeddingModel !== void 0) globalConfig.EMBEDDING_MODEL = pluginConfig.embeddingModel;
  if (pluginConfig.embeddingDevice !== void 0) globalConfig.EMBEDDING_DEVICE = pluginConfig.embeddingDevice;
  if (pluginConfig.migrationStrategy !== void 0) globalConfig.MIGRATION_STRATEGY = pluginConfig.migrationStrategy;
  if (pluginConfig.cacheTtlDays !== void 0) globalConfig.KNOWLEDGE_STORE_CACHE_TTL_DAYS = pluginConfig.cacheTtlDays;
  if (pluginConfig.scrapeTimeoutMs !== void 0) globalConfig.SCRAPE_TIMEOUT_MS = pluginConfig.scrapeTimeoutMs;
  if (pluginConfig.model !== void 0) globalConfig.RESEARCH_MODEL = pluginConfig.model;
  if (pluginConfig.reportExportEnabled !== void 0) globalConfig.RESEARCH_REPORT_EXPORT_ENABLED = pluginConfig.reportExportEnabled;
  if (pluginConfig.stackexchangeApiKey !== void 0) {
    process.env["STACKEXCHANGE_API_KEY"] = pluginConfig.stackexchangeApiKey;
  }
  if (pluginConfig.knowledgeEnabled !== void 0) {
    globalConfig.KNOWLEDGE_STORE_MODE = pluginConfig.knowledgeEnabled ? "project" : "none";
  }
  if (pluginConfig.defaultDepth !== void 0) {
    globalDefaultDepth = pluginConfig.defaultDepth;
  }
  globalRegistry = await buildModelRegistry(pluginConfig.apiKey, pluginConfig.provider);
  globalModel = resolveModel(
    globalRegistry,
    pluginConfig.model,
    pluginConfig.provider,
    pluginConfig.apiKey
  );
  globalContainer = getServiceContainer();
  registerInfrastructureServices(globalContainer);
  registerCoreServices(globalContainer);
  registerOrchestrationServices(globalContainer);
  const mockCtx = createMockContext(globalModel, globalRegistry);
  await initializeCoreServices(mockCtx, globalContainer);
  isInitialized = true;
}
async function shutdown() {
  if (!isInitialized) return;
  try {
    await shutdownManager.runCleanup("OpenClaw shutdown");
    await shutdownInfrastructureServices(globalContainer);
    await disposeCoreServices(globalContainer);
    await resetServiceContainer(globalContainer);
    clearAllSessionState();
  } catch (err) {
    logger.error("[OpenClaw] Shutdown error:", err);
  } finally {
    isInitialized = false;
    globalContainer = null;
    globalRegistry = null;
    globalModel = null;
    globalConfig = null;
  }
}
function createMockContext(model, registry) {
  const sessionId = `openclaw-${randomUUID6()}`;
  return {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    model,
    modelRegistry: registry,
    sessionId,
    container: globalContainer,
    getContextUsage: () => void 0,
    getSystemPrompt: () => "",
    getSignal: () => void 0,
    compact: () => {
    },
    abort: () => {
    },
    shutdown: () => {
    },
    getSystemPromptOptions: () => ({ selectedTools: ["research", "health"] }),
    ui: {
      notify: () => {
      },
      setWidget: () => {
      },
      custom: async () => ({ type: "cancel" }),
      confirm: async () => false,
      onTerminalInput: () => () => {
        return () => {
        };
      }
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => []
    }
  };
}
var openclaw_entry_default = definePluginEntry({
  id: "pi-research",
  name: "Pi Research",
  description: "Multi-agent web research with stealth browser, security databases, and Stack Exchange integration.",
  configSchema: buildJsonPluginConfigSchema({
    type: "object",
    properties: {
      apiKey: { type: "string", description: "LLM API key" },
      provider: { type: "string", description: "LLM provider name" },
      model: { type: "string", description: "Model ID override for researcher sub-agents" },
      timeoutMs: { type: "number", minimum: 18e4, maximum: 18e5, default: 3e5 },
      maxResearchers: { type: "number", minimum: 1, maximum: 5, default: 3 },
      defaultDepth: { type: "number", minimum: 0, maximum: 3, default: 1 },
      maxScrapeBatches: { type: "number", minimum: 0, maximum: 99, default: 2 },
      maxConcurrentScrapes: { type: "number", minimum: 1, maximum: 20, default: 3 },
      workerThreads: { type: "number", minimum: 1, maximum: 10, default: 4 },
      workerConcurrency: { type: "number", minimum: 1, maximum: 10, default: 2 },
      knowledgeEnabled: { type: "boolean", default: true },
      embeddingModel: { type: "string", description: "Embedding model (defaults to user config)" },
      embeddingDevice: { type: "string", enum: ["webgpu", "cpu"], default: "webgpu" },
      migrationStrategy: { type: "string", enum: ["drop", "re-embed", "backup"], default: "backup" },
      cacheTtlDays: { type: "number", minimum: 1, maximum: 365, default: 30 },
      scrapeTimeoutMs: { type: "number", minimum: 5e3, maximum: 12e4, default: 15e3 },
      stackexchangeApiKey: { type: "string", description: "Stack Exchange API key for higher rate limits" },
      reportExportEnabled: { type: "boolean", default: false }
    }
  }),
  async register(api) {
    api.lifecycle.registerRuntimeLifecycle({
      id: "pi-research-lifecycle",
      description: "Cleans up research sub-agents, browser processes, and knowledge store connections.",
      cleanup: async () => {
        logger.info("[OpenClaw] Shutdown signal received via lifecycle hook.");
        await shutdown();
      }
    });
    api.registerTool({
      name: "research",
      label: "Research",
      description: "Perform multi-source web research using search, scraping, and specialized databases.",
      parameters: Type10.Object({
        query: Type10.Optional(Type10.String({
          description: "The research topic or query to investigate."
        })),
        depth: Type10.Optional(Type10.Integer({
          minimum: 0,
          maximum: 3,
          description: "Research complexity. 0=quick, 1=normal, 2=deep, 3=ultra."
        })),
        excludeTools: Type10.Optional(Type10.Array(Type10.String(), {
          description: 'List of internal research tools to disable. Defaults to ["grep", "read"].'
        })),
        initialLinks: Type10.Optional(Type10.Array(Type10.String(), {
          description: "Optional seed URLs to investigate before (or instead of) web search."
        }))
      }),
      async execute(_toolCallId, params, signal) {
        const config = api.pluginConfig ?? {};
        await ensureInitialized(config);
        const query = params.query?.trim();
        if (!query && (!params.initialLinks || params.initialLinks.length === 0)) {
          throw new Error("Research query or initialLinks are required.");
        }
        const depth = params.depth ?? globalDefaultDepth;
        const excludeTools = params.excludeTools ?? ["grep", "read"];
        const initialLinks = params.initialLinks;
        const researchId = createResearchRunId();
        const piSessionId = `openclaw-${randomUUID6()}`;
        const mockCtx = createMockContext(globalModel, globalRegistry);
        const observer = _headlessObserver ??= new HeadlessObserver({ enableLogging: true });
        const researchStart = Date.now();
        try {
          let result;
          if (depth === 0) {
            const orchestrator = new QuickResearchOrchestrator({
              ctx: mockCtx,
              model: globalModel,
              query: query || (initialLinks?.[0] ?? "Initial Links Research"),
              sessionId: piSessionId,
              researchId,
              observer,
              config: globalConfig,
              excludeTools,
              initialLinks
            });
            result = await orchestrator.run(signal);
          } else {
            const complexity = Math.max(1, Math.min(3, depth));
            const orchService = await getService(ServiceNames.RESEARCH_ORCHESTRATION, mockCtx, globalContainer);
            const orchestrator = new DeepResearchOrchestrator({
              ctx: mockCtx,
              model: globalModel,
              query: query || (initialLinks?.[0] ?? "Initial Links Research"),
              complexity,
              sessionId: piSessionId,
              researchId,
              observer,
              config: globalConfig,
              excludeTools,
              orchestrationService: orchService,
              initialLinks
            });
            result = await orchestrator.run(signal);
          }
          metrics.observe("research_manager_latency_ms", Date.now() - researchStart, {
            depth: String(depth),
            status: "success",
            source: "openclaw"
          });
          if (config.reportExportEnabled) {
            const exportPath = config.reportExportPath || process.cwd();
            const filename = await exportResearchReport(result, query || (initialLinks?.[0] ?? "Research"), exportPath);
            result += `

Research report saved to ${filename}`;
          }
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[OpenClaw] Research failed: ${message}`);
          throw error;
        }
      }
    });
    api.registerTool({
      name: "health",
      label: "Health Check",
      description: "Check system health status across all research components.",
      parameters: Type10.Object({
        verbose: Type10.Optional(Type10.Boolean({ default: true })),
        probe: Type10.Optional(Type10.Boolean({ default: false }))
      }),
      async execute(_toolCallId, params) {
        const config = api.pluginConfig ?? {};
        await ensureInitialized(config);
        const { probe = false } = params;
        const systemHealth = await healthRegistry.runAll({ force: probe });
        return { content: [{ type: "text", text: JSON.stringify(systemHealth, null, 2) }], details: {} };
      }
    });
    api.registerTool({
      name: "research_knowledge_search",
      label: "Research Knowledge Search",
      description: "Search the research knowledge database for previously researched information.",
      parameters: Type10.Object({
        queries: Type10.Array(Type10.String(), { minItems: 1, maxItems: 5 })
      }),
      async execute(toolCallId, params, signal) {
        const config = api.pluginConfig ?? {};
        await ensureInitialized(config);
        if (globalConfig?.KNOWLEDGE_STORE_MODE === "none") {
          throw new Error("Knowledge store is disabled (knowledgeEnabled: false). Enable it in plugin settings to use this tool.");
        }
        const mockCtx = createMockContext(globalModel, globalRegistry);
        const tool = createResearchKnowledgeSearchTool();
        const result = await tool.execute(toolCallId, params, signal, void 0, mockCtx);
        return { ...result, details: {} };
      }
    });
  }
});
export {
  openclaw_entry_default as default
};
