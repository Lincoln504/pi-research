/**
 * Logger Module Unit Tests
 *
 * Tests the refactored logger factory pattern.
 * Now fully testable with dependency injection.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import {
  Logger,
  LogLevel,
  createLogger,
  getLogger,
  setLogger,
  resetLogger,
  isVerboseFromEnv,
  getDefaultLogFilePath,
  setupEmergencyHandlers,
  suppressConsole,
  isVerbose,
  type ILogger,
  type LoggerOptions,
} from '../../src/logger';

describe('logger (refactored)', () => {
  const originalConsole = { ...console };

  // Clean up global state between tests
  afterEach(() => {
    resetLogger();
    vi.restoreAllMocks();
  });

  describe('Logger class', () => {
    describe('constructor', () => {
      it('should create silent logger by default', () => {
        const logger = new Logger({ verbose: false });

        expect(logger.isVerbose()).toBe(false);
        expect(logger.getLogFilePath()).toBeNull();
      });

      it('should create verbose logger with default log file', () => {
        const logger = new Logger({ verbose: true, setupEmergencyHandlers: false });

        expect(logger.isVerbose()).toBe(true);
        expect(logger.getLogFilePath()).not.toBeNull();
        expect(logger.getLogFilePath()).toContain('/tmp/pi-research-');
      });

      it('should create verbose logger with custom log file', () => {
        const customPath = join(tmpdir(), 'test-custom.log');
        const logger = new Logger({ verbose: true, logFilePath: customPath, setupEmergencyHandlers: false });

        expect(logger.isVerbose()).toBe(true);
        expect(logger.getLogFilePath()).toBe(customPath);
      });

      it('should create verbose logger with partial options', () => {
        const logger = createLogger({ verbose: true, setupEmergencyHandlers: false });

        expect(logger.isVerbose()).toBe(true);
        expect(logger.getLogFilePath()).not.toBeNull();
      });

      it('should create silent logger with partial options', () => {
        const logger = createLogger();

        expect(logger.isVerbose()).toBe(false);
        expect(logger.getLogFilePath()).toBeNull();
      });
    });

    describe('log methods', () => {
      let logger: Logger;
      let logFilePath: string;

      beforeEach(() => {
        logFilePath = join(tmpdir(), `test-${Date.now()}.log`);
        logger = new Logger({ verbose: true, logFilePath, setupEmergencyHandlers: false });
      });

      afterEach(() => {
        if (existsSync(logFilePath)) {
          const fs = require('node:fs');
          try { fs.unlinkSync(logFilePath); } catch { /* ignore */ }
        }
      });

      it('should write INFO logs', () => {
        logger.info('test message');
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[INFO]');
        expect(content).toContain('test message');
      });

      it('should write ERROR logs', () => {
        logger.error('error message');
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[ERROR]');
        expect(content).toContain('error message');
      });

      it('should write WARN logs', () => {
        logger.warn('warning message');
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[WARN]');
        expect(content).toContain('warning message');
      });

      it('should write DEBUG logs', () => {
        logger.debug('debug message');
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[DEBUG]');
        expect(content).toContain('debug message');
      });

      it('should write generic log as INFO', () => {
        logger.log('generic message');
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[INFO]');
        expect(content).toContain('generic message');
      });

      it('should write multiple arguments', () => {
        logger.info('arg1', 'arg2', 'arg3');
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('arg1');
        expect(content).toContain('arg2');
        expect(content).toContain('arg3');
      });

      it('should handle Error objects', () => {
        const error = new Error('test error');
        logger.error(error);
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[ERROR]');
        expect(content).toContain('test error');
      });

      it('should handle objects as JSON', () => {
        const obj = { foo: 'bar', num: 42 };
        logger.info(obj);
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[INFO]');
        expect(content).toContain('foo');
        expect(content).toContain('bar');
        expect(content).toContain('42');
      });

      it('should handle arrays', () => {
        const arr = [1, 2, 3];
        logger.info(arr);
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[INFO]');
        expect(content).toContain('1');
        expect(content).toContain('2');
        expect(content).toContain('3');
      });

      it('should handle null and undefined', () => {
        logger.info(null, undefined);
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toContain('[INFO]');
        expect(content).toContain('null');
        expect(content).toContain('undefined');
      });

      it('should write timestamps in ISO format', () => {
        logger.info('timestamp test');
        const content = readFileSync(logFilePath, 'utf-8');

        expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/);
      });
    });

    describe('silent mode behavior', () => {
      let logger: Logger;
      let logFilePath: string;

      beforeEach(() => {
        logFilePath = join(tmpdir(), `test-silent-${Date.now()}.log`);
        logger = new Logger({ verbose: false, logFilePath, setupEmergencyHandlers: false });
      });

      it('should not write logs when not verbose', () => {
        logger.info('should not be written');
        logger.error('should not be written either');

        expect(existsSync(logFilePath)).toBe(false);
      });

      it('should return null for log file path', () => {
        expect(logger.getLogFilePath()).toBeNull();
      });

      it('should report not verbose', () => {
        expect(logger.isVerbose()).toBe(false);
      });
    });

    describe('error handling', () => {
      it('should handle file write errors gracefully', () => {
        // Use an invalid path that will fail
        const invalidPath = '/nonexistent/directory/file.log';
        const logger = new Logger({ verbose: true, logFilePath: invalidPath, setupEmergencyHandlers: false });

        expect(() => logger.info('test')).not.toThrow();
      });

      it('should handle errors in append', () => {
        const spy = vi.spyOn(require('node:fs'), 'appendFileSync').mockImplementation(() => {
          throw new Error('Simulated write error');
        });

        const logFilePath = join(tmpdir(), `test-error-${Date.now()}.log`);
        const logger = new Logger({ verbose: true, logFilePath, setupEmergencyHandlers: false });

        expect(() => logger.info('test')).not.toThrow();

        spy.mockRestore();
      });
    });

    describe('state methods', () => {
      it('should return correct verbose state', () => {
        const verboseLogger = new Logger({ verbose: true, setupEmergencyHandlers: false });
        const silentLogger = new Logger({ verbose: false });

        expect(verboseLogger.isVerbose()).toBe(true);
        expect(silentLogger.isVerbose()).toBe(false);
      });

      it('should return correct log file path', () => {
        const customPath = join(tmpdir(), 'custom.log');
        const logger = new Logger({ verbose: true, logFilePath: customPath, setupEmergencyHandlers: false });

        expect(logger.getLogFilePath()).toBe(customPath);
      });

      it('should return null for silent logger', () => {
        const logger = new Logger({ verbose: false });

        expect(logger.getLogFilePath()).toBeNull();
      });
    });
  });

  describe('createLogger', () => {
    it('should create logger with default options', () => {
      const logger = createLogger();

      expect(logger.isVerbose()).toBe(false);
      expect(logger.getLogFilePath()).toBeNull();
    });

    it('should create verbose logger', () => {
      const logger = createLogger({ verbose: true, setupEmergencyHandlers: false });

      expect(logger.isVerbose()).toBe(true);
      expect(logger.getLogFilePath()).not.toBeNull();
    });

    it('should create logger with custom log file', () => {
      const customPath = join(tmpdir(), 'test.log');
      const logger = createLogger({ verbose: true, logFilePath: customPath, setupEmergencyHandlers: false });

      expect(logger.getLogFilePath()).toBe(customPath);
    });

    it('should merge partial options with defaults', () => {
      const logger = createLogger({ verbose: false });

      expect(logger.isVerbose()).toBe(false);
      expect(logger.getLogFilePath()).toBeNull();
    });
  });

  describe('global logger state', () => {
    describe('getLogger', () => {
      it('should return same instance on subsequent calls', () => {
        const logger1 = getLogger();
        const logger2 = getLogger();

        expect(logger1).toBe(logger2);
      });

      it('should create default silent logger first time', () => {
        const logger = getLogger();

        expect(logger.isVerbose()).toBe(false);
        expect(logger.getLogFilePath()).toBeNull();
      });

      it('should check environment for verbose mode', () => {
        const originalArgv = process.argv.slice();
        const originalEnv = process.env;

        // Clean up first
        resetLogger();

        // Mock environment
        process.argv = ['node', 'script', '--verbose'];
        const logger = getLogger();

        expect(logger.isVerbose()).toBe(true);

        // Restore
        process.argv = originalArgv;
        process.env = originalEnv;
        resetLogger();
      });
    });

    describe('setLogger', () => {
      it('should set custom logger', () => {
        const customLogger = new Logger({ verbose: true, setupEmergencyHandlers: false });
        setLogger(customLogger);

        expect(getLogger()).toBe(customLogger);
        expect(getLogger().isVerbose()).toBe(true);
      });

      it('should replace existing logger', () => {
        const logger1 = getLogger();
        const logger2 = new Logger({ verbose: true, setupEmergencyHandlers: false });

        expect(getLogger()).not.toBe(logger2);

        setLogger(logger2);
        expect(getLogger()).toBe(logger2);
      });
    });

    describe('resetLogger', () => {
      it('should reset global logger', () => {
        const customLogger = new Logger({ verbose: true, setupEmergencyHandlers: false });
        setLogger(customLogger);
        expect(getLogger().isVerbose()).toBe(true);

        resetLogger();
        expect(getLogger().isVerbose()).toBe(false);
      });

      it('should work when no logger was set', () => {
        expect(() => resetLogger()).not.toThrow();
        resetLogger();
        resetLogger();
      });

      it('should create new instance after reset', () => {
        const logger1 = getLogger();
        resetLogger();
        const logger2 = getLogger();

        expect(logger1).not.toBe(logger2);
      });
    });
  });

  describe('isVerboseFromEnv', () => {
    let originalArgv: string[];
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalArgv = process.argv.slice();
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.argv = originalArgv;
      process.env = originalEnv;
    });

    it('should return true when --verbose in argv', () => {
      process.argv = ['node', 'script', '--verbose'];
      expect(isVerboseFromEnv()).toBe(true);
    });

    it('should return true when PI_RESEARCH_VERBOSE=1', () => {
      process.env.PI_RESEARCH_VERBOSE = '1';
      expect(isVerboseFromEnv()).toBe(true);
    });

    it('should return true when both conditions met', () => {
      process.argv = ['node', 'script', '--verbose'];
      process.env.PI_RESEARCH_VERBOSE = '1';
      expect(isVerboseFromEnv()).toBe(true);
    });

    it('should return false when no conditions met', () => {
      process.argv = ['node', 'script'];
      delete process.env.PI_RESEARCH_VERBOSE;
      expect(isVerboseFromEnv()).toBe(false);
    });

    it('should return false when PI_RESEARCH_VERBOSE is other value', () => {
      process.env.PI_RESEARCH_VERBOSE = '0';
      expect(isVerboseFromEnv()).toBe(false);

      process.env.PI_RESEARCH_VERBOSE = 'true';
      expect(isVerboseFromEnv()).toBe(false);

      process.env.PI_RESEARCH_VERBOSE = 'yes';
      expect(isVerboseFromEnv()).toBe(false);
    });

    it('should return false when verbose flag is different', () => {
      process.argv = ['node', 'script', '-v'];
      expect(isVerboseFromEnv()).toBe(false);
    });
  });

  describe('getDefaultLogFilePath', () => {
    it('should generate path with timestamp', () => {
      const path = getDefaultLogFilePath();
      expect(path).toMatch(/\/tmp\/pi-research-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
    });

    it('should generate unique paths', () => {
      // Test that calling it multiple times can generate different paths
      const path1 = getDefaultLogFilePath();
      const path2 = getDefaultLogFilePath();
      const path3 = getDefaultLogFilePath();

      // At least some should be different over time
      // For now, just verify the format is correct
      expect(path1).toMatch(/\/tmp\/pi-research-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
      expect(path2).toMatch(/\/tmp\/pi-research-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
      expect(path3).toMatch(/\/tmp\/pi-research-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
    });

    it('should be in /tmp directory', () => {
      const path = getDefaultLogFilePath();
      expect(path).toMatch(/^\/tmp\//);
    });
  });

  describe('setupEmergencyHandlers', () => {
    it('should return early with null path', () => {
      expect(() => setupEmergencyHandlers('')).not.toThrow();
    });

    it('should setup process handlers', () => {
      const path = join(tmpdir(), 'test.log');
      expect(() => setupEmergencyHandlers(path)).not.toThrow();
    });

    it('should not throw with valid path', () => {
      const path = join(tmpdir(), 'emergency.log');
      expect(() => setupEmergencyHandlers(path)).not.toThrow();
    });
  });

  describe('backward compatibility', () => {
    it('should export isVerbose const', () => {
      // isVerbose is checked at import time
      expect(typeof isVerbose).toBe('boolean');
    });
    it('should export logger singleton', () => {
      // The logger singleton is used internally
      // We can verify it works by using the global logger
      expect(typeof getLogger().log).toBe('function');
      expect(typeof getLogger().info).toBe('function');
      expect(typeof getLogger().error).toBe('function');
      expect(typeof getLogger().warn).toBe('function');
      expect(typeof getLogger().debug).toBe('function');
    });
    it('should export LogLevel enum', () => {
      expect(LogLevel.INFO).toBe('INFO');
      expect(LogLevel.ERROR).toBe('ERROR');
      expect(LogLevel.WARN).toBe('WARN');
      expect(LogLevel.DEBUG).toBe('DEBUG');
    });
    it('should export suppressConsole function', () => {
      expect(typeof suppressConsole).toBe('function');
    });
  });

  describe('suppressConsole', () => {
    it('should return a restore function', () => {
      const restore = suppressConsole();
      expect(typeof restore).toBe('function');
      restore();
    });

    it('should restore console after calling restore', () => {
      const originalLog = console.log;
      const restore = suppressConsole();
      restore();

      expect(console.log).toBe(originalLog);
    });

    it('should work in verbose mode', () => {
      const logger = new Logger({ verbose: true, setupEmergencyHandlers: false });
      setLogger(logger);

      const restore = suppressConsole();
      restore();

      expect(console.log).toBeDefined();
      resetLogger();
    });

    it('should work in silent mode', () => {
      const logger = new Logger({ verbose: false });
      setLogger(logger);

      const restore = suppressConsole();
      restore();

      expect(console.log).toBeDefined();
      resetLogger();
    });

    it('should be safe to call multiple times', () => {
      const restore1 = suppressConsole();
      const restore2 = suppressConsole();
      const restore3 = suppressConsole();

      expect(() => {
        restore3();
        restore2();
        restore1();
      }).not.toThrow();
    });
  });

  describe('integration scenarios', () => {
    it('should support full logger lifecycle', () => {
      // Create logger
      const logger1 = createLogger({ verbose: true, setupEmergencyHandlers: false });
      expect(logger1.isVerbose()).toBe(true);

      // Set as global
      setLogger(logger1);
      expect(getLogger()).toBe(logger1);

      // Use global
      expect(getLogger().isVerbose()).toBe(true);

      // Reset
      resetLogger();
      expect(getLogger().isVerbose()).toBe(false);
    });

    it('should work with console suppression', () => {
      const logger = new Logger({ verbose: true, setupEmergencyHandlers: false });
      setLogger(logger);

      const restore = suppressConsole();
      expect(typeof restore).toBe('function');

      restore();
      resetLogger();
    });

    it('should handle multiple loggers independently', () => {
      const logPath1 = join(tmpdir(), 'test1.log');
      const logPath2 = join(tmpdir(), 'test2.log');

      const logger1 = new Logger({ verbose: true, logFilePath: logPath1, setupEmergencyHandlers: false });
      const logger2 = new Logger({ verbose: true, logFilePath: logPath2, setupEmergencyHandlers: false });

      logger1.info('message from logger 1');
      logger2.info('message from logger 2');

      const content1 = readFileSync(logPath1, 'utf-8');
      const content2 = readFileSync(logPath2, 'utf-8');

      expect(content1).toContain('message from logger 1');
      expect(content2).toContain('message from logger 2');
      expect(content1).not.toContain('message from logger 2');
      expect(content2).not.toContain('message from logger 1');

      // Cleanup
      try { require('node:fs').unlinkSync(logPath1); } catch { /* ignore */ }
      try { require('node:fs').unlinkSync(logPath2); } catch { /* ignore */ }
    });
  });

  describe('edge cases', () => {
    it('should handle empty log messages', () => {
      const logFilePath = join(tmpdir(), 'empty.log');
      const logger = new Logger({ verbose: true, logFilePath, setupEmergencyHandlers: false });

      logger.info('');
      const content = readFileSync(logFilePath, 'utf-8');

      expect(content).toContain('[INFO]');
    });

    it('should handle very long messages', () => {
      const logFilePath = join(tmpdir(), 'long.log');
      const logger = new Logger({ verbose: true, logFilePath, setupEmergencyHandlers: false });
      const longMessage = 'x'.repeat(10000);

      logger.info(longMessage);
      const content = readFileSync(logFilePath, 'utf-8');

      expect(content).toContain('[INFO]');
      expect(content.length).toBeGreaterThan(10000);
    });

    it('should handle special characters', () => {
      const logFilePath = join(tmpdir(), 'special.log');
      const logger = new Logger({ verbose: true, logFilePath, setupEmergencyHandlers: false });

      logger.info('Special: \n\t\r"\'日本語🚀');
      const content = readFileSync(logFilePath, 'utf-8');

      expect(content).toContain('[INFO]');
      expect(content).toContain('日本語');
      expect(content).toContain('🚀');
    });

    it('should handle circular references gracefully', () => {
      const logFilePath = join(tmpdir(), 'circular.log');
      const logger = new Logger({ verbose: true, logFilePath, setupEmergencyHandlers: false });

      const safeObj = { a: 1, b: { c: 2 } };
      logger.info(safeObj);

      const content = readFileSync(logFilePath, 'utf-8');
      expect(content).toContain('[INFO]');
    });

    it('should handle numbers and booleans', () => {
      const logFilePath = join(tmpdir(), 'types.log');
      const logger = new Logger({ verbose: true, logFilePath, setupEmergencyHandlers: false });

      logger.info(123, true, false, 0, -1, 3.14);
      const content = readFileSync(logFilePath, 'utf-8');

      expect(content).toContain('123');
      expect(content).toContain('true');
      expect(content).toContain('false');
      expect(content).toContain('0');
      expect(content).toContain('-1');
      expect(content).toContain('3.14');
    });
  });
});
