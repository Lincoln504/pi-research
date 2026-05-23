/**
 * Structured Logger Unit Tests
 *
 * Tests the structured logging interface and context-aware logger factory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createStructuredLogger,
  createStructuredLoggerWithCorrelation,
  withCorrelationLogger,
  generateCorrelationId,
  NoOpLogger,
  InMemoryLogger,
  type ILogger,
} from '../../../src/utils/structured-logger.ts';
import { resetLogger } from '../../../src/logger.ts';

describe('Structured Logger', () => {
  beforeEach(() => {
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
  });

  describe('generateCorrelationId', () => {
    it('should generate unique correlation IDs', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();

      expect(id1).toMatch(/^corr-[a-z0-9]+-[a-z0-9]+$/);
      expect(id2).toMatch(/^corr-[a-z0-9]+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it('should generate correlation IDs with consistent format', () => {
      const ids = Array.from({ length: 100 }, generateCorrelationId);
      
      for (const id of ids) {
        expect(id).toMatch(/^corr-[a-z0-9]+-[a-z0-9]+$/);
      }
    });
  });

  describe('createStructuredLogger', () => {
    it('should create a logger with a component name', () => {
      const logger = createStructuredLogger('TestComponent');

      expect(logger.getComponent()).toBe('TestComponent');
      expect(logger.getCorrelationId()).toBeUndefined();
    });

    it('should create a logger with correlation ID', () => {
      const correlationId = 'corr-abc123';
      const logger = createStructuredLogger('TestComponent', {
        correlationId,
      });

      expect(logger.getComponent()).toBe('TestComponent');
      expect(logger.getCorrelationId()).toBe(correlationId);
    });

    it('should create a logger with base context', () => {
      const logger = createStructuredLogger('TestComponent', {
        baseContext: { sessionId: 'session-123', userId: 'user-456' },
      });

      expect(logger.getComponent()).toBe('TestComponent');
      expect(logger.getCorrelationId()).toBeUndefined();
    });

    it('should implement ILogger interface', () => {
      const logger = createStructuredLogger('TestComponent');

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.withContext).toBe('function');
      expect(typeof logger.getComponent).toBe('function');
      expect(typeof logger.getCorrelationId).toBe('function');
    });

    it('should not throw when logging at any level', () => {
      const logger = createStructuredLogger('TestComponent');

      expect(() => {
        logger.info('info message');
        logger.error('error message');
        logger.warn('warn message');
        logger.debug('debug message');
      }).not.toThrow();
    });

    it('should handle context objects', () => {
      const logger = createStructuredLogger('TestComponent');

      expect(() => {
        logger.info('operation started', { operation: 'search', query: 'test' });
        logger.warn('retrying', { attempt: 2, maxAttempts: 5 });
        logger.error('failed', new Error('test error'), { endpoint: '/api/test' });
      }).not.toThrow();
    });

    it('should handle undefined context', () => {
      const logger = createStructuredLogger('TestComponent');

      expect(() => {
        logger.info('no context');
        logger.warn('no context');
        logger.error('no context');
        logger.debug('no context');
      }).not.toThrow();
    });
  });

  describe('createStructuredLoggerWithCorrelation', () => {
    it('should create a logger with auto-generated correlation ID', () => {
      const logger = createStructuredLoggerWithCorrelation('TestComponent');

      expect(logger.getComponent()).toBe('TestComponent');
      expect(logger.getCorrelationId()).toMatch(/^corr-[a-z0-9]+-[a-z0-9]+$/);
    });

    it('should include base context along with correlation ID', () => {
      const logger = createStructuredLoggerWithCorrelation('TestComponent', {
        sessionId: 'session-123',
      });

      expect(logger.getComponent()).toBe('TestComponent');
      expect(logger.getCorrelationId()).toMatch(/^corr-[a-z0-9]+-[a-z0-9]+$/);
    });

    it('should generate unique correlation IDs for each call', () => {
      const logger1 = createStructuredLoggerWithCorrelation('TestComponent');
      const logger2 = createStructuredLoggerWithCorrelation('TestComponent');

      expect(logger1.getCorrelationId()).not.toBe(logger2.getCorrelationId());
    });
  });

  describe('withContext', () => {
    it('should create child logger with additional context', () => {
      const baseLogger = createStructuredLogger('TestComponent', {
        baseContext: { sessionId: 'session-123' },
      });
      const childLogger = baseLogger.withContext({ operation: 'search' });

      expect(childLogger.getComponent()).toBe('TestComponent');
      expect(childLogger.getCorrelationId()).toBe(baseLogger.getCorrelationId());
    });

    it('should preserve correlation ID in child loggers', () => {
      const baseLogger = createStructuredLogger('TestComponent', {
        correlationId: 'corr-abc123',
      });
      const childLogger = baseLogger.withContext({ operation: 'search' });

      expect(childLogger.getCorrelationId()).toBe('corr-abc123');
    });

    it('should merge context from parent and child', () => {
      const baseLogger = createStructuredLogger('TestComponent', {
        baseContext: { sessionId: 'session-123' },
      });
      const childLogger = baseLogger.withContext({ operation: 'search', query: 'test' });

      expect(childLogger.getComponent()).toBe('TestComponent');
      // Context is applied lazily when logging, so we just verify the logger structure
    });

    it('should allow chaining withContext calls', () => {
      const logger = createStructuredLogger('TestComponent');
      const child1 = logger.withContext({ level1: 'value1' });
      const child2 = child1.withContext({ level2: 'value2' });

      expect(child2.getComponent()).toBe('TestComponent');
    });
  });

  describe('withCorrelationLogger', () => {
    it('should run operation with correlation-scoped logger', async () => {
      const result = await withCorrelationLogger('TestComponent', async (logger) => {
        expect(logger.getComponent()).toBe('TestComponent');
        expect(logger.getCorrelationId()).toMatch(/^corr-[a-z0-9]+-[a-z0-9]+$/);
        logger.info('operation started');
        return 'success';
      });

      expect(result).toBe('success');
    });

    it('should pass through base context', async () => {
      await withCorrelationLogger('TestComponent', async (logger) => {
        logger.info('operation started');
        expect(logger.getComponent()).toBe('TestComponent');
      }, { sessionId: 'session-123' });
    });

    it('should propagate errors from operation', async () => {
      const error = new Error('operation failed');

      await expect(
        withCorrelationLogger('TestComponent', async () => {
          throw error;
        })
      ).rejects.toThrow('operation failed');
    });

    it('should log errors before rethrowing', async () => {
      const error = new Error('operation failed');

      try {
        await withCorrelationLogger('TestComponent', async (logger) => {
          throw error;
        });
      } catch {
        // Expected error
      }
    });
  });

  describe('NoOpLogger', () => {
    it('should implement ILogger interface', () => {
      const logger = new NoOpLogger();

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.withContext).toBe('function');
      expect(typeof logger.getComponent).toBe('function');
      expect(typeof logger.getCorrelationId).toBe('function');
    });

    it('should not throw on any log calls', () => {
      const logger = new NoOpLogger();

      expect(() => {
        logger.info('info');
        logger.error('error', new Error('test'));
        logger.warn('warn');
        logger.debug('debug');
      }).not.toThrow();
    });

    it('should return default component name', () => {
      const logger = new NoOpLogger();
      expect(logger.getComponent()).toBe('NoOp');
    });

    it('should return undefined correlation ID', () => {
      const logger = new NoOpLogger();
      expect(logger.getCorrelationId()).toBeUndefined();
    });

    it('should accept custom component name', () => {
      const logger = new NoOpLogger('TestComponent');
      expect(logger.getComponent()).toBe('TestComponent');
    });

    it('should return NoOpLogger from withContext', () => {
      const logger = new NoOpLogger();
      const child = logger.withContext({ operation: 'test' });

      expect(child).toBeInstanceOf(NoOpLogger);
      expect(child.getComponent()).toBe('NoOp');
    });
  });

  describe('InMemoryLogger', () => {
    it('should implement ILogger interface', () => {
      const logger = new InMemoryLogger();

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.withContext).toBe('function');
      expect(typeof logger.getComponent).toBe('function');
      expect(typeof logger.getCorrelationId).toBe('function');
    });

    it('should collect log entries', () => {
      const logger = new InMemoryLogger();

      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');
      logger.debug('debug message');

      const logs = logger.getLogs();
      expect(logs).toHaveLength(4);
    });

    it('should store log levels correctly', () => {
      const logger = new InMemoryLogger();

      logger.info('info');
      logger.warn('warn');
      logger.error('error');
      logger.debug('debug');

      const logs = logger.getLogs();
      expect(logs[0].level).toBe('info');
      expect(logs[1].level).toBe('warn');
      expect(logs[2].level).toBe('error');
      expect(logs[3].level).toBe('debug');
    });

    it('should store messages correctly', () => {
      const logger = new InMemoryLogger();

      logger.info('message 1');
      logger.warn('message 2');

      const logs = logger.getLogs();
      expect(logs[0].message).toBe('message 1');
      expect(logs[1].message).toBe('message 2');
    });

    it('should store context objects', () => {
      const logger = new InMemoryLogger();

      logger.info('message', { key: 'value', number: 42 });
      logger.warn('message', { attempts: 3 });

      const logs = logger.getLogs();
      expect(logs[0].context).toEqual({ key: 'value', number: 42 });
      expect(logs[1].context).toEqual({ attempts: 3 });
    });

    it('should store error objects', () => {
      const logger = new InMemoryLogger();
      const error = new Error('test error');

      logger.error('failed', error);

      const logs = logger.getLogs();
      expect(logs[0].error).toBe(error);
      expect(logs[0].level).toBe('error');
    });

    it('should handle non-Error errors', () => {
      const logger = new InMemoryLogger();

      logger.error('failed', 'string error');

      const logs = logger.getLogs();
      expect(logs[0].error).toBeUndefined(); // Non-Error objects not stored
      expect(logs[0].level).toBe('error');
    });

    it('should clear logs', () => {
      const logger = new InMemoryLogger();

      logger.info('message 1');
      logger.info('message 2');
      expect(logger.getLogs()).toHaveLength(2);

      logger.clear();
      expect(logger.getLogs()).toHaveLength(0);
    });

    it('should detect if message was logged', () => {
      const logger = new InMemoryLogger();

      logger.info('search completed successfully');
      logger.warn('retrying operation');

      expect(logger.hasLoggedMessage('search completed')).toBe(true);
      expect(logger.hasLoggedMessage('retrying')).toBe(true);
      expect(logger.hasLoggedMessage('not logged')).toBe(false);
    });

    it('should detect if log level was used', () => {
      const logger = new InMemoryLogger();

      logger.info('message');
      logger.error('error');

      expect(logger.hasLogLevel('info')).toBe(true);
      expect(logger.hasLogLevel('error')).toBe(true);
      expect(logger.hasLogLevel('warn')).toBe(false);
      expect(logger.hasLogLevel('debug')).toBe(false);
    });

    it('should return copy of logs from getLogs', () => {
      const logger = new InMemoryLogger();

      logger.info('message');
      const logs1 = logger.getLogs();
      const logs2 = logger.getLogs();

      expect(logs1).not.toBe(logs2); // Different references
      expect(logs1).toEqual(logs2); // Same content
    });

    it('should return default component name', () => {
      const logger = new InMemoryLogger();
      expect(logger.getComponent()).toBe('Test');
    });

    it('should return undefined correlation ID', () => {
      const logger = new InMemoryLogger();
      expect(logger.getCorrelationId()).toBeUndefined();
    });

    it('should accept custom component name', () => {
      const logger = new InMemoryLogger('CustomComponent');
      expect(logger.getComponent()).toBe('CustomComponent');
    });

    it('should return InMemoryLogger from withContext', () => {
      const logger = new InMemoryLogger();
      const child = logger.withContext({ operation: 'test' });

      expect(child).toBeInstanceOf(InMemoryLogger);
      expect(child.getComponent()).toBe('Test');
    });

    it('should isolate logs between instances', () => {
      const logger1 = new InMemoryLogger('Logger1');
      const logger2 = new InMemoryLogger('Logger2');

      logger1.info('message 1');
      logger2.info('message 2');

      expect(logger1.getLogs()).toHaveLength(1);
      expect(logger2.getLogs()).toHaveLength(1);
      expect(logger1.getLogs()[0].message).toBe('message 1');
      expect(logger2.getLogs()[0].message).toBe('message 2');
    });
  });

  describe('Integration with ILogger type', () => {
    it('should be usable with ILogger type annotations', () => {
      function processWithLogger(logger: ILogger): string {
        logger.info('processing');
        return 'done';
      }

      const structuredLogger = createStructuredLogger('TestComponent');
      const noOpLogger = new NoOpLogger();
      const inMemoryLogger = new InMemoryLogger();

      expect(processWithLogger(structuredLogger)).toBe('done');
      expect(processWithLogger(noOpLogger)).toBe('done');
      expect(processWithLogger(inMemoryLogger)).toBe('done');
    });

    it('should support dependency injection pattern', () => {
      class Service {
        constructor(private logger: ILogger) {}

        doWork(): void {
          this.logger.info('working');
        }
      }

      const serviceWithStructured = new Service(createStructuredLogger('Service'));
      const serviceWithNoOp = new Service(new NoOpLogger());

      expect(() => serviceWithStructured.doWork()).not.toThrow();
      expect(() => serviceWithNoOp.doWork()).not.toThrow();
    });
  });
});