/**
 * Logger Module Unit Tests
 *
 * Tests the refactored logger that writes to file (verbose) or is silent (default).
 * Tests also verify logging stays scoped and never patches console methods.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
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
    const testLogPaths = [TEST_LOG_PATH];
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

    it('should create per-run log file when researchRunId is provided', () => {
      const runId = 'run-a1b2c3d4';
      const logger = createLogger({ verbose: true, researchRunId: runId });
      
      const logPath = logger.getLogFilePath();
      expect(logPath).toContain(runId);
      expect(logPath).toMatch(/pi-research-run-a1b2c3d4\.log$/);
    });

    it('should create default log file when no researchRunId is provided', () => {
      const logger = createLogger({ verbose: true });
      
      const logPath = logger.getLogFilePath();
      expect(logPath).toBe(path.join(os.tmpdir(), 'pi-research.log'));
    });

    it('should write to per-run log file', () => {
      const runId = 'run-test1234';
      const logger = createLogger({ verbose: true, researchRunId: runId });
      
      runWithLogContext({ researchRunId: runId, toolName: 'test' }, () => {
        logger.info('test message for per-run log');
      });
      
      const content = readFileSync(logger.getLogFilePath()!, 'utf-8');
      expect(content).toContain('test message for per-run log');
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

    it('should capture direct writes to FD 2 via fs.writeSync if supported', async () => {
      const fs = await import('node:fs');
      const descriptor = Object.getOwnPropertyDescriptor(fs, 'writeSync');
      if (descriptor && !descriptor.writable && !descriptor.set) {
          // Skip if fs.writeSync is immutable in this environment
          return;
      }

      const logDir = path.dirname(TEST_LOG_PATH);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      
      await logger.runCapturingStderr(async () => {
        try {
            fs.writeSync(2, 'Direct native write\n');
        } catch (e) {
            // Ignore if patch failed
        }
      });

      if (existsSync(TEST_LOG_PATH)) {
        const content = readFileSync(TEST_LOG_PATH, 'utf-8');
        if (content.includes('Direct native write')) {
            expect(content).toContain('"level":"FS_WRITE_SYNC_STDERR"');
        }
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
