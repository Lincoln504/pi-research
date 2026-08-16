/**
 * Logger Module Unit Tests
 *
 * Tests the refactored logger that writes to file (verbose) or is silent (default).
 * Tests also verify logging stays scoped and never patches console methods.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Logger,
  createLogger,
  getLogger,
  setLogger,
  resetLogger,
  isVerboseFromEnv,
  runWithLogContext,
  logger,
} from '../../src/logger';

const TEST_LOG_PATH = path.join(os.tmpdir(), 'pi-research-test.log');

describe('logger', () => {
  beforeEach(() => {
    // Clear debug flag for each test
    delete process.env['PI_RESEARCH_DEBUG'];
  });

  afterEach(() => {
    resetLogger();
    delete process.env['PI_RESEARCH_DEBUG'];

    // Clean up test log files
    const testLogPaths = [
      TEST_LOG_PATH,
      path.join(os.tmpdir(), 'pi-research-run-test1234.log')
    ];
    for (const path of testLogPaths) {
      try {
        unlinkSync(path);
      } catch {
        // File may not exist, which is fine
      }
    }
  });

  describe('Logger class', () => {

    it('should write structured JSONL with scoped context when verbose', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });

      runWithLogContext({
        sessionId: 'session-1',
        sessionFile: '/tmp/session.json',
        cwd: '/work',
        researchRunId: 'run-1234',
        toolName: 'research',
      }, () => {
        logger.warn('context test', { phase: 'startup' });
      });

      const [line] = readFileSync(TEST_LOG_PATH, 'utf-8').trim().split('\n');
      const entry = JSON.parse(line!);

      expect(entry).toEqual(expect.objectContaining({
        level: 'WARN',
        sessionId: 'session-1',
        sessionFile: '/tmp/session.json',
        cwd: '/work',
        researchRunId: 'run-1234',
        toolName: 'research',
      }));
      expect(entry.message).toContain('context test');
    });

    it('stamps every record with the writing process id', () => {
      // One log file, many processes: up to three concurrent research runs plus the
      // elected browser-pool leader. Without this, their lines interleave into
      // something that reads like a single process contradicting itself, and any
      // forensic reconstruction is inference from timing.
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });

      logger.warn('first');
      logger.error('second');

      const lines = readFileSync(TEST_LOG_PATH, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(JSON.parse(line!).pid).toBe(process.pid);
      }
    });

    it('lets scoped context override nothing it should not — pid survives a context scope', () => {
      // getLogContext() is spread AFTER pid, so a context key named `pid` would
      // silently replace the process identity with something else.
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });

      runWithLogContext({ sessionId: 'session-2', pid: 999_999 } as any, () => {
        logger.warn('scoped');
      });

      const [line] = readFileSync(TEST_LOG_PATH, 'utf-8').trim().split('\n');
      const entry = JSON.parse(line!);
      expect(entry.pid).toBe(process.pid);
      expect(entry.sessionId).toBe('session-2'); // the rest of the context still lands
    });

    it('should not mutate console methods when logging', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      const originalConsole = {
        log: console.log,
        info: console.info,
        error: console.error,
        warn: console.warn,
        debug: console.debug,
      };

      logger.log('test');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
      logger.debug('debug');

      expect(console.log).toBe(originalConsole.log);
      expect(console.info).toBe(originalConsole.info);
      expect(console.error).toBe(originalConsole.error);
      expect(console.warn).toBe(originalConsole.warn);
      expect(console.debug).toBe(originalConsole.debug);
    });

    it('buffers INFO/DEBUG (no synchronous disk write) until flushed', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      logger.info('buffered-info');
      // Still in the in-memory buffer — setImmediate has not fired in synchronous code.
      const beforeFlush = existsSync(TEST_LOG_PATH) ? readFileSync(TEST_LOG_PATH, 'utf-8') : '';
      expect(beforeFlush).not.toContain('buffered-info');
      logger.flushSync();
      expect(readFileSync(TEST_LOG_PATH, 'utf-8')).toContain('buffered-info');
    });

    it('asynchronously flushes buffered INFO without an explicit flush', async () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      logger.info('auto-flushed');
      await new Promise((resolve) => setTimeout(resolve, 50)); // setImmediate → flush → appendFile
      expect(readFileSync(TEST_LOG_PATH, 'utf-8')).toContain('auto-flushed');
    });

    it('writes WARN/ERROR synchronously — durable with no flush', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      logger.error('sync-error');
      expect(readFileSync(TEST_LOG_PATH, 'utf-8')).toContain('sync-error');
    });

    it('drains buffered INFO before a synchronous WARN so order is preserved', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      logger.info('first-info');
      logger.warn('then-warn'); // forces a synchronous drain of the buffer, then a sync write
      const lines = readFileSync(TEST_LOG_PATH, 'utf-8').trim().split('\n');
      const infoIdx = lines.findIndex((l) => l.includes('first-info'));
      const warnIdx = lines.findIndex((l) => l.includes('then-warn'));
      expect(infoIdx).toBeGreaterThanOrEqual(0);
      expect(warnIdx).toBeGreaterThan(infoIdx);
    });

    it('should have default log file path', () => {
      const logger = new Logger({ verbose: true });
      const logPath = logger.getLogFilePath();
      expect(logPath).not.toBeNull();
      expect(logPath).toContain('pi-research.log');
    });

    it('should still have a log file path when not verbose (for ERROR/WARN logs)', () => {
      const logger = new Logger({ verbose: false });
      expect(logger.getLogFilePath()).not.toBeNull();
      expect(logger.getLogFilePath()).toContain('pi-research.log');
    });
  });

  describe('isVerboseFromEnv', () => {
    it('should detect PI_RESEARCH_DEBUG=true', () => {
      process.env['PI_RESEARCH_DEBUG'] = 'true';
      expect(isVerboseFromEnv()).toBe(true);
      delete process.env['PI_RESEARCH_DEBUG'];
    });

    it('should be false when PI_RESEARCH_DEBUG is not set', () => {
      expect(isVerboseFromEnv()).toBe(false);
    });

    it('should be false for PI_RESEARCH_DEBUG=false', () => {
      process.env['PI_RESEARCH_DEBUG'] = 'false';
      expect(isVerboseFromEnv()).toBe(false);
      delete process.env['PI_RESEARCH_DEBUG'];
    });
  });

  describe('singleton functions', () => {
    it('should create global logger instance', () => {
      resetLogger();
      const logger1 = getLogger();
      const logger2 = getLogger();

      expect(logger1).toBe(logger2); // Same instance
      expect(logger1).toBeInstanceOf(Logger);
    });

    it('should set custom logger', () => {
      resetLogger();
      const customLogger = new Logger({ verbose: false });
      setLogger(customLogger);

      const retrieved = getLogger();
      expect(retrieved).toBe(customLogger);
    });

    it('should reset logger', () => {
      const originalLogger = getLogger();
      setLogger(new Logger({ verbose: false }));
      resetLogger();

      const loggerAfterReset = getLogger();
      expect(loggerAfterReset).not.toBe(originalLogger);
    });
  });

  describe('factory function', () => {
    it('should create logger instance', () => {
      const logger = createLogger();
      expect(logger).toBeInstanceOf(Logger);
    });

    it('should respect verbose option in factory', () => {
      const logger = createLogger({ verbose: true });
      expect(logger.isVerbose()).toBe(true);
    });

    it('should use the consolidated log file even when researchRunId is provided', () => {
      const runId = 'run-a1b2c3d4';
      const logger = createLogger({ verbose: true, researchRunId: runId });

      const logPath = logger.getLogFilePath();
      expect(logPath).toMatch(/pi-research\.log$/);
      // The run ID must NOT appear in the path — consolidated file, not per-run
      expect(logPath).not.toContain(runId);
    });

    it('should use the default log file when no researchRunId is provided', () => {
      const logger = createLogger({ verbose: true });

      const logPath = logger.getLogFilePath();
      expect(logPath).toMatch(/pi-research\.log$/);
    });

    it('should write to the consolidated log file with context', () => {
      const runId = 'run-test1234';
      const logger = createLogger({ verbose: true, researchRunId: runId });
      
      runWithLogContext({ researchRunId: runId, toolName: 'test' }, () => {
        logger.info('test message for consolidated log');
      });
      logger.flushSync(); // INFO is buffered/async — drain before reading the file

      const content = readFileSync(logger.getLogFilePath()!, 'utf-8');
      expect(content).toContain('test message for consolidated log');
      expect(content).toContain(`"researchRunId":"${runId}"`);
    });
    it('should throw if setting the wrapper as the global logger', () => {
      expect(() => setLogger(logger as any)).toThrow('setLogger must be called with a Logger instance, not the wrapper.');
    });

    it('should not allow nested stderr capture', async () => {
      const logger1 = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      const logger2 = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH + '.2' });

      let innerCaptured = false;
      await logger1.runCapturingStderr(async () => {
        await logger2.runCapturingStderr(async () => {
          innerCaptured = true;
        });
      });

      expect(innerCaptured).toBe(true);
      // Clean up
      if (existsSync(TEST_LOG_PATH + '.2')) unlinkSync(TEST_LOG_PATH + '.2');
    });

    it('should capture stderr even when NOT verbose', async () => {
      const silentLogger = new Logger({ verbose: false, logFilePath: TEST_LOG_PATH });
      
      await silentLogger.runCapturingStderr(async () => {
        process.stderr.write('spam message');
      });

      const content = readFileSync(TEST_LOG_PATH, 'utf-8');
      expect(content).toContain('spam message');
      expect(content).toContain('"level":"STDERR"');
    });

    it('should selectively capture native logs from stdout', async () => {
      // Ensure directory exists
      const logDir = path.dirname(TEST_LOG_PATH);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      
      await logger.runCapturingStderr(async () => {
        process.stdout.write('Warning: Dawn is noisy\n');
        process.stdout.write('\x1b[31mTUI Output\x1b[0m\n');
        process.stdout.write('Plain log text\n');
      });

      const content = readFileSync(TEST_LOG_PATH, 'utf-8');
      expect(content).toContain('Warning: Dawn is noisy');
      expect(content).toContain('Plain log text');
      expect(content).not.toContain('TUI Output');
    });

    it('should capture direct writes to FD 2 via fs.writeSync if supported', async (ctx) => {
      // The capture patch replaces writeSync on the CJS require-cache `fs` object
      // (stdio-capture obtains a mutable binding via createRequire). Native addons
      // and CJS callers — the real producers of FD-2 writes — go through that same
      // object, so the test must drive THAT binding too. An ESM `import('node:fs')`
      // namespace export is a fixed binding that would never observe the patch,
      // which is what silently masked a regression before.
      const { createRequire } = await import('node:module');
      const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
      const descriptor = Object.getOwnPropertyDescriptor(fs, 'writeSync');
      if (descriptor && !descriptor.writable && !descriptor.set) {
          // fs.writeSync is immutable in this environment, so the capture patch
          // genuinely cannot be installed. Skip VISIBLY rather than return a
          // silent green (which would hide an FD-2 capture regression).
          return ctx.skip();
      }

      const logDir = path.dirname(TEST_LOG_PATH);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });

      await logger.runCapturingStderr(async () => {
        // NOT wrapped in try/catch: if the FD-2 patch throws, the test must fail
        // rather than swallow the error and pass.
        fs.writeSync(2, 'Direct native write\n');
      });

      // Unconditional assertions: the direct FD-2 write must have been diverted
      // to the log file AND tagged with the FS_WRITE_SYNC_STDERR marker. If the
      // capture regressed, the write goes to the real stderr and these fail.
      const content = readFileSync(TEST_LOG_PATH, 'utf-8');
      expect(content).toContain('Direct native write');
      expect(content).toContain('"level":"FS_WRITE_SYNC_STDERR"');
    });
  });

  describe('console sink sanitization', () => {
    it('strips non-CSI terminal escapes (private-mode CSI, OSC, DCS) from console output', () => {
      // redactSecrets removes only the colour/style CSI subset, so pre-fix these
      // sequences reached the user's terminal verbatim under
      // PI_RESEARCH_CONSOLE_LOG=true — hiding the cursor, retitling the window.
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH, consoleLog: true });
        logger.warn('before \x1b[?25l\x1b]0;pwned\x07\x1bP+q544e\x1b\\ after');

        expect(spy).toHaveBeenCalledTimes(1);
        const line = String(spy.mock.calls[0]![0]);
        expect(line).toContain('before');
        expect(line).toContain('after');
        // The sink's OWN colour prefix is expected; the smuggled sequences are not.
        expect(line).not.toContain('\x1b[?25l');
        expect(line).not.toContain(']0;pwned');
        expect(line).not.toContain('\x07');
        expect(line).not.toContain('\x1bP');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('logger singleton', () => {
    it('should be used by extension via getLogger', () => {
      resetLogger();
      // The singleton is used internally via getLogger()
      const logger1 = getLogger();
      const logger2 = getLogger();

      expect(logger1).toBe(logger2);
      expect(typeof logger1.log).toBe('function');
      expect(typeof logger1.error).toBe('function');
    });
  });
});
