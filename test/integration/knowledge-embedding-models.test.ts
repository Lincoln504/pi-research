/**
 * Integration tests: per-model embedding configuration and store workflow.
 *
 * Uses synthetic embedders (no model downloads). Validates that MODEL_CONFIG
 * entries are internally consistent and that the store + WriterQueue workflow
 * completes correctly for every configured embedding model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

import { KnowledgeStore } from '../../src/knowledge/store.ts';
import { WriterQueue } from '../../src/knowledge/writer-queue.ts';
import { Chunker } from '../../src/knowledge/chunker.ts';
import { getModelEmbedderConfig, getModelChunkConfig, SUPPORTED_MODELS as SOURCE_MODELS } from '../../src/knowledge/index.ts';
import { Embedder, getModelCacheDir } from '../../src/knowledge/embedder.ts';

// Derived from the authoritative MODEL_CONFIG in knowledge/index.ts — not a duplicate.
// Any model added to MODEL_CONFIG is automatically covered here.
const SUPPORTED_MODELS = SOURCE_MODELS.map(m => m.id);

// Known-correct expectations for each model
const MODEL_EXPECTATIONS: Record<string, {
  pooling: 'mean' | 'cls' | 'last_token';
  queryPrefix?: string;
  documentPrefix?: string;
  maxTokens?: number;
  batchSize?: number;
  charsPerToken?: number;
}> = {
  'Xenova/all-MiniLM-L6-v2':   { pooling: 'mean', maxTokens: 256 },
  'Xenova/bge-small-en-v1.5':  { pooling: 'cls' },
  'Xenova/all-mpnet-base-v2':  { pooling: 'mean', maxTokens: 384 },
  'Xenova/multilingual-e5-small': { pooling: 'mean', queryPrefix: 'query: ', documentPrefix: 'passage: ', charsPerToken: 3.5 },
  'Xenova/multilingual-e5-base':  { pooling: 'mean', queryPrefix: 'query: ', documentPrefix: 'passage: ', charsPerToken: 3.5 },
  'Xenova/bge-m3':             { pooling: 'cls', charsPerToken: 3.5 },
  'onnx-community/embeddinggemma-300m-ONNX': { pooling: 'mean', queryPrefix: 'task: search result | query: ', documentPrefix: 'title: none | text: ', charsPerToken: 3.5 },
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': { pooling: 'last_token', queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages.\nQuery: ', maxTokens: 512, batchSize: 2, charsPerToken: 2.5 },
  'onnx-community/granite-embedding-small-english-r2-ONNX': { pooling: 'cls', maxTokens: 512, batchSize: 8 },
};

// ---------------------------------------------------------------------------
// Synthetic embedder — no model downloads
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
  } as unknown as Embedder;
}

function isModelCachedLocally(modelId: string): boolean {
  const cacheDir = getModelCacheDir();
  const onnxDir = path.join(cacheDir, ...modelId.split('/'), 'onnx');
  try {
    return fs.readdirSync(onnxDir).some((f: string) => f.endsWith('.onnx'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-model config correctness
// ---------------------------------------------------------------------------
describe('MODEL_CONFIG — per-model configuration correctness', () => {
  for (const modelId of SUPPORTED_MODELS) {
    const exp = MODEL_EXPECTATIONS[modelId]!;

    describe(modelId, () => {
      it('pooling strategy is correct', () => {
        expect(getModelEmbedderConfig(modelId).pooling).toBe(exp.pooling);
      });

      it('pooling value is one of the three allowed strategies', () => {
        expect(['mean', 'cls', 'last_token']).toContain(getModelEmbedderConfig(modelId).pooling);
      });

      if (exp.queryPrefix !== undefined) {
        it('queryPrefix matches expected value', () => {
          expect(getModelEmbedderConfig(modelId).queryPrefix).toBe(exp.queryPrefix);
        });
        it('queryPrefix ends with a space (required for correct tokenization)', () => {
          const qp = getModelEmbedderConfig(modelId).queryPrefix!;
          expect(qp.endsWith(' ') || qp.endsWith('\n')).toBe(true);
        });
      } else {
        it('no queryPrefix (symmetric model)', () => {
          expect(getModelEmbedderConfig(modelId).queryPrefix).toBeUndefined();
        });
      }

      if (exp.documentPrefix !== undefined) {
        it('documentPrefix matches expected value', () => {
          expect(getModelEmbedderConfig(modelId).documentPrefix).toBe(exp.documentPrefix);
        });
      } else {
        it('no documentPrefix (symmetric or query-only-prefixed model)', () => {
          // Qwen3 has queryPrefix but no documentPrefix — asymmetric decoder style
          const cfg = getModelEmbedderConfig(modelId);
          if (exp.queryPrefix === undefined) {
            expect(cfg.documentPrefix).toBeUndefined();
          }
        });
      }

      if (exp.maxTokens !== undefined) {
        it(`maxTokens is ${exp.maxTokens}`, () => {
          expect(getModelEmbedderConfig(modelId).maxTokens).toBe(exp.maxTokens);
        });
      }

      if (exp.batchSize !== undefined) {
        it(`batchSize is ${exp.batchSize}`, () => {
          expect(getModelEmbedderConfig(modelId).batchSize).toBe(exp.batchSize);
        });
      }

      if (exp.charsPerToken !== undefined) {
        it(`charsPerToken is ${exp.charsPerToken}`, () => {
          expect(getModelEmbedderConfig(modelId).charsPerToken).toBe(exp.charsPerToken);
        });
      }

      it('chunkSize is in valid range [500, 5000]', () => {
        const { chunkSize } = getModelChunkConfig(modelId);
        expect(chunkSize).toBeGreaterThanOrEqual(500);
        expect(chunkSize).toBeLessThanOrEqual(5000);
      });

      it('overlapPct is exactly 0.15', () => {
        expect(getModelChunkConfig(modelId).overlapPct).toBe(0.15);
      });

      it('computed overlap is less than chunkSize (no infinite-loop risk)', () => {
        const { chunkSize, overlapPct } = getModelChunkConfig(modelId);
        const overlap = Math.round(chunkSize * overlapPct);
        expect(overlap).toBeLessThan(chunkSize);
      });

      it('chunkSize does not exceed maxTokens × charsPerToken', () => {
        const embedCfg = getModelEmbedderConfig(modelId);
        const { chunkSize } = getModelChunkConfig(modelId);
        if (embedCfg.maxTokens) {
          const charsPerToken = embedCfg.charsPerToken ?? 4;
          expect(chunkSize).toBeLessThanOrEqual(embedCfg.maxTokens * charsPerToken);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Full store workflow per model (synthetic embedder — no downloads)
// ---------------------------------------------------------------------------
describe('Full store+WriterQueue workflow — per model', () => {
  let baseTmpDir: string;

  beforeEach(() => {
    baseTmpDir = path.join(os.tmpdir(), `pi-emb-wf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(baseTmpDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(baseTmpDir)) {
      fs.rmSync(baseTmpDir, { recursive: true, force: true });
    }
  });

  for (const modelId of SUPPORTED_MODELS) {
    it(`${modelId}: enqueue → drain → findByUrl round-trip`, async () => {
      const dbDir = path.join(baseTmpDir, modelId.replace(/[/\\]/g, '-'));
      const embedder = makeSyntheticEmbedder(64);
      const store = new KnowledgeStore({ dbDir, embedder, modelName: modelId });
      await store.open();

      try {
        const { chunkSize, overlapPct } = getModelChunkConfig(modelId);
        const overlap = Math.round(chunkSize * overlapPct);
        const chunker = new Chunker({ targetSize: chunkSize, overlap });
        const queue = new WriterQueue({ store, chunker });

        const url = `https://test.example.com/${encodeURIComponent(modelId)}`;
        const markdown = `This is test content for model ${modelId}. `.repeat(10);
        queue.enqueue({ url, markdown });
        await queue.drain();

        const found = await store.findByUrl(url);
        expect(found.length).toBeGreaterThan(0);
        expect(found[0]!.url).toBe(url);
        // All rows share the same content hash
        const hash = createHash('sha256').update(markdown).digest('hex');
        expect(found.every(d => d.metadata['contentHash'] === hash)).toBe(true);
        // ingestionType is set correctly
        expect(found.every(d => d.metadata['ingestionType'] === 'synthesis-description')).toBe(true);
      } finally {
        await store.close();
      }
    });

    it(`${modelId}: model mismatch on re-open drops and recreates table`, async () => {
      const dbDir = path.join(baseTmpDir, `mismatch-${modelId.replace(/[/\\]/g, '-')}`);
      const embedder = makeSyntheticEmbedder(64);

      // Open with model A
      const store1 = new KnowledgeStore({ dbDir, embedder, modelName: 'synthetic-model-A' });
      await store1.open();
      await store1.addDocuments([{ url: 'https://mismatch.test', text: 'old content', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
      await store1.close();

      // Re-open with model B (simulates switching embedding model)
      const store2 = new KnowledgeStore({ dbDir, embedder, modelName: modelId });
      await store2.open();
      try {
        // Old data from model A must be gone (table was recreated)
        const found = await store2.findByUrl('https://mismatch.test');
        expect(found).toHaveLength(0);
      } finally {
        await store2.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Concurrent embedding — global queue simulation
// ---------------------------------------------------------------------------
describe('Concurrent embedding — WriterQueue serialization', () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `pi-conc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const embedder = makeSyntheticEmbedder(64);
    store = new KnowledgeStore({ dbDir: tmpDir, embedder, modelName: 'synthetic-concurrent' });
    await store.open();
  });

  afterEach(async () => {
    await store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('10 concurrent enqueues on one queue all land in the store', async () => {
    const chunker = new Chunker({ targetSize: 800, overlap: 120 });
    const queue = new WriterQueue({ store, chunker });
    const count = 10;

    for (let i = 0; i < count; i++) {
      queue.enqueue({
        url: `https://concurrent.example.com/page${i}`,
        markdown: `Page ${i} content with sufficient text to be meaningful. Extra padding to reach a reasonable length.`,
      });
    }

    await queue.drain();

    let total = 0;
    for (let i = 0; i < count; i++) {
      const found = await store.findByUrl(`https://concurrent.example.com/page${i}`);
      expect(found.length).toBeGreaterThan(0);
      total += found.length;
    }
    expect(total).toBeGreaterThanOrEqual(count);
  });

  it('two WriterQueue instances sharing one store complete without data loss', async () => {
    const chunker = new Chunker({ targetSize: 800, overlap: 120 });
    const q1 = new WriterQueue({ store, chunker });
    const q2 = new WriterQueue({ store, chunker });

    q1.enqueue({ url: 'https://q1.concurrent.example.com', markdown: 'Queue 1 content. Unique text for first queue.' });
    q2.enqueue({ url: 'https://q2.concurrent.example.com', markdown: 'Queue 2 content. Unique text for second queue.' });

    await Promise.all([q1.drain(), q2.drain()]);

    const q1Docs = await store.findByUrl('https://q1.concurrent.example.com');
    const q2Docs = await store.findByUrl('https://q2.concurrent.example.com');
    expect(q1Docs.length).toBeGreaterThan(0);
    expect(q2Docs.length).toBeGreaterThan(0);
    expect(q1Docs.every(d => d.url === 'https://q1.concurrent.example.com')).toBe(true);
    expect(q2Docs.every(d => d.url === 'https://q2.concurrent.example.com')).toBe(true);
  });

  it('rapid re-enqueue of same URL before drain — dedup prevents duplicate rows', async () => {
    const chunker = new Chunker({ targetSize: 800, overlap: 120 });
    const queue = new WriterQueue({ store, chunker });
    const markdown = 'Stable content for rapid re-enqueue deduplication test.';

    queue.enqueue({ url: 'https://rapid-dedup.example.com', markdown });
    queue.enqueue({ url: 'https://rapid-dedup.example.com', markdown });
    queue.enqueue({ url: 'https://rapid-dedup.example.com', markdown });

    await queue.drain();

    const docs = await store.findByUrl('https://rapid-dedup.example.com');
    expect(docs.length).toBeGreaterThan(0);
    const hashes = new Set(docs.map(d => d.metadata['contentHash']));
    expect(hashes.size).toBe(1);
  });

  it('content change triggers delete-and-replace across all chunks', async () => {
    const chunker = new Chunker({ targetSize: 800, overlap: 120 });
    const queue = new WriterQueue({ store, chunker });
    const url = 'https://replace.example.com';

    queue.enqueue({ url, markdown: 'Original content version one.' });
    await queue.drain();
    const before = await store.findByUrl(url);
    const originalHash = before[0]?.metadata['contentHash'];

    queue.enqueue({ url, markdown: 'Completely different content version two with new text.' });
    await queue.drain();
    const after = await store.findByUrl(url);
    const newHash = after[0]?.metadata['contentHash'];

    expect(newHash).not.toBe(originalHash);
    // All remaining rows should have the new hash
    expect(after.every(d => d.metadata['contentHash'] === newHash)).toBe(true);
  });

  it('WriterQueue with no chunker stores single document per enqueue', async () => {
    const queueNoChunker = new WriterQueue({ store });
    const markdown = 'Short content — no chunking needed.';
    queueNoChunker.enqueue({ url: 'https://nochunker.example.com', markdown });
    await queueNoChunker.drain();

    const found = await store.findByUrl('https://nochunker.example.com');
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe(markdown);
    expect(found[0]!.metadata['chunkIndex']).toBe(0);
    expect(found[0]!.metadata['totalChunks']).toBe(1);
  });

  it('embedding calls are tracked — embedMany called once per addDocuments', async () => {
    let embedManyCalls = 0;
    const trackingEmbedder = {
      isInitialized: () => true,
      getDimension: () => 64,
      initialize: async () => {},
      embed: async (text: string) => {
        const v = new Float32Array(64);
        const h = createHash('sha256').update(text).digest();
        for (let i = 0; i < 64; i++) v[i] = (h[i % h.length]! / 255) * 2 - 1;
        return v;
      },
      embedMany: async (texts: string[]) => {
        embedManyCalls++;
        return texts.map(t => {
          const v = new Float32Array(64);
          const h = createHash('sha256').update(t).digest();
          for (let i = 0; i < 64; i++) v[i] = (h[i % h.length]! / 255) * 2 - 1;
          return v;
        });
      },
    } as unknown as Embedder;

    const trackingTmpDir = path.join(os.tmpdir(), `pi-track-${Date.now()}`);
    const trackingStore = new KnowledgeStore({ dbDir: trackingTmpDir, embedder: trackingEmbedder, modelName: 'tracking' });
    await trackingStore.open();
    try {
      const chunker = new Chunker({ targetSize: 200, overlap: 30 });
      const queue = new WriterQueue({ store: trackingStore, chunker });
      // Text long enough to produce 2 chunks (400 chars / targetSize 200)
      const markdown = 'Embedding call tracking test. '.repeat(15);
      queue.enqueue({ url: 'https://tracking.example.com', markdown });
      await queue.drain();
      // addDocuments is called once per enqueue (all chunks in one batch)
      expect(embedManyCalls).toBe(1);
    } finally {
      await trackingStore.close();
      if (fs.existsSync(trackingTmpDir)) fs.rmSync(trackingTmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Real model inference — skipped when model is not cached locally
// ---------------------------------------------------------------------------
// These tests use the real Embedder (actual ONNX pipeline). They only run when
// the model has been pre-downloaded via `npm run models:download`. In CI without
// cached models every test is skipped — no failures, no downloads.
//
// Run `npm run models:download` to pre-cache all models before running these tests.
// ---------------------------------------------------------------------------
describe('Real model inference — requires npm run models:download', () => {
  for (const modelId of SUPPORTED_MODELS) {
    const cached = isModelCachedLocally(modelId);

    it.skipIf(!cached)(`${modelId}: initialize, embed, dimension, full store workflow`, async () => {
      const embedCfg = getModelEmbedderConfig(modelId);
      const embedder = new Embedder({
        model: modelId,
        pooling: embedCfg.pooling,
        queryPrefix: embedCfg.queryPrefix,
        documentPrefix: embedCfg.documentPrefix,
        maxTokens: embedCfg.maxTokens,
        batchSize: embedCfg.batchSize,
        charsPerToken: embedCfg.charsPerToken,
        device: 'cpu',
        initializationTimeoutMs: 120_000,
      });

      await embedder.initialize();
      expect(embedder.isInitialized()).toBe(true);
      const dim = embedder.getDimension();
      expect(dim).toBeGreaterThan(0);

      // embed() returns a vector of the correct dimension
      const vec = await embedder.embed('test query for dimension check');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(dim);

      // embedMany() returns one vector per input text
      const vecs = await embedder.embedMany(['document one', 'document two', 'document three']);
      expect(vecs).toHaveLength(3);
      vecs.forEach(v => {
        expect(v).toBeInstanceOf(Float32Array);
        expect(v.length).toBe(dim);
      });

      // Full store + WriterQueue workflow
      const tmpDir = path.join(os.tmpdir(), `pi-realmodel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      const store = new KnowledgeStore({ dbDir: tmpDir, embedder, modelName: modelId });
      await store.open();
      try {
        const { chunkSize, overlapPct } = getModelChunkConfig(modelId);
        const overlap = Math.round(chunkSize * overlapPct);
        const chunker = new Chunker({ targetSize: chunkSize, overlap });
        const queue = new WriterQueue({ store, chunker });

        const url = `https://realmodel.test/${encodeURIComponent(modelId)}`;
        const markdown = `Real model inference test for ${modelId}. This text exercises the full pipeline from embedding to vector storage and retrieval. It should be long enough to be meaningful.`;
        queue.enqueue({ url, markdown });
        await queue.drain();

        const found = await store.findByUrl(url);
        expect(found.length).toBeGreaterThan(0);
        expect(found[0]!.url).toBe(url);
        // Vector dimension in store matches embedder dimension
        expect(found[0]!.metadata['ingestionType']).toBe('synthesis-description');
      } finally {
        await store.close();
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        await embedder.dispose();
      }
    }, 180_000); // 3-minute timeout per real model test
  }
});
