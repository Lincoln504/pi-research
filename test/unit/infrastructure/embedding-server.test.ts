import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingServer, _SerialQueue } from '../../../src/infrastructure/embedding/embedding-server';
import type { IStateManager } from '../../../src/core/interfaces/state-manager-interfaces';
import type { Embedder } from '../../../src/knowledge/embedder';

describe('EmbeddingServer', () => {
  let mockStateManager: IStateManager;
  let mockEmbedder: Embedder;
  let server: EmbeddingServer;
  const serverId = 'test-server-id';

  beforeEach(() => {
    mockStateManager = {
      getEmbeddingServer: vi.fn(),
      clearEmbeddingServer: vi.fn(),
      // Add other required IStateManager methods as necessary, 
      // or cast to any for this test if they aren't called.
    } as any;

    mockEmbedder = {} as any;
    server = new EmbeddingServer(mockEmbedder, mockStateManager, serverId);
  });

  describe('getEmbeddingServerWithRetry', () => {
    it('should return server info immediately if available', async () => {
      const serverInfo = { port: 8080, pid: 123, serverId };
      vi.mocked(mockStateManager.getEmbeddingServer).mockResolvedValue(serverInfo);

      const result = await (server as any).getEmbeddingServerWithRetry(2, 10);
      expect(result).toEqual(serverInfo);
      expect(mockStateManager.getEmbeddingServer).toHaveBeenCalledTimes(1);
    });

    it('should retry if the first call returns null', async () => {
      const serverInfo = { port: 8080, pid: 123, serverId };
      vi.mocked(mockStateManager.getEmbeddingServer)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(serverInfo);

      const result = await (server as any).getEmbeddingServerWithRetry(2, 10);
      expect(result).toEqual(serverInfo);
      expect(mockStateManager.getEmbeddingServer).toHaveBeenCalledTimes(2);
    });

    it('should return null if retries are exhausted', async () => {
      vi.mocked(mockStateManager.getEmbeddingServer).mockResolvedValue(null);

      const result = await (server as any).getEmbeddingServerWithRetry(2, 10);
      expect(result).toBeNull();
      expect(mockStateManager.getEmbeddingServer).toHaveBeenCalledTimes(3);
    });
  });

  describe('SerialQueue — GPU serialization invariant', () => {
    it('never runs two enqueued tasks concurrently', async () => {
      const q = new _SerialQueue(200, 1000);
      let active = 0;
      let maxActive = 0;
      const task = (ms: number) => () => new Promise<void>((r) => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => { active--; r(); }, ms);
      });
      await Promise.all([q.enqueue(task(30)), q.enqueue(task(10)), q.enqueue(task(20))]);
      expect(maxActive).toBe(1);
    });

    it('holds the queue slot past a caller timeout until the timed-out work settles', async () => {
      // 30ms timeout, but the first task's real work runs ~120ms. The caller gets a
      // timeout rejection promptly, yet the next task must NOT start (which would be
      // concurrent GPU inference) until the first task's work actually completes.
      const q = new _SerialQueue(200, 30);
      let active = 0;
      let maxActive = 0;
      let secondStarted = false;
      const slow = () => new Promise<void>((r) => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => { active--; r(); }, 120);
      });
      const quick = () => new Promise<void>((r) => {
        secondStarted = true;
        active++;
        maxActive = Math.max(maxActive, active);
        active--;
        r();
      });

      const pA = q.enqueue(slow).catch((e: unknown) => e);
      const pB = q.enqueue(quick);

      const a = await pA;
      expect(a).toBeInstanceOf(Error);
      expect((a as Error).message).toContain('timed out');
      // At the moment the caller's promise rejected (~30ms), the second task must
      // not have started — the first task's inference is still holding the slot.
      expect(secondStarted).toBe(false);

      await pB;
      expect(maxActive).toBe(1);
    });
  });
});
