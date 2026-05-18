import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Embedder } from '../../../src/knowledge/embedder.ts';

// Mock @huggingface/transformers
vi.mock('@huggingface/transformers', () => {
  return {
    pipeline: vi.fn().mockResolvedValue(async (text: string | string[], options: any) => {
      // Mock embedding output
      const dimensions = 384;
      if (Array.isArray(text)) {
        return {
          data: new Float32Array(text.length * dimensions),
          dims: [text.length, dimensions],
        };
      }
      return {
        data: new Float32Array(dimensions),
        dims: [1, dimensions],
      };
    }),
  };
});

describe('Embedder', () => {
  let embedder: Embedder;

  beforeEach(() => {
    embedder = new Embedder({
      model: 'test-model',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize successfully', async () => {
    expect(embedder.isInitialized()).toBe(false);
    await embedder.initialize();
    expect(embedder.isInitialized()).toBe(true);
  });

  it('should generate embeddings for a single string', async () => {
    await embedder.initialize();
    const result = await embedder.embed('hello world');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  });

  it('should generate embeddings for multiple strings', async () => {
    await embedder.initialize();
    const results = await embedder.embedMany(['hello', 'world']);
    expect(results).toHaveLength(2);
    expect(results[0]).toBeInstanceOf(Float32Array);
    expect(results[0].length).toBe(384);
  });

  it('should throw if not initialized', async () => {
    await expect(embedder.embed('hello')).rejects.toThrow('Embedder not initialized');
  });

  it('should return dimension size', async () => {
    await embedder.initialize();
    expect(embedder.getDimension()).toBe(384);
  });
});
