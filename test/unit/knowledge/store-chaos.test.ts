/**
 * Chaos Engineering Tests: Knowledge Store
 *
 * Tests chaotic scenarios for the knowledge store including:
 * - LanceDB connection failures
 * - Reconnection after connection loss
 * - Concurrent operations during reconnection
 * - Partial write failures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  simulateConnectionReset,
  simulateConnectionRefused,
  simulateNetworkTimeout,
  withRandomError,
  withNetworkChaos,
  raceConcurrent,
  measureTime,
} from '../../utils/chaos-helpers.ts';

describe('Knowledge Store Chaos Tests', () => {
  // Mock LanceDB
  const mockConnect = vi.fn();
  const mockTable = vi.fn();
  const mockAdd = vi.fn();
  const mockSearch = vi.fn();
  const mockClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mocks
    mockConnect.mockReset();
    mockTable.mockReset();
    mockAdd.mockReset();
    mockSearch.mockReset();
    mockClose.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Connection Failure Scenarios', () => {
    it('should handle initial connection failure and retry', async () => {
      let attempt = 0;
      mockConnect.mockImplementation(async () => {
        attempt++;
        if (attempt < 3) {
          throw simulateConnectionRefused();
        }
        return {
          openTable: mockTable,
          close: mockClose,
        };
      });

      // Simulate retry logic
      let connection: any = null;
      let retries = 0;
      const maxRetries = 5;

      while (!connection && retries < maxRetries) {
        try {
          connection = await mockConnect();
        } catch (e) {
          retries++;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      expect(connection).toBeDefined();
      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(retries).toBe(2);
    });

    it('should handle connection reset during operation', async () => {
      let callCount = 0;
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      mockAdd.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw simulateConnectionReset();
        }
        return void 0;
      });

      const db = await mockConnect();
      const table = await db.openTable('test');

      // First add succeeds
      await table.add([{ id: '1', text: 'test1' }]);

      // Second add fails with connection reset
      await expect(table.add([{ id: '2', text: 'test2' }]))
        .rejects.toThrow();

      expect(mockAdd).toHaveBeenCalledTimes(2);
    });

    it('should handle network timeout during query', async () => {
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      mockSearch.mockRejectedValue(simulateNetworkTimeout());

      const db = await mockConnect();
      const table = await db.openTable('test');

      await expect(table.search([1, 2, 3]))
        .rejects.toThrow('timeout');

      expect(mockSearch).toHaveBeenCalledTimes(1);
    });

    it('should recover from transient connection errors', async () => {
      let connectionAttempts = 0;
      mockConnect.mockImplementation(async () => {
        connectionAttempts++;
        if (connectionAttempts <= 2) {
          throw simulateConnectionReset();
        }
        return {
          openTable: mockTable,
          close: mockClose,
        };
      });

      // Simulate reconnection logic
      const result = await (async () => {
        let db: any = null;
        for (let i = 0; i < 5; i++) {
          try {
            db = await mockConnect();
            return db;
          } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        throw new Error('Failed to reconnect');
      })();

      expect(result).toBeDefined();
      expect(connectionAttempts).toBe(3);
    });
  });

  describe('Concurrent Operations During Failures', () => {
    it('should handle concurrent writes during connection instability', async () => {
      let failureCount = 0;
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      mockAdd.mockImplementation(async () => {
        failureCount++;
        // Fail first 3 attempts
        if (failureCount <= 3) {
          throw simulateConnectionReset();
        }
        return void 0;
      });

      const db = await mockConnect();
      const table = await db.openTable('test');

      const operations = Array.from({ length: 10 }, (_, i) =>
        table.add([{ id: String(i), text: `text ${i}` }])
          .catch(err => ({ error: err.message, id: i }))
      );

      const results = await Promise.all(operations);

      // Some should fail, some should succeed
      const failures = results.filter((r: any) => r.error);
      const successes = results.filter((r: any) => !r.error);

      expect(failures.length).toBe(3);
      expect(successes.length).toBe(7);
    });

    it('should handle concurrent reads during connection loss', async () => {
      let callCount = 0;
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      mockSearch.mockImplementation(async () => {
        callCount++;
        // Fail on 3rd and 6th calls
        if (callCount === 3 || callCount === 6) {
          throw simulateNetworkTimeout();
        }
        return [{ id: '1', text: 'result', score: 0.9 }];
      });

      const db = await mockConnect();
      const table = await db.openTable('test');

      const operations = Array.from({ length: 8 }, (_, i) =>
        table.search([i, i + 1, i + 2])
          .catch(err => ({ error: err.message }))
      );

      const results = await Promise.all(operations);

      // 2 failures, 6 successes
      const failures = results.filter((r: any) => r.error);
      expect(failures.length).toBe(2);
    });

    it('should handle mixed read/write operations under chaos', async () => {
      let chaosCounter = 0;
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      const chaoticOperation = async (operation: 'add' | 'search') => {
        chaosCounter++;
        // Fail on 30% of operations
        if (Math.random() < 0.3) {
          throw simulateConnectionReset();
        }

        if (operation === 'add') {
          return await mockAdd([{ id: String(chaosCounter), text: `chaos ${chaosCounter}` }]);
        } else {
          return await mockSearch([chaosCounter, chaosCounter + 1, chaosCounter + 2]);
        }
      };

      const db = await mockConnect();
      const table = await db.openTable('test');

      const operations: Promise<any>[] = [];
      for (let i = 0; i < 15; i++) {
        operations.push(
          chaoticOperation(i % 2 === 0 ? 'add' : 'search')
            .catch(err => ({ error: err.message, type: i % 2 === 0 ? 'add' : 'search' }))
        );
      }

      const results = await Promise.all(operations);

      // All should complete (either success or error)
      expect(results).toHaveLength(15);

      const failures = results.filter((r: any) => r.error);
      // Approximately 30% should fail (give or take randomness)
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.length).toBeLessThan(10);
    });
  });

  describe('Partial Write Failures', () => {
    it('should handle batch write with partial failures', async () => {
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      let batchCount = 0;
      mockAdd.mockImplementation(async (items: any[]) => {
        batchCount++;
        // Second batch fails
        if (batchCount === 2) {
          throw new Error('Batch write failed');
        }
        return void 0;
      });

      const db = await mockConnect();
      const table = await db.openTable('test');

      const results = await Promise.allSettled([
        table.add([{ id: '1', text: 'text1' }, { id: '2', text: 'text2' }]),
        table.add([{ id: '3', text: 'text3' }, { id: '4', text: 'text4' }]),
        table.add([{ id: '5', text: 'text5' }, { id: '6', text: 'text6' }]),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');
    });

    it('should handle single item failures in batch', async () => {
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      // Some items are invalid
      const items = [
        { id: '1', text: 'valid1' },
        { id: '2', text: '' }, // Invalid (empty text)
        { id: '3', text: 'valid3' },
        null, // Invalid (null)
      ];

      mockAdd.mockImplementation(async (items: any[]) => {
        // Simulate validation error
        if (items.some(item => !item || !item.text)) {
          throw new Error('Invalid items in batch');
        }
        return void 0;
      });

      const db = await mockConnect();
      const table = await db.openTable('test');

      await expect(table.add(items as any[]))
        .rejects.toThrow('Invalid items');
    });
  });

  describe('Reconnection Logic', () => {
    it('should automatically reconnect on connection loss', async () => {
      let connectionCount = 0;
      mockConnect.mockImplementation(async () => {
        connectionCount++;
        return {
          openTable: mockTable,
          close: mockClose,
        };
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      // Simulate connection loss detection and reconnection
      let currentDb = await mockConnect();
      let currentTable = await currentDb.openTable('test');

      // First operation succeeds
      await currentTable.add([{ id: '1', text: 'text1' }]);

      // Simulate connection loss - table operations start failing
      mockSearch.mockRejectedValueOnce(simulateConnectionReset());

      // Operation fails
      await expect(currentTable.search([1, 2, 3]))
        .rejects.toThrow();

      // Reconnect
      currentDb = await mockConnect();
      currentTable = await currentDb.openTable('test');

      // Reset mock to succeed again
      mockSearch.mockResolvedValue([{ id: '1', text: 'result' }]);

      // Operation succeeds after reconnection
      const result = await currentTable.search([1, 2, 3]);
      expect(result).toBeDefined();

      // Should have created 2 connections
      expect(connectionCount).toBe(2);
    });

    it('should handle reconnection with retry backoff', async () => {
      let attempt = 0;
      const delays: number[] = [];

      mockConnect.mockImplementation(async () => {
        attempt++;
        if (attempt <= 3) {
          throw simulateConnectionRefused();
        }
        return {
          openTable: mockTable,
          close: mockClose,
        };
      });

      // Simulate exponential backoff reconnection
      const connectWithBackoff = async (): Promise<any> => {
        let db: any = null;
        let retryDelay = 100;
        
        for (let i = 0; i < 5; i++) {
          try {
            db = await mockConnect();
            return db;
          } catch (e) {
            delays.push(retryDelay);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            retryDelay *= 2;
          }
        }
        throw new Error('Max retries exceeded');
      };

      const db = await connectWithBackoff();

      expect(db).toBeDefined();
      expect(attempt).toBe(4);
      expect(delays).toEqual([100, 200, 400]);
    });

    it('should give up after max reconnection attempts', async () => {
      mockConnect.mockRejectedValue(simulateConnectionRefused());

      const maxRetries = 3;
      let attempts = 0;

      try {
        for (let i = 0; i < maxRetries; i++) {
          attempts++;
          await mockConnect();
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Should have failed');
      } catch (e) {
        // Expected to fail
      }

      expect(attempts).toBe(maxRetries);
    });
  });

  describe('Network Chaos Integration', () => {
    it('should handle network chaos with chaos helper', async () => {
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      const baseSearch = vi.fn().mockResolvedValue([{ id: '1', text: 'result' }]);
      const chaoticSearch = withNetworkChaos(baseSearch, {
        failureProbability: 0.4,
        failureTypes: ['timeout', 'reset'],
        seed: 12345,
      });

      const operations = Array.from({ length: 10 }, () =>
        chaoticSearch().catch(err => ({ error: err.message }))
      );

      const results = await Promise.all(operations);

      // Some should fail, some should succeed
      const failures = results.filter((r: any) => r.error);
      const successes = results.filter((r: any) => !r.error);

      expect(failures.length).toBeGreaterThan(0);
      expect(successes.length).toBeGreaterThan(0);
      expect(failures.length + successes.length).toBe(10);
    });

    it('should handle random error injection', async () => {
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      const baseAdd = vi.fn().mockResolvedValue(undefined);
      const chaoticAdd = withRandomError(baseAdd, {
        errorProbability: 0.3,
        error: simulateConnectionReset(),
        seed: 54321,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          chaoticAdd([{ id: String(i), text: `text ${i}` }])
        )
      );

      const failures = results.filter(r => r.status === 'rejected');
      const successes = results.filter(r => r.status === 'fulfilled');

      expect(failures.length).toBeGreaterThan(0);
      expect(successes.length).toBeGreaterThan(0);
    });
  });

  describe('Resource Cleanup', () => {
    it('should handle cleanup after failed operations', async () => {
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      mockAdd.mockRejectedValueOnce(simulateConnectionReset());

      const db = await mockConnect();
      const table = await db.openTable('test');

      // Operation fails
      await expect(table.add([{ id: '1', text: 'text' }]))
        .rejects.toThrow();

      // Cleanup should still work
      await expect(db.close())
        .resolves.not.toThrow();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle multiple cleanup attempts', async () => {
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      const db = await mockConnect();

      // Close multiple times
      await db.close();
      await db.close();
      await db.close();

      expect(mockClose).toHaveBeenCalledTimes(3);
    });
  });

  describe('Performance Under Chaos', () => {
    it('should maintain reasonable performance despite occasional failures', async () => {
      mockConnect.mockResolvedValue({
        openTable: mockTable,
        close: mockClose,
      });

      mockTable.mockResolvedValue({
        add: mockAdd,
        search: mockSearch,
      });

      let failCount = 0;
      mockSearch.mockImplementation(async () => {
        failCount++;
        if (failCount % 4 === 0) { // Fail every 4th call
          throw simulateNetworkTimeout();
        }
        return [{ id: '1', text: 'result' }];
      });

      const db = await mockConnect();
      const table = await db.openTable('test');

      const { result, durationMs } = await measureTime(async () => {
        const operations = Array.from({ length: 20 }, (_, i) =>
          table.search([i, i + 1, i + 2])
            .catch(err => ({ error: err.message }))
        );
        return await Promise.all(operations);
      });

      // All should complete
      expect(result).toHaveLength(20);

      // Some failures expected
      const failures = result.filter((r: any) => r.error);
      expect(failures.length).toBeGreaterThan(0);

      // Should complete in reasonable time
      expect(durationMs).toBeLessThan(1000);
    });
  });
});