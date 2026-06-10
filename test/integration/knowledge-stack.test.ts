/**
 * End-to-end integration tests for the knowledge store stack.
 *
 * Uses a real LanceDB database in /tmp and real Chunker — only the Embedder
 * is synthetic (no HF model download). The goal is to verify that every
 * layer of the stack (Chunker → WriterQueue → KnowledgeStore → search /
 * rebuildDocument) works correctly as a unit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

import { KnowledgeStore } from '../../src/knowledge/store.ts';
import { WriterQueue } from '../../src/knowledge/writer-queue.ts';
import { Chunker } from '../../src/knowledge/chunker.ts';
import { Embedder } from '../../src/knowledge/embedder.ts';

// ---------------------------------------------------------------------------
// Synthetic embedder — returns deterministic vectors without downloading models
// ---------------------------------------------------------------------------
function makeSyntheticEmbedder(dim = 64): Embedder {
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
    dispose: async () => {},
  } as unknown as Embedder;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function makeStore(dir: string, embedder: Embedder, modelName = 'synthetic-64') {
  const store = new KnowledgeStore({ dbDir: dir, embedder, modelName });
  await store.open();
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Knowledge stack integration', () => {
  let tmpDir: string;
  let embedder: Embedder;
  let store: KnowledgeStore;
  let chunker: Chunker;
  let queue: WriterQueue;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `pi-knowledge-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
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
      vi.clearAllMocks();
    }
  });

  // ── Chunker ──────────────────────────────────────────────────────────────

  it('Chunker produces chunks that losslessly reconstruct the source', () => {
    const text = 'A '.repeat(200); // 400 chars, well above targetSize=200
    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThan(1);

    let rebuilt = chunks[0]!.text;
    for (let i = 1; i < chunks.length; i++) {
      rebuilt += chunks[i]!.text.slice(chunks[i]!.actual_overlap);
    }
    expect(rebuilt).toBe(text);
  });

  // ── KnowledgeStore ────────────────────────────────────────────────────────

  it('addDocuments + findByUrl round-trip', async () => {
    await store.addDocuments([
      { url: 'https://a.example.com', text: 'alpha content', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
    ]);
    const found = await store.findByUrl('https://a.example.com');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.text).toBe('alpha content');
  });

  it('findByUrl is exact — does not return docs for a different URL', async () => {
    await store.addDocuments([
      { url: 'https://a.example.com', text: 'page A', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
      { url: 'https://b.example.com', text: 'page B', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
    ]);
    const found = await store.findByUrl('https://a.example.com');
    expect(found.every(r => r.url === 'https://a.example.com')).toBe(true);
  });

  it('deleteByUrl removes target chunks, leaves others', async () => {
    await store.addDocuments([
      { url: 'https://del.example.com', text: 'gone', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
      { url: 'https://keep.example.com', text: 'kept', metadata: { chunkIndex: 0 }, timestamp: Date.now() },
    ]);

    await store.deleteByUrl('https://del.example.com');

    expect(await store.findByUrl('https://del.example.com')).toHaveLength(0);
    expect(await store.findByUrl('https://keep.example.com')).not.toHaveLength(0);
  });

  it('rebuildDocument returns null for an unknown URL', async () => {
    const result = await store.rebuildDocument('https://not-in-store.example.com');
    expect(result).toBeNull();
  });

  it('search returns results after ingestion', async () => {
    await store.addDocuments([
      { url: 'https://search.example.com', text: 'machine learning transformers', metadata: { chunkIndex: 0, ingestionType: 'synthesis-description' }, timestamp: Date.now() },
    ]);
    const results = await store.search('transformer model', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.url).toBe('https://search.example.com');
  });

  it('TTL eviction removes old records on re-open', async () => {
    await store.addDocuments([
      { url: 'https://old.example.com', text: 'stale content', metadata: {}, timestamp: 1 },
    ]);
    const before = await store.findByUrl('https://old.example.com');
    expect(before.length).toBeGreaterThan(0);

    await store.close();

    const store2 = await makeStore(tmpDir, embedder);
    try {
      const after = await store2.findByUrl('https://old.example.com');
      expect(after).toHaveLength(0);
    } finally {
      await store2.close();
    }
  });

  // ── WriterQueue ────────────────────────────────────────────────────────────

  it('WriterQueue ingests markdown through chunker into store', async () => {
    const markdown = 'Integration test content. '.repeat(20);
    queue.enqueue({ url: 'https://wq.example.com', markdown });
    await queue.drain();

    const found = await store.findByUrl('https://wq.example.com');
    expect(found.length).toBeGreaterThan(1);
  });

  it('WriterQueue deduplicates — same content is not re-ingested', async () => {
    const markdown = 'Stable content for dedup test.';
    queue.enqueue({ url: 'https://dedup.example.com', markdown });
    await queue.drain();
    const countAfterFirst = (await store.findByUrl('https://dedup.example.com')).length;

    queue.enqueue({ url: 'https://dedup.example.com', markdown });
    await queue.drain();
    const countAfterSecond = (await store.findByUrl('https://dedup.example.com')).length;

    expect(countAfterFirst).toBeGreaterThan(0);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('WriterQueue re-ingests on content change (delete-and-replace)', async () => {
    queue.enqueue({ url: 'https://changed.example.com', markdown: 'original content' });
    await queue.drain();

    const before = await store.findByUrl('https://changed.example.com');
    const originalHash = before[0]?.metadata['contentHash'];

    queue.enqueue({ url: 'https://changed.example.com', markdown: 'completely different content now' });
    await queue.drain();

    const after = await store.findByUrl('https://changed.example.com');
    expect(after[0]?.metadata['contentHash']).not.toBe(originalHash);
  });

  it('WriterQueue stores contentHash in chunk metadata', async () => {
    const markdown = 'hash check content';
    const expectedHash = createHash('sha256').update(markdown).digest('hex');
    queue.enqueue({ url: 'https://hash.example.com', markdown });
    await queue.drain();

    const docs = await store.findByUrl('https://hash.example.com');
    expect(docs.every(d => d.metadata['contentHash'] === expectedHash)).toBe(true);
  });

  // ── Full cache-hit simulation (scrape → cache → rebuild) ─────────────────

  it('full cache-hit path: ingest then rebuildDocument returns original', async () => {
    const originalMarkdown = '# Title\n\nSome paragraph content.\n\nAnother paragraph here.';
    queue.enqueue({ url: 'https://cache.example.com', markdown: 'Summary of the cache example', content: originalMarkdown });
    await queue.drain();

    const rebuilt = await store.rebuildDocument('https://cache.example.com');
    expect(rebuilt?.text).toBe(originalMarkdown);
  });

  // ── WriterQueue chunking ───────────────────────────────────────────────────

  describe('WriterQueue chunking', () => {
    it('stores multiple chunks for text larger than targetSize', async () => {
      const markdown = 'Integration test content. '.repeat(20);
      queue.enqueue({ url: 'https://chunks.example.com', markdown });
      await queue.drain();
      const found = await store.findByUrl('https://chunks.example.com');
      expect(found.length).toBeGreaterThan(1);
      const hash = createHash('sha256').update(markdown).digest('hex');
      expect(found.every(d => d.url === 'https://chunks.example.com')).toBe(true);
      expect(found.every(d => d.metadata['contentHash'] === hash)).toBe(true);
    });

    it('only first chunk carries the full-page content field', async () => {
      const markdown = 'Content. '.repeat(60); 
      const fullPageContent = '# Full Page\n\nOriginal markdown content here.';
      queue.enqueue({ url: 'https://content-field.example.com', markdown, content: fullPageContent });
      await queue.drain();
      const found = await store.findByUrl('https://content-field.example.com');
      expect(found.length).toBeGreaterThan(0);
      const withContent = found.filter(d => d.content !== undefined && d.content !== null);
      expect(withContent.length).toBe(1); 
      expect(withContent[0]!.content).toBe(fullPageContent);
      expect(withContent[0]!.metadata['chunkIndex']).toBe(0); 
    });

    it('chunk metadata includes chunkIndex and totalChunks', async () => {
      const markdown = 'Metadata test. '.repeat(40); 
      queue.enqueue({ url: 'https://meta.example.com', markdown });
      await queue.drain();
      const found = await store.findByUrl('https://meta.example.com');
      expect(found.length).toBeGreaterThan(1);
      const total = found[0]!.metadata['totalChunks'];
      expect(typeof total).toBe('number');
      expect(total).toBeGreaterThan(1);
      const indices = found.map(d => d.metadata['chunkIndex'] as number).sort((a, b) => a - b);
      expect(indices).toEqual(Array.from({ length: total }, (_, i) => i));
    });

    it('deduplication works correctly for multi-chunk documents', async () => {
      const markdown = 'Stable chunk content. '.repeat(30);
      queue.enqueue({ url: 'https://chunk-dedup.example.com', markdown });
      await queue.drain();
      const countAfterFirst = (await store.findByUrl('https://chunk-dedup.example.com')).length;
      expect(countAfterFirst).toBeGreaterThan(0);

      queue.enqueue({ url: 'https://chunk-dedup.example.com', markdown });
      await queue.drain();
      const countAfterSecond = (await store.findByUrl('https://chunk-dedup.example.com')).length;
      expect(countAfterSecond).toBe(countAfterFirst);
    });
  });
});
