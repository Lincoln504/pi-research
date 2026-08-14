/**
 * Dawn WebGPU adapter probe — stderr capture
 *
 * onnxruntime-node's bundled Dawn prints its limit-clamping notices
 * ("maxDynamicUniformBuffersPerPipelineLayout artificially reduced from 1000000
 * to 16 …") from native code straight to FD 2 as soon as a WebGPU instance is
 * created. loadPipelineWithTimeout already builds the pipeline inside
 * logger.runCapturingStderr for exactly that reason; the adapter probe in
 * initializeDawnWebGPU is the OTHER native entry point and was missing it, so a
 * plain `pi-research knowledge …` run printed those lines to the user's terminal
 * — and, for the agent skill, into the stderr an agent is told to read for
 * errors.
 *
 * Asserting on real FD-2 output would need a subprocess and a real GPU. Instead
 * this pins the structural property that produces the behavior: the webgpu
 * create()/requestAdapter() calls must happen INSIDE the capture scope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let insideCapture = false;
const createdInsideCapture: boolean[] = [];
const requestedInsideCapture: boolean[] = [];

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    async runCapturingStderr<T>(task: () => Promise<T>): Promise<T> {
      insideCapture = true;
      try {
        return await task();
      } finally {
        insideCapture = false;
      }
    },
  },
}));

vi.mock('webgpu', () => ({
  globals: {},
  create: (_args: unknown[]) => {
    createdInsideCapture.push(insideCapture);
    return {
      requestAdapter: async () => {
        requestedInsideCapture.push(insideCapture);
        // A hardware-looking adapter so the function takes its success path.
        return { info: { vendor: 'nvidia', device: 'rtx', architecture: 'ada' } };
      },
    };
  },
}));

describe('initializeDawnWebGPU — native stderr containment', () => {
  beforeEach(() => {
    insideCapture = false;
    createdInsideCapture.length = 0;
    requestedInsideCapture.length = 0;
    vi.resetModules();
  });

  it('creates the WebGPU instance and requests the adapter inside the stderr capture', async () => {
    const { initializeDawnWebGPU } = await import('../../../src/knowledge/embedder-utils.ts');

    await expect(initializeDawnWebGPU()).resolves.toBe(true);

    expect(createdInsideCapture).toEqual([true]);
    expect(requestedInsideCapture).toEqual([true]);
    // The scope must not leak past the probe.
    expect(insideCapture).toBe(false);
  });
});
