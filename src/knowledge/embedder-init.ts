/**
 * Embedder Initialization Logic
 *
 * Handles initialization and warmup logic for the embedder
 */

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { logger } from '../logger.ts';
import type { IStateManager } from '../core/service-interfaces.ts';
import type { DisposablePipeline } from './embedder-types.ts';
import { withTimeout, getHFEnv, markWebGpuFallback } from './embedder-utils.ts';

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

  const pipelinePromise = pipeline('feature-extraction', model, {
    device: device as 'webgpu' | 'cpu' | 'auto' | 'gpu' | 'wasm' | 'cuda' | 'dml' | 'coreml' | 'webnn' | 'webnn-npu' | 'webnn-gpu' | 'webnn-cpu',
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

  const loadedPipeline = await logger.runCapturingStderr(async () => {
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

  let msg: string;
  let stack: string;
  
  if (err instanceof Error) {
    msg = err.message || '';
    stack = err.stack || '';
  } else if (typeof err === 'object' && err !== null) {
    msg = String((err as any).message || '');
    stack = String((err as any).stack || '');
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
 * Check if model is cached on disk
 */
export async function isModelCached(model: string): Promise<boolean> {
  try {
    const env = getHFEnv();
    const cacheDir = env.cacheDir;
    if (!cacheDir) return false;
    const { access } = await import('node:fs/promises');
    const path = await import('node:path');
    await access(path.default.join(cacheDir, model, 'onnx', 'model.onnx'));
    return true;
  } catch {
    return false;
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
    return await withTimeout(
      pipeline('feature-extraction', model, {
        device: 'cpu',
        ...(useCache === false ? { use_cache: false } : {}),
        session_options: {
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
        },
      }),
      initializationTimeoutMs,
      'CPU fallback model load timed out'
    );
  });
  
  return loadedPipeline;
}

/**
 * Release GPU lock if held
 */
export async function releaseGpuLock(stateManager: IStateManager | null, gpuLockHeld: boolean): Promise<void> {
  if (gpuLockHeld && stateManager) {
    await stateManager.releaseGpuLock().catch(() => {});
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
    try { await (pipeline as DisposablePipeline).dispose(); } catch { /* ignore */ }
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
    try { await (pipeline as DisposablePipeline).dispose(); } catch { /* ignore */ }
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
        try { await (cpuPipeline as DisposablePipeline).dispose(); } catch { /* ignore */ }
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