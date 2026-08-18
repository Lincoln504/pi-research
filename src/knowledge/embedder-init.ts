/**
 * Embedder Initialization Logic
 *
 * Handles initialization and warmup logic for the embedder
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { logger } from '../logger.ts';
import type { IStateManager } from '../core/service-interfaces.ts';
import { DisposablePipeline } from '../core/interfaces/knowledge-interfaces.ts';
import { withTimeout, markWebGpuFallback } from './embedder-utils.ts';
import { getHFEnv } from './onnx-env.ts';
import { getTransformers } from './transformers-loader.ts';

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
    const { pipeline } = await getTransformers();
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
    // withTimeout races but cannot cancel: on timeout the underlying pipeline()
    // keeps loading in the background and its eventual ONNX session would leak
    // (the caller's catch disposes this.pipeline, which was never assigned).
    // Dispose the late arrival when it eventually resolves — one orphaned native
    // session per retry adds up on a slow disk.
    let timedOut = true;
    try {
      const p = await withTimeout(pipelinePromise, timeoutMs, errorMessage);
      timedOut = false;
      return p;
    } finally {
      if (timedOut) {
        pipelinePromise
          .then((late) => (late as unknown as { dispose?: () => Promise<void> }).dispose?.())
          .catch(() => { /* load failed after the timeout — nothing to dispose */ });
      }
    }
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
    // Inside runCapturingStderr for the same reason the load above is, and for one
    // more: warmup is the FIRST inference, so it is where a GPU that cannot serve the
    // model actually fails. transformers.js reports that failure by printing
    // "An error occurred during model execution: ..." plus a dump of the input tensors
    // to console.error BEFORE rejecting — and this call was the only pipeline
    // invocation in the module left unwrapped, so that dump went straight to the
    // user's terminal. It is pure noise there: the rejection is caught two frames up,
    // the embedder falls back to CPU, and the run continues to completion. What the
    // user saw was a multi-line raw error for something that had already been handled.
    //
    // The load's capture ends before this runs, so wrapping the caller is not enough;
    // and the server's captureStdio around startServer() covers only the FIRST
    // initialization, not the re-initialization that follows every idle-timeout
    // teardown — which is exactly when this was observed (2026-08-16, the fourth
    // init of the session).
    const dummy = await logger.runCapturingStderr(async () =>
      withTimeout(
        pipeline('warmup', {
          pooling: poolingMode as any,
          normalize: false,
          ...(useCache === false ? { use_cache: false } : {}),
        }),
        20_000,
        'Model warmup timed out after 20000ms.'
      ),
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
 * Verifying only that `model.onnx` exists is not enough on two axes:
 *
 *  1. WEIGHTS: large models keep their weights in a sibling external-data file
 *     (`model.onnx_data`). An interrupted download can leave the small graph file
 *     (`model.onnx`) complete while the weights file is missing, zero-length, or a
 *     leftover partial-download artifact — which passes a presence-only check and then
 *     crashes the ONNX loader ("Deserialize tensor … file_length … out of bounds").
 *  2. ROOT METADATA: transformers.js also needs `config.json` and a tokenizer at the
 *     MODEL ROOT (not in `onnx/`). A truncated/garbage `config.json` (external disk
 *     error, partial delete) otherwise passes a weights-only check and then fails to
 *     parse with an error isCorruptModelError does NOT match — a permanent, un-self-
 *     healing init failure on every startup. Requiring them here re-fetches instead.
 *
 * Returning false routes the caller back through a fresh download, which heals the gap.
 * A leftover `.tmp` artifact alongside COMPLETE weights is just trash from a prior
 * interrupted attempt that later succeeded — it is swept (best-effort) and does not
 * defeat the cached fast-path (which would otherwise re-download every startup).
 */
export async function isModelCached(model: string): Promise<boolean> {
  try {
    const env = await getHFEnv();
    const cacheDir = env.cacheDir;
    if (!cacheDir) return false;
    const { access, readdir, readFile, stat, rm } = await import('node:fs/promises');
    const path = await import('node:path');
    const modelDir = path.default.join(cacheDir, model);
    const onnxDir = path.default.join(modelDir, 'onnx');

    // Graph file must exist.
    await access(path.default.join(onnxDir, 'model.onnx'));

    // Root config.json must exist AND parse — catches a missing/empty/truncated/garbage
    // config (the un-self-healing corruption case). It is tiny, so the parse is cheap.
    try {
      const cfgRaw = await readFile(path.default.join(modelDir, 'config.json'), 'utf-8');
      JSON.parse(cfgRaw);
    } catch {
      return false;
    }

    // A tokenizer must be present and non-empty. Accept any recognized form so this never
    // false-negatives across the supported models (fast tokenizer.json) or a custom model
    // (sentencepiece tokenizer.model / WordPiece vocab.txt).
    const tokenizerFiles = ['tokenizer.json', 'tokenizer.model', 'vocab.txt'];
    let hasTokenizer = false;
    for (const f of tokenizerFiles) {
      const st = await stat(path.default.join(modelDir, f)).catch(() => null);
      if (st && st.size > 0) { hasTokenizer = true; break; }
    }
    if (!hasTokenizer) return false;

    const entries = await readdir(onnxDir).catch(() => [] as string[]);

    // If an external weights file is listed, it must be non-empty — an interrupted
    // download can leave a zero-length model.onnx_data that crashes the ONNX loader.
    const hasExternalWeights = entries.includes('model.onnx_data');
    if (hasExternalWeights) {
      const dataStat = await stat(path.default.join(onnxDir, 'model.onnx_data')).catch(() => null);
      if (!dataStat || dataStat.size === 0) return false;
    }

    const partialArtifacts = entries.filter(
      (f) => /\.(incomplete|downloading|part|tmp)$/i.test(f) || f.includes('.tmp.')
    );
    if (partialArtifacts.length > 0) {
      // A leftover partial-download artifact. Treat it as trash to sweep ONLY when the
      // real weights are confirmed present and complete (model.onnx_data non-empty,
      // checked above) — a prior interrupted attempt that later succeeded. With no
      // confirmed external-weights file the partial IS an in-flight/interrupted weights
      // download, so the cache is genuinely incomplete → re-download.
      if (hasExternalWeights) {
        for (const f of partialArtifacts) {
          await rm(path.default.join(onnxDir, f), { force: true }).catch(() => {});
        }
      } else {
        return false;
      }
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
    const env = await getHFEnv();
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
    await rm(modelDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    const { pipeline } = await getTransformers();
    const pipelinePromise = pipeline('feature-extraction', model, {
      device: 'cpu',
      ...(useCache === false ? { use_cache: false } : {}),
      session_options: {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
      },
    });
    // Same late-arrival disposal as loadPipelineWithTimeout: withTimeout races
    // but cannot cancel, so on timeout the CPU load keeps running and its
    // eventual ONNX session would leak. This path runs *after* a WebGPU
    // failure — i.e. on a host already under memory pressure — and can be
    // re-entered per retry, so each orphaned session compounds.
    let timedOut = true;
    try {
      const p = await withTimeout(pipelinePromise, initializationTimeoutMs, 'CPU fallback model load timed out');
      timedOut = false;
      return p;
    } finally {
      if (timedOut) {
        pipelinePromise
          .then((late) => (late as unknown as { dispose?: () => Promise<void> }).dispose?.())
          .catch(() => { /* load failed after the timeout — nothing to dispose */ });
      }
    }
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
  useCache: boolean,
  poolingMode: 'mean' | 'cls' | 'last_token' = 'mean'
): Promise<{ success: boolean; pipeline?: FeatureExtractionPipeline; error?: Error; dummy?: any }> {
  markWebGpuFallback();

  // Deliberately does NOT try to name the cause from this error's text. The split it
  // replaced ("validation error" vs "OOM", chosen on whether the message contains
  // "validation") reported the SYMPTOM as the diagnosis, and got it backwards in the
  // case that matters: when the GPU is out of VRAM, Dawn raises
  // VK_ERROR_OUT_OF_DEVICE_MEMORY through its device-error callback — native stderr,
  // not this promise — and CreateBuffer then hands back an invalid buffer. What
  // reaches JS is the first thing to *use* that buffer, i.e.
  // "[Invalid Buffer] ... While calling CreateBindGroup", which contains the word
  // "validation" and so was logged as a validation error. A 2026-08-16 run read
  // exactly that way in the log while eighteen vkAllocateMemory failures sat directly
  // above it. The native lines are captured into this same log, so point at them
  // rather than paraphrasing them wrongly.
  logger.warn(
    '[embedder] WebGPU error during warmup — falling back to CPU. ' +
    'The underlying cause (commonly VRAM exhaustion) is in the native Dawn/ONNX output logged just above this line.',
  );
  logger.debug('[embedder] Warmup error details:', warmupErr.message);
  
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
    const { dummy, success, error: cpuWarmupErr } = await warmupPipeline(cpuPipeline, poolingMode, useCache);
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