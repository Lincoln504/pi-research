import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Embedder, resetWebGpuFallbackFlag } from '../../../src/knowledge/embedder.ts';

// vi.hoisted ensures these are available when vi.mock factories run (which are hoisted to the top)
const { mockPipelineFn, mockEnv, mockAccess } = vi.hoisted(() => {
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

  // Mutable env object — embedder code mutates env.allowRemoteModels directly,
  // so we need a real object rather than a spy wrapper.
  const mockEnv = {
    allowRemoteModels: true,
    cacheDir: '/fake/cache',
    allowLocalModels: true,
    useFSCache: true,
  };

  // Mock fs/promises.access — default resolves (model is cached)
  const mockAccess = vi.fn().mockResolvedValue(undefined);

  return { mockPipelineFn, mockEnv, mockAccess };
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockImplementation(async () => mockPipelineFn),
  env: mockEnv,
}));

vi.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => mockAccess(...args),
}));

describe('Embedder', () => {
  let embedder: Embedder;

  beforeEach(() => {
    resetWebGpuFallbackFlag();
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

  it('should initialize lazily when embed() is called', async () => {
    const result = await embedder.embed('hello');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  });

  it('should return dimension size', async () => {
    await embedder.initialize();
    expect(embedder.getDimension()).toBe(384);
  });

  it('should return null from getDimension before initialization', () => {
    expect(embedder.getDimension()).toBeNull();
  });

  it('should default to mean pooling and no prefix', async () => {
    await embedder.initialize();
    mockPipelineFn.mockClear();

    await embedder.embed('test text');

    expect(mockPipelineFn).toHaveBeenCalledWith(
      'test text',
      expect.objectContaining({ pooling: 'mean', normalize: true }),
    );
  });

  it('should pass cls pooling to the pipeline when configured', async () => {
    const clsEmbedder = new Embedder({ model: 'bge-m3', pooling: 'cls' });
    await clsEmbedder.initialize();
    mockPipelineFn.mockClear();

    await clsEmbedder.embed('test text');

    expect(mockPipelineFn).toHaveBeenCalledWith(
      'test text',
      expect.objectContaining({ pooling: 'cls', normalize: true }),
    );
  });

  it('should pass last_token pooling to the pipeline when configured', async () => {
    const ltEmbedder = new Embedder({ model: 'qwen3-emb', pooling: 'last_token' });
    await ltEmbedder.initialize();
    mockPipelineFn.mockClear();

    await ltEmbedder.embed('test text');

    expect(mockPipelineFn).toHaveBeenCalledWith(
      'test text',
      expect.objectContaining({ pooling: 'last_token', normalize: true }),
    );
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

  it('embedMany() does NOT prepend queryPrefix — query prefix is query-side only', async () => {
    const prefixEmbedder = new Embedder({
      model: 'test-model',
      queryPrefix: 'Instruct: retrieve\nQuery: ',
    });
    await prefixEmbedder.initialize();
    mockPipelineFn.mockClear();

    await prefixEmbedder.embedMany(['doc one', 'doc two']);

    // queryPrefix must not be prepended to document embeddings
    const calls = mockPipelineFn.mock.calls;
    const inputArgs = calls.map((c: any[]) => c[0]);
    expect(inputArgs.some((arg: any) => Array.isArray(arg) && arg.includes('doc one'))).toBe(true);
  });

  it('embedMany() prepends documentPrefix when configured (e.g. E5 "passage: ")', async () => {
    const e5Embedder = new Embedder({
      model: 'multilingual-e5-small',
      queryPrefix: 'query: ',
      documentPrefix: 'passage: ',
    });
    await e5Embedder.initialize();
    mockPipelineFn.mockClear();

    await e5Embedder.embedMany(['hello world', 'foo bar']);

    const calls = mockPipelineFn.mock.calls;
    const inputArgs = calls.map((c: any[]) => c[0]);
    expect(inputArgs.some((arg: any) => Array.isArray(arg) && arg.includes('passage: hello world'))).toBe(true);
  });

  it('embed() does NOT prepend documentPrefix — document prefix is document-side only', async () => {
    const e5Embedder = new Embedder({
      model: 'multilingual-e5-small',
      queryPrefix: 'query: ',
      documentPrefix: 'passage: ',
    });
    await e5Embedder.initialize();
    mockPipelineFn.mockClear();

    await e5Embedder.embed('what is AI?');

    expect(mockPipelineFn).toHaveBeenCalledWith(
      'query: what is AI?',
      expect.objectContaining({ pooling: 'mean' }),
    );
  });

  it('should call the pipeline with correct options for embedMany', async () => {
    await embedder.initialize();
    mockPipelineFn.mockClear();

    await embedder.embedMany(['a', 'b']);

    expect(mockPipelineFn).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ pooling: 'mean', normalize: true }),
    );
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
    (vi.mocked(pipeline) as any)
      .mockRejectedValueOnce(new Error('model download failed'))
      .mockImplementationOnce(async () => mockPipelineFn);

    const failingEmbedder = new Embedder({ model: 'test-model' });

    await expect(failingEmbedder.initialize()).rejects.toThrow('model download failed');
    expect(failingEmbedder.isInitialized()).toBe(false);

    // Retry should now succeed because the initializing promise was cleared on failure
    await failingEmbedder.initialize();
    expect(failingEmbedder.isInitialized()).toBe(true);
  });

  it('should recover to CPU when WebGPU device error occurs during embed()', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    
    // First call to pipeline (initialization) succeeds with WebGPU
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => mockPipelineFn);

    const embedder = new Embedder({ model: 'test-model', device: 'webgpu' });
    await embedder.initialize();
    
    // Setup mockPipelineFn to throw WebGPU error on first embed()
    mockPipelineFn.mockRejectedValueOnce(new Error('WebGPU OUT_OF_DEVICE_MEMORY'));
    
    // Setup second pipeline initialization (for recovery) to succeed with CPU
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      // Return a fresh mock that works
      return vi.fn(async () => ({ data: new Float32Array(384).fill(9), dims: [1, 384] }));
    });

    const result = await embedder.embed('test');
    
    // Should have called pipeline twice (once for initial, once for recovery)
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(pipeline).toHaveBeenLastCalledWith(
      'feature-extraction',
      'test-model',
      expect.objectContaining({ device: 'cpu' })
    );
    expect(result[0]).toBe(9); // Value from the recovery pipeline
  });
});

/**
 * Timeout Tests
 * 
 * These tests verify that the embedder initialization timeout works correctly.
 * The timeout prevents the process from hanging indefinitely when model
 * downloads stall or fail.
 */
describe('Embedder timeout behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate model not cached so initializationTimeoutMs (100ms in tests) governs
    // pipeline load timeout instead of the fixed 30s cached-path timeout.
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fail initialization when timeout is exceeded', async () => {
    const { pipeline } = await import('@huggingface/transformers');

    // Mock pipeline to hang indefinitely (never resolve)
    vi.mocked(pipeline).mockReturnValue(
      new Promise(() => {
        // Never resolve - simulates a stuck download
      })
    );

    const embedder = new Embedder({
      model: 'test/model',
      initializationTimeoutMs: 100, // 100ms timeout
    });

    await expect(embedder.initialize()).rejects.toThrow(
      /timed out after 100ms/
    );

    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(1);
  });

  it('should not create duplicate initialization promises during a timeout', async () => {
    const { pipeline } = await import('@huggingface/transformers');

    // Mock pipeline to hang indefinitely
    vi.mocked(pipeline).mockReturnValue(
      new Promise(() => {
        // Never resolve
      })
    );

    const embedder = new Embedder({
      model: 'test/model',
      initializationTimeoutMs: 100,
    });

    const init1 = embedder.initialize();
    const init2 = embedder.initialize();

    // Both should reject with the same error
    await expect(init1).rejects.toThrow(/timed out/);
    await expect(init2).rejects.toThrow(/timed out/);

    // Pipeline should only be called once
    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(1);
  });

  it('should reset initialization after timeout error, allowing retry', async () => {
    const { pipeline } = await import('@huggingface/transformers');

    let callCount = 0;
    vi.mocked(pipeline).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: hang
        return new Promise(() => {});
      } else {
        // Second call: return a callable mock pipeline
        return mockPipelineFn as any;
      }
    });

    const embedder = new Embedder({
      model: 'test/model',
      initializationTimeoutMs: 100,
    });

    // First attempt: timeout
    await expect(embedder.initialize()).rejects.toThrow(/timed out/);

    // Second attempt: should succeed
    await expect(embedder.initialize()).resolves.not.toThrow();
    expect(embedder.isInitialized()).toBe(true);

    // Pipeline should be called twice (once per attempt)
    expect(callCount).toBe(2);
  });

});

describe('GPU lock behavior', () => {
  const makeStateManager = () => ({
    acquireGpuLock: vi.fn().mockResolvedValue(true),
    releaseGpuLock: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    resetWebGpuFallbackFlag();
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
  });

  it('acquires GPU init lock and releases it after initialization completes', async () => {
    const sm = makeStateManager();
    const e = new Embedder({ model: 'test-model', device: 'webgpu', stateManager: sm as any });
    await e.initialize();
    expect(sm.acquireGpuLock).toHaveBeenCalledTimes(1);
    // Lock must be released after init, before any inference
    expect(sm.releaseGpuLock).toHaveBeenCalledTimes(1);
  });

  it('falls back to CPU when GPU init lock cannot be acquired', async () => {
    const sm = makeStateManager();
    sm.acquireGpuLock.mockResolvedValue(false);
    const { pipeline } = await import('@huggingface/transformers');
    let deviceUsed: string | undefined;
    (vi.mocked(pipeline) as any).mockImplementationOnce(async (_task: any, _model: any, opts: any) => {
      deviceUsed = opts?.device;
      return mockPipelineFn;
    });

    const e = new Embedder({ model: 'test-model', device: 'webgpu', stateManager: sm as any });
    await e.initialize();
    expect(deviceUsed).toBe('cpu');
    expect(sm.releaseGpuLock).not.toHaveBeenCalled();
  });

  it('acquires and releases GPU lock per embed() call', async () => {
    const sm = makeStateManager();
    const e = new Embedder({ model: 'test-model', device: 'webgpu', stateManager: sm as any });
    await e.initialize();
    sm.acquireGpuLock.mockClear();
    sm.releaseGpuLock.mockClear();

    await e.embed('hello');
    expect(sm.acquireGpuLock).toHaveBeenCalledTimes(1);
    expect(sm.releaseGpuLock).toHaveBeenCalledTimes(1);
  });

  it('acquires and releases GPU lock once for entire embedMany() operation', async () => {
    const sm = makeStateManager();
    const e = new Embedder({ model: 'test-model', device: 'webgpu', batchSize: 2, stateManager: sm as any });
    await e.initialize();
    sm.acquireGpuLock.mockClear();
    sm.releaseGpuLock.mockClear();

    await e.embedMany(['a', 'b', 'c', 'd']); // 2 batches of 2, but only 1 lock acquisition
    expect(sm.acquireGpuLock).toHaveBeenCalledTimes(1);
    expect(sm.releaseGpuLock).toHaveBeenCalledTimes(1);
  });

  it('releases GPU lock even when embed() pipeline throws', async () => {
    const sm = makeStateManager();
    const e = new Embedder({ model: 'test-model', device: 'webgpu', stateManager: sm as any });
    await e.initialize();
    sm.acquireGpuLock.mockClear();
    sm.releaseGpuLock.mockClear();

    mockPipelineFn.mockRejectedValueOnce(new Error('non-gpu pipeline error'));
    await expect(e.embed('hello')).rejects.toThrow('non-gpu pipeline error');
    expect(sm.releaseGpuLock).toHaveBeenCalledTimes(1);
  });

  it('releases GPU init lock even when initialization fails', async () => {
    const sm = makeStateManager();
    const { pipeline } = await import('@huggingface/transformers');
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('init failure'));

    const e = new Embedder({ model: 'test-model', device: 'webgpu', stateManager: sm as any });
    await expect(e.initialize()).rejects.toThrow('init failure');
    expect(sm.releaseGpuLock).toHaveBeenCalledTimes(1);
  });

  it('no GPU lock calls when stateManager is not provided', async () => {
    const e = new Embedder({ model: 'test-model', device: 'webgpu' });
    await e.initialize();
    // No stateManager — no lock calls, no crash
    await e.embed('hello');
    await e.embedMany(['a', 'b']);
  });
});

describe('cache-aware initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to defaults before each test
    mockEnv.allowRemoteModels = true;
    mockEnv.cacheDir = '/fake/cache';
    // Default: model is cached
    mockAccess.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets allowRemoteModels=false when model is cached', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    let allowRemoteAtCallTime: boolean | undefined;

    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      allowRemoteAtCallTime = mockEnv.allowRemoteModels;
      return mockPipelineFn;
    });

    const embedder = new Embedder({ model: 'test-model' });
    await embedder.initialize();

    expect(allowRemoteAtCallTime).toBe(false);
  });

  it('restores allowRemoteModels after successful init', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => mockPipelineFn);

    mockEnv.allowRemoteModels = true;
    const embedder = new Embedder({ model: 'test-model' });
    await embedder.initialize();

    expect(mockEnv.allowRemoteModels).toBe(true);
  });

  it('restores allowRemoteModels even if pipeline throws', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('load failure'));

    mockEnv.allowRemoteModels = true;
    const embedder = new Embedder({ model: 'test-model' });
    await expect(embedder.initialize()).rejects.toThrow('load failure');

    expect(mockEnv.allowRemoteModels).toBe(true);
  });

  it('does NOT set allowRemoteModels=false when model is not cached', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    let allowRemoteAtCallTime: boolean | undefined;

    // Simulate missing model file
    mockAccess.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      allowRemoteAtCallTime = mockEnv.allowRemoteModels;
      return mockPipelineFn;
    });

    const embedder = new Embedder({ model: 'test-model' });
    await embedder.initialize();

    expect(allowRemoteAtCallTime).toBe(true);
  });
});

describe('Embedder disposal', () => {
  let embedder: Embedder;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    embedder = new Embedder({ model: 'test-model' });
  });

  it('should dispose pipeline and set isInitialized to false', async () => {
    await embedder.initialize();
    expect(embedder.isInitialized()).toBe(true);

    await embedder.dispose();

    expect(embedder.isInitialized()).toBe(false);
  });

  it('should handle dispose when not initialized', async () => {
    await expect(embedder.dispose()).resolves.not.toThrow();
    expect(embedder.isInitialized()).toBe(false);
  });

  it('should re-initialize when calling embed after dispose', async () => {
    await embedder.initialize();
    await embedder.dispose();

    const result = await embedder.embed('test');
    expect(result).toBeInstanceOf(Float32Array);
  });

  it('should re-initialize when calling embedMany after dispose', async () => {
    await embedder.initialize();
    await embedder.dispose();

    const results = await embedder.embedMany(['test']);
    expect(results).toHaveLength(1);
  });

  it('should still return dimension size after dispose if previously initialized', async () => {
    await embedder.initialize();
    await embedder.dispose();

    expect(embedder.getDimension()).toBe(384);
  });

  it('should release GPU lock when disposing with stateManager', async () => {
    const sm = {
      acquireGpuLock: vi.fn().mockResolvedValue(true),
      releaseGpuLock: vi.fn().mockResolvedValue(undefined),
    };
    const e = new Embedder({ model: 'test-model', device: 'webgpu', stateManager: sm as any });
    await e.initialize();

    // Clear calls from initialization
    sm.releaseGpuLock.mockClear();

    await e.dispose();

    expect(sm.releaseGpuLock).toHaveBeenCalledTimes(1);
  });
});

