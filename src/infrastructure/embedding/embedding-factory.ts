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
import type { IProcessLifecycle } from '../../core/interfaces/process-interfaces.ts';
import type { IEmbedder } from '../../core/interfaces/knowledge-interfaces.ts';
import { Embedder } from '../../knowledge/embedder.ts';
import { getModelEmbedderConfig } from '../../knowledge/model-config.ts';

import { EmbeddingServer, getEmbeddingServerAuthSecret } from './embedding-server.ts';
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
// Leader liveness — PID paired with start-time to defeat PID reuse
// ---------------------------------------------------------------------------

/**
 * Decide whether a persisted embedding-leader entry still refers to a live process.
 *
 * Pairs the recorded PID with its start-time (when present) so a recycled PID — the OS
 * handing a dead leader's PID to an unrelated new process, which a bare signal-0 check
 * would mistake for the still-running leader — is correctly reported dead. This matches
 * the PID-reuse handling the GPU lock and session cleanup already use. Entries written
 * before start-time was recorded (no `startTime`) degrade to a bare liveness check, so
 * older on-disk state keeps working with no migration.
 *
 * The reachable failure this closes is narrow: a leader that dies mid-model-init (its
 * entry still carries the sentinel port -1, so the port probe is skipped) whose PID the
 * OS then recycles. Without start-time the waiter would spin the full poll timeout on a
 * leader that will never come; with it the stale entry is cleared immediately.
 */
export async function isEmbeddingLeaderAlive(
  info: { pid: number; startTime?: number },
  processLifecycle: Pick<IProcessLifecycle, 'isProcessAlive'>,
): Promise<boolean> {
  return processLifecycle.isProcessAlive(info.pid, info.startTime);
}

// ---------------------------------------------------------------------------
// Module-level singleton cache (mirrors scheduler-factory.ts pattern)
// ---------------------------------------------------------------------------

let _embeddingInstance: IEmbedder | null = null;
let _embeddingInitPromise: Promise<IEmbedder> | null = null;
// Config the in-flight init was started for. The join below must compare against
// these — the cached-instance path checks model/device before reuse, and the
// adoption paths refuse mismatched leaders, but a caller joining a promise built
// for a different config would silently receive (and stamp the cache with) the
// wrong-model embedder, defeating both guards.
let _initModel: string | null = null;
let _initDevice: string | null = null;
let _cachedModel: string | null = null;
let _cachedDevice: string | null = null;

// ---------------------------------------------------------------------------
// getEmbedder — public entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// In-process Embedder construction — shared by the leader path (wrapped in an
// EmbeddingServer) and the model-mismatch fallback (used bare, never elected).
// ---------------------------------------------------------------------------

function buildInProcessEmbedder(cfg: Config, stateManager: IStateManager): Embedder {
  const modelCfg = getModelEmbedderConfig(cfg.EMBEDDING_MODEL);
  return new Embedder({
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
}

// Bounds the leader-wait retry tail-call below. Without a cap, a cluster where no
// process can ever become leader (e.g. every model init OOMs) would recurse
// forever, each hop doing a state-lock round-trip and accumulating async frames.
const MAX_LEADER_WAIT_RETRIES = 5;

export async function getEmbedder(config?: Config, _attempt = 0): Promise<IEmbedder> {
  const cfg = config ?? getConfig();

  // If we have a cached instance, check if it matches the current config
  if (_embeddingInstance) {
    if (_cachedModel === cfg.EMBEDDING_MODEL && _cachedDevice === cfg.EMBEDDING_DEVICE) {
      return _embeddingInstance;
    }
    logger.info(`[EmbeddingFactory] Configuration change detected (${_cachedModel} on ${_cachedDevice} -> ${cfg.EMBEDDING_MODEL} on ${cfg.EMBEDDING_DEVICE}). Disposing stale instance.`);
    // Claim the instance SYNCHRONOUSLY, before the first await. Two callers that
    // resolve different EMBEDDING_MODEL/EMBEDDING_DEVICE values would otherwise both
    // observe it, both await dispose() on the same live EmbeddingServer (double
    // close(), double embedder dispose) and both proceed to init().
    const stale = _embeddingInstance;
    _embeddingInstance = null;
    await stale.dispose?.();
  }

  // An internal retry (_attempt > 0) is re-entering from INSIDE the promise stored
  // here, so handing that promise back would make it await itself. Only a fresh
  // external call may join an in-flight init — and only one started for the SAME
  // config: a mismatched joiner would get the wrong-model embedder (same-dimension
  // models cross-embed silently). On mismatch, wait the in-flight init out (never
  // race a second election in this process), then re-resolve for this config — the
  // cached-instance check above disposes the mismatched instance.
  if (_embeddingInitPromise && _attempt === 0) {
    if (_initModel === cfg.EMBEDDING_MODEL && _initDevice === cfg.EMBEDDING_DEVICE) {
      return _embeddingInitPromise;
    }
    await _embeddingInitPromise.catch(() => {});
    return getEmbedder(cfg, _attempt);
  }

  let p: Promise<IEmbedder>;

  const init = async (): Promise<IEmbedder> => {
    const serverId = crypto.randomUUID();
    const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER);
    const processLifecycle = await getService<IProcessLifecycle>(ServiceNames.PROCESS_LIFECYCLE);
    // Recorded alongside our PID so another process can distinguish "leader still
    // alive" from "our PID was recycled after we died" (getCurrentProcessStartTime
    // caches, so this is a single cheap read). Null on a platform where it cannot be
    // read → the entry omits it and liveness falls back to a bare signal-0 check.
    const myStartTime = await processLifecycle.getCurrentProcessStartTime();

    // ---- Phase 1: Atomically claim candidacy under the state lock ----
    // Writing port=-1 acts as a mutex: other processes that see it will wait
    // for the real port rather than starting their own model initialization.
    // This prevents concurrent GPU sessions and wasted init work.
    let iAmCandidate = false;
    let fastPathPort: number | null = null;
    let fastPathModel: string | null = null;

    await stateManager.updateState(async (state) => {
      if (state.embeddingServer) {
        const alive = await isEmbeddingLeaderAlive(state.embeddingServer, processLifecycle);
        if (alive) {
          // Either a real server (port > 0) or another process is initializing (port = -1)
          fastPathPort = state.embeddingServer.port;
          fastPathModel = state.embeddingServer.model ?? null;
          return state;
        }
        // Stale entry from a dead process — clear it
        delete state.embeddingServer;
      }
      // Claim the slot with sentinel port -1 to signal "initializing". Record the
      // model we will serve so followers with a DIFFERENT configured model can
      // refuse adoption (see mismatch check below) instead of silently
      // cross-embedding into a shared vector space.
      state.embeddingServer = {
        port: -1,
        pid: process.pid,
        serverId,
        model: cfg.EMBEDDING_MODEL,
        // Published with the claim, not with the port, so a follower that adopts
        // this leader always has the secret available whenever the port is.
        authSecret: getEmbeddingServerAuthSecret(),
        ...(myStartTime !== null ? { startTime: myStartTime } : {}),
      };
      iAmCandidate = true;
      return state;
    });

    // A live leader serving a DIFFERENT model must not be adopted: two sessions
    // with different EMBEDDING_MODELs would cross-embed (same-dimension models
    // corrupt the vector space silently). Fall back to a local in-process
    // embedder for this session — no competing election, the leader's entry is
    // left untouched. Entries without a recorded model (older process) are
    // tolerated as matching.
    const localFallbackForMismatch = (leaderModel: string): IEmbedder => {
      logger.warn(
        `[EmbeddingFactory] Live embedding leader serves model "${leaderModel}" but this session is configured for ` +
        `"${cfg.EMBEDDING_MODEL}". Not adopting it — using a local in-process embedder for this session.`,
      );
      const embedder = buildInProcessEmbedder(cfg, stateManager);
      _embeddingInstance = embedder;
      _cachedModel = cfg.EMBEDDING_MODEL;
      _cachedDevice = cfg.EMBEDDING_DEVICE;
      return embedder;
    };

    if (!iAmCandidate) {
      if (fastPathModel !== null && fastPathModel !== cfg.EMBEDDING_MODEL) {
        return localFallbackForMismatch(fastPathModel);
      }
      // Another process is already leader or initializing — wait for real port
      const POLL_INTERVAL_MS = 500;
      const POLL_TIMEOUT_MS = 120_000;
      const deadline = Date.now() + POLL_TIMEOUT_MS;

      /**
       * How many CONSECUTIVE polls must find a confirmed-live leader's endpoint
       * unusable before its registration is judged stale.
       *
       * Deleting a live leader's entry is the expensive mistake in this loop: the
       * leader is not told, treats a missing entry as benign, and never steps down,
       * so the follower's subsequent election produces a second model init and a
       * second GPU context while the first server keeps running, invisible. The old
       * code reached that from two failed TCP probes ~2.5s apart — well inside a
       * blip from a saturated accept backlog, a paused event loop during a large
       * batch embed, or CPU starvation on a shared box.
       *
       * Not clearing at all is not the answer either: a leader whose HTTP server
       * died while the process lives on leaves a registration nothing else collects,
       * and every later process then falls back to its own in-process embedder. So
       * the threshold is raised rather than removed. Each iteration costs the poll
       * interval plus up to the 2s probe timeout, making this roughly 25s of
       * uninterrupted unreachability — far past any blip, far short of the 120s wait.
       */
      const UNREACHABLE_POLLS_BEFORE_STALE = 10;
      let unreachablePolls = 0;
      let unreachableEndpoint: string | null = null;

      logger.info(`[EmbeddingFactory] Another process is initializing (port=${fastPathPort}), waiting...`);

      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        const info = await stateManager.getEmbeddingServer();
        if (!info) {
          // Candidate died and cleared state — fall through to restart below
          break;
        }
        if (!(await isEmbeddingLeaderAlive(info, processLifecycle))) {
          // Candidate process died without cleaning up (or its PID was recycled by
          // an unrelated process — the start-time pairing catches that too).
          // serverId-scoped: several waiters typically detect the death in the same
          // poll tick; the first one's clear+claim can commit before this one's clear
          // runs, and an unconditional delete here would deregister that NEW claimant
          // (whose Phase-3 port publish is CAS-guarded and silently no-ops) — leaving
          // two concurrent model inits and an invisible leader.
          await stateManager.clearEmbeddingServer({ serverId: info.serverId }).catch((err) => logger.debug('Swallowed clear embedding server error:', err));
          break;
        }
        // Re-check model identity every poll: the leader may have changed while
        // we waited (old one died, a new one with a different model claimed).
        if (info.model !== undefined && info.model !== cfg.EMBEDDING_MODEL) {
          return localFallbackForMismatch(info.model);
        }
        if (info.port > 0) {
          // A new claimant resets the streak — the count must describe ONE endpoint's
          // continuous unreachability, not a tally across successive leaders.
          const endpoint = `${info.serverId}:${info.port}`;
          if (endpoint !== unreachableEndpoint) {
            unreachableEndpoint = endpoint;
            unreachablePolls = 0;
          }

          // Reaching the counter below means "not usable this poll" by construction:
          // the only usable outcome returns.
          if (await isPortListening(info.port)) {
            logger.info(`[EmbeddingFactory] Connecting to embedding server on port ${info.port}`);
            const client = new EmbeddingClient(info.port, cfg.EMBEDDING_DEVICE, info.authSecret);
            try {
              await client.fetchHealth();
              _embeddingInstance = client;
              _cachedModel = cfg.EMBEDDING_MODEL;
              _cachedDevice = cfg.EMBEDDING_DEVICE;
              return client;
            } catch (err) {
              // The socket accepted but the server did not answer. Previously this
              // rejected out of getEmbedder entirely, so one failed health request
              // against an otherwise-recoverable leader (mid model swap, momentarily
              // wedged) took embedding down for the whole session instead of costing
              // one poll. Count it as an unreachable poll and keep waiting.
              logger.debug(`[EmbeddingFactory] Health check against port ${info.port} failed:`, err);
            }
          }

          unreachablePolls++;
          if (unreachablePolls >= UNREACHABLE_POLLS_BEFORE_STALE) {
            logger.warn(
              `[EmbeddingFactory] Registered port ${info.port} unreachable for ${unreachablePolls} consecutive polls ` +
              `(PID ${info.pid} is alive) — treating the registration as stale and electing a replacement.`,
            );
            // serverId-scoped: this snapshot is many seconds old by now and the entry
            // may already belong to a new claimant. See the dead-leader clear above
            // for the failure an unconditional delete causes.
            await stateManager.clearEmbeddingServer({ serverId: info.serverId }).catch((err) => logger.debug('Swallowed clear embedding server error:', err));
            break;
          }
        }
      }

      // Timed out or candidate died — attempt to claim candidacy ourselves (tail-call).
      // The in-flight marker is deliberately LEFT in place: clearing it here, while
      // this very promise is still running, let a concurrent getEmbedder() see no
      // instance and no init in flight and start a second, competing election in the
      // same process. The retry re-enters with _attempt > 0, which skips the join
      // above, so leaving it set cannot deadlock.
      if (_attempt + 1 >= MAX_LEADER_WAIT_RETRIES) {
        throw new Error(
          `[EmbeddingFactory] Could not obtain an embedding server after ${MAX_LEADER_WAIT_RETRIES} attempts ` +
          `(no process became leader; model init may be failing repeatedly).`,
        );
      }
      logger.warn(`[EmbeddingFactory] Wait for embedding leader timed out or leader died, retrying (attempt ${_attempt + 2}/${MAX_LEADER_WAIT_RETRIES})...`);
      return getEmbedder(cfg, _attempt + 1);
    }

    // ---- Phase 2: We are the exclusive candidate — do model init ----
    const embedder = buildInProcessEmbedder(cfg, stateManager);

    const server = new EmbeddingServer(embedder, stateManager, serverId, () => {
      // This leader poisoned itself after a permanently hung inference; drop the
      // cached singleton so this process's next getEmbedder() re-elects. The store's
      // reconnectFactory also triggers on the first fast-failed embed, so cluster
      // recovery does not depend solely on this hook.
      void clearEmbeddingInstance();
    });
    let port: number;
    try {
      port = await server.startServer();
    } catch (err) {
      // Init failed — clear our placeholder so others can try. serverId-scoped so a
      // concurrent steal-and-reclaim (a waiter that judged us dead and claimed) is
      // never deregistered by our own failure path.
      await stateManager.clearEmbeddingServer({ serverId }).catch((err) => logger.debug('Swallowed clear embedding server error:', err));
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
  _initModel = cfg.EMBEDDING_MODEL;
  _initDevice = cfg.EMBEDDING_DEVICE;
  // init() already assigns _embeddingInstance before it resolves, so do NOT
  // re-assign it here. If clearEmbeddingInstance() ran (and disposed the server)
  // between init resolving and this microtask, re-assigning would resurrect the
  // disposed instance and hand it to the next getEmbedder() caller. Only clear
  // the in-flight promise marker.
  // Clear the marker only if it is STILL ours. An unconditional clear let a settling
  // promise wipe a newer caller's in-flight marker — admitting yet another election,
  // and cascading. Same guard as scheduler-factory's initialization promise.
  const clearIfCurrent = (): void => {
    if (_embeddingInitPromise === p) _embeddingInitPromise = null;
  };
  p.then(clearIfCurrent).catch(clearIfCurrent);
  return p;
}

// ---------------------------------------------------------------------------
// clearEmbeddingInstance — for testing / restart scenarios
// ---------------------------------------------------------------------------

/**
 * Does THIS process currently hold a live embedding server (as opposed to a client
 * pointing at someone else's, or nothing at all)?
 *
 * Asked by the teardown-time state clear, which is pid-scoped and therefore cannot
 * tell "my leftover registration" from "my server that is still listening". That
 * clear runs before disposeAllServices, so at that moment our own server usually
 * IS still up — and deleting its entry makes it an invisible leader, since its
 * leadership check reads a missing entry as benign and never steps down. Its own
 * dispose clears the entry properly, keyed on serverId.
 */
export function ownsLiveEmbeddingServer(): boolean {
    return _embeddingInstance !== null && _embeddingInstance instanceof EmbeddingServer;
}

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
