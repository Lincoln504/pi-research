import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Embedder } from '../../../src/knowledge/embedder.ts';

// Accessible mock pipeline function — allows inspection of call arguments
const mockPipelineFn = vi.fn(async (text: string | string[], _options: any) => {
  const dimensions = 384;
  if (Array.isArray(text)) {
    // Each text's embedding has its 0-index set to its 1-based position
    // so slicing correctness can be verified
    const data = new Float32Array(text.length * dimensions);
    for (let i = 0; i < text.length; i++) {
      data[i * dimensions] = i + 1;
    }
    return { data, dims: [text.length, dimensions] };
  }
  return { data: new Float32Array(dimensions).fill(1), dims: [1, dimensions] };
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockImplementation(async () => mockPipelineFn),
}));

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

  it('should throw from getDimension before initialization', () => {
    expect(() => embedder.getDimension()).toThrow('Embedder not initialized');
  });

  it('should default to mean pooling and no prefix', async () => {
    await embedder.initialize();
    mockPipelineFn.mockClear();

    await embedder.embed('test text');

    expect(mockPipelineFn).toHaveBeenCalledWith('test text', {
      pooling: 'mean',
      normalize: true,
    });
  });

  it('should pass cls pooling to the pipeline when configured', async () => {
    const clsEmbedder = new Embedder({ model: 'bge-m3', pooling: 'cls' });
    await clsEmbedder.initialize();
    mockPipelineFn.mockClear();

    await clsEmbedder.embed('test text');

    expect(mockPipelineFn).toHaveBeenCalledWith('test text', {
      pooling: 'cls',
      normalize: true,
    });
  });

  it('should pass last_token pooling to the pipeline when configured', async () => {
    const ltEmbedder = new Embedder({ model: 'qwen3-emb', pooling: 'last_token' });
    await ltEmbedder.initialize();
    mockPipelineFn.mockClear();

    await ltEmbedder.embed('test text');

    expect(mockPipelineFn).toHaveBeenCalledWith('test text', {
      pooling: 'last_token',
      normalize: true,
    });
  });

  it('embed() prepends queryPrefix to the input text', async () => {
    const prefixEmbedder = new Embedder({
      model: 'test-model',
      queryPrefix: 'Instruct: retrieve\nQuery: ',
    });
    await prefixEmbedder.initialize();
    mockPipelineFn.mockClear();

    await prefixEmbedder.embed('what is AI?');

    expect(mockPipelineFn).toHaveBeenCalledWith(
      'Instruct: retrieve\nQuery: what is AI?',
      expect.objectContaining({ pooling: 'mean' }),
    );
  });

  it('embedMany() does NOT prepend queryPrefix — document ingestion is unprefixed', async () => {
    const prefixEmbedder = new Embedder({
      model: 'test-model',
      queryPrefix: 'Instruct: retrieve\nQuery: ',
    });
    await prefixEmbedder.initialize();
    mockPipelineFn.mockClear();

    await prefixEmbedder.embedMany(['doc one', 'doc two']);

    // Raw text passed through — no prefix prepended
    expect(mockPipelineFn).toHaveBeenCalledWith(['doc one', 'doc two'], expect.any(Object));
  });

  it('should call the pipeline with correct options for embedMany', async () => {
    await embedder.initialize();
    mockPipelineFn.mockClear();

    await embedder.embedMany(['a', 'b']);

    expect(mockPipelineFn).toHaveBeenCalledWith(['a', 'b'], {
      pooling: 'mean',
      normalize: true,
    });
  });

  it('warm-up call uses the configured pooling mode', async () => {
    const clsEmbedder = new Embedder({ model: 'bge-m3', pooling: 'cls' });
    mockPipelineFn.mockClear();
    await clsEmbedder.initialize();

    // First call is the warm-up
    const warmupCall = mockPipelineFn.mock.calls[0];
    expect(warmupCall[1]).toMatchObject({ pooling: 'cls' });
  });

  it('embedMany should return correctly sliced distinct vectors per text', async () => {
    await embedder.initialize();
    const results = await embedder.embedMany(['first', 'second']);

    expect(results).toHaveLength(2);
    // Each slice should start with 1-based index (set by mockPipelineFn)
    expect(results[0][0]).toBe(1);
    expect(results[1][0]).toBe(2);
    // Slices must be independent Float32Array instances
    expect(results[0]).not.toBe(results[1]);
  });

  it('embedMany with empty array returns empty array', async () => {
    await embedder.initialize();
    const results = await embedder.embedMany([]);
    expect(results).toEqual([]);
  });

  it('should reraise pipeline errors, remain uninitialized, and allow retry', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    vi.mocked(pipeline)
      .mockRejectedValueOnce(new Error('model download failed'))
      .mockImplementationOnce(async () => mockPipelineFn);

    const failingEmbedder = new Embedder({ model: 'test-model' });

    await expect(failingEmbedder.initialize()).rejects.toThrow('model download failed');
    expect(failingEmbedder.isInitialized()).toBe(false);

    // Retry should now succeed because the initializing promise was cleared on failure
    await failingEmbedder.initialize();
    expect(failingEmbedder.isInitialized()).toBe(true);
  });

  it('concurrent initialize() calls should invoke the underlying pipeline only once', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    const callCount = vi.fn();
    vi.mocked(pipeline).mockImplementationOnce(async (..._args) => {
      callCount();
      return mockPipelineFn;
    });

    const freshEmbedder = new Embedder({ model: 'test-model' });
    await Promise.all([
      freshEmbedder.initialize(),
      freshEmbedder.initialize(),
      freshEmbedder.initialize(),
    ]);

    expect(callCount).toHaveBeenCalledTimes(1);
    expect(freshEmbedder.isInitialized()).toBe(true);
  });
});
