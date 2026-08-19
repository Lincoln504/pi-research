import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Embedder, resetWebGpuFallbackFlag } from '../../../src/knowledge/embedder.ts';
import { metrics } from '../../../src/utils/metrics.ts';

// vi.hoisted ensures these are available when vi.mock factories run (which are hoisted to the top)
const { mockPipelineFn, mockEnv, mockAccess, mockReaddir, mockStat, mockRm, mockReadFile } = vi.hoisted(() => {
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

  // Mock fs/promises for isModelCached() — default state is a COMPLETE cache:
  // access(model.onnx) resolves, root config.json reads as valid JSON, a tokenizer file
  // stats non-empty, readdir lists no partial-download artifacts and no external weights
  // file, so isModelCached returns true. stat/rm/readFile back the completeness, root-
  // metadata, sweep, and corrupt-cache-purge paths.
  const mockAccess = vi.fn().mockResolvedValue(undefined);
  const mockReaddir = vi.fn().mockResolvedValue(['model.onnx', 'config.json']);
  const mockStat = vi.fn().mockResolvedValue({ size: 1024 });
  const mockRm = vi.fn().mockResolvedValue(undefined);
  const mockReadFile = vi.fn().mockResolvedValue('{}');

  return { mockPipelineFn, mockEnv, mockAccess, mockReaddir, mockStat, mockRm, mockReadFile };
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockImplementation(async () => mockPipelineFn),
  env: mockEnv,
}));

vi.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Keep unit tests hermetic: the real resolveEmbeddingDevice('auto', ...) spawns
// an out-of-process WebGPU probe child. Stub it so 'auto' resolves to 'webgpu'
// (exercising the same in-process path the suite asserted before 'auto' existed)
// and 'cpu'/'webgpu' pass through unchanged — with no subprocess and no GPU.
vi.mock('../../../src/knowledge/webgpu-viability.ts', () => ({
  resolveEmbeddingDevice: vi.fn(async (requested: string) => (requested === 'cpu' ? 'cpu' : 'webgpu')),
}));

// initializeDawnWebGPU() lazily `import('webgpu')` and probes a real GPU. On a
// headless host with no GPU (CI ubuntu/windows) it returns false, so the embedder
// silently falls back to CPU and the GPU-lock path is never exercised — making
// these tests pass only on real-GPU machines (local dev, macOS Metal runners).
// Force it true so the WebGPU code path is deterministic everywhere; importActual
// keeps the real fallback-flag helpers (resetWebGpuFallbackFlag/markWebGpuFallback).
vi.mock('../../../src/knowledge/embedder-utils.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/knowledge/embedder-utils.ts')>();
  return { ...actual, initializeDawnWebGPU: vi.fn(async () => true) };
});

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

  it('initializes and embeds correctly without a stateManager (no GPU-lock path)', async () => {
    const e = new Embedder({ model: 'test-model', device: 'webgpu' });
    await e.initialize();
    expect(e.isInitialized()).toBe(true);

    const single = await e.embed('hello');
    expect(single).toBeInstanceOf(Float32Array);
    expect(single.length).toBe(384);

    const many = await e.embedMany(['a', 'b']);
    expect(many).toHaveLength(2);
    expect(many[0]).toBeInstanceOf(Float32Array);
    expect(many[0]!.length).toBe(384);
  });
});

describe('cache-aware initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to defaults before each test
    mockEnv.allowRemoteModels = true;
    mockEnv.cacheDir = '/fake/cache';
    // Default: model is fully cached (graph file present, no partial artifacts, no empty weights).
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue(['model.onnx', 'config.json']);
    mockStat.mockResolvedValue({ size: 1024 });
    mockRm.mockResolvedValue(undefined);
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

  it('treats a cache with a partial-download artifact as NOT cached', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    let allowRemoteAtCallTime: boolean | undefined;

    // model.onnx exists (access resolves) but an interrupted weights download left a partial
    // artifact in the dir — isModelCached must report not-cached so the model is re-fetched.
    mockReaddir.mockResolvedValueOnce(['model.onnx', 'model.onnx_data.incomplete']);

    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      allowRemoteAtCallTime = mockEnv.allowRemoteModels;
      return mockPipelineFn;
    });

    const embedder = new Embedder({ model: 'test-model' });
    await embedder.initialize();

    expect(allowRemoteAtCallTime).toBe(true);
  });

  it('purges a corrupt cache and re-downloads once when the load deserialize-fails', async () => {
    const { pipeline } = await import('@huggingface/transformers');

    // First load (from the "complete" cache) fails with a corruption error; the embedder must
    // purge the cache (rm) and re-download exactly once, which then succeeds.
    (vi.mocked(pipeline) as any)
      .mockRejectedValueOnce(new Error('Deserialize tensor onnx::MatMul failed. file_length 36229843 out of bounds'))
      .mockImplementationOnce(async () => mockPipelineFn);

    const embedder = new Embedder({ model: 'test-model' });
    await embedder.initialize();

    expect(mockRm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(2);
  });

  it('does NOT purge the cache on a transient/non-corruption load error', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('network unreachable'));

    const embedder = new Embedder({ model: 'test-model' });
    await expect(embedder.initialize()).rejects.toThrow('network unreachable');

    expect(mockRm).not.toHaveBeenCalled();
  });

  it('does NOT purge the cache on ONNX Runtime\'s GENERIC load-failure wrappers (OOM / opset mismatch)', async () => {
    // ort wraps essentially every session-creation failure in "Load model from <uri> failed: <ex>"
    // and "Failed to load model with error: <ex>" — including a transient CPU OOM (bad_alloc) and
    // an opset/op-registration mismatch on a perfectly good cache. Matching these would purge and
    // (offline) permanently destroy a valid model, so isCorruptModelError must NOT classify them.
    const generic = [
      'Load model from /home/u/.cache/pi-research/models/m/onnx/model.onnx failed: bad_alloc',
      'Failed to load model with error: Fatal error: com.microsoft:GroupQueryAttention(1) is not a registered function/op',
      'Node (/Reshape) Op (Reshape) output shape index out of bounds',
    ];
    for (const message of generic) {
      vi.clearAllMocks();
      mockAccess.mockResolvedValue(undefined);
      const { pipeline } = await import('@huggingface/transformers');
      vi.mocked(pipeline).mockRejectedValueOnce(new Error(message));

      const embedder = new Embedder({ model: 'test-model' });
      await expect(embedder.initialize()).rejects.toThrow(message);
      expect(mockRm).not.toHaveBeenCalled();
    }
  });
});

describe('input truncation (OOM guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('truncates over-long input to maxTokens*charsPerToken chars before embedding, and records a metric', async () => {
    const incSpy = vi.spyOn(metrics, 'increment');
    // cap = maxTokens(10) * charsPerToken(2) = 20 chars
    const e = new Embedder({ model: 'trunc-model', maxTokens: 10, charsPerToken: 2 });
    await e.initialize();
    mockPipelineFn.mockClear();
    incSpy.mockClear();

    await e.embed('x'.repeat(100));

    // The pipeline must receive the truncated input, not the full 100 chars.
    const passedInput = mockPipelineFn.mock.calls[0]![0] as string;
    expect(passedInput).toHaveLength(20);
    expect(passedInput).toBe('x'.repeat(20));
    // The otherwise-silent truncation is surfaced as a metric.
    expect(incSpy).toHaveBeenCalledWith('embedder_truncations_total', 1, { model: 'trunc-model' });
  });

  it('does NOT truncate or record a metric when input fits within the cap', async () => {
    const incSpy = vi.spyOn(metrics, 'increment');
    const e = new Embedder({ model: 'trunc-model', maxTokens: 10, charsPerToken: 2 });
    await e.initialize();
    mockPipelineFn.mockClear();
    incSpy.mockClear();

    await e.embed('short');

    expect(mockPipelineFn.mock.calls[0]![0]).toBe('short');
    expect(incSpy).not.toHaveBeenCalledWith('embedder_truncations_total', expect.anything(), expect.anything());
  });

  it('truncates each oversized document independently in embedMany', async () => {
    const e = new Embedder({ model: 'trunc-model', maxTokens: 10, charsPerToken: 2 }); // cap 20
    await e.initialize();
    mockPipelineFn.mockClear();

    await e.embedMany(['y'.repeat(50), 'ok']);

    const batchArg = mockPipelineFn.mock.calls[0]![0] as string[];
    expect(batchArg[0]).toHaveLength(20);
    expect(batchArg[0]).toBe('y'.repeat(20));
    expect(batchArg[1]).toBe('ok'); // untouched — already within the cap
  });

  it('backs off one unit instead of splitting a surrogate pair at the truncation boundary', async () => {
    const e = new Embedder({ model: 'trunc-model', maxTokens: 10, charsPerToken: 2 }); // cap 20
    await e.initialize();
    mockPipelineFn.mockClear();

    // An astral character (2 UTF-16 code units) straddles the raw index-20 cut:
    // its high surrogate lands at index 19 (kept), low surrogate at index 20
    // (dropped) — a naive slice(0, 20) would emit a lone high surrogate.
    const text = `${'x'.repeat(19)}\u{1F600}${'y'.repeat(79)}`;
    await e.embed(text);

    const passedInput = mockPipelineFn.mock.calls[0]![0] as string;
    const lastUnit = passedInput.charCodeAt(passedInput.length - 1);
    expect(lastUnit < 0xd800 || lastUnit > 0xdbff).toBe(true); // never ends on a lone high surrogate
    expect(passedInput).toBe('x'.repeat(19)); // backed off past the whole pair, not just one unit short
  });

  it('truncates AFTER the query prefix is prepended (the prefix counts toward the cap)', async () => {
    const incSpy = vi.spyOn(metrics, 'increment');
    const e = new Embedder({ model: 'trunc-model', maxTokens: 10, charsPerToken: 2, queryPrefix: 'PFX:' });
    await e.initialize();
    mockPipelineFn.mockClear();
    incSpy.mockClear();

    await e.embed('z'.repeat(100));

    const passedInput = mockPipelineFn.mock.calls[0]![0] as string;
    expect(passedInput).toHaveLength(20);
    expect(passedInput.startsWith('PFX:')).toBe(true); // prefix retained, tail dropped
    expect(incSpy).toHaveBeenCalledWith('embedder_truncations_total', 1, { model: 'trunc-model' });
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

