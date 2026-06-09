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
  private readonly tasks: Array<() => Promise<void>> = [];

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tasks.push(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      if (!this.running) void this.pump();
    });
  }

  private async pump(): Promise<void> {
    // FIX (#19): Guard against empty array (edge case from concurrent enqueue + pump)
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift();
        if (task) {
          await task();
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

// ---------------------------------------------------------------------------
// EmbeddingServer
// ---------------------------------------------------------------------------

export class EmbeddingServer implements IEmbedder {
  private server: http.Server | null = null;
  private leadershipTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveLeadershipMisses = 0;
  private readonly LEADERSHIP_MISS_THRESHOLD = 3;
  private isShuttingDown = false;
  private readonly queue = new SerialQueue();

  // Public dimension field so store.ts can set it via `(embedder as any).dimension = dim`
  dimension: number | null = null;

  constructor(
    private readonly embedder: Embedder,
    private readonly stateManager: IStateManager,
    public readonly serverId: string,
  ) {
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

  isInitialized(): boolean {
    return this.embedder.isInitialized();
  }

  async embed(text: string): Promise<Float32Array> {
    return this.queue.enqueue(() => this.embedder.embed(text));
  }

  async embedMany(texts: string[]): Promise<(Float32Array | number[])[]> {
    return this.queue.enqueue(() => this.embedder.embedMany(texts));
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
    const logFile = buildDefaultDebugLogPath('embedding-server');
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

  async shutdown(): Promise<void> {
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
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          resolve();
        });
      }).catch(() => { this.server = null; });
    }

    await this.embedder.dispose().catch((err) => {
      logger.warn('[EmbeddingServer] Error disposing embedder:', err);
    });
  }

  // ---- Leadership check ----

  startLeadershipCheck(): void {
    const check = async () => {
      if (this.isShuttingDown) return;
      try {
        const serverInfo = await this.stateManager.getEmbeddingServer();
        if (serverInfo?.serverId !== this.serverId) {
          this.consecutiveLeadershipMisses++;
          logger.warn(
            `[EmbeddingServer] Leadership check failed (${this.consecutiveLeadershipMisses}/${this.LEADERSHIP_MISS_THRESHOLD}) — ` +
            `expected ${this.serverId}, found ${serverInfo?.serverId ?? 'none'}`,
          );
          if (this.consecutiveLeadershipMisses >= this.LEADERSHIP_MISS_THRESHOLD) {
            logger.error('[EmbeddingServer] Leadership lost, shutting down...');
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
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        req.destroy(new Error('Payload too large'));
      }
    });

    req.on('error', (err) => {
      logger.error('[EmbeddingServer] Request stream error:', err);
    });

    await new Promise<void>((resolve) => {
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
            resolve();
            return;
          }

          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end('Method Not Allowed');
            resolve();
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
        resolve();
      });
    });
  }
}
