/**
 * Embedder Utilities
 *
 * Utility functions for the embedder module
 */

import { env as hfEnv } from '@huggingface/transformers';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as os from 'node:os';

import type { HFEnv } from './embedder-types.ts';
import { logger } from '../logger.ts';

/**
 * Timeout wrapper for promises
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      if (timer.unref) timer.unref(); 
    }),
  ]);
}

/**
 * Get the HuggingFace env object
 */
export function getHFEnv() {
  return hfEnv;
}

/**
 * Get the model cache directory
 */
export function getModelCacheDir(): string {
  const xdgCache = process.env['XDG_CACHE_HOME'];
  const base = xdgCache ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'pi-research', 'models');
}

// Module-level flag to track if any embedder instance has fallen back to CPU due to WebGPU errors
// This prevents retrying with WebGPU after it's been proven to fail
let hasWebGpuFallbackOccurred = false;

/**
 * Reset the WebGPU fallback flag (useful for testing or if WebGPU becomes available)
 */
export function resetWebGpuFallbackFlag(): void {
  hasWebGpuFallbackOccurred = false;
}

/**
 * Check if WebGPU fallback has occurred
 */
export function hasWebGpuFallback(): boolean {
  return hasWebGpuFallbackOccurred;
}

/**
 * Mark that WebGPU fallback has occurred
 */
export function markWebGpuFallback(): void {
  hasWebGpuFallbackOccurred = true;
}

/**
 * Initialize the ONNX environment
 */
export function initializeONNXEnv(): void {
  hfEnv.cacheDir = getModelCacheDir();

  try {
    const _nodeRequire = createRequire(import.meta.url);
    const { env: ortEnv } = _nodeRequire('onnxruntime-common') as { env: { logLevel?: string } };
    if (ortEnv) ortEnv.logLevel = 'error';
  } catch { /* ignore */ }

  try {
    const envObj = hfEnv as unknown as HFEnv;
    if (envObj.onnx) {
      envObj.onnx.logLevel = 'error';
      envObj.onnx.debug = false;
    }
  } catch (e) {
    logger.debug('[embedder] Failed to set ONNX logLevel:', e);
  }
}

// Initialize ONNX environment on module load
initializeONNXEnv();