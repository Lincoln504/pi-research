/**
 * Embedder Utilities
 *
 * Utility functions for the embedder module
 */

import { env as hfEnv } from '@huggingface/transformers';
import path from 'node:path';
import * as os from 'node:os';

import { HFEnv } from '../core/interfaces/knowledge-interfaces.ts';
import { logger } from '../logger.ts';
import { withTimeout as retryWithTimeout } from '../web-research/retry-utils.ts';

import { shutdownManager } from '../utils/shutdown-manager.ts';

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
  dawnInitialized = false; // Allow Dawn re-initialization after reset
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

// Module-level flags to track shutdown state
let isProcessExiting = false;

/**
 * Check if the process is in a fatal shutdown state (exiting)
 */
export function isShuttingDown(): boolean {
  return isProcessExiting;
}

// Global embedder reference for process-exit cleanup.
let globalEmbedderRef: { dispose: () => Promise<void> } | null = null;

/**
 * Register an Embedder instance for process-exit cleanup.
 * Called by Embedder constructor.
 */
export function registerGlobalEmbedder(e: { dispose: () => Promise<void> }): void {
  globalEmbedderRef = e;
  
  // Register with shutdown manager for graceful extension shutdown.
  // Note: we DO NOT set isProcessExiting here because shutdownManager
  // tasks run during reloads too, and we still want to dispose there.
  shutdownManager.register(async () => {
    if (globalEmbedderRef === e) {
      const ref = globalEmbedderRef;
      globalEmbedderRef = null;
      try { await ref.dispose(); } catch { /* ignore */ }
    }
  });
}

/**
 * Unregister the global Embedder reference.
 * Called by Embedder.dispose() once cleanup is complete.
 */
export function unregisterGlobalEmbedder(): void {
  globalEmbedderRef = null;
}

// Exit handler for process-level teardown (SIGTERM, SIGINT, beforeExit).
// During these events, the native ONNX environment is often in a race 
// with the JS event loop. Calling dispose() here is risky and redundant.
const exitHandler = async () => {
  isProcessExiting = true;
  if (globalEmbedderRef) {
    globalEmbedderRef = null; 
    // We intentionally DO NOT call dispose here during process exit 
    // to prevent the OnnxRuntimeException: DefaultLogger crash.
    // The OS will reclaim the memory.
    logger.debug('[embedder] Process exiting, skipping native disposal to prevent crash');
  }
};

// Register via shutdownManager only — it internally calls process.on()
shutdownManager.registerEventListener(process, 'beforeExit', exitHandler);

/**
 * Initialize the ONNX environment
 */
let onnxInitialized = false;
export function initializeONNXEnv(): void {
  if (onnxInitialized) return;
  
  hfEnv.cacheDir = getModelCacheDir();

  try {
    const envObj = hfEnv as unknown as HFEnv;
    if (envObj.backends?.onnx) {
      envObj.backends.onnx.logLevel = 'error';
    }
    // Fallback for older transformers.js versions if any
    if ((envObj as any).onnx) {
      (envObj as any).onnx.logLevel = 'error';
    }
  } catch (e) {
    logger.debug('[embedder] Failed to set ONNX logLevel:', e);
  }
  
  onnxInitialized = true;
}

// REMOVED: initializeONNXEnv() is now called lazily inside Embedder.initialize()
// to prevent issues during module load / extension reload.

let dawnInitialized = false;


/**
 * Verify WebGPU availability for the current Node.js environment.
 *
 * onnxruntime-node@1.23+ bundles Dawn natively as a WebGPU execution provider
 * (verified via listSupportedBackends: { name: 'webgpu', bundled: true }). On Linux
 * this uses the Vulkan backend, which is available on virtually all modern GPUs
 * including integrated graphics (Intel/AMD/NVIDIA all ship Vulkan-capable drivers).
 *
 * No additional packages or navigator.gpu polyfills are needed — onnxruntime-node's
 * WebGPU EP is fully self-contained. This function logs GPU info if the optional
 * 'webgpu' package is installed, then signals that WebGPU can proceed.
 */
export async function initializeDawnWebGPU(): Promise<boolean> {
  if (dawnInitialized) return true;

  try {
    // Optional: log GPU adapter info if the 'webgpu' npm package is available.
    // This package exposes the JS-side WebGPU API (not needed by onnxruntime-node
    // which uses its own bundled Dawn, but useful for diagnostics).
    // @ts-ignore — optional dependency
    const { create, globals } = await import('webgpu');
    Object.assign(globalThis, globals);
    // Use Object.defineProperty — Node.js defines navigator as a configurable getter
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: create([]) },
      writable: true,
      configurable: true,
    });
    const adapter = await (globalThis as any).navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter?.info) {
      logger.info(`[embedder] WebGPU adapter: ${adapter.info.vendor} ${adapter.info.device}`);
    }
  } catch {
    // 'webgpu' package not installed — onnxruntime-node's bundled Dawn EP
    // handles WebGPU without it; this branch is diagnostic only.
  }

  dawnInitialized = true;
  logger.info('[embedder] WebGPU ready via onnxruntime-node bundled Dawn (Vulkan on Linux)');
  return true;
}