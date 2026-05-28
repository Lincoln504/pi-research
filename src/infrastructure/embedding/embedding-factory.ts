/**
 * Embedding Factory
 *
 * Leader-election for the embedding server. Mirrors getScheduler() in
 * scheduler-factory.ts: one process wins and runs EmbeddingServer; all
 * others become EmbeddingClient instances pointing at the winner's port.
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import type { Config } from '../../config.ts';
import { getConfig } from '../../config.ts';
import { logger } from '../../logger.ts';
import { getService } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import type { IStateManager } from '../../core/interfaces/state-manager-interfaces.ts';
import type { IEmbedder } from '../../core/interfaces/knowledge-interfaces.ts';
import { Embedder } from '../../knowledge/embedder.ts';
import { getModelEmbedderConfig } from '../../knowledge/model-config.ts';
import { EmbeddingServer } from './embedding-server.ts';
import { EmbeddingClient } from './embedding-client.ts';

// ---------------------------------------------------------------------------
// Port probe — same helper as scheduler-factory.ts
// ---------------------------------------------------------------------------

async function isPortListening(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
    socket.connect(port, '127.0.0.1');
  });
}

// ---------------------------------------------------------------------------
// Simple PID-alive check (no state-manager dependency)
// ---------------------------------------------------------------------------

function isPidAliveStatic(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton cache (mirrors scheduler-factory.ts pattern)
// ---------------------------------------------------------------------------

let _embeddingInstance: IEmbedder | null = null;
let _embeddingInitPromise: Promise<IEmbedder> | null = null;

// ---------------------------------------------------------------------------
// getEmbedder — public entry point
// ---------------------------------------------------------------------------

export async function getEmbedder(config?: Config): Promise<IEmbedder> {
  if (_embeddingInstance) return _embeddingInstance;
  if (_embeddingInitPromise) return _embeddingInitPromise;

  let p: Promise<IEmbedder>;

  const init = async (): Promise<IEmbedder> => {
    const serverId = crypto.randomUUID();
    const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER);
    const cfg = config ?? getConfig();

    // ---- Fast path: existing leader ----
    const serverInfo = await stateManager.getEmbeddingServer();
    if (serverInfo) {
      const alive = isPidAliveStatic(serverInfo.pid);
      if (alive) {
        const portOk = await isPortListening(serverInfo.port);
        if (portOk) {
          logger.info(`[EmbeddingFactory] Connecting to existing embedding server on port ${serverInfo.port}`);
          const client = new EmbeddingClient(serverInfo.port);
          await client.fetchHealth();
          _embeddingInstance = client;
          return client;
        }
        await stateManager.clearEmbeddingServer().catch(() => {});
      }
    }

    // ---- Slow path: start a candidate server, then hold election ----
    const modelCfg = getModelEmbedderConfig(cfg.EMBEDDING_MODEL);
    const embedder = new Embedder({
      model: cfg.EMBEDDING_MODEL,
      pooling: modelCfg.pooling,
      queryPrefix: modelCfg.queryPrefix,
      initializationTimeoutMs: cfg.EMBEDDING_MODEL_INIT_TIMEOUT_MS,
      device: cfg.EMBEDDING_DEVICE,
      maxTokens: modelCfg.maxTokens,
      batchSize: modelCfg.batchSize,
      charsPerToken: modelCfg.charsPerToken,
      documentPrefix: modelCfg.documentPrefix,
      stateManager,
      useCache: modelCfg.useCache,
    });

    const server = new EmbeddingServer(embedder, stateManager, serverId);
    const port = await server.startServer();

    // ---- Compare-and-set election (atomic under the state lock) ----
    let wonElection = false;
    let winnerPort = port;

    await stateManager.updateState(async (state) => {
      if (state.embeddingServer) {
        const alive = isPidAliveStatic(state.embeddingServer.pid);
        if (alive) {
          winnerPort = state.embeddingServer.port;
          wonElection = false;
          return state;
        }
      }
      state.embeddingServer = { port, pid: process.pid, serverId };
      wonElection = true;
      return state;
    });

    if (!wonElection) {
      logger.info(`[EmbeddingFactory] Lost election, connecting to winner at port ${winnerPort}`);
      await server.shutdown();
      const client = new EmbeddingClient(winnerPort);
      await client.fetchHealth();
      _embeddingInstance = client;
      return client;
    }

    logger.info(`[EmbeddingFactory] Won election, serving as embedding leader on port ${port} (PID ${process.pid})`);
    // Start leadership check only after winning — model init (inside startServer)
    // can exceed the 30s interval, so starting earlier would produce false misses.
    server.startLeadershipCheck();
    _embeddingInstance = server;
    return server;
  };

  p = init();
  _embeddingInitPromise = p;
  p.then((r) => {
    _embeddingInstance = r;
    _embeddingInitPromise = null;
  }).catch(() => {
    _embeddingInitPromise = null;
  });
  return p;
}

// ---------------------------------------------------------------------------
// clearEmbeddingInstance — for testing / restart scenarios
// ---------------------------------------------------------------------------

export function clearEmbeddingInstance(): void {
  _embeddingInstance = null;
  _embeddingInitPromise = null;
}
