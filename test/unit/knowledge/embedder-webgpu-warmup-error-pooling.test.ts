/**
 * handleWebGPUWarmupError's CPU-fallback re-warmup used to hardcode 'mean'
 * pooling instead of the model's actually configured poolingMode, unlike
 * every other warmupPipeline call site in the embedder (the real embed()
 * path and the load-error fallback both use `this.poolingMode`). Models like
 * bge-m3 ('cls') or Qwen3-Embedding ('last_token') would warm up with the
 * wrong pooling mode on this one fallback path — inconsequential for the
 * dummy warmup inference itself, but a genuine inconsistency worth pinning
 * down so it can't spread.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    runCapturingStderr: async (task: () => Promise<unknown>) => task(),
    log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

const warmupCalls: Array<Record<string, unknown>> = [];
const mockPipeline = Object.assign(
  vi.fn(async (_text: string, opts: Record<string, unknown>) => {
    warmupCalls.push(opts);
    return { dims: [1, 4], data: new Float32Array(4) };
  }),
  { dispose: vi.fn() }
);

vi.mock('../../../src/knowledge/transformers-loader.ts', () => ({
  getTransformers: vi.fn(async () => ({
    pipeline: vi.fn(async () => mockPipeline),
  })),
}));

import { handleWebGPUWarmupError } from '../../../src/knowledge/embedder-init.ts';

describe('handleWebGPUWarmupError — CPU-fallback re-warmup pooling mode', () => {
  beforeEach(() => {
    warmupCalls.length = 0;
    vi.clearAllMocks();
  });

  it.each([
    ['cls' as const],
    ['last_token' as const],
    ['mean' as const],
  ])('re-warms the CPU fallback with the model\'s actual poolingMode (%s), not a hardcoded default', async (poolingMode) => {
    const result = await handleWebGPUWarmupError(
      new Error('WebGPU device lost'),
      null,
      null,
      false,
      'some/model',
      30_000,
      true,
      poolingMode
    );

    expect(result.success).toBe(true);
    expect(warmupCalls).toHaveLength(1);
    expect(warmupCalls[0]!['pooling']).toBe(poolingMode);
  });

  it('defaults to mean pooling when the caller passes none (back-compat)', async () => {
    const result = await handleWebGPUWarmupError(
      new Error('WebGPU device lost'),
      null,
      null,
      false,
      'some/model',
      30_000,
      true
    );

    expect(result.success).toBe(true);
    expect(warmupCalls[0]!['pooling']).toBe('mean');
  });
});
