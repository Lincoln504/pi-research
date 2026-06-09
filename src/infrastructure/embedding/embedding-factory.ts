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
let _cachedModel: string | null = null;
let _cachedDevice: string | null = null;

// ---------------------------------------------------------------------------
// getEmbedder — public entry point
// ---------------------------------------------------------------------------

export async function getEmbedder(config?: Config): Promise<IEmbedder> {
  const cfg = config ?? getConfig();

  // If we have a cached instance, check if it matches the current config
  if (_embeddingInstance) {
    if (_cachedModel === cfg.EMBEDDING_MODEL && _cachedDevice === cfg.EMBEDDING_DEVICE) {
      return _embeddingInstance;
    }
    logger.info(`[EmbeddingFactory] Configuration change detected (${_cachedModel} on ${_cachedDevice} -> ${cfg.EMBEDDING_MODEL} on ${cfg.EMBEDDING_DEVICE}). Disposing stale instance.`);
    await _embeddingInstance.dispose?.();
    _embeddingInstance = null;
  }

  if (_embeddingInitPromise) return _embeddingInitPromise;

  let p: Promise<IEmbedder>;

  const init = async (): Promise<IEmbedder> => {
    const serverId = crypto.randomUUID();
    const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER);

    // ---- Phase 1: Atomically claim candidacy under the state lock ----
    // Writing port=-1 acts as a mutex: other processes that see it will wait
    // for the real port rather than starting their own model initialization.
    // This prevents concurrent GPU sessions and wasted init work.
    let iAmCandidate = false;
    let fastPathPort: number | null = null;

    await stateManager.updateState(async (state) => {
      if (state.embeddingServer) {
        const alive = isPidAliveStatic(state.embeddingServer.pid);
        if (alive) {
          // Either a real server (port > 0) or another process is initializing (port = -1)
          fastPathPort = state.embeddingServer.port;
          return state;
        }
        // Stale entry from a dead process — clear it
        delete state.embeddingServer;
      }
      // Claim the slot with sentinel port -1 to signal "initializing"
      state.embeddingServer = { port: -1, pid: process.pid, serverId };
      iAmCandidate = true;
      return state;
    });

    if (!iAmCandidate) {
      // Another process is already leader or initializing — wait for real port
      const POLL_INTERVAL_MS = 500;
      const POLL_TIMEOUT_MS = 120_000;
      const deadline = Date.now() + POLL_TIMEOUT_MS;

      logger.info(`[EmbeddingFactory] Another process is initializing (port=${fastPathPort}), waiting...`);

      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        const info = await stateManager.getEmbeddingServer();
        if (!info) {
          // Candidate died and cleared state — fall through to restart below
          break;
        }
        if (!isPidAliveStatic(info.pid)) {
          // Candidate process died without cleaning up
          await stateManager.clearEmbeddingServer().catch((err) => logger.debug('Swallowed clear embedding server error:', err));
          break;
        }
        if (info.port > 0) {
          const portOk = await isPortListening(info.port);
          if (portOk) {
            logger.info(`[EmbeddingFactory] Connecting to embedding server on port ${info.port}`);
            const client = new EmbeddingClient(info.port);
            await client.fetchHealth();
            _embeddingInstance = client;
            _cachedModel = cfg.EMBEDDING_MODEL;
            _cachedDevice = cfg.EMBEDDING_DEVICE;
            return client;
          }
          // Port registered but not responding — wait one more interval and re-check
          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
          const secondCheck = await isPortListening(info.port);
          if (!secondCheck) {
            logger.warn(`[EmbeddingFactory] Registered port ${info.port} is unreachable after two checks — clearing stale state`);
            await stateManager.clearEmbeddingServer().catch((err) => logger.debug('Swallowed clear embedding server error:', err));
            break;
          }
        }
      }

      // Timed out or candidate died — attempt to claim candidacy ourselves (tail-call)
      logger.warn('[EmbeddingFactory] Wait for embedding leader timed out or leader died, retrying...');
      _embeddingInitPromise = null;
      return getEmbedder(cfg);
    }

    // ---- Phase 2: We are the exclusive candidate — do model init ----
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
    let port: number;
    try {
      port = await server.startServer();
    } catch (err) {
      // Init failed — clear our placeholder so others can try
      await stateManager.clearEmbeddingServer().catch((err) => logger.debug('Swallowed clear embedding server error:', err));
      throw err;
    }

    // ---- Phase 3: Update state with real port ----
    await stateManager.updateState(async (state) => {
      if (state.embeddingServer?.serverId === serverId) {
        state.embeddingServer.port = port;
      }
      return state;
    });

    logger.info(`[EmbeddingFactory] Won election, serving as embedding leader on port ${port} (PID ${process.pid})`);
    // Start leadership check only after winning — model init (inside startServer)
    // can exceed the 30s interval, so starting earlier would produce false misses.
    server.startLeadershipCheck();
    _embeddingInstance = server;
    _cachedModel = cfg.EMBEDDING_MODEL;
    _cachedDevice = cfg.EMBEDDING_DEVICE;
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

export async function clearEmbeddingInstance(): Promise<void> {
  if (_embeddingInstance) {
    try {
      await _embeddingInstance.dispose?.();
    } catch (err) {
      logger.warn('[EmbeddingFactory] Error disposing old embedding instance:', err);
    }
  }
  _embeddingInstance = null;
  _embeddingInitPromise = null;
  _cachedModel = null;
  _cachedDevice = null;
}
