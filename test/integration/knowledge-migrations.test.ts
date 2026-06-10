/**
 * Knowledge Store Persistence Integration Tests
 *
 * Tests for unified database scoping, data integrity, and schema versioning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { KnowledgeStore } from '../../src/knowledge/store.ts';
import { WriterQueue } from '../../src/knowledge/writer-queue.ts';
import { Chunker } from '../../src/knowledge/chunker.ts';
import { createHash } from 'node:crypto';
import { CURRENT_SCHEMA_VERSION } from '../../src/knowledge/store-schema.ts';

// ---------------------------------------------------------------------------
// Synthetic embedder — returns deterministic vectors without downloading models
// ---------------------------------------------------------------------------
function makeSyntheticEmbedder(dim = 64) {
  function textToVector(text: string): Float32Array {
    const v = new Float32Array(dim);
    const h = createHash('sha256').update(text).digest();
    for (let i = 0; i < dim; i++) {
      v[i] = (h[i % h.length]! / 255) * 2 - 1;
    }
    return v;
  }

  return {
    isInitialized: () => true,
    getDimension: () => dim,
    initialize: async () => {},
    embed: async (text: string) => textToVector(text),
    embedMany: async (texts: string[]) => texts.map(t => textToVector(t)),
  } as unknown as any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function makeStore(dir: string, embedder: any, modelName = 'synthetic-64') {
  const store = new KnowledgeStore({ dbDir: dir, embedder, modelName });
  await store.open();
  return store;
}

describe('Knowledge Store Persistence', () => {
  let tmpDir: string;
  let embedder: any;
  let store: KnowledgeStore;
  let chunker: Chunker;
  let queue: WriterQueue;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `pi-persistence-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    embedder = makeSyntheticEmbedder(64);
    store = await makeStore(tmpDir, embedder);
    chunker = new Chunker({ targetSize: 200, overlap: 30 });
    queue = new WriterQueue({ store, chunker });
  });

  afterEach(async () => {
    try {
      await store.close();
    } finally {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  describe('Unified Scoping', () => {
    it('segregates local and global entries within the same database', async () => {
      // 1. Add project-local data
      const localStore = new KnowledgeStore({ 
        dbDir: tmpDir, 
        embedder, 
        modelName: 'synthetic-64',
        workspace: '/project/a',
        localEnabled: true,
        globalEnabled: false
      });
      await localStore.open();
      await localStore.addDocuments([{
        url: 'https://local-a.com',
        text: 'Project A content',
        metadata: {},
        timestamp: Date.now()
      }]);
      await localStore.close();

      // 2. Add global data
      const globalStore = new KnowledgeStore({ 
        dbDir: tmpDir, 
        embedder, 
        modelName: 'synthetic-64',
        workspace: '/project/b', // Different workspace
        localEnabled: false,
        globalEnabled: true
      });
      await globalStore.open();
      await globalStore.addDocuments([{
        url: 'https://global.com',
        text: 'Global shared content',
        metadata: {},
        timestamp: Date.now()
      }]);
      await globalStore.close();

      // 3. Verify project B only sees global data
      const storeB = new KnowledgeStore({ 
        dbDir: tmpDir, 
        embedder, 
        modelName: 'synthetic-64',
        workspace: '/project/b',
        localEnabled: true,
        globalEnabled: true
      });
      await storeB.open();
      
      const foundGlobal = await storeB.findByUrl('https://global.com');
      expect(foundGlobal).toHaveLength(1);
      
      const foundLocalA = await storeB.findByUrl('https://local-a.com');
      expect(foundLocalA).toHaveLength(0); // Should be invisible to project B

      await storeB.close();
    });
  });

  describe('Schema Versioning', () => {
    it('tracks schema version in database metadata', async () => {
      await store.addDocuments([
        {
          url: 'https://example.com',
          text: 'Test content',
          metadata: { chunkIndex: 0 },
          timestamp: Date.now(),
        },
      ]);

      // Verify schema version in metadata
      const schema = await (store as any).table.schema();
      let storedVersion = schema.metadata.get('schema_version');
      if (typeof storedVersion === 'object' && storedVersion !== null && 'byteLength' in (storedVersion as any)) {
        storedVersion = new TextDecoder().decode(storedVersion as unknown as Uint8Array);
      }
      expect(storedVersion).toBe(CURRENT_SCHEMA_VERSION);

      await store.close();
      const store2 = await makeStore(tmpDir, embedder);

      const found = await store2.findByUrl('https://example.com');
      expect(found.length).toBeGreaterThan(0);

      await store2.close();
    });
  });

  describe('Data Integrity', () => {
    it('preserves document data across sessions', async () => {
      const testData = [
        {
          url: 'https://example.com/1',
          text: 'First document',
          metadata: { chunkIndex: 0, customField: 'value1' },
          timestamp: Date.now(),
        },
      ];

      await store.addDocuments(testData);
      await store.close();

      const store2 = await makeStore(tmpDir, embedder);
      const found = await store2.findByUrl(testData[0].url);
      expect(found).toHaveLength(1);
      expect(found[0]?.text).toBe(testData[0].text);
      expect(found[0]?.metadata['customField']).toBe(testData[0].metadata.customField);

      await store2.close();
    });
  });
});
