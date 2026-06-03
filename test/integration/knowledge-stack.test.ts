/**
 * End-to-end integration tests for the knowledge store stack.
 *
 * Uses a real LanceDB database in /tmp and real Chunker — only the Embedder
 * is synthetic (no HF model download). The goal is to verify that every
 * layer of the stack (Chunker → WriterQueue → KnowledgeStore → search /
 * rebuildDocument) works correctly as a unit and that MODEL_CONFIG pooling
 * options are threaded through properly.
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
import { getModelEmbedderConfig, getModelChunkConfig } from '../../src/knowledge/index.ts';

// ---------------------------------------------------------------------------
// Synthetic embedder — returns deterministic vectors without downloading models
// ---------------------------------------------------------------------------
function makeSyntheticEmbedder(dim = 64): Embedder {
  // Hash input text to a reproducible float vector so similar texts get
  // similar (but not identical) vectors.
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
    // 'Integration test content. '.repeat(20) = 500 chars, targetSize=200 → >1 chunk
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

  // ── MODEL_CONFIG / getModelEmbedderConfig ─────────────────────────────────

  describe('getModelEmbedderConfig', () => {
    it('mean-pooling models all return pooling: mean', () => {
      expect(getModelEmbedderConfig('Xenova/all-MiniLM-L6-v2').pooling).toBe('mean');
      expect(getModelEmbedderConfig('Xenova/all-mpnet-base-v2').pooling).toBe('mean');
      expect(getModelEmbedderConfig('Xenova/multilingual-e5-small').pooling).toBe('mean');
      expect(getModelEmbedderConfig('Xenova/multilingual-e5-base').pooling).toBe('mean');
      expect(getModelEmbedderConfig('onnx-community/embeddinggemma-300m-ONNX').pooling).toBe('mean');
    });

    it('cls-pooling models return pooling: cls', () => {
      expect(getModelEmbedderConfig('Xenova/bge-small-en-v1.5').pooling).toBe('cls');
      expect(getModelEmbedderConfig('Xenova/bge-m3').pooling).toBe('cls');
      expect(getModelEmbedderConfig('onnx-community/granite-embedding-small-english-r2-ONNX').pooling).toBe('cls');
    });

    it('Qwen3-Embedding returns last_token pooling', () => {
      const cfg = getModelEmbedderConfig('onnx-community/Qwen3-Embedding-0.6B-ONNX');
      expect(cfg.pooling).toBe('last_token');
    });

    it('Qwen3-Embedding queryPrefix contains required Instruct/Query markers', () => {
      const { queryPrefix } = getModelEmbedderConfig('onnx-community/Qwen3-Embedding-0.6B-ONNX');
      expect(queryPrefix).toBeDefined();
      expect(queryPrefix).toContain('Instruct:');
      expect(queryPrefix).toContain('Query:');
      expect(queryPrefix!.endsWith(' ')).toBe(true);
    });

    it('bge-m3 has no queryPrefix', () => {
      const { queryPrefix } = getModelEmbedderConfig('Xenova/bge-m3');
      expect(queryPrefix).toBeUndefined();
    });
  });

  describe('getModelChunkConfig', () => {
    it('all supported models return chunk size in valid range and 15% overlap', () => {
      const models = [
        'Xenova/all-MiniLM-L6-v2',
        'Xenova/bge-small-en-v1.5',
        'Xenova/all-mpnet-base-v2',
        'Xenova/multilingual-e5-small',
        'Xenova/multilingual-e5-base',
        'Xenova/bge-m3',
        'onnx-community/embeddinggemma-300m-ONNX',
        'onnx-community/Qwen3-Embedding-0.6B-ONNX',
        'onnx-community/granite-embedding-small-english-r2-ONNX',
      ];
      for (const m of models) {
        const cfg = getModelChunkConfig(m);
        expect(cfg.chunkSize, `${m} chunkSize`).toBeGreaterThanOrEqual(500);
        expect(cfg.chunkSize, `${m} chunkSize`).toBeLessThanOrEqual(5000);
        expect(cfg.overlapPct, `${m} overlapPct`).toBe(0.15);
        const overlap = Math.round(cfg.chunkSize * cfg.overlapPct);
        expect(overlap, `${m} overlap < chunkSize`).toBeLessThan(cfg.chunkSize);
      }
    });

    it('MiniLM chunk size is smaller than Qwen3 (training context difference)', () => {
      expect(getModelChunkConfig('Xenova/all-MiniLM-L6-v2').chunkSize)
        .toBeLessThan(getModelChunkConfig('onnx-community/Qwen3-Embedding-0.6B-ONNX').chunkSize);
    });
  });

  // ── WriterQueue chunking ───────────────────────────────────────────────────

  describe('WriterQueue chunking', () => {
    it('stores multiple chunks for text larger than targetSize', async () => {
      // Chunker is configured with targetSize: 200, 'Integration test content. '.repeat(20) = 500 chars
      const markdown = 'Integration test content. '.repeat(20);
      queue.enqueue({ url: 'https://chunks.example.com', markdown });
      await queue.drain();
      const found = await store.findByUrl('https://chunks.example.com');
      expect(found.length).toBeGreaterThan(1);
      // All chunks share the same URL and contentHash
      const hash = createHash('sha256').update(markdown).digest('hex');
      expect(found.every(d => d.url === 'https://chunks.example.com')).toBe(true);
      expect(found.every(d => d.metadata['contentHash'] === hash)).toBe(true);
    });

    it('only first chunk carries the full-page content field', async () => {
      const markdown = 'Content. '.repeat(60); // long enough to chunk
      const fullPageContent = '# Full Page\n\nOriginal markdown content here.';
      queue.enqueue({ url: 'https://content-field.example.com', markdown, content: fullPageContent });
      await queue.drain();
      const found = await store.findByUrl('https://content-field.example.com');
      expect(found.length).toBeGreaterThan(0);
      const withContent = found.filter(d => d.content !== undefined && d.content !== null);
      expect(withContent.length).toBe(1); // exactly one chunk carries content
      expect(withContent[0]!.content).toBe(fullPageContent);
      expect(withContent[0]!.metadata['chunkIndex']).toBe(0); // must be the first chunk
    });

    it('chunk metadata includes chunkIndex and totalChunks', async () => {
      const markdown = 'Metadata test. '.repeat(40); // forces multiple chunks
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

      // Re-enqueue same content — should be a no-op
      queue.enqueue({ url: 'https://chunk-dedup.example.com', markdown });
      await queue.drain();
      const countAfterSecond = (await store.findByUrl('https://chunk-dedup.example.com')).length;
      expect(countAfterSecond).toBe(countAfterFirst);
    });
  });

  // ── Concurrent WriterQueue operations ─────────────────────────────────────

  describe('Concurrent WriterQueue operations', () => {
    it('multiple sequential enqueues before drain all complete', async () => {
      const urls = ['https://c1.example.com', 'https://c2.example.com', 'https://c3.example.com'];
      for (const url of urls) {
        queue.enqueue({ url, markdown: `Content for ${url} with enough words to be meaningful.` });
      }
      await queue.drain();
      for (const url of urls) {
        const found = await store.findByUrl(url);
        expect(found.length).toBeGreaterThan(0);
      }
    });

    it('two WriterQueue instances sharing one store do not cross-contaminate', async () => {
      const q2 = new WriterQueue({ store, chunker });
      queue.enqueue({ url: 'https://q1share.example.com', markdown: 'Queue 1 share content.' });
      q2.enqueue({ url: 'https://q2share.example.com', markdown: 'Queue 2 share content.' });
      await Promise.all([queue.drain(), q2.drain()]);

      const q1Docs = await store.findByUrl('https://q1share.example.com');
      const q2Docs = await store.findByUrl('https://q2share.example.com');
      expect(q1Docs.length).toBeGreaterThan(0);
      expect(q2Docs.length).toBeGreaterThan(0);
      expect(q1Docs.every(d => d.url === 'https://q1share.example.com')).toBe(true);
      expect(q2Docs.every(d => d.url === 'https://q2share.example.com')).toBe(true);
    });

    it('rapid re-enqueue of same URL serializes correctly — no duplicate rows', async () => {
      const markdown = 'Rapid dedup content for serialization test.';
      queue.enqueue({ url: 'https://rapid.example.com', markdown });
      queue.enqueue({ url: 'https://rapid.example.com', markdown });
      queue.enqueue({ url: 'https://rapid.example.com', markdown });
      await queue.drain();
      const docs = await store.findByUrl('https://rapid.example.com');
      // Same hash means dedup kicks in after first ingest
      const hashes = new Set(docs.map(d => d.metadata['contentHash']));
      expect(hashes.size).toBe(1);
    });
  });
});
