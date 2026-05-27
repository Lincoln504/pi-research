/**
 * Embedder Utilities
 *
 * Utility functions for the embedder module
 */

import { env as hfEnv } from '@huggingface/transformers';
import path from 'node:path';
import * as os from 'node:os';

import type { HFEnv } from './embedder-types.ts';
import { logger } from '../logger.ts';
import { withTimeout as retryWithTimeout } from '../web-research/retry-utils.ts';

/**
 * Timeout wrapper for promises (re-exports from retry-utils.ts)
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  // Normalize via Promise.resolve() to handle HuggingFace pipeline thenables
  // that are not standard Promises (retry-utils calls .then() directly).
  return retryWithTimeout(Promise.resolve(promise), timeoutMs, errorMessage, undefined);
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

// Global embedder reference for process-exit cleanup.
// Stores the active Embedder instance so the beforeExit handler can call dispose()
// before the Node.js process tears down the ONNX C++ runtime's global logger.
// Without this, an active InferenceSession accessed after C++ teardown triggers
// `terminate called after throwing OnnxRuntimeException: Attempt to use DefaultLogger
// but none has been registered` — an uncatchable crash via std::terminate.
let globalEmbedderRef: { dispose: () => Promise<void> } | null = null;

/**
 * Register an Embedder instance for process-exit cleanup.
 * Called by Embedder constructor.
 */
export function registerGlobalEmbedder(e: { dispose: () => Promise<void> }): void {
  globalEmbedderRef = e;
}

/**
 * Unregister the global Embedder reference.
 * Called by Embedder.dispose() once cleanup is complete.
 */
export function unregisterGlobalEmbedder(): void {
  globalEmbedderRef = null;
}

// Belt-and-suspenders fallback for graceful (no-signal) exits.
// Node re-fires 'beforeExit' as long as async work keeps the event loop alive,
// so awaiting dispose() inside this handler works correctly for clean exits.
//
// For SIGTERM / SIGINT / process.exit() paths the primary disposal route is the
// service container (KnowledgeStoreService.dispose → Embedder.dispose), which is
// already properly awaited by the shutdown manager in those flows.
process.on('beforeExit', async () => {
  if (globalEmbedderRef) {
    const ref = globalEmbedderRef;
    globalEmbedderRef = null; // Clear first to prevent re-entry
    try { await ref.dispose(); } catch { /* ignore */ }
  }
});

/**
 * Initialize the ONNX environment
 */
export function initializeONNXEnv(): void {
  hfEnv.cacheDir = getModelCacheDir();

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