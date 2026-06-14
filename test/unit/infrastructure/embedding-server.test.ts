import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingServer } from '../../../src/infrastructure/embedding/embedding-server';
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
});
