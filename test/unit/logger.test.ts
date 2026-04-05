/**
 * Logger Module Unit Tests
 *
 * Tests the refactored logger that writes to file (verbose) or is silent (default).
 * Tests also verify suppressConsole() patches console methods correctly.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { Logger, createLogger, getLogger, setLogger, resetLogger, isVerboseFromEnv, suppressConsole } from '../../src/logger';

describe('logger', () => {
  beforeEach(() => {
    // Clear verbose flag for each test
    process.argv = process.argv.filter(arg => arg !== '--verbose');
    delete process.env['PI_RESEARCH_VERBOSE'];
  });

  afterEach(() => {
    resetLogger();
    delete process.env['PI_RESEARCH_VERBOSE'];
    process.argv = process.argv.filter(arg => arg !== '--verbose');

    // Clean up test log files
    const testLogPaths = ['/tmp/test.log'];
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
      const logger = new Logger({ verbose: false, logFilePath: '/tmp/test.log' });

      expect(() => {
        logger.log('test message');
        logger.info('info message');
      }).not.toThrow();

      expect(logger.isVerbose()).toBe(false);
    });

    it('should detect verbose from isVerbose()', () => {
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });
      expect(logger.isVerbose()).toBe(true);
    });

    it('should handle error objects', () => {
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });

      const testError = new Error('test error');
      expect(() => {
        logger.error(testError);
      }).not.toThrow();
    });

    it('should handle object arguments', () => {
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });

      const testData = { key: 'value', number: 42 };
      expect(() => {
        logger.log('test', testData, 'extra');
      }).not.toThrow();
    });

    it('should return log file path', () => {
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });
      expect(logger.getLogFilePath()).toBe('/tmp/test.log');
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
      expect(logPath).toMatch(/^\/tmp\/pi-research-debug-[a-z0-9]{4}\.log$/);
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

    it('should detect PI_RESEARCH_VERBOSE=1 in env', () => {
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

  describe('suppressConsole', () => {
    it('should suppress console when not verbose', () => {
      resetLogger();
      const logger = new Logger({ verbose: false, logFilePath: '/tmp/test.log' });
      setLogger(logger);

      const originalLog = console.log;
      const restore = suppressConsole();

      // After suppression, console.log should be a noop
      expect(console.log).not.toBe(originalLog);

      // Call console.log — should not throw
      expect(() => {
        console.log('test');
      }).not.toThrow();

      // Restore
      restore();
      expect(console.log).toBe(originalLog);
    });

    it('should patch console when verbose', () => {
      resetLogger();
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });
      setLogger(logger);

      const originalLog = console.log;
      const restore = suppressConsole();

      // After suppression, console.log should be different
      expect(console.log).not.toBe(originalLog);

      // Call console.log — should not throw
      expect(() => {
        console.log('test message');
      }).not.toThrow();

      // Restore
      restore();
      expect(console.log).toBe(originalLog);
    });

    it('should handle console.error', () => {
      resetLogger();
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });
      setLogger(logger);

      const originalError = console.error;
      const restore = suppressConsole();

      expect(console.error).not.toBe(originalError);

      expect(() => {
        console.error('error message');
      }).not.toThrow();

      restore();
      expect(console.error).toBe(originalError);
    });

    it('should handle console.warn', () => {
      resetLogger();
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });
      setLogger(logger);

      const originalWarn = console.warn;
      const restore = suppressConsole();

      expect(console.warn).not.toBe(originalWarn);

      expect(() => {
        console.warn('warn message');
      }).not.toThrow();

      restore();
      expect(console.warn).toBe(originalWarn);
    });

    it('should handle console.debug', () => {
      resetLogger();
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });
      setLogger(logger);

      const originalDebug = (console as any).debug;
      const restore = suppressConsole();

      expect((console as any).debug).not.toBe(originalDebug);

      expect(() => {
        (console as any).debug('debug message');
      }).not.toThrow();

      restore();
      expect((console as any).debug).toBe(originalDebug);
    });

    it('should restore original console methods', () => {
      resetLogger();
      const logger = new Logger({ verbose: true, logFilePath: '/tmp/test.log' });
      setLogger(logger);

      const originalLog = console.log;
      const originalError = console.error;

      const restore = suppressConsole();

      // Should be different
      expect(console.log).not.toBe(originalLog);
      expect(console.error).not.toBe(originalError);

      // Restore
      restore();

      // Should be restored
      expect(console.log).toBe(originalLog);
      expect(console.error).toBe(originalError);
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
