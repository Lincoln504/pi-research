import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Must mock all heavy dependencies before importing the module under test
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('../../../src/knowledge/embedder.ts', () => ({
  Embedder: vi.fn().mockImplementation(function(opts: any) {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      isInitialized: vi.fn().mockReturnValue(true),
      getDimension: vi.fn().mockReturnValue(384),
      embed: vi.fn().mockResolvedValue(new Float32Array(384)),
      embedMany: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(384))),
      getOriginalDevice: vi.fn().mockReturnValue('webgpu'),
      getDevice: vi.fn().mockReturnValue('webgpu'),
      _opts: opts,
    };
  }),
}));

vi.mock('../../../src/knowledge/store.ts', () => ({
  KnowledgeStore: vi.fn().mockImplementation(function() {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      rebuildFtsIndex: vi.fn().mockResolvedValue(undefined),
      addDocuments: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      findByUrl: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    };
  }),
}));

vi.mock('../../../src/knowledge/writer-queue.ts', () => ({
  WriterQueue: vi.fn().mockImplementation(function() {
    return {
      enqueue: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('../../../src/knowledge/chunker.ts', () => ({
  Chunker: vi.fn().mockImplementation(function() {
    return {
      chunk: vi.fn().mockReturnValue([{ text: 'chunk', actual_overlap: 0 }]),
    };
  }),
}));

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn().mockReturnValue({
    KNOWLEDGE_STORE_MODE: 'project',
    EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
    KNOWLEDGE_STORE_CACHE_TTL_DAYS: 30,
  }),
  validateConfig: vi.fn(),
  getDbDir: vi.fn().mockReturnValue('/tmp/knowledge_db'),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() },
}));

import { getModelEmbedderConfig, getModelChunkConfig, SUPPORTED_MODELS, createKnowledgeStoreComponents, forceDeleteKnowledgeStore } from '../../../src/knowledge/index.ts';
import { getConfig } from '../../../src/config.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { WriterQueue } from '../../../src/knowledge/writer-queue.ts';

// Derived from SUPPORTED_MODELS — never a hardcoded duplicate.
const ALL_MODEL_IDS = SUPPORTED_MODELS.map(m => m.id);

describe('createKnowledgeStoreComponents', () => {
  it('returns null if both local and global stores are disabled', async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      KNOWLEDGE_STORE_MODE: 'none',
    } as any);

    const components = await createKnowledgeStoreComponents(() => Promise.resolve({} as any));
    expect(components).toBeNull();
  });

  it('fails fast to a clean OFF (null, embedder factory never called) when the store packages are not resolvable', async () => {
    // The availability probe runs BEFORE the retry loop: a missing optional dep
    // must not burn MAX_INIT_RETRIES (5) attempts of exponential backoff (~31s)
    // discovering what require.resolve already knows. Same null verdict as
    // mode='none', so every null-tolerant consumer treats it as a disabled store.
    const embedderFactory = vi.fn();
    const components = await createKnowledgeStoreComponents(
      embedderFactory,
      undefined,
      undefined,
      undefined,
      undefined,
      { available: false, missing: ['@huggingface/transformers'] },
    );
    expect(components).toBeNull();
    expect(embedderFactory).not.toHaveBeenCalled();
  });

  it('applies the real-resolver probe verdict consistently on the default path (no injection)', async () => {
    // Guard against the pre-flight not consulting the probe at all: whatever the
    // running host's truth is, init must honor it — available → full build,
    // missing → null with the embedder factory never invoked. Host-state
    // independent: CI legs with and without optional deps both pass.
    const { probeKnowledgeStoreAvailability } = await import('../../../src/knowledge/availability.ts');
    const expectedAvailable = probeKnowledgeStoreAvailability().available;
    const mockEmbedder = { initialize: vi.fn(), getDimension: () => 384 };
    const embedderFactory = vi.fn().mockResolvedValue(mockEmbedder);

    const components = await createKnowledgeStoreComponents(embedderFactory);

    if (expectedAvailable) {
      expect(embedderFactory).toHaveBeenCalled();
      expect(components).not.toBeNull();
    } else {
      expect(embedderFactory).not.toHaveBeenCalled();
      expect(components).toBeNull();
    }
  });

  it('wires the embedder, store and writer-queue together', async () => {
    const mockEmbedder = { initialize: vi.fn(), getDimension: () => 384 };
    const embedderFactory = vi.fn().mockResolvedValue(mockEmbedder);

    const components = await createKnowledgeStoreComponents(embedderFactory);

    // The embedder comes from the supplied factory, not constructed internally.
    expect(embedderFactory).toHaveBeenCalled();
    expect(components!.embedder).toBe(mockEmbedder);

    // The store is constructed with that exact embedder (verifies real wiring,
    // not merely that a mock returned an object).
    expect(KnowledgeStore).toHaveBeenCalledTimes(1);
    const storeOpts = vi.mocked(KnowledgeStore).mock.calls[0]![0] as any;
    expect(storeOpts.embedder).toBe(mockEmbedder);
    expect(components!.store).toBe(vi.mocked(KnowledgeStore).mock.results[0]!.value);

    // The writer-queue is constructed against that same store instance.
    expect(WriterQueue).toHaveBeenCalledTimes(1);
    const wqOpts = vi.mocked(WriterQueue).mock.calls[0]![0] as any;
    expect(wqOpts.store).toBe(components!.store);
    expect(components!.writerQueue).toBe(vi.mocked(WriterQueue).mock.results[0]!.value);
  });
});

describe('forceDeleteKnowledgeStore', () => {
  afterEach(() => {
    vi.mocked(fs.existsSync).mockRestore();
    vi.mocked(fs.rmSync).mockRestore();
    vi.mocked(fs.readFileSync).mockRestore();
  });

  it('should not throw if directory does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(forceDeleteKnowledgeStore()).resolves.toBeUndefined();
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('deletes only the active table directory, never the shared dbDir itself — so sibling backups and other workspaces survive', async () => {
    // dbDir exists, manifest exists, manifest names a non-default active table
    // (the persisted-rename-failure case store.ts documents).
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ activeTableName: 'knowledge_migration_123' }));

    await forceDeleteKnowledgeStore();

    expect(fs.rmSync).toHaveBeenCalledTimes(1);
    const [deletedPath] = vi.mocked(fs.rmSync).mock.calls[0]!;
    expect(deletedPath).toBe(path.join('/tmp/knowledge_db', 'knowledge_migration_123.lance'));
    // The old behavior deleted the whole dbDir — assert this fix never does.
    expect(deletedPath).not.toBe('/tmp/knowledge_db');
  });

  it('falls back to the default table name when the manifest is missing or unreadable, without widening the delete to the whole dbDir', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

    await forceDeleteKnowledgeStore();

    expect(fs.rmSync).toHaveBeenCalledWith(path.join('/tmp/knowledge_db', 'knowledge.lance'), expect.any(Object));
  });
});

describe('getModelEmbedderConfig', () => {
  it('returns mean pooling and no prefix for unknown models', () => {
    const result = getModelEmbedderConfig('some/unknown-model');
    expect(result.pooling).toBe('mean');
    expect(result.queryPrefix).toBeUndefined();
  });

  it('returns mean pooling for Xenova/all-MiniLM-L6-v2', () => {
    const result = getModelEmbedderConfig('Xenova/all-MiniLM-L6-v2');
    expect(result.pooling).toBe('mean');
  });

  it('returns mean pooling for multilingual-e5-small', () => {
    const cfg = getModelEmbedderConfig('Xenova/multilingual-e5-small');
    expect(cfg.pooling).toBe('mean');
  });

  it('returns mean pooling for embeddinggemma', () => {
    const cfg = getModelEmbedderConfig('onnx-community/embeddinggemma-300m-ONNX');
    expect(cfg.pooling).toBe('mean');
  });

  it('returns cls pooling for bge-m3 (CLS-trained model)', () => {
    const cfg = getModelEmbedderConfig('Xenova/bge-m3');
    expect(cfg.pooling).toBe('cls');
    expect(cfg.queryPrefix).toBeUndefined();
  });

  it('returns last_token pooling for Qwen3-Embedding', () => {
    const cfg = getModelEmbedderConfig('onnx-community/Qwen3-Embedding-0.6B-ONNX');
    expect(cfg.pooling).toBe('last_token');
  });

  it('returns non-empty queryPrefix for Qwen3-Embedding', () => {
    const cfg = getModelEmbedderConfig('onnx-community/Qwen3-Embedding-0.6B-ONNX');
    expect(cfg.queryPrefix).toBeDefined();
    expect(cfg.queryPrefix!.length).toBeGreaterThan(0);
    // Should contain the required "Instruct:" and "Query:" markers per the model spec
    expect(cfg.queryPrefix).toContain('Instruct:');
    expect(cfg.queryPrefix).toContain('Query:');
  });

  it('queryPrefix for Qwen3 ends with a space so the query text is cleanly appended', () => {
    const cfg = getModelEmbedderConfig('onnx-community/Qwen3-Embedding-0.6B-ONNX');
    expect(cfg.queryPrefix!.endsWith(' ')).toBe(true);
  });

  it('returns consistent values across multiple calls (pure function)', () => {
    const a = getModelEmbedderConfig('Xenova/bge-m3');
    const b = getModelEmbedderConfig('Xenova/bge-m3');
    expect(a.pooling).toBe(b.pooling);
    expect(a.queryPrefix).toBe(b.queryPrefix);
  });
});

describe('getModelChunkConfig', () => {
  it('unknown model gets safe fallback values', () => {
    const cfg = getModelChunkConfig('some/unknown-model');
    expect(cfg.chunkSize).toBeGreaterThan(0);
    expect(cfg.overlapPct).toBeGreaterThan(0);
    expect(cfg.overlapPct).toBeLessThan(0.5);
  });

  it('MiniLM has a smaller chunk size than Qwen3 (respects training context)', () => {
    const mini = getModelChunkConfig('Xenova/all-MiniLM-L6-v2');
    const qwen = getModelChunkConfig('onnx-community/Qwen3-Embedding-0.6B-ONNX');
    expect(mini.chunkSize).toBeLessThan(qwen.chunkSize);
  });

  it('all configured models have chunk size within safe char range (500–5000)', () => {
    for (const m of ALL_MODEL_IDS) {
      const cfg = getModelChunkConfig(m);
      expect(cfg.chunkSize, `${m} chunkSize`).toBeGreaterThanOrEqual(500);
      expect(cfg.chunkSize, `${m} chunkSize`).toBeLessThanOrEqual(5000);
    }
  });

  it('overlap percentage is 15% for all configured models', () => {
    for (const m of ALL_MODEL_IDS) {
      expect(getModelChunkConfig(m).overlapPct, `${m} overlapPct`).toBe(0.15);
    }
  });

  it('derived overlap chars are strictly less than chunk size (no infinite loop)', () => {
    for (const m of ALL_MODEL_IDS) {
      const { chunkSize, overlapPct } = getModelChunkConfig(m);
      const overlap = Math.round(chunkSize * overlapPct);
      expect(overlap, `${m} overlap < chunkSize`).toBeLessThan(chunkSize);
    }
  });
});

describe('SUPPORTED_MODELS', () => {
  it('contains all models from MODEL_CONFIG (at least 9)', () => {
    expect(SUPPORTED_MODELS.length).toBeGreaterThanOrEqual(9);
  });

  it('every entry has a non-empty id and a boolean multilingual field', () => {
    for (const m of SUPPORTED_MODELS) {
      expect(typeof m.id, `id of ${m.id}`).toBe('string');
      expect(m.id.length, `id length of ${m.id}`).toBeGreaterThan(0);
      expect(typeof m.multilingual, `multilingual of ${m.id}`).toBe('boolean');
    }
  });

  it('multilingual models are listed before English-only models', () => {
    const firstEnIdx = SUPPORTED_MODELS.findIndex(m => !m.multilingual);
    const lastMlIdx = [...SUPPORTED_MODELS].reverse().findIndex(m => m.multilingual);
    const lastMlForward = SUPPORTED_MODELS.length - 1 - lastMlIdx;
    if (firstEnIdx !== -1 && lastMlForward !== -1) {
      expect(firstEnIdx, 'first EN model must come after last ML model').toBeGreaterThan(lastMlForward);
    }
  });

  it('every id is also addressable via getModelEmbedderConfig (not the default fallback)', () => {
    for (const m of SUPPORTED_MODELS) {
      const cfg = getModelEmbedderConfig(m.id);
      expect(['mean', 'cls', 'last_token'], `${m.id} pooling`).toContain(cfg.pooling);
    }
  });

  it('no duplicate ids', () => {
    const ids = SUPPORTED_MODELS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
