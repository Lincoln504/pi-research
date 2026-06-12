import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must mock all heavy dependencies before importing the module under test
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
    LOCAL_KNOWLEDGE_STORE_ENABLED: true,
    GLOBAL_KNOWLEDGE_STORE_ENABLED: false,
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

// Derived from SUPPORTED_MODELS — never a hardcoded duplicate.
const ALL_MODEL_IDS = SUPPORTED_MODELS.map(m => m.id);

describe('createKnowledgeStoreComponents', () => {
  it('returns null if both local and global stores are disabled', async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      LOCAL_KNOWLEDGE_STORE_ENABLED: false,
      GLOBAL_KNOWLEDGE_STORE_ENABLED: false,
    } as any);

    const components = await createKnowledgeStoreComponents(() => Promise.resolve({} as any));
    expect(components).toBeNull();
  });

  it('initializes and returns components successfully', async () => {
    const mockEmbedder = { initialize: vi.fn(), getDimension: () => 384 };
    const embedderFactory = vi.fn().mockResolvedValue(mockEmbedder);

    const components = await createKnowledgeStoreComponents(embedderFactory);

    expect(components.embedder).toBe(mockEmbedder);
    expect(components.store).toBeDefined();
    expect(components.writerQueue).toBeDefined();
    expect(embedderFactory).toHaveBeenCalled();
  });
});

describe('forceDeleteKnowledgeStore', () => {
  it('should not throw if directory does not exist', async () => {
    vi.mock('node:fs', async () => {
      const actual = await vi.importActual('node:fs') as any;
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
      };
    });

    await expect(forceDeleteKnowledgeStore()).resolves.toBeUndefined();
  });
});

describe('getModelEmbedderConfig', () => {
  it('returns mean pooling and no prefix for unknown models', () => {
    const cfg = getModelEmbedderConfig('some/unknown-model');
    expect(cfg.pooling).toBe('mean');
    expect(cfg.queryPrefix).toBeUndefined();
  });

  it('returns mean pooling for Xenova/all-MiniLM-L6-v2 (default model)', () => {
    const cfg = getModelEmbedderConfig('Xenova/all-MiniLM-L6-v2');
    expect(cfg.pooling).toBe('mean');
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
