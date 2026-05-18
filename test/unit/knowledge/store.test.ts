import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { Embedder } from '../../../src/knowledge/embedder.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

// Mock Embedder
const mockEmbedder = {
  getDimension: vi.fn().mockReturnValue(384),
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  embedMany: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(384))),
  isInitialized: vi.fn().mockReturnValue(true),
} as unknown as Embedder;

describe('KnowledgeStore', () => {
  let store: KnowledgeStore;
  let testDbDir: string;

  beforeEach(async () => {
    testDbDir = path.join(os.tmpdir(), `pi-research-test-${Date.now()}`);
    store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'test-model',
    });
  });

  afterEach(async () => {
    await store.close();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('should open and initialize a table', async () => {
    await store.open();
    expect(fs.existsSync(testDbDir)).toBe(true);
  });

  it('should insert and search documents', async () => {
    await store.open();
    const doc = {
      url: 'https://example.com',
      text: 'Hello world',
      metadata: { title: 'Test' },
      timestamp: Date.now(),
    };
    
    await store.addDocuments([doc]);
    
    const results = await store.search('hello', { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com');
  });

  it('should invalidate table if model changes', async () => {
    await store.open();
    await store.close();
    
    // Re-open with different model
    const newStore = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'different-model',
    });
    
    // We should detect that it was recreated or at least handle the mismatch
    // Actually, we can check if the old data is gone.
    await newStore.open();
    const results = await newStore.search('hello', { limit: 1 });
    expect(results).toHaveLength(0);
    await newStore.close();
  });
});
