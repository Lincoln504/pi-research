import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { FileLockService } from '../../../src/infrastructure/file-lock-service.ts';

describe('FileLockService', () => {
  let tmpDir: string;
  let lockFilePath: string;
  let service: FileLockService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `file-lock-test-${crypto.randomBytes(6).toString('hex')}`);
    await fs.mkdir(tmpDir, { recursive: true });
    lockFilePath = path.join(tmpDir, 'test.lock');
  });

  afterEach(async () => {
    // Dispose service if still present
    if (service) {
      try {
        await service.dispose();
      } catch {
        // Ignore dispose errors in cleanup
      }
    }
    // Remove temp directory
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ---------------------------------------------------------------------------
  // Basic lock acquisition and release
  // ---------------------------------------------------------------------------

  describe('basic lock acquisition and release', () => {
    it('acquireLock() creates a lock file with the service UUID as content', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      await service.acquireLock();

      const content = await fs.readFile(lockFilePath, 'utf-8');
      expect(content.trim()).toBe(service.getLockUuid());

      await service.releaseLock();
    });

    it('after releaseLock() the lock file no longer exists', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      await service.acquireLock();
      await service.releaseLock();

      await expect(fs.access(lockFilePath)).rejects.toThrow();
    });

    it('reading the lock file before release returns the UUID written during acquisition', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      await service.acquireLock();

      const content = await fs.readFile(lockFilePath, 'utf-8');
      expect(content.trim()).toBe(service.getLockUuid());

      await service.releaseLock();
    });
  });



  // ---------------------------------------------------------------------------
  // Stale lock recovery
  // ---------------------------------------------------------------------------

  describe('stale lock recovery', () => {
    it('acquireLock() succeeds and replaces a stale lock file (mtime 40 s ago)', async () => {
      // Write a lock file with a foreign UUID
      const foreignUuid = crypto.randomUUID();
      await fs.writeFile(lockFilePath, foreignUuid, 'utf-8');

      // Back-date the mtime by 40 seconds
      const staleTime = new Date(Date.now() - 40_000);
      await fs.utimes(lockFilePath, staleTime, staleTime);

      service = new FileLockService({
        lockFilePath,
        lockTimeout: 5000,
        lockRetryDelay: 1,
      });
      await service.initialize();

      // Should succeed without timing out
      await expect(service.acquireLock()).resolves.toBeUndefined();

      // New content must be our service's UUID, not the foreign one
      const content = await fs.readFile(lockFilePath, 'utf-8');
      expect(content.trim()).toBe(service.getLockUuid());
      expect(content.trim()).not.toBe(foreignUuid);

      await service.releaseLock();
    });
  });

  // ---------------------------------------------------------------------------
  // Non-owner release is a no-op
  // ---------------------------------------------------------------------------

  describe('non-owner release', () => {
    it('releaseLock() does not delete a lock file that was overwritten by a different UUID', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      // Acquire the lock so the service holds a handle
      await service.acquireLock();

      // Overwrite the lock file content with a foreign UUID (simulates lock theft)
      const otherUuid = crypto.randomUUID();
      await fs.writeFile(lockFilePath, otherUuid, 'utf-8');

      // releaseLock() should detect the UUID mismatch and NOT delete the file
      await service.releaseLock();

      // File must still exist with the other UUID
      const content = await fs.readFile(lockFilePath, 'utf-8');
      expect(content.trim()).toBe(otherUuid);

      // Clean up manually
      await fs.unlink(lockFilePath);
    });
  });

  // ---------------------------------------------------------------------------
  // withLock wrapper
  // ---------------------------------------------------------------------------

  describe('withLock wrapper', () => {
    it('executes the callback and the lock file exists during execution, is gone after', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      let lockExistedDuringCallback = false;

      await service.withLock(async () => {
        try {
          await fs.access(lockFilePath);
          lockExistedDuringCallback = true;
        } catch {
          lockExistedDuringCallback = false;
        }
      });

      expect(lockExistedDuringCallback).toBe(true);

      // Lock file should be gone after withLock resolves
      await expect(fs.access(lockFilePath)).rejects.toThrow();
    });

    it('releases the lock even when the callback throws', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      const callbackError = new Error('callback failed');

      await expect(
        service.withLock(async () => {
          throw callbackError;
        }),
      ).rejects.toThrow('callback failed');

      // Lock file must be deleted despite the throw
      await expect(fs.access(lockFilePath)).rejects.toThrow();
    });

    it('supports re-entrancy within the same async flow', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      await service.withLock(async () => {
        expect(service.isLocked()).toBe(true);
        // Nested lock
        await service.withLock(async () => {
          expect(service.isLocked()).toBe(true);
          const content = await fs.readFile(lockFilePath, 'utf-8');
          expect(content.trim()).toBe(service.getLockUuid());
        });
        expect(service.isLocked()).toBe(true);
      });
      expect(service.isLocked()).toBe(false);
    });

    it('correctly serializes concurrent non-nested calls on the same instance', async () => {
      service = new FileLockService({ lockFilePath });
      await service.initialize();

      const events: string[] = [];
      const task1 = service.withLock(async () => {
        events.push('1:start');
        await new Promise(r => setTimeout(r, 50));
        events.push('1:end');
      });

      const task2 = service.withLock(async () => {
        events.push('2:start');
        await new Promise(r => setTimeout(r, 50));
        events.push('2:end');
      });

      await Promise.all([task1, task2]);

      expect(events).toEqual(['1:start', '1:end', '2:start', '2:end']);
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout error message
  // ---------------------------------------------------------------------------

  describe('timeout error message', () => {
    it('rejection message matches "Failed to acquire lock" when a non-stale lock exists', async () => {
      // Write a fresh (non-stale) lock file
      await fs.writeFile(lockFilePath, crypto.randomUUID(), 'utf-8');

      service = new FileLockService({
        lockFilePath,
        lockTimeout: 50,
        lockRetryDelay: 1,
      });
      await service.initialize();

      await expect(service.acquireLock()).rejects.toThrow('Failed to acquire lock');
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent lock safety
  // ---------------------------------------------------------------------------

  describe('concurrent lock safety', () => {
    it('two instances on the same path acquire the lock sequentially without corruption', async () => {
      const lockFilePath2 = lockFilePath; // shared path

      const serviceA = new FileLockService({
        lockFilePath: lockFilePath2,
        lockTimeout: 5000,
        lockRetryDelay: 5,
      });
      const serviceB = new FileLockService({
        lockFilePath: lockFilePath2,
        lockTimeout: 5000,
        lockRetryDelay: 5,
      });

      // Track which service held the lock and when
      const events: string[] = [];

      try {
        await serviceA.initialize();
        await serviceB.initialize();

        // Run both concurrently; each acquires, records, then releases
        const taskA = serviceA.withLock(async () => {
          events.push('A:start');
          await new Promise<void>((r) => setTimeout(r, 20));
          events.push('A:end');
        });

        const taskB = serviceB.withLock(async () => {
          events.push('B:start');
          await new Promise<void>((r) => setTimeout(r, 20));
          events.push('B:end');
        });

        await Promise.all([taskA, taskB]);

        // Both completed without error
        expect(events).toHaveLength(4);

        // The events must be non-interleaved: either A fully completes before B starts, or vice-versa
        const aStartIdx = events.indexOf('A:start');
        const aEndIdx = events.indexOf('A:end');
        const bStartIdx = events.indexOf('B:start');
        const bEndIdx = events.indexOf('B:end');

        const aBeforeB = aEndIdx < bStartIdx;
        const bBeforeA = bEndIdx < aStartIdx;

        expect(aBeforeB || bBeforeA).toBe(true);
      } finally {
        await serviceA.dispose();
        await serviceB.dispose();
        // Prevent afterEach from double-disposing the default `service`
        service = undefined as unknown as FileLockService;
      }
    });
  });
});
