import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { Embedder } from '../../../src/knowledge/embedder.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import { logger } from '../../../src/logger.ts';

// Mock Embedder
const mockEmbedder = {
  getDimension: vi.fn().mockReturnValue(384),
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  embedMany: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(384))),
  isInitialized: vi.fn().mockReturnValue(true),
} as unknown as Embedder;

describe('KnowledgeStore Scoping', () => {
  let testDbDir: string;
  const workspaceA = '/workspaces/project-a';
  const workspaceB = '/workspaces/project-b';

  beforeEach(() => {
    testDbDir = path.join(os.tmpdir(), `pi-research-scoping-test-${Date.now()}`);
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
  });

  afterEach(async () => {
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  async function createStore(options: { 
    workspace?: string, 
    localEnabled?: boolean, 
    globalEnabled?: boolean 
  }) {
    const store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      ...options
    });
    await store.initialize();
    return store;
  }

  it('should warn when scope flags are undefined', () => {
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'Xenova/all-MiniLM-L6-v2',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Warning: localEnabled and globalEnabled not explicitly set'));
    logSpy.mockRestore();
  });

  it('should isolate data between different workspaces', async () => {
    // 1. Add data to Workspace A
    const storeA = await createStore({ workspace: workspaceA, localEnabled: true, globalEnabled: false });
    await storeA.addDocuments([{
      url: 'https://a.com',
      text: 'Content A',
      metadata: { ingestionType: 'synthesis-description' },
      timestamp: Date.now()
    }]);
    
    expect(await storeA.count()).toBe(1);
    await storeA.close();

    // 2. Open Workspace B - should see 0 documents
    const storeB = await createStore({ workspace: workspaceB, localEnabled: true, globalEnabled: false });
    expect(await storeB.count()).toBe(0);

    // 3. Add data to Workspace B
    await storeB.addDocuments([{
      url: 'https://b.com',
      text: 'Content B',
      metadata: { ingestionType: 'synthesis-description' },
      timestamp: Date.now()
    }]);
    expect(await storeB.count()).toBe(1);
    
    // 4. Re-open Workspace A - should still see only 1 document (from A)
    const storeA2 = await createStore({ workspace: workspaceA, localEnabled: true, globalEnabled: false });
    expect(await storeA2.count()).toBe(1);
    const searchA = await storeA2.search('Content');
    expect(searchA).toHaveLength(1);
    expect(searchA[0]!.url).toBe('https://a.com');

    await storeB.close();
    await storeA2.close();
  });

  it('should see global data when globalEnabled is true', async () => {
    // 1. Add global data (using a store with globalEnabled=true)
    // Note: in current implementation, documents are tagged as is_global if options.globalEnabled is true
    const globalStore = await createStore({ globalEnabled: true, localEnabled: false });
    await globalStore.addDocuments([{
      url: 'https://global.com',
      text: 'Global Content',
      metadata: { ingestionType: 'synthesis-description' },
      timestamp: Date.now()
    }]);
    await globalStore.close();

    // 2. Workspace A (local only) should NOT see global data
    const storeA = await createStore({ workspace: workspaceA, localEnabled: true, globalEnabled: false });
    expect(await storeA.count()).toBe(0);
    await storeA.close();

    // 3. Workspace B (local + global) should see global data
    const storeB = await createStore({ workspace: workspaceB, localEnabled: true, globalEnabled: true });
    expect(await storeB.count()).toBe(1);
    const searchB = await storeB.search('Global');
    expect(searchB).toHaveLength(1);
    expect(searchB[0]!.url).toBe('https://global.com');
    await storeB.close();
  });

  it('should correctly count scoped documents', async () => {
    // 1. Add local data to Workspace A
    const storeA = await createStore({ workspace: workspaceA, localEnabled: true, globalEnabled: false });
    await storeA.addDocuments([{
      url: 'https://a.com',
      text: 'Local A',
      metadata: { ingestionType: 'synthesis-description' },
      timestamp: Date.now()
    }]);

    // 2. Add global data
    const storeGlobal = await createStore({ globalEnabled: true, localEnabled: false });
    await storeGlobal.addDocuments([{
      url: 'https://global.com',
      text: 'Global',
      metadata: { ingestionType: 'synthesis-description' },
      timestamp: Date.now()
    }]);

    // 3. Check counts from Workspace A's perspective (local + global enabled)
    const storeAView = await createStore({ workspace: workspaceA, localEnabled: true, globalEnabled: true });
    const counts = await storeAView.countScoped();
    expect(counts.local).toBe(1);
    expect(counts.global).toBe(1);
    expect(await storeAView.count()).toBe(2);

    await storeA.close();
    await storeGlobal.close();
    await storeAView.close();
  });

  it('clear() should only remove documents within scope', async () => {
    // 1. Add data to Workspace A and Workspace B
    const storeA = await createStore({ workspace: workspaceA, localEnabled: true, globalEnabled: false });
    await storeA.addDocuments([{ url: 'https://a.com', text: 'A', metadata: {}, timestamp: Date.now() }]);
    
    const storeB = await createStore({ workspace: workspaceB, localEnabled: true, globalEnabled: false });
    await storeB.addDocuments([{ url: 'https://b.com', text: 'B', metadata: {}, timestamp: Date.now() }]);

    // 2. Clear from Workspace A
    await storeA.clear();
    expect(await storeA.count()).toBe(0);

    // 3. Verify Workspace B data still exists
    expect(await storeB.count()).toBe(1);

    await storeA.close();
    await storeB.close();
  });

  it('deleteByUrl() should respect scope', async () => {
     // 1. Add same URL to Workspace A and Workspace B
    const url = 'https://shared.com';
    const storeA = await createStore({ workspace: workspaceA, localEnabled: true, globalEnabled: false });
    await storeA.addDocuments([{ url, text: 'A', metadata: {}, timestamp: Date.now() }]);
    
    const storeB = await createStore({ workspace: workspaceB, localEnabled: true, globalEnabled: false });
    await storeB.addDocuments([{ url, text: 'B', metadata: {}, timestamp: Date.now() }]);

    // 2. Delete from Workspace A
    await storeA.deleteByUrl(url);
    expect(await storeA.count()).toBe(0);

    // 3. Verify Workspace B data still exists for that URL
    expect(await storeB.count()).toBe(1);

    await storeA.close();
    await storeB.close();
  });
});
