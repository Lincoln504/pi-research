/**
 * Logger Module Unit Tests
 *
 * Tests the refactored logger that writes to file (verbose) or is silent (default).
 * Tests also verify logging stays scoped and never patches console methods.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync, unlinkSync } from 'node:fs';
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
} from '../../src/logger';

const TEST_LOG_PATH = path.join(os.tmpdir(), 'pi-research-test.log');

describe('logger', () => {
  beforeEach(() => {
    // Clear verbose flag for each test
    process.argv = process.argv.filter(arg => arg !== '--verbose');
    delete process.env['PI_RESEARCH_VERBOSE'];
  });

  afterEach(() => {
    resetLogger();
    process.argv = process.argv.filter(arg => arg !== '--verbose');
    delete process.env['PI_RESEARCH_VERBOSE'];

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
    it('should create logger instance with no options', () => {
      const logger = new Logger();
      expect(logger).toBeDefined();
      expect(logger.log).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.debug).toBeDefined();
    });

    it('should be silent when not verbose', () => {
      const logger = new Logger({ verbose: false, logFilePath: TEST_LOG_PATH });

      expect(() => {
        logger.log('test message');
        logger.info('info message');
      }).not.toThrow();

      expect(logger.isVerbose()).toBe(false);
    });

    it('should detect verbose from isVerbose()', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      expect(logger.isVerbose()).toBe(true);
    });

    it('should handle error objects', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });

      const testError = new Error('test error');
      expect(() => {
        logger.error(testError);
      }).not.toThrow();
    });

    it('should handle object arguments', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });

      const testData = { key: 'value', number: 42 };
      expect(() => {
        logger.log('test', testData, 'extra');
      }).not.toThrow();
    });

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

    it('should return log file path', () => {
      const logger = new Logger({ verbose: true, logFilePath: TEST_LOG_PATH });
      expect(logger.getLogFilePath()).toBe(TEST_LOG_PATH);
    });

    it('should return isVerbose status', () => {
      const verbose = new Logger({ verbose: true });
      const silent = new Logger({ verbose: false });

      expect(verbose.isVerbose()).toBe(true);
      expect(silent.isVerbose()).toBe(false);
    });

    it('should have default log file path with hash suffix', () => {
      const logger = new Logger({ verbose: true });
      const logPath = logger.getLogFilePath();
      expect(logPath).not.toBeNull();
      expect(path.dirname(logPath!)).toBe(os.tmpdir());
      expect(path.basename(logPath!)).toMatch(/^pi-research-debug-[a-z0-9]{4}\.log$/);
    });

    it('should have null log file path when not verbose', () => {
      const logger = new Logger({ verbose: false });
      expect(logger.getLogFilePath()).toBeNull();
    });
  });

  describe('isVerboseFromEnv', () => {
    it('should detect --verbose in process.argv', () => {
      process.argv.push('--verbose');
      expect(isVerboseFromEnv()).toBe(true);
    });

    it('should detect PI_RESEARCH_VERBOSE=1', () => {
      process.env['PI_RESEARCH_VERBOSE'] = '1';
      expect(isVerboseFromEnv()).toBe(true);
    });

    it('should be false when not verbose', () => {
      expect(isVerboseFromEnv()).toBe(false);
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
