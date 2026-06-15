import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Embedder, resetWebGpuFallbackFlag } from '../../../src/knowledge/embedder.ts';

// vi.hoisted ensures these are available when vi.mock factories run (which are hoisted to the top)
const { mockPipelineFn, mockEnv, mockAccess } = vi.hoisted(() => {
  const mockPipelineFn = vi.fn(async (text: string | string[], _options: any) => {
    const dimensions = 384;
    if (Array.isArray(text)) {
      const data = new Float32Array(text.length * dimensions);
      for (let i = 0; i < text.length; i++) {
        data[i * dimensions] = i + 1;
      }
      return { data, dims: [text.length, dimensions] };
    }
    return { data: new Float32Array(dimensions).fill(1), dims: [1, dimensions] };
  });

  const mockEnv = {
    allowRemoteModels: true,
    cacheDir: '/fake/cache',
    allowLocalModels: true,
    useFSCache: true,
  };

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

describe('Embedder WebGPU Fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWebGpuFallbackFlag();
  });

  it('should skip WebGPU if fallback flag is set', async () => {
    const { pipeline } = await import('@huggingface/transformers');

    // The fallback flag is process-global; it gets set as a side effect of
    // embedder1's WebGPU failure below, then exercised by embedder2.
    const embedder1 = new Embedder({ model: 'test-model', device: 'webgpu' });
    
    // Simulate WebGPU error during pipeline load
    const webGpuError = new Error('WebGPU validation failed: invalid buffer binding');
    vi.mocked(pipeline).mockRejectedValueOnce(webGpuError);
    
    // Second call should succeed with CPU
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return mockPipelineFn;
    });

    await expect(embedder1.initialize()).resolves.not.toThrow();
    expect(embedder1.getDevice()).toBe('cpu');
    
    // Create a new embedder - it should skip WebGPU and use CPU directly
    const embedder2 = new Embedder({ model: 'test-model', device: 'webgpu' });
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return mockPipelineFn;
    });
    
    await embedder2.initialize();
    expect(embedder2.getDevice()).toBe('cpu');
    expect(embedder2.getOriginalDevice()).toBe('webgpu');
  });

  it('should reset fallback flag on successful initialization', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    
    // Set the fallback flag by simulating a WebGPU error
    const embedder1 = new Embedder({ model: 'test-model', device: 'webgpu' });
    const webGpuError = new Error('WebGPU validation failed: invalid buffer binding');
    vi.mocked(pipeline).mockRejectedValueOnce(webGpuError);
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return mockPipelineFn;
    });
    
    await embedder1.initialize();
    expect(embedder1.getDevice()).toBe('cpu');
    
    // Reset the flag manually (simulating successful init in knowledge/index.ts)
    resetWebGpuFallbackFlag();
    
    // New embedder should try WebGPU again
    const embedder2 = new Embedder({ model: 'test-model', device: 'webgpu' });
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return mockPipelineFn;
    });
    
    await embedder2.initialize();
    expect(embedder2.getDevice()).toBe('webgpu');
  });

  it('should handle WebGPU OOM during pipeline load', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    
    const embedder = new Embedder({ model: 'test-model', device: 'webgpu' });
    
    // First call fails with OOM
    const oomError = new Error('OUT_OF_DEVICE_MEMORY');
    vi.mocked(pipeline).mockRejectedValueOnce(oomError);
    
    // Second call succeeds with CPU
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return mockPipelineFn;
    });

    await expect(embedder.initialize()).resolves.not.toThrow();
    expect(embedder.getDevice()).toBe('cpu');
  });

  it('should handle WebGPU validation error during warmup', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    
    const embedder = new Embedder({ model: 'test-model', device: 'webgpu' });
    
    // Pipeline load succeeds
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return mockPipelineFn;
    });
    
    // Warmup fails with validation error
    const validationError = new Error('WebGPU validation failed: bindGroup size mismatch');
    vi.mocked(mockPipelineFn).mockRejectedValueOnce(validationError);
    
    // CPU fallback pipeline load succeeds
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      // Return a fresh mock that works
      return vi.fn(async (text: string | string[], _options: any) => {
        const dimensions = 384;
        if (Array.isArray(text)) {
          const data = new Float32Array(text.length * dimensions);
          for (let i = 0; i < text.length; i++) {
            data[i * dimensions] = i + 1;
          }
          return { data, dims: [text.length, dimensions] };
        }
        return { data: new Float32Array(dimensions).fill(2), dims: [1, dimensions] };
      });
    });
    
    // CPU warmup succeeds
    // This will be called by the fresh mock we just returned
    
    await expect(embedder.initialize()).resolves.not.toThrow();
    expect(embedder.getDevice()).toBe('cpu');
  });

  it('should detect decoder model via past_key_values error', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    
    const embedder = new Embedder({ model: 'Qwen3-Embedding-0.6B', device: 'webgpu' });
    
    // Pipeline load succeeds
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return mockPipelineFn;
    });
    
    // Warmup fails with past_key_values error (decoder model indicator)
    const decoderError = new Error('past_key_values tensor not compatible with WebGPU buffer binding');
    vi.mocked(mockPipelineFn).mockRejectedValueOnce(decoderError);
    
    // CPU fallback pipeline load succeeds
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return vi.fn(async (text: string | string[], _options: any) => {
        return { data: new Float32Array(384).fill(3), dims: [1, 384] };
      });
    });
    
    await expect(embedder.initialize()).resolves.not.toThrow();
    expect(embedder.getDevice()).toBe('cpu');
  });

  it('should handle CPU fallback load failure', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    
    const embedder = new Embedder({ model: 'test-model', device: 'webgpu' });
    
    // WebGPU load fails
    const webGpuError = new Error('WebGPU validation failed');
    vi.mocked(pipeline).mockRejectedValueOnce(webGpuError);
    
    // CPU load also fails
    const cpuError = new Error('CPU OOM');
    vi.mocked(pipeline).mockRejectedValueOnce(cpuError);
    
    await expect(embedder.initialize()).rejects.toThrow(/CPU fallback load also failed/);
  });

  it('should handle CPU fallback warmup failure', async () => {
    const { pipeline } = await import('@huggingface/transformers');
    
    const embedder = new Embedder({ model: 'test-model', device: 'webgpu' });
    
    // Pipeline load succeeds
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return mockPipelineFn;
    });
    
    // Warmup fails with WebGPU error
    const webGpuError = new Error('WebGPU validation failed');
    vi.mocked(mockPipelineFn).mockRejectedValueOnce(webGpuError);
    
    // CPU fallback pipeline load succeeds
    (vi.mocked(pipeline) as any).mockImplementationOnce(async () => {
      return vi.fn(async () => {
        throw new Error('CPU warmup failed');
      });
    });
    
    await expect(embedder.initialize()).rejects.toThrow(/CPU fallback warmup also failed/);
  });
});