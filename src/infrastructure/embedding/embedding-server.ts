/**
 * Embedding Server
 *
 * Wraps a single Embedder instance behind an HTTP server so all other
 * processes can share one GPU context. Mirrors BrowserTaskScheduler.
 */

import * as http from 'node:http';
import * as path from 'node:path';
import { logger } from '../../logger.ts';
import { captureStdio } from '../../utils/stdio-capture.ts';
import { buildDefaultDebugLogPath } from '../../utils/log-utils.ts';
import { DiskSpaceChecker } from '../../utils/disk-space-checker.ts';
import type { IEmbedder } from '../../core/interfaces/knowledge-interfaces.ts';
import type { IStateManager } from '../../core/interfaces/state-manager-interfaces.ts';
import type { Embedder } from '../../knowledge/embedder.ts';

// ---------------------------------------------------------------------------
// SerialQueue — ensures embed/embedMany never run concurrently on the GPU
// ---------------------------------------------------------------------------

class SerialQueue {
  private running = false;
  private readonly tasks: Array<{ run: () => Promise<void>; fail: (e: Error) => void }> = [];
  private readonly maxDepth: number;
  private readonly timeoutMs: number;
  private readonly hardDeadlineMs: number;
  private readonly onPoison?: (err: Error) => void;
  private poisoned: Error | null = null;

  constructor(
    maxDepth = 200,
    timeoutMs = 120000,
    // A single embed/embedMany that has still not settled after this long is
    // genuinely hung (e.g. a WebGPU device-lost stall), not merely slow. Kept well
    // above the soft caller timeout so a legitimately slow CPU batch is never
    // false-poisoned. On expiry the queue is POISONED rather than the slot freed:
    // freeing the slot would start a second inference concurrently with the stuck
    // one on the re-entrant-locked GPU context (the native-segfault class this
    // queue exists to prevent), and the native call cannot be cancelled in-process.
    hardDeadlineMs = 600000,
    onPoison?: (err: Error) => void,
  ) {
    this.maxDepth = maxDepth;
    this.timeoutMs = timeoutMs;
    this.hardDeadlineMs = hardDeadlineMs;
    this.onPoison = onPoison;
  }

  isPoisoned(): boolean {
    return this.poisoned !== null;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // Once poisoned (a prior inference hung permanently) the queue can never run
    // another task without risking concurrent GPU inference on the stuck context,
    // so fail every caller fast instead of letting them hang indefinitely.
    if (this.poisoned) return Promise.reject(this.poisoned);
    if (this.tasks.length >= this.maxDepth) {
      return Promise.reject(new Error(`SerialQueue at capacity (${this.maxDepth}). Embed request dropped.`));
    }
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`SerialQueue: embed request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        });
        // Start the real GPU work once and keep a handle to it. On timeout we
        // report to the caller promptly, but must NOT let pump() advance to the
        // next task while this inference is still executing — Promise.race does
        // not cancel the loser, and the same-PID GPU lock is re-entrant, so this
        // queue is the only guard against concurrent GPU inference (the class of
        // bug that previously caused native segfaults). fn() is invoked inside the
        // try so a synchronous throw rejects the caller cleanly (run() itself
        // never rejects, so pump()'s `await run()` can't produce an unhandled
        // rejection).
        let work: Promise<T> | undefined;
        let settled = false;
        let hardTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          work = fn();
          // Arm the hard-deadline watchdog from the moment the real GPU work starts, so
          // the cap is an honest wall-clock deadline measured from work-start rather than
          // (soft-timeout + hardDeadlineMs). A single inference still unsettled after
          // hardDeadlineMs is genuinely hung (e.g. a WebGPU device-lost stall); on expiry
          // the queue is POISONED rather than the slot freed — freeing it would start a
          // second inference concurrently with the stuck one on the re-entrant GPU lock.
          hardTimer = setTimeout(() => {
            if (settled) return;
            this.poison(new Error(
              `SerialQueue: embed permanently hung (exceeded hard deadline ${this.hardDeadlineMs}ms) — embedder poisoned; leader stepping down`,
            ));
          }, this.hardDeadlineMs);
          hardTimer.unref?.();
          resolve(await Promise.race([work, timeoutPromise]));
        } catch (e) {
          reject(e);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        // Hold the queue slot until the actual work settles, even past a reported (soft)
        // timeout, to preserve the GPU-serialization invariant. The hard-deadline watchdog
        // armed above is the backstop: a genuinely hung inference never settles and would
        // otherwise wedge the whole queue (and, via the leader's HTTP endpoint, every other
        // process) forever, so it poisons the queue once the work outlives hardDeadlineMs.
        if (work) {
          try {
            await work.catch(() => {});
          } finally {
            settled = true;
            if (hardTimer !== undefined) clearTimeout(hardTimer);
          }
        }
      };
      this.tasks.push({ run, fail: reject });
      if (!this.running) void this.pump();
    });
  }

  private poison(err: Error): void {
    if (this.poisoned) return;
    this.poisoned = err;
    logger.error(`[SerialQueue] ${err.message}`);
    // Fast-fail everything already queued behind the hung task — their per-task
    // timeout timers never armed (the timer is created only once a task starts
    // running), so without this they would hang with no timeout at all.
    const queued = this.tasks.splice(0, this.tasks.length);
    for (const entry of queued) {
      try { entry.fail(err); } catch { /* caller already settled */ }
    }
    try { this.onPoison?.(err); } catch (e) { logger.warn('[SerialQueue] onPoison hook failed:', e); }
  }

  private async pump(): Promise<void> {
    // FIX (#19): Guard against empty array (edge case from concurrent enqueue + pump)
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const entry = this.tasks.shift();
        if (entry) {
          await entry.run();
        }
      }
    } finally {
      this.running = false;
      // If tasks were enqueued while we were finishing, pump again
      if (this.tasks.length > 0) {
        void this.pump();
      }
    }
  }
}

// Exported under a _-prefixed alias for focused unit testing of the
// serialization invariant; the class itself stays internal.
export { SerialQueue as _SerialQueue };

// ---------------------------------------------------------------------------
// EmbeddingServer
// ---------------------------------------------------------------------------

export class EmbeddingServer implements IEmbedder {
  private server: http.Server | null = null;
  private leadershipTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveLeadershipMisses = 0;
  private readonly LEADERSHIP_MISS_THRESHOLD = 3;
  private isShuttingDown = false;
  private readonly queue: SerialQueue;

  // Dimension field — set by store.ts from table schema before embedder is warmed up,
  // and updated after embedder gets its own dimension at initialization.
  dimension: number | null = null;

  constructor(
    private readonly embedder: Embedder,
    private readonly stateManager: IStateManager,
    public readonly serverId: string,
    // Invoked when the embedding queue poisons itself after a permanently-hung
    // inference — lets the factory drop this now-leaderless singleton so the next
    // getEmbedder() re-elects a fresh leader in a clean process.
    private readonly externalOnPoison?: (err: Error) => void,
  ) {
    // Wire the queue's poison hook to step this leader down (without disposing the
    // stuck embedder) so a fresh process can re-elect with a clean GPU context.
    this.queue = new SerialQueue(200, 120000, 600000, (err) => this.handleQueuePoisoned(err));
    // Leadership check is started externally (by embedding-factory) after the
    // election is won. Starting it here would cause false misses because model
    // init (inside startServer) can take longer than the 30s check interval.
  }

  // ---- IEmbedder ----

  getDevice(): string {
    return this.embedder.isInitialized() ? this.embedder.getDevice() : 'unknown';
  }

  getOriginalDevice(): string {
    return this.embedder.isInitialized() ? this.embedder.getOriginalDevice() : 'unknown';
  }

  getDimension(): number | null {
    if (this.dimension !== null) return this.dimension;
    return this.embedder.isInitialized() ? this.embedder.getDimension() : null;
  }

  setDimension(dim: number): void {
    this.dimension = dim;
  }

  isInitialized(): boolean {
    return this.embedder.isInitialized();
  }

  async embed(text: string): Promise<Float32Array> {
    this.assertServing();
    return this.queue.enqueue(() => this.embedder.embed(text));
  }

  async embedMany(texts: string[]): Promise<(Float32Array | number[])[]> {
    this.assertServing();
    return this.queue.enqueue(() => this.embedder.embedMany(texts));
  }

  // Refuse to serve once this server has stepped down (leadership lost or queue
  // poisoned). Throwing an ECONNREFUSED-bearing error — the same signal a dead
  // remote leader produces — drives the store's withEmbedderReconnect to re-resolve
  // through the factory and become a client of the NEW leader, instead of silently
  // re-initializing this disposed embedder and re-acquiring the GPU in a process
  // that is no longer the leader (which would break the single-GPU-context invariant).
  private assertServing(): void {
    if (this.isShuttingDown) {
      throw new Error('[EmbeddingServer] embedding endpoint gone (ECONNREFUSED): leader stepped down — reconnect required');
    }
  }

  private handleQueuePoisoned(err: Error): void {
    logger.error(
      '[EmbeddingServer] Embedding queue poisoned by a permanently hung inference. ' +
      'Stepping down as leader so a fresh process can re-elect with a clean GPU context. ' +
      err.message,
    );
    // Step down WITHOUT disposing the embedder: pipeline.dispose() would join the
    // stuck native thread (itself hanging) or touch a device-lost context. Clearing
    // the state registration + closing the HTTP server is enough for re-election;
    // the wedged native resources are abandoned to eventual process exit.
    void this.shutdown(false);
    this.externalOnPoison?.(err);
  }

  async dispose(): Promise<void> {
    return this.shutdown();
  }

  // ---- Server lifecycle ----

  async startServer(): Promise<number> {
    // Wrap embedder initialization in a dedicated captureStdio scope keyed by
    // serverId. This ensures native C++ output (Dawn/ONNX limit-clamping warnings
    // written directly to FD 2) is redirected to the log file regardless of whether
    // a research session's outer captureStdio is already active — the serverId key
    // bypasses the global isAnyLoggerCapturingOutput guard.
    const diskChecker = new DiskSpaceChecker();
    // Consolidated log: the embedding server writes into the same file as the
    // main process (path defaults to tmpdir, overridable via PI_RESEARCH_LOG_PATH).
    const logFile = buildDefaultDebugLogPath();
    await captureStdio(
      logFile,
      () => diskChecker.checkDiskSpace(path.dirname(logFile)),
      () => this.embedder.initialize(),
      this.serverId,
    );

    // Capture dimension after initialization
    this.dimension = this.embedder.getDimension();

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          logger.info(`[EmbeddingServer] Listening on http://127.0.0.1:${addr.port} (serverId: ${this.serverId})`);
          resolve(addr.port);
        } else {
          reject(new Error('[EmbeddingServer] Failed to get server port'));
        }
      });

      this.server.on('error', (err) => {
        logger.error('[EmbeddingServer] Server error:', err);
        reject(err);
      });
    });
  }

  async shutdown(disposeEmbedder = true): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (this.leadershipTimer) {
      clearTimeout(this.leadershipTimer);
      this.leadershipTimer = null;
    }

    // Clear our registration if we still own it
    try {
      const serverInfo = await this.stateManager.getEmbeddingServer();
      if (serverInfo?.serverId === this.serverId) {
        await this.stateManager.clearEmbeddingServer().catch((err) => {
          logger.warn('[EmbeddingServer] Failed to clear embedding server state:', err);
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // State manager is torn down before the embedding server during process exit —
      // this is expected and harmless; log at debug to avoid noise.
      if (msg.includes('not initialized') || msg.includes('State manager')) {
        logger.debug('[EmbeddingServer] State manager already disposed during shutdown, skipping registration cleanup.');
      } else {
        logger.warn('[EmbeddingServer] Could not read embedding server state during shutdown:', err);
      }
    }

    if (this.server) {
      this.server.closeAllConnections?.();
      const srv = this.server;
      // Bound server.close(): a lingering keep-alive client could otherwise hang
      // the callback forever and block process shutdown. Force teardown after 5s.
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        const timer = setTimeout(() => {
          logger.warn('[EmbeddingServer] server.close() timed out after 5s; forcing teardown.');
          done();
        }, 5000);
        timer.unref?.();
        try {
          srv.close(() => { clearTimeout(timer); done(); });
        } catch {
          clearTimeout(timer); done();
        }
      });
      this.server = null;
    }

    // Skip embedder disposal on the poison path (disposeEmbedder=false): the native
    // inference is wedged, so pipeline.dispose()/ReleaseSession would join the stuck
    // thread and hang the whole teardown. Registration is already cleared above, which
    // is enough for another process to re-elect; the leaked native resources die with
    // eventual process exit.
    if (disposeEmbedder) {
      await this.embedder.dispose().catch((err) => {
        if (this.isShuttingDown) {
          logger.debug('[EmbeddingServer] Error disposing embedder during shutdown (expected):', err);
        } else {
          logger.warn('[EmbeddingServer] Error disposing embedder:', err);
        }
      });
    }
  }

  private async getEmbeddingServerWithRetry(retries = 2, delay = 300): Promise<{ port: number; pid: number; serverId: string } | null> {
    for (let i = 0; i <= retries; i++) {
      const serverInfo = await this.stateManager.getEmbeddingServer();
      if (serverInfo) return serverInfo;
      if (i < retries) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return null;
  }

  // ---- Leadership check ----

  startLeadershipCheck(): void {
    const check = async () => {
      if (this.isShuttingDown) return;
      try {
        const serverInfo = await this.getEmbeddingServerWithRetry();
        
        // Resilience: Skip check if server info is transiently unavailable after retries.
        // This is a benign, explicitly-handled condition (the state entry can be briefly
        // absent while a concurrent run rewrites shared state), so log at DEBUG — at WARN
        // it spams the log every 30s for the life of the process.
        if (!serverInfo) {
          logger.debug('[EmbeddingServer] Leadership check: no embedding server found in state after retries. Skipping check.');
          return;
        }

        if (serverInfo.serverId !== this.serverId) {
          this.consecutiveLeadershipMisses++;
          logger.warn(
            `[EmbeddingServer] Leadership check failed (${this.consecutiveLeadershipMisses}/${this.LEADERSHIP_MISS_THRESHOLD}) — ` +
            `expected ${this.serverId}, found ${serverInfo?.serverId ?? 'none'}`,
          );
          if (this.consecutiveLeadershipMisses >= this.LEADERSHIP_MISS_THRESHOLD) {
            // Another process won leadership; step down. This is an orderly, expected
            // handoff (not a fault), so it logs at WARN to match the surrounding
            // leadership-check severity (DEBUG/WARN above) rather than polluting the
            // ERROR log — which also re-tracks into the diagnostic error count.
            logger.warn('[EmbeddingServer] Leadership lost, shutting down...');
            void this.shutdown();
            return;
          }
        } else {
          if (this.consecutiveLeadershipMisses > 0) {
            logger.log(`[EmbeddingServer] Leadership confirmed, resetting miss counter from ${this.consecutiveLeadershipMisses}`);
            this.consecutiveLeadershipMisses = 0;
          }
        }
      } catch (err) {
        logger.warn('[EmbeddingServer] Leadership check error:', err);
      } finally {
        if (!this.isShuttingDown) {
          this.leadershipTimer = setTimeout(check, 30_000);
          if (this.leadershipTimer.unref) this.leadershipTimer.unref();
        }
      }
    };

    this.leadershipTimer = setTimeout(check, 30_000);
    if (this.leadershipTimer.unref) this.leadershipTimer.unref();
  }

  // ---- HTTP request handler ----

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50 MB

    let body = '';
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        oversized = true;
        req.destroy(new Error('Payload too large'));
      }
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };

      // req.destroy() on an oversized body (and any client-side stream fault)
      // emits 'error' but NOT 'end'. Without this the 'end'-only awaiter below
      // would never resolve — the handler would dangle and the client would
      // block until its own timeout. Respond (best-effort) and unblock.
      req.on('error', (err) => {
        logger.error('[EmbeddingServer] Request stream error:', err);
        if (!res.headersSent) {
          try {
            res.writeHead(oversized ? 413 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: oversized ? 'Payload too large' : 'Request stream error' }));
          } catch { /* socket may already be torn down */ }
        }
        finish();
      });

      req.on('end', async () => {
        try {
          if (req.method === 'GET' && req.url === '/health') {
            const payload = {
              status: 'ok',
              device: this.getDevice(),
              dimension: this.getDimension(),
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
            finish();
            return;
          }

          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end('Method Not Allowed');
            finish();
            return;
          }

          const data = JSON.parse(body);

          switch (req.url) {
            case '/embed': {
              const result = await this.queue.enqueue(() => this.embedder.embed(data.text as string));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ data: Array.from(result) }));
              break;
            }
            case '/embedMany': {
              const results = await this.queue.enqueue(() => this.embedder.embedMany(data.texts as string[]));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ results: results.map(r => Array.from(r)) }));
              break;
            }
            default:
              res.writeHead(404);
              res.end('Not Found');
          }
        } catch (error) {
          // Log full error internally for debugging
          logger.error('[EmbeddingServer] Error handling request:', error);

          // Extract safe error message - first line only to prevent stack trace exposure
          let errorMessage = 'Unknown error';
          if (error instanceof Error && error.message) {
            errorMessage = (error.message.split('\n')[0] || '').trim();
          } else if (typeof error === 'string') {
            errorMessage = (error.split('\n')[0] || '').trim();
          }

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errorMessage }));
        }
        finish();
      });
    });
  }
}
