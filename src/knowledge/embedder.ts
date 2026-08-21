/**
 * Text Embedding Service using HuggingFace Transformers
 *
 * Provides embeddings for text using ONNX runtime with WebGPU/CPU support.
 * Includes automatic fallback from WebGPU to CPU on errors and idle timeout
 * to release GPU memory when not in use.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

import { logger } from '../logger.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { metrics } from '../utils/metrics.ts';
import type { IStateManager } from '../core/service-interfaces.ts';
import type {
  EmbedderOptions,
  EmbedderState,
  DisposablePipeline,
} from '../core/interfaces/knowledge-interfaces.ts';
import {
  resetWebGpuFallbackFlag,
  hasWebGpuFallback,
  markWebGpuFallback,
  getModelCacheDir,
  registerGlobalEmbedder,
  unregisterGlobalEmbedder,
  initializeDawnWebGPU,
} from './embedder-utils.ts';
import { getHFEnv, initializeONNXEnv } from './onnx-env.ts';
import { resolveEmbeddingDevice } from './webgpu-viability.ts';
import {
  isWebGpuDeviceError,
  isModelCached,
  acquireGpuLock,
  releaseGpuLock,
  loadPipelineWithTimeout,
  warmupPipeline,
  handleWebGPULoadError,
  handleWebGPUWarmupError,
  isCorruptModelError,
  purgeModelCache,
} from './embedder-init.ts';

export { resetWebGpuFallbackFlag, hasWebGpuFallback, getModelCacheDir };
export type { EmbedderOptions, EmbedderState };

export class Embedder {
  private state: EmbedderState = 'idle';
  private pipeline: FeatureExtractionPipeline | null = null;
  private initializingPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private recoveryPromise: Promise<void> | null = null;
  // Latched by the SerialQueue poison path (via EmbeddingServer): a native
  // inference is permanently hung inside this pipeline. dispose() must then
  // never call pipeline.dispose() — it would join the stuck native thread, the
  // exact hazard the poison path's shutdown(false) avoided — yet this instance
  // stays registered for process-exit cleanup (registerGlobalEmbedder), whose
  // task calls dispose() unconditionally. Without the latch the teardown path
  // re-created the hang the step-down deliberately abandoned.
  private pipelineWedged = false;

  private model: string;
  private poolingMode: 'mean' | 'cls' | 'last_token';
  private queryPrefix: string;
  private dimension: number | null = null;
  private initializationTimeoutMs: number;
  private device: string;
  private maxTokens: number;
  private batchSize: number;
  private charsPerToken: number;
  private documentPrefix: string;
  private stateManager: IStateManager | null;
  private gpuLockHeld = false;
  private originalDevice: string;
  private useCache: boolean;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly IDLE_TIMEOUT_MS = 60 * 1000;
  private activeEmbeddings = 0;
  /**
   * Embed calls actively INSIDE the model (a pipeline invocation in flight), as
   * opposed to activeEmbeddings, which counts whole embed()/embedMany() calls —
   * including callers parked on recoveryPromise after a device loss. recoverToCpu
   * drains THIS count before swapping the pipeline: parked callers still hold
   * their activeEmbeddings slot (decremented downstream in their finally), so a
   * drain on activeEmbeddings could never succeed with ≥2 concurrent device-loss
   * failures and always burned the full timeout.
   */
  private activeInferences = 0;
  /**
   * Callers parked on recoveryPromise — they JOINED an in-flight recovery while
   * still holding their activeEmbeddings slot (the decrement runs downstream in
   * their finally, after the joined recovery settles). recoverToCpu's drain must
   * distinguish them from callers still progressing toward the pipeline (parked
   * on the per-call GPU lock, or between embedMany batches): parked joiners can
   * never finish until recovery completes (waiting on them deadlocks into the
   * drain timeout), while the progressing callers MUST be waited for — disposing
   * the pipeline under them raises a TypeError no device-error classifier
   * recognizes, so their embed fails unrecovered.
   */
  private recoveryWaiters = 0;
  /**
   * Why the in-flight dispose was started. An IDLE dispose is a memory-reclaim
   * pause that a later embed is expected to undo, so initialize() waits it out and
   * re-initializes. A TERMINAL dispose (shutdown, config change, explicit
   * disposal) must never be undone — re-initializing there would resurrect the
   * ONNX pipeline during teardown. Only meaningful while state === 'disposing'.
   */
  private disposeReason: 'idle' | 'terminal' = 'terminal';

  constructor(options: EmbedderOptions) {
    this.model = options.model;
    this.poolingMode = options.pooling ?? 'mean';
    this.queryPrefix = options.queryPrefix ?? '';
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 300000;
    this.originalDevice = options.device ?? 'auto';

    // If WebGPU already proved unusable earlier this session, skip it entirely
    // for any GPU-capable request ('webgpu' or 'auto') — no point re-probing or
    // re-attempting a path known to fail.
    const couldUseWebGpu = this.originalDevice === 'webgpu' || this.originalDevice === 'auto';

    if (hasWebGpuFallback() && couldUseWebGpu) {
      this.device = 'cpu';
      logger.info('[embedder] Skipping WebGPU (previous fallback detected), using CPU directly');
    } else {
      this.device = this.originalDevice;
    }

    this.maxTokens = options.maxTokens ?? 512;
    this.batchSize = options.batchSize ?? 8;
    this.charsPerToken = options.charsPerToken ?? 4;
    this.documentPrefix = options.documentPrefix ?? '';
    this.stateManager = options.stateManager ?? null;
    this.useCache = options.useCache ?? true;

    // Register this instance so the beforeExit handler can dispose it before
    // the ONNX C++ runtime tears down its global logger singleton (prevents crash).
    registerGlobalEmbedder(this);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      // FIX (#17): Only dispose if no embeddings are active, otherwise re-schedule
      if (this.activeEmbeddings > 0) {
        logger.debug(`[embedder] Idle timeout but ${this.activeEmbeddings} embeddings active, rescheduling...`);
        this.resetIdleTimer();
        return;
      }
      if (this.state === 'ready') {
        logger.info(`[embedder] Idle timeout reached (${this.IDLE_TIMEOUT_MS}ms), releasing GPU memory...`);
        this.dispose('idle').catch(err => logger.warn('[embedder] Failed to dispose on idle:', err));
      }
    }, this.IDLE_TIMEOUT_MS);
    if (this.idleTimer) safeUnref(this.idleTimer);
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async initialize(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'disposing') {
      // An IDLE dispose is a pause, not an end: the pipeline was released purely
      // to reclaim GPU/host memory and the next embed is meant to bring it back.
      // Throwing here lost that race — the idle timer fires, dispose() flips the
      // state, and a document that arrives during the (up to ~5s) teardown got
      // "Cannot initialize while disposing", which nothing classifies as
      // transient, so the writer queue dropped it with no retry. Wait the dispose
      // out and re-initialize instead.
      if (this.disposeReason === 'idle') {
        logger.debug('[embedder] initialize() raced an idle dispose — waiting for it to finish, then re-initializing.');
        await this.disposePromise?.catch(() => { /* a failed idle dispose must not block the revive */ });
        // Re-check: another caller may have revived (or terminally disposed) the
        // embedder while we waited.
        if ((this.state as EmbedderState) === 'ready') return;
        // A terminal dispose landed as a DOWNGRADE onto the idle dispose we just
        // awaited: state is 'idle', but reviving is forbidden — pre-fix this fell
        // through to a full model load during process teardown. (A LATER, fresh
        // initialize()/embed() after the completed dispose never enters this
        // branch and stays revivable — that re-use is pinned behaviour.) The cast
        // defeats control-flow narrowing, which cannot see the awaited dispose
        // mutating the field — same idiom as the state re-checks around it.
        if ((this.disposeReason as 'idle' | 'terminal') === 'terminal') {
          throw new Error('Cannot initialize while disposing');
        }
        if ((this.state as EmbedderState) === 'disposing') {
          throw new Error('Cannot initialize while disposing');
        }
      } else {
        // Terminal dispose (shutdown / config change): must NOT be revived.
        throw new Error('Cannot initialize while disposing');
      }
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    this.state = 'initializing';
    this.initializingPromise = this._initializeInternal();

    try {
      await this.initializingPromise;
      const currentState = this.state as EmbedderState;
      if (currentState === 'disposing') {
        logger.warn('[embedder] Initialization finished but embedder was disposed in the meantime.');
        return;
      }
      this.state = 'ready';
      // Re-point the global ref on the idle→active revive: a prior idle dispose() called
      // unregisterGlobalEmbedder() (nulling the ref), which would otherwise leave the
      // beforeExit ORT-teardown safety net pointing at nothing for the now-live pipeline.
      // Idempotent — the shutdown task is WeakSet-guarded, so no callback is leaked.
      registerGlobalEmbedder(this);
    } catch (err) {
      this.state = 'failed';
      throw err;
    } finally {
      this.initializingPromise = null;
    }
  }

  private async _initializeInternal(): Promise<void> {
    try {
      // Lazy initialization of the ONNX/transformers environment. Kept here (not
      // in initialize()) so initialize()'s synchronous state setup — state =
      // 'initializing' and the initializingPromise — runs before the first await,
      // preserving the dispose-during-init ordering. This is also the first point
      // the native ML stack is touched (via the lazy transformers loader).
      await initializeONNXEnv();

      // Resolve 'auto' to a concrete backend BEFORE any native ONNX/Dawn code runs.
      // For 'auto' this runs an out-of-process probe (cached per host) so that a
      // native SIGSEGV on a software/paravirtual GPU can never reach this process.
      if (this.device === 'auto') {
        this.device = await resolveEmbeddingDevice('auto', this.model, this.initializationTimeoutMs);
      }

      // Acquire GPU lock if using WebGPU
      if (this.device === 'webgpu') {
        const { acquired, shouldFallback } = await acquireGpuLock(this.stateManager);
        if (shouldFallback) {
          this.device = 'cpu';
        } else if (acquired) {
          this.gpuLockHeld = true;
        }
      }

      // Try to initialize WebGPU via Dawn for Node.js environments. A false
      // return means a software/fallback adapter was detected in-process —
      // downgrade to CPU before any native compute runs (and release the GPU lock).
      if (this.device === 'webgpu') {
        const webgpuOk = await initializeDawnWebGPU();
        if (!webgpuOk) {
          await releaseGpuLock(this.stateManager, this.gpuLockHeld);
          this.gpuLockHeld = false;
          this.device = 'cpu';
        }
      }

      const cached = await isModelCached(this.model);
      logger.info(
        `[embedder] Loading model: ${this.model} (${cached ? 'from local cache' : 'downloading from HuggingFace'})...`
      );

      const env = await getHFEnv();
      const prevAllowRemote = env.allowRemoteModels;
      if (cached) {
        env.allowRemoteModels = false;
      }

      try {
        const timeoutMs = cached ? 30_000 : this.initializationTimeoutMs;
        const { pipeline: loadedPipeline } = await loadPipelineWithTimeout(this.model, this.device, timeoutMs, this.useCache);
        this.pipeline = loadedPipeline;
        logger.info(`[embedder] Pipeline loaded (device: ${this.device})`);
      } catch (loadErr) {
        if (this.device === 'webgpu' && isWebGpuDeviceError(loadErr)) {
          const result = await handleWebGPULoadError(
            loadErr,
            this.pipeline,
            this.stateManager,
            this.gpuLockHeld,
            this.model,
            this.initializationTimeoutMs,
            this.useCache
          );
          if (!result.success) {
            throw result.error;
          }
          this.pipeline = result.pipeline ?? null;
          this.device = 'cpu';
          this.gpuLockHeld = false;
        } else if (cached && isCorruptModelError(loadErr)) {
          // The on-disk cache is truncated/corrupt (e.g. an interrupted weights download that
          // slipped past isModelCached). Retrying the same files fails identically and, on one
          // path, surfaced as an uncaughtException that took down the host. Purge the cache and
          // re-download exactly once; allowRemoteModels must be re-enabled for the fetch.
          const errMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
          logger.warn(`[embedder] Corrupt model cache detected on load (${errMsg}); purging and re-downloading once`);
          await purgeModelCache(this.model);
          env.allowRemoteModels = true;
          const { pipeline: reloadedPipeline } = await loadPipelineWithTimeout(
            this.model,
            this.device,
            this.initializationTimeoutMs,
            this.useCache
          );
          this.pipeline = reloadedPipeline;
          logger.info(`[embedder] Re-download after cache purge succeeded (device: ${this.device})`);
        } else {
          throw loadErr;
        }
      } finally {
        env.allowRemoteModels = prevAllowRemote;
      }

      // Warmup
      let dummy: any;
      try {
        const warmupResult = await warmupPipeline(this.pipeline!, this.poolingMode, this.useCache);
        if (!warmupResult.success) {
          throw warmupResult.error;
        }
        dummy = warmupResult.dummy;
      } catch (warmupErr) {
        if (this.device === 'webgpu' && isWebGpuDeviceError(warmupErr)) {
          const result = await handleWebGPUWarmupError(
            warmupErr as Error,
            this.pipeline,
            this.stateManager,
            this.gpuLockHeld,
            this.model,
            this.initializationTimeoutMs,
            this.useCache,
            this.poolingMode
          );
          if (!result.success) {
            throw result.error;
          }
          this.pipeline = result.pipeline ?? null;
          this.device = 'cpu';
          this.gpuLockHeld = false;
          dummy = result.dummy;
        } else {
          throw warmupErr;
        }
      }
      
      this.dimension = dummy.dims[dummy.dims.length - 1] ?? null;

      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;

      logger.info(`[embedder] Ready. Dimension: ${this.dimension}, device: ${this.device}`);
    } catch (err) {
      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;
      if (this.pipeline) {
        try { if (typeof (this.pipeline as any).dispose === 'function') await (this.pipeline as DisposablePipeline).dispose(); } catch (err) { logger.warn('[embedder] Error disposing pipeline:', err); }
        this.pipeline = null;
      }
      logger.error(`[embedder] Failed to initialize:`, err);
      throw err;
    }
  }

  isInitialized(): boolean {
    return this.state === 'ready' && this.pipeline !== null && this.dimension !== null;
  }

  getDevice(): string {
    return this.device;
  }

  getOriginalDevice(): string {
    return this.originalDevice;
  }

  getDimension(): number | null {
    return this.dimension;
  }

  /**
   * Set the embedding dimension explicitly.
   * Used by KnowledgeStore when restoring dimension from an existing table schema
   * before the embedder has been fully warmed up.
   */
  setDimension(dim: number): void {
    this.dimension = dim;
  }

  private pipelineOpts(): { pooling: 'mean' | 'cls' | 'last_token'; normalize: boolean; use_cache?: boolean } {
    return {
      pooling: this.poolingMode as 'mean' | 'cls' | 'last_token',
      normalize: true,
      ...(this.useCache === false ? { use_cache: false } : {}),
    };
  }

  private truncateText(text: string): string {
    const maxChars = this.maxTokens * this.charsPerToken;
    if (text.length > maxChars) {
      // Hard OOM guard: never feed the model more than its context window (~maxTokens,
      // approximated in chars). Only the tail-end of an oversized input is dropped from
      // the VECTOR — the full text is still stored verbatim and covered by FTS — but the
      // truncation is otherwise silent, so surface it: a spike here means chunks are
      // arriving larger than the embed cap and vector recall on their tail is degraded.
      let keep = maxChars;
      // slice() counts UTF-16 code units, so the cut can land between the halves of
      // a surrogate pair (emoji, rare CJK) — same guard as truncateWithMarker
      // (utils/text-utils.ts): a lone high surrogate is invalid text some
      // tokenizers/providers choke on. Back off one unit to restore well-formed text.
      const lastKeptUnit = text.charCodeAt(keep - 1);
      if (lastKeptUnit >= 0xd800 && lastKeptUnit <= 0xdbff) keep -= 1;
      metrics.increment('embedder_truncations_total', 1, { model: this.model });
      logger.debug(`[embedder] Truncated input for embedding: ${text.length} -> ${keep} chars (model=${this.model})`);
      return text.slice(0, keep);
    }
    return text;
  }

  /**
   * Run the pipeline over an input, tracked in activeInferences so recoverToCpu's
   * drain loop waits only on calls genuinely inside the model.
   */
  private async runInference(input: string | string[]): Promise<any> {
    // A disposal/recovery that raced this call may have nulled the pipeline out
    // from under us. Calling through null raises a bare TypeError that nothing
    // classifies (the writer queue drops the document as a generic ingest_error);
    // throw the reconnect-classified signal instead — isEmbedderUnreachable
    // matches "aborted" — so the caller retries via a fresh embedder.
    if (!this.pipeline) {
      throw new Error('[embedder] embed aborted: pipeline disposed before inference could run — reconnect required');
    }
    this.activeInferences++;
    try {
      return await logger.runCapturingStderr(async () => {
        return await this.pipeline!(input, this.pipelineOpts());
      });
    } finally {
      this.activeInferences--;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    await this.initialize();
    // Compute the input BEFORE the active-count increment: truncateText is a pure
    // string op, and keeping it (and nothing else) ahead of the try/finally means
    // every path that can throw or await is inside the finally that decrements the
    // counter. Otherwise a throw here (or in acquireGpuLock) would leak the count,
    // permanently wedging dispose (5s hang).
    const input = this.truncateText(this.queryPrefix ? this.queryPrefix + text : text);
    this.stopIdleTimer();
    this.activeEmbeddings++;

    let lockAcquired = false;
    try {
      if (this.device === 'webgpu' && this.stateManager) {
        lockAcquired = await this.stateManager.acquireGpuLock(undefined, 15_000);
        if (!lockAcquired) {
          logger.warn('[embedder] GPU per-call lock timeout after 15s — proceeding without lock');
        }
      }
      const output = await this.runInference(input);
      return output.data as Float32Array;
    } catch (err) {
      if (isWebGpuDeviceError(err)) {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch(err => {
            logger.warn('[embedder] Failed to release GPU lock:', err);
          });
          lockAcquired = false;
        }
        await this.recoverToCpu();
        // recoverToCpu early-returns (no re-init) when disposal/idle already started;
        // dereferencing a null pipeline would raise a TypeError that MASKS the
        // original device error — rethrow the original instead.
        if (!this.pipeline) throw err;
        const output = await this.runInference(input);
        return output.data as Float32Array;
      }
      throw err;
    } finally {
      if (lockAcquired && this.stateManager) {
        await this.stateManager.releaseGpuLock().catch((err) => logger.warn('[embedder] Failed to release per-call GPU lock:', err));
      }
      this.activeEmbeddings--;
      this.resetIdleTimer();
    }
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    await this.initialize();
    this.stopIdleTimer();

    return metrics.measure('embedMany_latency', async () => {
      // Increment INSIDE the measured closure and inside the try/finally below, so
      // the dimension-null throw and acquireGpuLock can't leak the active count
      // (the increment used to sit outside this closure while the decrement was in
      // the finally — a throw before the try wedged the counter permanently).
      this.activeEmbeddings++;
      let lockAcquired = false;
      try {
        const dim = this.getDimension();
        if (dim === null) throw new Error('Embedder not initialized (dimension unknown)');
        const results: Float32Array[] = [];

        if (this.device === 'webgpu' && this.stateManager) {
          lockAcquired = await this.stateManager.acquireGpuLock(undefined, 45_000);
          if (!lockAcquired) {
            logger.warn('[embedder] GPU batch lock timeout after 45s — proceeding without lock');
          }
        }

        for (let i = 0; i < texts.length; i += this.batchSize) {
          // Prefix BEFORE truncation (matching embed()'s queryPrefix handling) so
          // the model input never exceeds the char cap by the prefix length.
          const batch = texts.slice(i, i + this.batchSize).map(t =>
            this.truncateText(this.documentPrefix ? this.documentPrefix + t : t)
          );

          let output: any;
          try {
            output = await this.runInference(batch);
          } catch (err) {
            if (isWebGpuDeviceError(err)) {
              if (lockAcquired && this.stateManager) {
                await this.stateManager.releaseGpuLock().catch(err => {
            logger.warn('[embedder] Failed to release GPU lock:', err);
          });
                lockAcquired = false;
              }
              await this.recoverToCpu();
              // Same guard as embed(): recoverToCpu may have skipped (disposing/idle),
              // leaving pipeline null — rethrow the original error, not a TypeError.
              if (!this.pipeline) throw err;
              output = await this.runInference(batch);
            } else {
              throw err;
            }
          }

          for (let j = 0; j < batch.length; j++) {
            results.push(output.data.slice(j * dim, (j + 1) * dim) as Float32Array);
          }
        }
        return results;
      } finally {
        if (lockAcquired && this.stateManager) {
          await this.stateManager.releaseGpuLock().catch(err => {
            logger.warn('[embedder] Failed to release GPU lock:', err);
          });
        }
        this.activeEmbeddings--;
        this.resetIdleTimer();
      }
    });
  }

  private async recoverToCpu(): Promise<void> {
    if (this.recoveryPromise) {
      // Counted join: this caller still holds its activeEmbeddings slot while
      // parked here, and the drain below must not wait on parked joiners (see
      // the recoveryWaiters field comment).
      this.recoveryWaiters++;
      try {
        return await this.recoveryPromise;
      } finally {
        this.recoveryWaiters--;
      }
    }

    // Guard: if disposal has already started, skip recovery — the embedder is going away.
    if (this.state === 'disposing' || this.state === 'idle') {
      logger.debug('[embedder] recoverToCpu called during disposal/idle — skipping');
      return;
    }

    // Close the initialize() re-entry window SYNCHRONOUSLY, before the first
    // await: initialize() only checks 'ready'/'disposing' and initializingPromise,
    // so until the recovery promise below is published, a concurrent
    // embed()/embedMany() passed every guard and launched a second concurrent
    // _initializeInternal — racing pipeline/state assignments, leaking the losing
    // pipeline, and (device was flipped to 'cpu' only after the drain loop)
    // reloading the exact WebGPU backend that just failed. Flip device first so
    // no joiner can ever observe 'webgpu' again this session.
    this.state = 'initializing';
    this.device = 'cpu';

    const recovery = (async () => {
      logger.warn('[embedder] WebGPU device error detected during operation — falling back to CPU for the remainder of this session');

      markWebGpuFallback();

      await releaseGpuLock(this.stateManager, this.gpuLockHeld);
      this.gpuLockHeld = false;

      // Drain in-flight callers before disposing the pipeline, on BOTH counts:
      //  - activeInferences > 0: a call genuinely inside the model.
      //  - activeEmbeddings - recoveryWaiters > 1: callers past initialize() but
      //    not yet inside the model — parked on the per-call GPU lock, or between
      //    embedMany batches. Self counts as 1 (this recovery runs from a caller
      //    holding its own slot); parked joiners are subtracted because they can
      //    never finish until THIS recovery completes (an uncorrected
      //    activeEmbeddings drain always burned the full timeout under
      //    multi-caller device loss). An inferences-only drain (the prior form)
      //    disposed the pipeline under a lock-parked caller, whose embed then
      //    failed with an unclassified TypeError, masking the device loss.
      const maxWaitMs = 15000;
      const startTime = Date.now();
      while (
        (this.activeInferences > 0 || this.activeEmbeddings - this.recoveryWaiters > 1) &&
        (Date.now() - startTime) < maxWaitMs
      ) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (this.pipeline) {
        try { if (typeof (this.pipeline as any).dispose === 'function') await (this.pipeline as DisposablePipeline).dispose(); } catch (err) { logger.warn('[embedder] Error disposing pipeline:', err); }
        this.pipeline = null;
      }

      try {
        await this._initializeInternal();
      } catch (e) {
        this.state = 'failed';
        throw e;
      }
      // Same guard as initialize(): a terminal dispose may have landed while the
      // CPU pipeline loaded — never overwrite 'disposing' with 'ready'. (Cast
      // defeats control-flow narrowing, which cannot see the awaited init racing
      // dispose() — same idiom as the state re-checks in initialize().)
      if ((this.state as EmbedderState) === 'disposing') {
        logger.warn('[embedder] Recovery finished but embedder was disposed in the meantime.');
        return;
      }
      this.state = 'ready';
      logger.warn('[embedder] CPU fallback recovery complete.');
    })();

    this.recoveryPromise = recovery;
    // Publish for initialize(): a caller arriving mid-recovery must join the
    // WHOLE recovery (drain + pipeline swap + re-init), not start its own. This
    // and the assignments above run before recovery's first await, so there is
    // no window in which a joiner can slip past.
    this.initializingPromise = recovery;

    try {
      await recovery;
    } finally {
      if (this.recoveryPromise === recovery) this.recoveryPromise = null;
      // Guarded: by the time this finally runs, a fresh initialize() may already
      // own initializingPromise (e.g. after a failed recovery) — never null it out
      // from under that caller.
      if (this.initializingPromise === recovery) this.initializingPromise = null;
    }
  }

  /**
   * Mark this embedder's pipeline as permanently wedged (a native inference hung
   * past the SerialQueue hard deadline). From here on, dispose() abandons the
   * pipeline instead of calling pipeline.dispose() — see pipelineWedged.
   */
  markPipelineWedged(): void {
    this.pipelineWedged = true;
  }

  /**
   * @param reason `'idle'` for the memory-reclaim pause driven by the idle timer —
   *   a later embed is allowed to revive the embedder. Anything else is terminal
   *   (shutdown, config change, explicit disposal) and must never be revived, so
   *   the default is deliberately the safe one: callers that do not opt in get
   *   terminal semantics.
   */
  async dispose(reason: 'idle' | 'terminal' = 'terminal'): Promise<void> {
    if (this.state === 'idle') return;
    this.stopIdleTimer();

    if (this.state === 'disposing' && this.disposePromise) {
      // A terminal dispose landing on top of an in-flight idle dispose must
      // downgrade the reason, so a concurrent initialize() cannot revive what is
      // now a shutdown. Never the reverse.
      if (reason === 'terminal') this.disposeReason = 'terminal';
      return this.disposePromise;
    }

    this.disposeReason = reason;
    this.state = 'disposing';
    this.disposePromise = (async () => {
      // Wait for all active embeddings to complete. Pointless when the pipeline
      // is wedged: the hung call holds its activeEmbeddings slot forever, so the
      // drain can only time out — skip straight to the (dispose-skipping)
      // teardown below instead of burning the wait twice at process exit.
      const maxWaitMs = 5000;
      const drainActiveEmbeddings = async (): Promise<void> => {
        if (this.pipelineWedged) return;
        const startTime = Date.now();
        while (this.activeEmbeddings > 0 && (Date.now() - startTime) < maxWaitMs) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (this.activeEmbeddings > 0) {
          logger.warn(`[embedder] Disposing with ${this.activeEmbeddings} active embeddings (timed out)`);
        }
      };
      await drainActiveEmbeddings();

      if (this.initializingPromise) {
        try {
          await this.initializingPromise;
        } catch (_e) {
          // Initialize failed, which is fine
        }
        // A caller parked on that same init increments activeEmbeddings only
        // AFTER init resolves — i.e. after the drain above already passed — and
        // initialize()'s disposed-mid-init branch returns cleanly, so its embed
        // proceeds into runInference. Yield one macrotask so those callers reach
        // their increment, then drain AGAIN; otherwise the pipeline below is
        // torn down under a just-started inference (an unclassified TypeError
        // the writer queue drops as a generic ingest_error).
        await new Promise(resolve => setTimeout(resolve, 0));
        await drainActiveEmbeddings();
      }

      if (this.pipeline) {
        if (this.pipelineWedged) {
          // See pipelineWedged's declaration: disposing a wedged ORT session
          // joins the permanently hung native thread. Abandon it — the native
          // resources die with process exit, which is where this path runs.
          logger.warn('[embedder] Skipping pipeline.dispose(): pipeline wedged by a permanently hung inference; abandoning native resources to process exit.');
          this.pipeline = null;
        } else {
          try {
            if (typeof (this.pipeline as any).dispose === 'function') {
              await (this.pipeline as DisposablePipeline).dispose();
            }
          } catch (err) {
            logger.warn('[embedder] Error during pipeline dispose:', err);
          }
          this.pipeline = null;
        }
      }

      // Always release the GPU lock once on dispose (defensive: the gpuLockHeld flag
      // may be stale, and a normal init already released it). A single unconditional
      // release covers both cases — previously this also called releaseGpuLock(sm,
      // gpuLockHeld) first, double-releasing when the flag was still true.
      if (this.stateManager) {
        await this.stateManager.releaseGpuLock().catch(err => {
          logger.warn('[embedder] Failed to release GPU lock during dispose:', err);
        });
      }
      this.gpuLockHeld = false;

      this.state = 'idle';
      this.disposePromise = null;

      // Unregister from the global beforeExit handler — cleanup is done.
      unregisterGlobalEmbedder();
    })();

    return this.disposePromise;
  }
}