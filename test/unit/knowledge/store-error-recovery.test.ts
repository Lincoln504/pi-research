import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { Embedder } from '../../../src/knowledge/embedder.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

describe('KnowledgeStore Error Recovery', () => {
  let testDbDir: string;
  let store: KnowledgeStore;
  let mockEmbedder: any;

  beforeEach(async () => {
    testDbDir = path.join(os.tmpdir(), `pi-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
    
    mockEmbedder = {
      getDimension: vi.fn().mockReturnValue(384),
      embed: vi.fn().mockResolvedValue(new Float32Array(384)),
      embedMany: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(384))),
      isInitialized: vi.fn().mockReturnValue(true),
    };

    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'Xenova/all-MiniLM-L6-v2',
    });
    await store.initialize();
  });

  afterEach(async () => {
    if (store) await store.close();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('circuit breaker trips after 3 search failures', async () => {
    await store.addDocuments([{ url: 'https://test.com', text: 'test', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
    mockEmbedder.embed.mockRejectedValue(new Error('Search failed'));
    await expect(store.search('query')).rejects.toThrow('Search failed');
    await expect(store.search('query')).rejects.toThrow('Search failed');
    await expect(store.search('query')).rejects.toThrow('Search failed');
    await expect(store.search('query')).rejects.toThrow(/CircuitBreaker.*is OPEN/i);
    expect(mockEmbedder.embed).toHaveBeenCalledTimes(3);
  });

  it('withEmbedderReconnect retries once on ECONNREFUSED during addDocuments', async () => {
    let callCount = 0;
    const reconnectFactory = vi.fn().mockResolvedValue(mockEmbedder);
    
    const storeWithReconnect = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: {
        ...mockEmbedder,
        embedMany: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error('ECONNREFUSED');
          return Promise.resolve([new Float32Array(384)]);
        })
      } as any,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      reconnectFactory
    });
    await storeWithReconnect.initialize();
    await storeWithReconnect.addDocuments([{ url: 'https://retry.com', text: 'test', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
    expect(reconnectFactory).toHaveBeenCalledOnce();
    await storeWithReconnect.close();
  });

  it('write contention retry loop retries on "Version mismatch"', async () => {
    // 1. First doc to create table
    await store.addDocuments([{ url: 'https://init.com', text: 'init', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);

    // 2. Mock db.openTable to return a table with a mock add method
    const db = (store as any).db;
    const originalOpenTable = db.openTable.bind(db);
    let addCalls = 0;

    vi.spyOn(db, 'openTable').mockImplementation(async (name) => {
      const table = await originalOpenTable(name);
      const originalAdd = table.add.bind(table);
      table.add = vi.fn().mockImplementation(async (data) => {
        addCalls++;
        if (addCalls === 1) throw new Error('Version mismatch: something happened');
        return originalAdd(data);
      });
      return table;
    });

    // 3. Add another doc, which should trigger the retry
    await store.addDocuments([{ url: 'https://test.com', text: 'test', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
    
    expect(addCalls).toBe(2);
    expect(await store.count()).toBe(2);
  });
});
