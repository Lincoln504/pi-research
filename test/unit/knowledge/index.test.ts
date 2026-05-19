import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must mock all heavy dependencies before importing the module under test
vi.mock('../../../src/knowledge/embedder.ts', () => ({
  Embedder: vi.fn().mockImplementation((opts: any) => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
    getDimension: vi.fn().mockReturnValue(384),
    embed: vi.fn().mockResolvedValue(new Float32Array(384)),
    embedMany: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(384))),
    // Expose constructor options so tests can inspect how it was built
    _opts: opts,
  })),
}));

vi.mock('../../../src/knowledge/store.ts', () => ({
  KnowledgeStore: vi.fn().mockImplementation(() => ({
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    rebuildFtsIndex: vi.fn().mockResolvedValue(undefined),
    addDocuments: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    findByUrl: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../../src/knowledge/writer-queue.ts', () => ({
  WriterQueue: vi.fn().mockImplementation(() => ({
    enqueue: vi.fn(),
    drain: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/knowledge/chunker.ts', () => ({
  Chunker: vi.fn().mockImplementation(() => ({
    chunk: vi.fn().mockReturnValue([{ text: 'chunk', actual_overlap: 0 }]),
  })),
}));

vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn().mockReturnValue({
    KNOWLEDGE_STORE_ENABLED: true,
    EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
    CHUNK_SIZE_CHARS: 3000,
    CHUNK_OVERLAP_CHARS: 512,
    KNOWLEDGE_STORE_CACHE_TTL_DAYS: 30,
  }),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { getModelEmbedderConfig } from '../../../src/knowledge/index.ts';

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
