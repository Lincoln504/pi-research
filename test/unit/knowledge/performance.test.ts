import { describe, it, expect, vi } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { Embedder } from '../../../src/knowledge/embedder.ts';
import * as path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Mock Embedder for performance tests (we want to measure Store overhead, not Embedder speed)
const mockEmbedder = {
  getDimension: () => 384,
  embed: async () => new Float32Array(384),
  embedMany: async (texts: string[]) => texts.map(() => new Float32Array(384)),
  isInitialized: () => true,
} as unknown as Embedder;

describe('KnowledgeStore Performance Baselines', () => {
  let testDbDir: string;

  it('should insert and search 100 chunks within reasonable time', async () => {
    testDbDir = path.join(os.tmpdir(), `pi-perf-test-${Date.now()}`);
    const store = new KnowledgeStore({
      dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'perf-model',
    });

    await store.open();

    const chunks = Array.from({ length: 100 }, (_, i) => ({
      url: `https://example.com/${i}`,
      text: `This is chunk number ${i} for performance testing.`.repeat(10),
      metadata: { chunkIndex: 0, ingestionType: 'synthesis-description' },
      timestamp: Date.now(),
    }));

    const startAdd = Date.now();
    await store.addDocuments(chunks);
    const endAdd = Date.now();
    const addDuration = endAdd - startAdd;

    // Baseline: 100 chunks should be added very quickly (mock embedder)
    // On most CI/dev machines, this should be < 500ms
    expect(addDuration).toBeLessThan(1000);

    const startSearch = Date.now();
    const results = await store.search('performance testing', { limit: 10 });
    const endSearch = Date.now();
    const searchDuration = endSearch - startSearch;

    expect(results.length).toBeGreaterThan(0);
    // Search should be < 100ms
    expect(searchDuration).toBeLessThan(200);

    await store.close();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });
});
