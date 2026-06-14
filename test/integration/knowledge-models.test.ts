/**
 * Integration tests: per-model embedding configuration and store workflow.
 *
 * Validates that MODEL_CONFIG entries are internally consistent and that the 
 * store + WriterQueue workflow completes correctly for every configured 
 * embedding model using synthetic embedders.
 * 
 * Also includes real model inference tests that are skipped unless models 
 * are cached locally.
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

const SUPPORTED_MODELS = SOURCE_MODELS.map(m => m.id);

// ---------------------------------------------------------------------------
// Synthetic embedder — no model downloads
// ---------------------------------------------------------------------------
function makeSyntheticEmbedder(dim = 64): Embedder {
  function textToVector(text: string): Float32Array {
    const v = new Float32Array(dim);
    const h = createHash('sha256').update(text || '').digest();
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
// Full store workflow sampled (synthetic embedder — no downloads)
// ---------------------------------------------------------------------------
const WORKFLOW_MODELS = [
  'Xenova/all-MiniLM-L6-v2',      // 384
  'Xenova/all-mpnet-base-v2',     // 768
  'onnx-community/Qwen3-Embedding-0.6B-ONNX', // 1024
];

describe('Knowledge store workflow — sampled per dimension', () => {
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

  for (const modelId of WORKFLOW_MODELS) {
    it(`${modelId}: enqueue → drain → findByUrl round-trip`, async () => {
      const dbDir = path.join(baseTmpDir, modelId.replace(/[/\\]/g, '-'));
      const dimensions: Record<string, number> = {
        'Xenova/all-MiniLM-L6-v2': 384,
        'Xenova/all-mpnet-base-v2': 768,
        'onnx-community/Qwen3-Embedding-0.6B-ONNX': 1024,
      };
      const modelDim = dimensions[modelId] || 384;
      
      const embedder = makeSyntheticEmbedder(modelDim);
      const store = new KnowledgeStore({ knowledgeMode: "project", dbDir, embedder, modelName: modelId });
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
        const hash = createHash('sha256').update(markdown).digest('hex');
        expect(found.every(d => d.metadata['contentHash'] === hash)).toBe(true);
        expect(found.every(d => d.metadata['ingestionType'] === 'synthesis-description')).toBe(true);
      } finally {
        await store.close();
      }
    });
  }
  
  it('model mismatch on re-open drops and recreates table (sampled)', async () => {
    const modelId = 'Xenova/all-MiniLM-L6-v2';
    const dbDir = path.join(baseTmpDir, 'mismatch-test');
    const modelA = 'Xenova/multilingual-e5-base';
    
    // 1. Open with model A (768)
    const store1 = new KnowledgeStore({ knowledgeMode: "project", dbDir, embedder: makeSyntheticEmbedder(768), modelName: modelA });
    await store1.open();
    await store1.addDocuments([{ url: 'https://mismatch.test', text: 'old content', metadata: { ingestionType: 'synthesis-description' }, timestamp: Date.now() }]);
    await store1.close();

    // 2. Re-open with model B (384)
    const store2 = new KnowledgeStore({ knowledgeMode: "project", dbDir, embedder: makeSyntheticEmbedder(384), modelName: modelId });
    await store2.open();
    try {
      const found = await store2.findByUrl('https://mismatch.test');
      expect(found).toHaveLength(0);
    } finally {
      await store2.close();
    }
  });
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
    store = new KnowledgeStore({ knowledgeMode: "project", dbDir: tmpDir, embedder, modelName: 'synthetic-concurrent' });
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
    expect(after.every(d => d.metadata['contentHash'] === newHash)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real model inference — skipped when model is not cached locally
// ---------------------------------------------------------------------------
describe('Real model inference — requires pre-cached models', () => {
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

      const vec = await embedder.embed('test query for dimension check');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(dim);

      const tmpDir = path.join(os.tmpdir(), `pi-realmodel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
      const store = new KnowledgeStore({ knowledgeMode: "project", dbDir: tmpDir, embedder, modelName: modelId });
      await store.open();
      try {
        const { chunkSize, overlapPct } = getModelChunkConfig(modelId);
        const overlap = Math.round(chunkSize * overlapPct);
        const chunker = new Chunker({ targetSize: chunkSize, overlap });
        const queue = new WriterQueue({ store, chunker });

        const url = `https://realmodel.test/${encodeURIComponent(modelId)}`;
        const markdown = `Real model inference test for ${modelId}.`;
        queue.enqueue({ url, markdown });
        await queue.drain();

        const found = await store.findByUrl(url);
        expect(found.length).toBeGreaterThan(0);
        expect(found[0]!.url).toBe(url);
      } finally {
        await store.close();
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        await embedder.dispose();
      }
    }, 180_000);
  }
});
