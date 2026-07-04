import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeStore, isLanceCommitConflict } from '../../../src/knowledge/store.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

describe('KnowledgeStore Error Recovery', () => {
  let testDbDir: string;
  let store: KnowledgeStore;
  let mockEmbedder: any;

  beforeEach(async () => {
    testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-recovery-test-'));
    
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
      knowledgeMode: 'project',
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
    
    const storeWithReconnect = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: {
        ...mockEmbedder,
        embedMany: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error('ECONNREFUSED');
          return Promise.resolve([new Float32Array(384)]); })
      } as any,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      reconnectFactory,
    });
    await storeWithReconnect.initialize();
    await storeWithReconnect.addDocuments([{ url: 'https://retry.com', text: 'test', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
    expect(reconnectFactory).toHaveBeenCalledOnce();
    await storeWithReconnect.close();
  });

  it('withEmbedderReconnect also reconnects on a poison-sentinel rejection (no ECONNREFUSED in the message)', async () => {
    // When the leader poisons its embed queue on a permanently-hung inference, an
    // in-flight/queued embed is fast-failed with an "embedder poisoned" error that carries
    // NO ECONNREFUSED. That must still drive a reconnect to the freshly-elected leader,
    // not fail the write hard.
    let callCount = 0;
    const reconnectFactory = vi.fn().mockResolvedValue(mockEmbedder);

    const storeWithReconnect = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: {
        ...mockEmbedder,
        embedMany: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            throw new Error('SerialQueue: embed permanently hung (exceeded hard deadline 600000ms) — embedder poisoned; leader stepping down');
          }
          return Promise.resolve([new Float32Array(384)]); })
      } as any,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      reconnectFactory,
    });
    await storeWithReconnect.initialize();
    await storeWithReconnect.addDocuments([{ url: 'https://poison.com', text: 'test', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
    expect(reconnectFactory).toHaveBeenCalledOnce();
    await storeWithReconnect.close();
  });

  it('deleteByUrl retry loop retries on "Version mismatch" and succeeds', async () => {
    await store.addDocuments([{ url: 'https://delete-retry.com', text: 'to be deleted', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);

    const db = (store as any).db;
    const originalOpenTable = db.openTable.bind(db);
    let deleteCalls = 0;

    vi.spyOn(db, 'openTable').mockImplementation(async (...args: unknown[]) => {
      const table = await originalOpenTable(args[0] as string);
      const originalDelete = table.delete.bind(table);
      table.delete = vi.fn().mockImplementation(async (filter: string) => {
        deleteCalls++;
        if (deleteCalls === 1) throw new Error('Version mismatch: concurrent writer');
        return originalDelete(filter);
      });
      return table;
    });

    await store.deleteByUrl('https://delete-retry.com');
    expect(deleteCalls).toBe(2);
    const remaining = await store.findByUrl('https://delete-retry.com');
    expect(remaining).toHaveLength(0);
  });

  it('deleteByUrl throws after exceeding MAX_RETRIES on persistent contention', async () => {
    await store.addDocuments([{ url: 'https://always-fails.com', text: 'doc', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);

    const db = (store as any).db;
    const originalOpenTable = db.openTable.bind(db);

    vi.spyOn(db, 'openTable').mockImplementation(async (...args: unknown[]) => {
      const table = await originalOpenTable(args[0] as string);
      table.delete = vi.fn().mockRejectedValue(new Error('Version mismatch: always'));
      return table;
    });

    await expect(store.deleteByUrl('https://always-fails.com')).rejects.toThrow('Version mismatch: always');
  });

  it('countScoped isolates local vs global document counts', async () => {
    // Two separate stores: one local, one global
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scope-local-'));
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-scope-global-'));

    const localStore = new KnowledgeStore({ knowledgeMode: 'project', dbDir: localDir, embedder: mockEmbedder, modelName: 'Xenova/all-MiniLM-L6-v2' });
    const globalStore = new KnowledgeStore({ knowledgeMode: 'global', dbDir: globalDir, embedder: mockEmbedder, modelName: 'Xenova/all-MiniLM-L6-v2' });

    try {
      await localStore.initialize();
      await globalStore.initialize();

      await localStore.addDocuments([{ url: 'https://local.example.com/1', text: 'local doc', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
      await globalStore.addDocuments([{ url: 'https://global.example.com/1', text: 'global doc', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
      await globalStore.addDocuments([{ url: 'https://global.example.com/2', text: 'global doc 2', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);

      const localCounts = await localStore.countScoped();
      const globalCounts = await globalStore.countScoped();

      // Local store: 1 local doc, no global docs (different DB dir)
      expect(localCounts.local).toBe(1);
      expect(localCounts.global).toBe(0);

      // Global store: 0 local docs (global mode stores as global), 2 global docs
      expect(globalCounts.global).toBe(2);
    } finally {
      await localStore.close();
      await globalStore.close();
      fs.rmSync(localDir, { recursive: true, force: true });
      fs.rmSync(globalDir, { recursive: true, force: true });
    }
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

  it('write contention retry loop retries on the real LanceDB 0.29 "Commit conflict" message', async () => {
    // The pre-fix matcher only knew 'Version mismatch'/'Lock error'/'Commit error' —
    // none of which LanceDB 0.29 emits — so every real cross-process conflict fell
    // through to a hard throw and the batch was dropped. This proves the real
    // message now reaches the retry path end-to-end.
    await store.addDocuments([{ url: 'https://init2.com', text: 'init', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);

    const db = (store as any).db;
    const originalOpenTable = db.openTable.bind(db);
    let addCalls = 0;

    vi.spyOn(db, 'openTable').mockImplementation(async (name) => {
      const table = await originalOpenTable(name);
      const originalAdd = table.add.bind(table);
      table.add = vi.fn().mockImplementation(async (data) => {
        addCalls++;
        if (addCalls === 1) throw new Error('Commit conflict for version 42: a concurrent transaction committed first');
        return originalAdd(data);
      });
      return table;
    });

    await store.addDocuments([{ url: 'https://real-conflict.com', text: 'test', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);

    expect(addCalls).toBe(2);
    expect(await store.count()).toBe(2);
  });
});

describe('isLanceCommitConflict', () => {
  it('matches the three REAL LanceDB 0.29 concurrent-write conflict messages', () => {
    // Strings confirmed present in the @lancedb 0.29.0 native binary.
    expect(isLanceCommitConflict(new Error('Commit conflict for version 7: another writer won'))).toBe(true);
    expect(isLanceCommitConflict(new Error('Retryable commit conflict for version 12'))).toBe(true);
    expect(isLanceCommitConflict(new Error('Too many concurrent writes, please retry later: backpressure'))).toBe(true);
  });

  it('keeps matching the legacy strings as a safety net', () => {
    expect(isLanceCommitConflict(new Error('Version mismatch: concurrent writer'))).toBe(true);
    expect(isLanceCommitConflict(new Error('Lock error acquiring table lock'))).toBe(true);
    expect(isLanceCommitConflict(new Error('Commit error: something'))).toBe(true);
  });

  it('accepts non-Error throwables', () => {
    expect(isLanceCommitConflict('Retryable commit conflict for version 3')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isLanceCommitConflict(new Error('ECONNREFUSED'))).toBe(false);
    expect(isLanceCommitConflict(new Error('Table not found: knowledge'))).toBe(false);
    expect(isLanceCommitConflict(new Error('embedder poisoned; leader stepping down'))).toBe(false);
    expect(isLanceCommitConflict(null)).toBe(false);
  });
});
