/**
 * warmupPipeline must run inside the stderr capture.
 *
 * Warmup is the FIRST inference, so it is where a GPU that cannot actually serve the
 * model fails. transformers.js reports that by printing
 *
 *   An error occurred during model execution: "Error: WebGPU validation failed. ..."
 *   Inputs given to model: { input_ids: { ... dims: [1, 4] ... } }
 *
 * to console.error before rejecting. Every other pipeline invocation in
 * embedder-init.ts (both loads) and the real inference in embedder.ts already run
 * inside logger.runCapturingStderr; this one did not, so that dump went straight to
 * the user's terminal — for a failure that is caught two frames up, falls back to
 * CPU, and lets the run finish normally.
 *
 * Observed on 2026-08-16: eighteen vkAllocateMemory / VK_ERROR_OUT_OF_DEVICE_MEMORY
 * lines were captured into the log (they came from the load, which is wrapped), the
 * warmup dump was not, and the user saw only the uncaptured half — the symptom,
 * without the cause. The `[1, 4]` in that dump is the four tokens of the literal
 * string "warmup", which is what identifies this call as the source.
 *
 * Wrapping the CALLER is not sufficient and that is why the wrap belongs here: the
 * load's capture has already ended by the time warmup runs, and the embedding
 * server's captureStdio covers only the first initialize() — not the re-initialize
 * that follows every idle-timeout GPU teardown, which is the case actually observed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** True while the fake runCapturingStderr is on the stack. */
let insideCapture = false;
const runCapturingStderr = vi.fn(async (task: () => Promise<unknown>) => {
  insideCapture = true;
  try {
    return await task();
  } finally {
    insideCapture = false;
  }
});

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    runCapturingStderr: (task: () => Promise<unknown>) => runCapturingStderr(task),
    log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

import { warmupPipeline } from '../../../src/knowledge/embedder-init.ts';

describe('warmupPipeline — native and console output must be captured', () => {
  beforeEach(() => {
    insideCapture = false;
    vi.clearAllMocks();
  });

  it('invokes the pipeline while the capture is active, not merely at some point', async () => {
    let captureActiveAtInvocation: boolean | null = null;
    const pipeline = vi.fn(async () => {
      // Recorded at the moment the pipeline runs — a wrapper that is called but does
      // not enclose the invocation would leave this false.
      captureActiveAtInvocation = insideCapture;
      return { data: new Float32Array(384), dims: [1, 384] };
    });

    const result = await warmupPipeline(pipeline as any, 'mean', true);

    expect(result.success).toBe(true);
    expect(captureActiveAtInvocation).toBe(true);
  });

  it('keeps the capture in place while the pipeline REJECTS — the case that prints', async () => {
    // The dump is emitted on the failure path, so a capture that only covers the happy
    // path covers nothing that matters.
    let captureActiveAtThrow: boolean | null = null;
    const pipeline = vi.fn(async () => {
      captureActiveAtThrow = insideCapture;
      throw new Error(
        'WebGPU validation failed. [Invalid Buffer (unlabeled)] is invalid.\n' +
        ' - While calling [Device].CreateBindGroup([BindGroupDescriptor "Slice"]).',
      );
    });

    const result = await warmupPipeline(pipeline as any, 'mean', true);

    // Still reported as a caught failure, not a throw — the caller's fallback depends on it.
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Invalid Buffer/);
    expect(captureActiveAtThrow).toBe(true);
  });

  it('warms up on the literal string "warmup"', async () => {
    // Pinned because it is what ties a terminal dump back to this call: "warmup"
    // tokenizes to four tokens, which is the dims: [1, 4] seen in the wild.
    const pipeline = vi.fn(async () => ({ data: new Float32Array(384), dims: [1, 384] }));

    await warmupPipeline(pipeline as any, 'cls', false);

    expect(pipeline).toHaveBeenCalledWith('warmup', expect.objectContaining({ pooling: 'cls' }));
  });

  it('leaves the capture unwound after it returns', async () => {
    const pipeline = vi.fn(async () => ({ data: new Float32Array(384), dims: [1, 384] }));
    await warmupPipeline(pipeline as any, 'mean', true);
    expect(insideCapture).toBe(false);
  });
});
