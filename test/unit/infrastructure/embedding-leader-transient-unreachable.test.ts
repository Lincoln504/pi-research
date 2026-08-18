/**
 * A follower must not deregister a CONFIRMED-LIVE embedding leader over a transient
 * port probe.
 *
 * The wait loop probes the registered port with a 2s TCP connect. On failure it used
 * to probe once more ~500ms later and, if that also failed, call
 * clearEmbeddingServer() — even though isEmbeddingLeaderAlive had just confirmed the
 * leader's process is alive. Two failures 2.5s apart is well inside an ordinary blip:
 * a saturated accept backlog, an event loop paused by a large batch embed, CPU
 * starvation on a shared box.
 *
 * Deleting that entry is the expensive mistake. The leader is never told, treats a
 * missing registration as benign, and does not step down; the follower then wins its
 * own election and initializes the model again — a second GPU context, with the first
 * server still running and now invisible to everyone.
 *
 * Not clearing at all is also wrong: a leader whose HTTP server died while the process
 * lived on leaves a registration nothing else collects, and every later process falls
 * back to its own in-process embedder. So the threshold is raised, not removed —
 * sustained unreachability still elects a replacement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const embedderInstances: any[] = [];
vi.mock('../../../src/knowledge/embedder.ts', () => ({
  Embedder: class MockEmbedder {
    options: any;
    constructor(options: any) { this.options = options; embedderInstances.push(this); }
    async dispose() {}
  },
}));

const clientInstances: any[] = [];
const fetchHealthTimeouts: Array<number | undefined> = [];
vi.mock('../../../src/infrastructure/embedding/embedding-client.ts', () => ({
  EmbeddingClient: class MockEmbeddingClient {
    port: number;
    constructor(port: number) { this.port = port; clientInstances.push(this); }
    async fetchHealth(timeoutMs?: number) {
      fetchHealthTimeouts.push(timeoutMs);
      if (healthShouldFail) throw new Error('health check failed');
    }
    async dispose() {}
  },
}));

vi.mock('../../../src/infrastructure/embedding/embedding-server.ts', () => ({
  EmbeddingServer: class MockEmbeddingServer {
    async startServer() { return 45123; }
    startLeadershipCheck() {}
    async dispose() {}
  },
  getEmbeddingServerAuthSecret: () => 'mock-embedding-secret',
}));

/**
 * Probe outcome is driven by `portReachable`, and settled SYNCHRONOUSLY inside
 * connect() so the probe needs no timer — only the loop's poll sleeps do, which keeps
 * the fake-timer stepping below honest.
 */
let portReachable = false;
let probeCount = 0;
let healthShouldFail = false;
vi.mock('node:net', () => {
  class MockSocket {
    private handlers: Record<string, () => void> = {};
    setTimeout() {}
    once(ev: string, cb: () => void) { this.handlers[ev] = cb; }
    connect() {
      probeCount++;
      if (portReachable) this.handlers['connect']?.();
      else this.handlers['error']?.();
    }
    destroy() {}
  }
  return { Socket: MockSocket, default: { Socket: MockSocket } };
});

const LIVE_LEADER = {
  port: 45999,
  pid: 4242,
  serverId: 'leader-abc',
  model: 'model-a',
  authSecret: 's',
  startTime: 999,
};

const mockState: { embeddingServer?: any } = {};
const stateManager = {
  updateState: vi.fn(async (fn: (s: any) => Promise<any> | any) => { await fn(mockState); }),
  getEmbeddingServer: vi.fn(async () => mockState.embeddingServer ?? null),
  clearEmbeddingServer: vi.fn(async () => { delete mockState.embeddingServer; }),
};
const processLifecycle = {
  // The leader's process is alive throughout. That is the whole point.
  isProcessAlive: vi.fn(async () => true),
  getCurrentProcessStartTime: vi.fn(async () => 12345),
};

vi.mock('../../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getService: vi.fn(async (name: string) => {
      if (name === 'state-manager') return stateManager;
      if (name === 'process-lifecycle') return processLifecycle;
      throw new Error(`Unexpected service requested in test: ${name}`);
    }),
  };
});

import { getEmbedder, clearEmbeddingInstance } from '../../../src/infrastructure/embedding/embedding-factory.ts';

const config = { EMBEDDING_MODEL: 'model-a', EMBEDDING_DEVICE: 'cpu', EMBEDDING_MODEL_INIT_TIMEOUT_MS: 1000 } as any;

/** Step the loop forward by `polls` iterations of its 500ms sleep. */
async function stepPolls(polls: number): Promise<void> {
  for (let i = 0; i < polls; i++) await vi.advanceTimersByTimeAsync(500);
}

describe('embedding follower — a live leader that fails a port probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    embedderInstances.length = 0;
    clientInstances.length = 0;
    fetchHealthTimeouts.length = 0;
    probeCount = 0;
    portReachable = false;
    healthShouldFail = false;
    mockState.embeddingServer = { ...LIVE_LEADER };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearEmbeddingInstance();
  });

  it('keeps waiting through a blip and adopts the leader when it answers again', async () => {
    const pending = getEmbedder(config);

    // Three consecutive failed probes — one more than the old two-strike rule.
    await stepPolls(3);
    expect(probeCount).toBeGreaterThanOrEqual(2);
    expect(stateManager.clearEmbeddingServer).not.toHaveBeenCalled();
    expect(mockState.embeddingServer).toMatchObject({ serverId: 'leader-abc' });

    portReachable = true;
    await stepPolls(2);

    const embedder = await pending;
    // Adopted the existing leader rather than electing a second one.
    expect(clientInstances).toHaveLength(1);
    expect(clientInstances[0].port).toBe(LIVE_LEADER.port);
    expect(embedder).toBe(clientInstances[0]);
    expect(embedderInstances).toHaveLength(0);
    expect(stateManager.clearEmbeddingServer).not.toHaveBeenCalled();
  });

  it('survives a failed health check on an otherwise reachable leader', async () => {
    // The socket accepted but the server did not answer. This used to reject straight
    // out of getEmbedder, taking embedding down for the whole session over one bad
    // request instead of costing a single poll.
    portReachable = true;
    healthShouldFail = true;

    const pending = getEmbedder(config);
    await stepPolls(3);
    expect(stateManager.clearEmbeddingServer).not.toHaveBeenCalled();

    healthShouldFail = false;
    await stepPolls(2);

    await expect(pending).resolves.toBe(clientInstances[clientInstances.length - 1]);
  });

  it('still elects a replacement when the endpoint stays unreachable', async () => {
    // The threshold exists to distinguish a blip from a dead server, not to make the
    // registration immortal.
    const pending = getEmbedder(config);
    await stepPolls(14);

    expect(stateManager.clearEmbeddingServer).toHaveBeenCalledWith({ serverId: 'leader-abc' });

    // The retry re-enters, finds no leader, and elects itself.
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBeDefined();
    expect(embedderInstances.length).toBeGreaterThan(0);
  });

  it('probes health with a short, poll-scale timeout — never the client default of 120s', async () => {
    // Regression: the unreachable-poll counter above assumes each iteration costs
    // roughly the poll interval plus a ~2s probe. Calling fetchHealth() with no
    // timeout silently uses EmbeddingClient's general-purpose 120s default, so a
    // leader that is merely busy (not dead) can take the full 120s to answer —
    // blowing the outer 120s poll timeout long before this counter would ever fire,
    // and turning "wait a poll, try again" into "give up and retry the whole
    // election" against a leader that was never actually unreachable.
    portReachable = true;

    const pending = getEmbedder(config);
    await stepPolls(2);
    const embedder = await pending;

    expect(embedder).toBe(clientInstances[0]);
    expect(fetchHealthTimeouts.length).toBeGreaterThan(0);
    for (const timeoutMs of fetchHealthTimeouts) {
      expect(timeoutMs).toBeDefined();
      expect(timeoutMs).toBeLessThanOrEqual(5_000);
    }
  });
});
