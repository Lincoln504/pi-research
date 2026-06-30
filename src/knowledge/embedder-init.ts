/**
 * Embedder Initialization Logic
 *
 * Handles initialization and warmup logic for the embedder
 */

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { logger } from '../logger.ts';
import type { IStateManager } from '../core/service-interfaces.ts';
import { DisposablePipeline } from '../core/interfaces/knowledge-interfaces.ts';
import { withTimeout, markWebGpuFallback } from './embedder-utils.ts';
import { getHFEnv } from './onnx-env.ts';

/**
 * Load pipeline with timeout
 */
export async function loadPipelineWithTimeout(
  model: string,
  device: string,
  timeoutMs: number,
  useCache: boolean
): Promise<{ pipeline: FeatureExtractionPipeline; errorMessage: string }> {
  const errorMessage = `Model load timed out after ${timeoutMs}ms. Check network connection or try a smaller model.`;

  // pipeline() must be created INSIDE runCapturingStderr so that the FD-level
  // stderr redirect is in place before the native ONNX/Dawn C++ code runs.
  // Creating the Promise outside means the background thread could write its
  // Dawn limit-clamping warnings before captureStdio redirects FD 2.
  const loadedPipeline = await logger.runCapturingStderr(async () => {
    const pipelinePromise = pipeline('feature-extraction', model, {
      device: device as 'webgpu' | 'cpu' | 'auto' | 'gpu' | 'wasm' | 'webnn' | 'webnn-npu' | 'webnn-gpu' | 'webnn-cpu',
      ...(useCache === false ? { use_cache: false } : {}),
      // Clamp ONNX intra-op thread pool to 2 threads per session.
      // Default (0) = one thread per physical CPU core. With multiple concurrent
      // processes each loading their own pipeline, the default spawns N_cores * N_procs
      // threads that all busy-spin simultaneously, saturating the CPU.
      // 2 threads gives adequate within-op parallelism without thrashing.
      session_options: {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      },
    });
    return await withTimeout(pipelinePromise, timeoutMs, errorMessage);
  });

  return { pipeline: loadedPipeline, errorMessage };
}

/**
 * Warmup the pipeline
 */
export async function warmupPipeline(
  pipeline: FeatureExtractionPipeline,
  poolingMode: 'mean' | 'cls' | 'last_token',
  useCache: boolean
): Promise<{ dummy: any; success: boolean; error?: Error }> {
  try {
    const dummy = await withTimeout(
      pipeline('warmup', { 
        pooling: poolingMode as any, 
        normalize: false,
        ...(useCache === false ? { use_cache: false } : {}),
      }),
      20_000,
      'Model warmup timed out after 20000ms.'
    );
    return { dummy, success: true };
  } catch (warmupErr) {
    return { dummy: null, success: false, error: warmupErr as Error };
  }
}

/**
 * Check if error is a WebGPU device error
 */
export function isWebGpuDeviceError(err: unknown): boolean {
  if (!err) return false;

  // Type-safe string extraction from error objects
  let msg: string;
  let stack: string;

  if (err instanceof Error) {
    msg = err.message ?? '';
    stack = err.stack ?? '';
  } else if (typeof err === 'object') {
    msg = String((err as Record<string, unknown>)['message'] ?? '');
    stack = String((err as Record<string, unknown>)['stack'] ?? '');
    if (!msg && !stack) {
      try { msg = JSON.stringify(err); } catch { msg = String(err); }
    }
  } else {
    msg = String(err);
    stack = '';
  }

  const combined = (msg + ' ' + stack).toLowerCase();
  
  return (
    combined.includes('webgpu') ||
    combined.includes('out_of_device_memory') ||
    combined.includes('out of memory') ||
    combined.includes('vk_error_out_of_device_memory') ||
    combined.includes('vkallocatememory') ||
    combined.includes('device lost') ||
    combined.includes('devicelost') ||
    combined.includes('validation failed') ||
    combined.includes('invalid buffer') ||
    combined.includes('bindgroup') ||
    combined.includes('minbindingsize') ||
    combined.includes('past_key_values') ||
    combined.includes('unlabeled') ||
    combined.includes('bufferbindingtype') ||
    combined.includes('createdevice') ||
    combined.includes('createbindgroup') ||
    combined.includes('out-of-memory')
  );
}

/**
 * Check if a model is FULLY cached on disk.
 *
 * Verifying only that `model.onnx` exists is not enough: large models keep their weights in a
 * sibling external-data file (`model.onnx_data`). An interrupted download can leave the small
 * graph file (`model.onnx`) complete while the weights file is missing, zero-length, or a
 * leftover partial-download artifact — which passes a presence-only check and then crashes the
 * ONNX loader at deserialize time ("Deserialize tensor … file_length … out of bounds").
 * Returning false here routes the caller back through a fresh download instead.
 */
export async function isModelCached(model: string): Promise<boolean> {
  try {
    const env = getHFEnv();
    const cacheDir = env.cacheDir;
    if (!cacheDir) return false;
    const { access, readdir, stat } = await import('node:fs/promises');
    const path = await import('node:path');
    const onnxDir = path.default.join(cacheDir, model, 'onnx');
    // Graph file must exist.
    await access(path.default.join(onnxDir, 'model.onnx'));
    // Reject an incomplete cache: a leftover partial-download artifact anywhere in the onnx
    // dir, or a present-but-empty external weights file. Best-effort — directory read failures
    // fall through to "cached" rather than forcing a needless re-download.
    const entries = await readdir(onnxDir).catch(() => [] as string[]);
    const hasPartialArtifact = entries.some(
      (f) => /\.(incomplete|downloading|part|tmp)$/i.test(f) || f.includes('.tmp.')
    );
    if (hasPartialArtifact) return false;
    if (entries.includes('model.onnx_data')) {
      const dataStat = await stat(path.default.join(onnxDir, 'model.onnx_data')).catch(() => null);
      if (!dataStat || dataStat.size === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a model-load failure indicates a corrupt/truncated on-disk cache (as opposed to a
 * network, timeout, OOM, opset-mismatch, or GPU error). These are unrecoverable by retrying the
 * same files — the only fix is to purge the cache and re-download.
 *
 * Match ONLY corruption-specific signals. ONNX Runtime wraps essentially every session-creation
 * failure in two GENERIC strings — `Load model from <uri> failed: <ex>` and `Failed to load
 * model with error: <ex>` — and also emits broad `out of bounds` / `out_of_range` for non-cache
 * conditions (CPU OOM during weight load, unregistered-op/opset drift, shape inference, WebGPU
 * buffer-offset checks). Matching those would purge + re-download a perfectly good multi-hundred-MB
 * cache on a transient error, and PERMANENTLY destroy it if the host is offline. The genuine
 * truncated-weights error ("Deserialize tensor … file_length … out of bounds") is still caught
 * here via 'deserialize'/'file_length', so narrowing loses no real corruption coverage.
 */
export function isCorruptModelError(err: unknown): boolean {
  const msg = (err instanceof Error ? (err.message + ' ' + (err.stack ?? '')) : String(err)).toLowerCase();
  return (
    msg.includes('deserialize') ||
    msg.includes('file_length') ||
    msg.includes('protobuf parsing failed') ||
    msg.includes('invalid protobuf')
  );
}

/**
 * Delete a model's on-disk cache directory so the next load re-downloads it from scratch.
 * Best-effort: a deletion failure is logged and swallowed (the subsequent re-download attempt
 * will surface any real, persistent problem).
 */
export async function purgeModelCache(model: string): Promise<void> {
  try {
    const env = getHFEnv();
    const cacheDir = env.cacheDir;
    if (!cacheDir) return;
    const { rm } = await import('node:fs/promises');
    const path = await import('node:path');
    // Containment guard: the consequence here is a recursive delete, so never let an empty,
    // absolute, or traversal model id collapse `modelDir` to the cache root (which would wipe
    // every model) or escape it. `model` is infrastructure config (EMBEDDING_MODEL), not
    // attacker-derived, but validate in depth regardless.
    const resolvedCache = path.default.resolve(cacheDir);
    const modelDir = path.default.resolve(resolvedCache, model);
    if (!model || path.default.isAbsolute(model) || modelDir === resolvedCache || !modelDir.startsWith(resolvedCache + path.default.sep)) {
      logger.warn(`[embedder] Refusing to purge unsafe model-cache path for model id ${JSON.stringify(model)}`);
      return;
    }
    await rm(modelDir, { recursive: true, force: true });
    logger.warn(`[embedder] Purged corrupt model cache at ${modelDir}`);
  } catch (err) {
    logger.warn('[embedder] Failed to purge model cache:', err);
  }
}

/**
 * Load model on CPU (fallback from WebGPU)
 */
export async function loadModelOnCPU(
  model: string,
  initializationTimeoutMs: number,
  useCache: boolean
): Promise<FeatureExtractionPipeline> {
  logger.info(`[embedder] Loading model on CPU after WebGPU error...`);
  
  const loadedPipeline = await logger.runCapturingStderr(async () => {
    const pipelinePromise = pipeline('feature-extraction', model, {
      device: 'cpu',
      ...(useCache === false ? { use_cache: false } : {}),
      session_options: {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      },
    });
    return await withTimeout(pipelinePromise, initializationTimeoutMs, 'CPU fallback model load timed out');
  });
  
  return loadedPipeline;
}

/**
 * Release GPU lock if held
 */
export async function releaseGpuLock(stateManager: IStateManager | null, gpuLockHeld: boolean): Promise<void> {
  if (gpuLockHeld && stateManager) {
    await stateManager.releaseGpuLock().catch(err => {
      logger.warn('[embedder] Failed to release GPU lock:', err);
    });
  }
}

/**
 * Acquire GPU lock for initialization
 */
export async function acquireGpuLock(
  stateManager: IStateManager | null
): Promise<{ acquired: boolean; shouldFallback: boolean }> {
  if (!stateManager) {
    return { acquired: false, shouldFallback: false };
  }

  const gpuLockHeld = await stateManager.acquireGpuLock(undefined, 30_000);
  if (!gpuLockHeld) {
    logger.warn('[embedder] Failed to acquire GPU init lock within 30s — falling back to CPU');
    return { acquired: false, shouldFallback: true };
  }
  
  logger.debug('[embedder] Acquired GPU init lock');
  return { acquired: true, shouldFallback: false };
}

/**
 * Handle WebGPU error during load
 */
export async function handleWebGPULoadError(
  loadErr: unknown,
  pipeline: FeatureExtractionPipeline | null,
  stateManager: IStateManager | null,
  gpuLockHeld: boolean,
  model: string,
  initializationTimeoutMs: number,
  useCache: boolean
): Promise<{ success: boolean; pipeline?: FeatureExtractionPipeline; error?: Error; dummy?: any }> {
  const errorMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
  const isValidationError = errorMsg.toLowerCase().includes('validation');
  
  markWebGpuFallback();
  
  if (isValidationError) {
    logger.warn('[embedder] WebGPU validation error during pipeline loading — falling back to CPU');
    logger.debug('[embedder] Validation error details:', errorMsg);
  } else {
    logger.warn('[embedder] WebGPU OOM during pipeline loading — falling back to CPU');
  }
  
  // Clean up
  if (pipeline) {
    try { if (typeof (pipeline as any).dispose === 'function') await (pipeline as DisposablePipeline).dispose(); } catch (err) { logger.warn('[embedder] Error disposing pipeline:', err); }
  }
  await releaseGpuLock(stateManager, gpuLockHeld);

  // Load on CPU instead
  try {
    const cpuPipeline = await loadModelOnCPU(model, initializationTimeoutMs, useCache);
    logger.info(`[embedder] Pipeline loaded (device: cpu)`);
    return { success: true, pipeline: cpuPipeline };
  } catch (cpuLoadErr) {
    logger.error('[embedder] CPU fallback pipeline load failed:', cpuLoadErr);
    const error = new Error(`WebGPU initialization failed and CPU fallback load also failed: ${cpuLoadErr instanceof Error ? cpuLoadErr.message : String(cpuLoadErr)}`, { cause: cpuLoadErr });
    return { success: false, error };
  }
}

/**
 * Handle WebGPU error during warmup
 */
export async function handleWebGPUWarmupError(
  warmupErr: Error,
  pipeline: FeatureExtractionPipeline | null,
  stateManager: IStateManager | null,
  gpuLockHeld: boolean,
  model: string,
  initializationTimeoutMs: number,
  useCache: boolean
): Promise<{ success: boolean; pipeline?: FeatureExtractionPipeline; error?: Error; dummy?: any }> {
  const isValidationError = warmupErr.message.toLowerCase().includes('validation');
  
  markWebGpuFallback();
  
  if (isValidationError) {
    logger.warn('[embedder] WebGPU validation error during warmup — falling back to CPU');
    logger.debug('[embedder] Validation error details:', warmupErr.message);
  } else {
    logger.warn('[embedder] WebGPU OOM during warmup — falling back to CPU');
  }
  
  // Clean up
  if (pipeline) {
    try { if (typeof (pipeline as any).dispose === 'function') await (pipeline as DisposablePipeline).dispose(); } catch (err) { logger.warn('[embedder] Error disposing pipeline:', err); }
  }
  await releaseGpuLock(stateManager, gpuLockHeld);

  // Load on CPU
  try {
    const cpuPipeline = await loadModelOnCPU(model, initializationTimeoutMs, useCache);
    logger.info('[embedder] CPU pipeline loaded successfully');
    
    // Warmup CPU pipeline
    const { dummy, success, error: cpuWarmupErr } = await warmupPipeline(cpuPipeline, 'mean', useCache);
    if (!success || cpuWarmupErr) {
      logger.error('[embedder] CPU fallback pipeline warmup failed:', cpuWarmupErr);
      if (cpuPipeline) {
        try { if (typeof (cpuPipeline as any).dispose === 'function') await (cpuPipeline as DisposablePipeline).dispose(); } catch (err) { logger.warn('[embedder] Error disposing fallback CPU pipeline:', err); }
      }
      const error = new Error(`WebGPU initialization failed and CPU fallback warmup also failed: ${cpuWarmupErr?.message || 'Unknown error'}`, { cause: cpuWarmupErr });
      return { success: false, error };
    }
    
    logger.info(`[embedder] CPU pipeline warmup successful. Ready with device: cpu`);
    return { success: true, pipeline: cpuPipeline, dummy };
  } catch (cpuLoadErr) {
    logger.error('[embedder] CPU pipeline load failed:', cpuLoadErr);
    const error = new Error(`WebGPU initialization failed and CPU fallback load also failed: ${cpuLoadErr instanceof Error ? cpuLoadErr.message : String(cpuLoadErr)}`, { cause: cpuLoadErr });
    return { success: false, error };
  }
}