import { describe, it, expect, vi } from 'vitest';
import { Embedder } from '../../../src/knowledge/embedder.ts';
import { pipeline } from '@huggingface/transformers';

// Mock dependencies
vi.mock('@huggingface/transformers', () => {
  return {
    env: { cacheDir: '' },
    pipeline: vi.fn().mockImplementation(async () => {
      // Simulate loading time
      await new Promise(resolve => setTimeout(resolve, 50));
      return vi.fn().mockResolvedValue({
        dims: [384],
        data: new Float32Array(384).fill(0.1)
      });
    })
  };
});

describe('Embedder Concurrency & Lifecycle', () => {
  it('should prevent double-dispose race condition', async () => {
    const embedder = new Embedder({
      model: 'test-model',
      device: 'cpu'
    });

    await embedder.initialize();

    // Call dispose concurrently multiple times
    const dispose1 = embedder.dispose();
    const dispose2 = embedder.dispose();
    const dispose3 = embedder.dispose();

    await Promise.all([dispose1, dispose2, dispose3]);

    expect((embedder as any).state).toBe('idle');
  });

  it('should handle dispose called during initialization', async () => {
    const embedder = new Embedder({
      model: 'test-model',
      device: 'cpu'
    });

    // Start initialization but don't await it
    const initPromise = embedder.initialize();
    
    // Immediately call dispose while it's still initializing
    const disposePromise = embedder.dispose();

    await Promise.all([initPromise.catch(() => {}), disposePromise]);

    expect((embedder as any).state).toBe('idle');
    expect((embedder as any).pipeline).toBeNull();
  });

  it('activeEmbeddings counter increments during embed and decrements on completion', async () => {
    const embedder = new Embedder({ model: 'test-model', device: 'cpu' });
    await embedder.initialize();
    expect((embedder as any).activeEmbeddings).toBe(0);

    // Block the embed so we can inspect activeEmbeddings while it's in flight
    let resolveEmbed!: (v: any) => void;
    const blocked = new Promise(resolve => { resolveEmbed = resolve; });
    const mockPipeline = (embedder as any).pipeline as ReturnType<typeof vi.fn>;
    mockPipeline.mockImplementationOnce(async () => {
      await blocked;
      return { dims: [384], data: new Float32Array(384).fill(0.1) };
    });

    const embedPromise = embedder.embed('hello world');
    // Yield to let the embed start processing
    await Promise.resolve();
    await Promise.resolve();

    // While blocked: counter must be at least 1 (FIX #17 guard)
    expect((embedder as any).activeEmbeddings).toBeGreaterThanOrEqual(1);

    // Complete the embed
    resolveEmbed({ dims: [384], data: new Float32Array(384).fill(0.1) });
    await embedPromise;

    // After completion: counter must return to 0
    expect((embedder as any).activeEmbeddings).toBe(0);

    await embedder.dispose();
  });

  it('collapses concurrent initialize() calls into a single pipeline construction', async () => {
    const embedder = new Embedder({
      model: 'test-model',
      device: 'cpu'
    });
    vi.mocked(pipeline).mockClear();

    await Promise.all([
      embedder.initialize(),
      embedder.initialize(),
      embedder.initialize(),
    ]);

    expect((embedder as any).state).toBe('ready');
    // The shared initializingPromise must collapse N concurrent calls into one
    // underlying pipeline construction — this is the property the test asserts.
    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(1);

    // Re-initializing an already-ready embedder must not rebuild the pipeline.
    await embedder.initialize();
    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(1);

    await embedder.dispose();
  });
});
