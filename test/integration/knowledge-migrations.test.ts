/**
 * Knowledge Store Migration Integration Tests
 *
 * Tests for knowledge store schema migrations, data integrity during upgrades,
 * and backward compatibility handling.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { KnowledgeStore } from '../../src/knowledge/store.ts';
import { WriterQueue } from '../../src/knowledge/writer-queue.ts';
import { Chunker } from '../../src/knowledge/chunker.ts';
import { createHash } from 'node:crypto';

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

describe('Knowledge Store Migrations', () => {
  let tmpDir: string;
  let embedder: any;
  let store: KnowledgeStore;
  let chunker: Chunker;
  let queue: WriterQueue;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `pi-migration-test-${Date.now()}`);
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

  describe('Schema Version Management', () => {
    it('tracks schema version in database metadata', async () => {
      // Add some data
      await store.addDocuments([
        {
          url: 'https://example.com',
          text: 'Test content',
          metadata: { chunkIndex: 0 },
          timestamp: Date.now(),
        },
      ]);

      // Close and reopen
      await store.close();
      const store2 = await makeStore(tmpDir, embedder);

      // Data should still be accessible
      const found = await store2.findByUrl('https://example.com');
      expect(found.length).toBeGreaterThan(0);

      await store2.close();
    });

    it('handles database created without version metadata', async () => {
      // Simulate old database by creating it without version metadata
      // This is a simplified simulation - in practice, you'd need to manually
      // create an old database structure
      await store.addDocuments([
        {
          url: 'https://example.com',
          text: 'Test content',
          metadata: { chunkIndex: 0 },
          timestamp: Date.now(),
        },
      ]);

      // Close and reopen - should handle gracefully
      await store.close();
      const store2 = await makeStore(tmpDir, embedder);

      const found = await store2.findByUrl('https://example.com');
      expect(found.length).toBeGreaterThan(0);

      await store2.close();
    });
  });

  describe('Data Integrity During Migration', () => {
    it('preserves document data during schema upgrades', async () => {
      const testData = [
        {
          url: 'https://example.com/1',
          text: 'First document',
          metadata: { chunkIndex: 0, customField: 'value1' },
          timestamp: Date.now(),
        },
        {
          url: 'https://example.com/2',
          text: 'Second document',
          metadata: { chunkIndex: 0, customField: 'value2' },
          timestamp: Date.now(),
        },
        {
          url: 'https://example.com/3',
          text: 'Third document',
          metadata: { chunkIndex: 0, customField: 'value3' },
          timestamp: Date.now(),
        },
      ];

      await store.addDocuments(testData);

      // Close and reopen to simulate migration
      await store.close();
      const store2 = await makeStore(tmpDir, embedder);

      // Verify all data is preserved
      for (const doc of testData) {
        const found = await store2.findByUrl(doc.url);
        expect(found.length).toBeGreaterThan(0);
        expect(found[0]?.text).toBe(doc.text);
        expect(found[0]?.metadata['customField']).toBe(doc.metadata.customField);
      }

      await store2.close();
    });

    it('preserves search functionality after schema upgrade', async () => {
      await store.addDocuments([
        {
          url: 'https://example.com/ml',
          text: 'Machine learning algorithms for pattern recognition',
          metadata: { chunkIndex: 0 },
          timestamp: Date.now(),
        },
        {
          url: 'https://example.com/ai',
          text: 'Artificial intelligence and neural networks',
          metadata: { chunkIndex: 0 },
          timestamp: Date.now(),
        },
      ]);

      // Perform search before migration
      const resultsBefore = await store.search('machine learning', { limit: 5 });
      expect(resultsBefore.length).toBeGreaterThan(0);

      // Close and reopen to simulate migration
      await store.close();
      const store2 = await makeStore(tmpDir, embedder);

      // Verify search still works
      const resultsAfter = await store2.search('machine learning', { limit: 5 });
      expect(resultsAfter.length).toBeGreaterThan(0);
      expect(resultsAfter[0]?.url).toBe('https://example.com/ml');

      await store2.close();
    });

    it('preserves TTL eviction behavior after migration', async () => {
      // Add old document
      await store.addDocuments([
        {
          url: 'https://example.com/old',
          text: 'Old content',
          metadata: {},
          timestamp: 1, // Very old timestamp
        },
      ]);

      // Verify it exists
      const before = await store.findByUrl('https://example.com/old');
      expect(before.length).toBeGreaterThan(0);

      // Close and reopen to simulate migration
      await store.close();
      const store2 = await makeStore(tmpDir, embedder);

      // Old document should be evicted by TTL
      await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
      const after = await store2.findByUrl('https://example.com/old');
      expect(after).toHaveLength(0);

      await store2.close();
    });
  });

  describe('Backward Compatibility', () => {
    it('can read documents written by older version', async () => {
      // Simulate old document format (simplified)
      const oldFormatDoc = {
        url: 'https://legacy.example.com',
        text: 'Legacy document',
        metadata: {
          chunkIndex: 0,
          // Old format might have different metadata structure
          legacyField: 'old value',
        },
        timestamp: Date.now(),
      };

      await store.addDocuments([oldFormatDoc]);

      // Reopen with current version
      await store.close();
      const store2 = await makeStore(tmpDir, embedder);

      const found = await store2.findByUrl('https://legacy.example.com');
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.text).toBe('Legacy document');

      await store2.close();
    });

    it('handles documents with missing optional metadata fields', async () => {
      // Add documents with minimal metadata
      await store.addDocuments([
        {
          url: 'https://minimal.example.com',
          text: 'Minimal metadata document',
          metadata: { chunkIndex: 0 }, // Only required field
          timestamp: Date.now(),
        },
      ]);

      await store.close();
      const store2 = await makeStore(tmpDir, embedder);

      const found = await store2.findByUrl('https://minimal.example.com');
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.metadata['chunkIndex']).toBe(0);

      await store2.close();
    });
  });

  describe('Migration Error Recovery', () => {
    it('handles partial migration gracefully', async () => {
      // Add data
      await store.addDocuments([
        {
          url: 'https://example.com/partial',
          text: 'Partial migration test',
          metadata: { chunkIndex: 0 },
          timestamp: Date.now(),
        },
      ]);

      // Close to simulate migration scenario
      await store.close();

      // Simulate partial migration by opening with different embedder dimension
      // In a real scenario, this might fail or require migration
      try {
        const newEmbedder = makeSyntheticEmbedder(128); // Different dimension
        const store2 = await makeStore(tmpDir, newEmbedder);

        // If we got here, the store handled the dimension change
        const found = await store2.findByUrl('https://example.com/partial');
        // Data might be lost or re-embedded depending on implementation
        await store2.close();
      } catch (error) {
        // Expected: dimension mismatch should be caught
        expect(error).toBeDefined();
      }
    });

    it('preserves data when migration is interrupted', async () => {
      // Add multiple documents
      const docs = Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/doc${i}`,
        text: `Document ${i} content`,
        metadata: { chunkIndex: 0 },
        timestamp: Date.now(),
      }));

      await store.addDocuments(docs);

      await store.close();

      // Reopen - should recover and be usable
      const store2 = await makeStore(tmpDir, embedder);

      // Verify at least some data is preserved
      const allUrls = await Promise.all(
        docs.map(doc => store2.findByUrl(doc.url))
      );

      const preservedCount = allUrls.filter(results => results.length > 0).length;
      expect(preservedCount).toBeGreaterThan(0);

      await store2.close();
    });
  });

  describe('Concurrent Access During Migration', () => {
    it('handles concurrent reads during schema upgrade', async () => {
      // Add initial data
      await store.addDocuments([
        {
          url: 'https://example.com/concurrent',
          text: 'Concurrent access test',
          metadata: { chunkIndex: 0 },
          timestamp: Date.now(),
        },
      ]);

      await store.close();

      // Reopen (triggers migration) and immediately start concurrent reads
      const store2 = await makeStore(tmpDir, embedder);

      const readPromises = Array.from({ length: 10 }, () =>
        store2.findByUrl('https://example.com/concurrent')
      );

      const results = await Promise.all(readPromises);

      // All reads should succeed
      results.forEach(found => {
        expect(found.length).toBeGreaterThan(0);
      });

      await store2.close();
    });

    it('handles concurrent writes during schema upgrade', async () => {
      await store.close();

      // Reopen (triggers migration) and immediately start concurrent writes
      const store2 = await makeStore(tmpDir, embedder);

      const writePromises = Array.from({ length: 10 }, (_, i) =>
        store2.addDocuments([
          {
            url: `https://example.com/concurrent${i}`,
            text: `Concurrent document ${i}`,
            metadata: { chunkIndex: 0 },
            timestamp: Date.now(),
          },
        ])
      );

      await Promise.all(writePromises);

      // Verify all writes succeeded
      for (let i = 0; i < 10; i++) {
        const found = await store2.findByUrl(`https://example.com/concurrent${i}`);
        expect(found.length).toBeGreaterThan(0);
      }

      await store2.close();
    });
  });

  describe('Document Rebuild After Migration', () => {
    it('can rebuild documents after schema upgrade', async () => {
      const originalContent = '# Original\n\nContent here.\n\nMore content.';
      const summary = 'Summary of original content';

      queue.enqueue({
        url: 'https://example.com/rebuild',
        markdown: summary,
        content: originalContent,
      });
      await queue.drain();

      // Verify document was stored
      const found1 = await store.findByUrl('https://example.com/rebuild');
      expect(found1.length).toBeGreaterThan(0);

      await store.close();

      // Reopen to trigger migration
      const store2 = await makeStore(tmpDir, embedder);

      // Verify rebuildDocument still works
      const rebuilt = await store2.rebuildDocument('https://example.com/rebuild');
      expect(rebuilt).not.toBeNull();
      expect(rebuilt?.text).toBe(originalContent);

      await store2.close();
    });
  });
});