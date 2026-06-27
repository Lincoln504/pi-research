/**
 * Embedder Utilities
 *
 * Utility functions for the embedder module
 */

import path from 'node:path';
import * as os from 'node:os';

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
 * Detect whether an error indicates the native ML/vector stack is unavailable on
 * this platform — i.e. a prebuilt native binding is genuinely missing, not a
 * transient/logic failure. This is the case on platforms the upstream packages
 * do not ship binaries for (e.g. Intel macOS / darwin-x64, where onnxruntime-node
 * has no prebuilt and @lancedb/lancedb's optional native binding is absent).
 *
 * Such an error is a permanent capability gap, not a fault: callers should treat
 * the knowledge store as DISABLED (degrade gracefully) rather than UNHEALTHY, so
 * research still runs without the optional embedding/vector cache.
 *
 * Pure string matching — safe to call from native-import-free modules.
 * Matched signatures (observed in the wild):
 *   - onnxruntime-node:  "Cannot find module '.../bin/napi-v6/darwin/x64/onnxruntime_binding.node'"
 *   - @lancedb/lancedb:  "Cannot find native binding. npm has a bug related to optional dependencies"
 *   - jiti-masked module-eval failure of the above surfaces as:
 *                        "KnowledgeStoreService is not a constructor"
 */
export function isNativeStackUnavailableError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? `${err.message} ${err.stack ?? ''}` : String(err)).toLowerCase();
  return (
    msg.includes('cannot find native binding') ||
    msg.includes('onnxruntime_binding.node') ||
    /cannot find module '[^']*onnxruntime/.test(msg) ||
    /cannot find module '[^']*lancedb/.test(msg) ||
    msg.includes('knowledgestoreservice is not a constructor')
  );
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

// Global embedder reference for process-exit cleanup.
let globalEmbedderRef: { dispose: () => Promise<void> } | null = null;

/**
 * Register an Embedder instance for process-exit cleanup.
 * Called by Embedder constructor.
 */
export function registerGlobalEmbedder(e: { dispose: () => Promise<void> }): void {
  globalEmbedderRef = e;
  
  // Register with shutdown manager for graceful extension shutdown.
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

// Last-resort safety net: during beforeExit the C++ ORT LoggingManager is still
// alive, so async disposal is safe. session_shutdown should have already disposed
// the embedder; this only fires if somehow it didn't (e.g. a crash path).
// We do NOT register on 'exit' — by then C++ statics may already be destroyed.
const beforeExitHandler = () => {
  if (globalEmbedderRef) {
    const ref = globalEmbedderRef;
    globalEmbedderRef = null;
    // Fire async dispose — beforeExit allows scheduling async tasks.
    ref.dispose().catch(() => {
      // Silently ignore — process is shutting down, OS reclaims memory.
    });
  }
};

/**
 * Register the beforeExit safety-net handler.
 * Must be called during each extension activation because deactivate()
 * strips all registered event listeners. Module-level registration is
 * insufficient — after a Pi reload the handler would be missing.
 */
export function registerBeforeExitSafetyNet(): void {
  shutdownManager.registerEventListener(process, 'beforeExit', beforeExitHandler);
}

// ONNX / transformers.js env setup (getHFEnv, initializeONNXEnv) lives in
// ./onnx-env.ts so that this utility module stays free of the native
// @huggingface/transformers import — keeping it safe to load from src/index.ts.

let dawnInitialized = false;


/**
 * Names that identify a software / paravirtual / fallback GPU adapter — i.e. one
 * on which onnxruntime-node's bundled Dawn will load but then SIGSEGV during the
 * first compute dispatch. Matched case-insensitively against adapter info fields.
 */
const SOFTWARE_ADAPTER_PATTERNS = [
  'llvmpipe',
  'lavapipe',
  'swiftshader',
  'softpipe',
  'basic render',          // "Microsoft Basic Render Driver"
  'microsoft basic',
  'software',
  'virtio',                // virtio-gpu paravirtual (VMs)
  'venus',                 // Mesa venus (virtio-gpu Vulkan)
  'llvm',
];

/**
 * Verify WebGPU availability for the current Node.js environment.
 *
 * onnxruntime-node bundles Dawn natively as its WebGPU execution provider; on
 * Linux this uses Vulkan. On hardware GPUs this works. On software/paravirtual
 * Vulkan adapters (llvmpipe/lavapipe, virtio/venus, SwiftShader, ...) Dawn LOADS
 * the pipeline but then crashes natively (SIGSEGV) on the first compute dispatch.
 *
 * This function is the in-process secondary guard for the FORCED 'webgpu' path
 * (the 'auto' path is gated earlier by an out-of-process probe). When the
 * optional 'webgpu' package is present we inspect the adapter and RETURN FALSE if
 * it is a software/fallback adapter, so the caller can downgrade to CPU before
 * any native compute runs. If the 'webgpu' package is absent we cannot inspect
 * the adapter in-process and proceed (the out-of-process probe remains the real
 * safeguard for 'auto').
 *
 * @returns true if WebGPU may proceed; false if a software/fallback adapter was
 *          detected and the caller should use CPU instead.
 */
export async function initializeDawnWebGPU(): Promise<boolean> {
  if (dawnInitialized) return true;

  try {
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

    if (!adapter) {
      logger.warn('[embedder] No WebGPU adapter available — using CPU.');
      return false;
    }

    const info = adapter.info ?? {};
    const haystack = [info.vendor, info.architecture, info.device, info.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (adapter.isFallbackAdapter === true || SOFTWARE_ADAPTER_PATTERNS.some((p) => haystack.includes(p))) {
      logger.warn(
        `[embedder] WebGPU adapter is software/paravirtual (${haystack || 'fallback'}) — Dawn would crash on compute; using CPU.`,
      );
      return false;
    }

    logger.info(`[embedder] WebGPU adapter: ${info.vendor ?? '?'} ${info.device ?? info.architecture ?? '?'}`);
  } catch {
    // 'webgpu' package not installed — cannot inspect the adapter in-process.
    // onnxruntime-node's bundled Dawn EP still works without it on real hardware;
    // for 'auto' the out-of-process probe already validated viability.
  }

  dawnInitialized = true;
  logger.info('[embedder] WebGPU ready via onnxruntime-node bundled Dawn');
  return true;
}