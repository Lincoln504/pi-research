/**
 * Leader-election model-identity guard.
 *
 * The leader state entry records which EMBEDDING_MODEL the leader serves. A
 * follower configured with a DIFFERENT model must NOT adopt that leader — two
 * sessions cross-embedding through one server silently corrupts the shared
 * vector space when the models have the same dimension. Instead the follower
 * falls back to a local in-process Embedder for its session (no competing
 * election: the leader's state entry is left untouched). Entries WITHOUT a
 * recorded model (written by an older process) are tolerated as matching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const embedderInstances: any[] = [];
vi.mock('../../../src/knowledge/embedder.ts', () => ({
  Embedder: class MockEmbedder {
    options: any;
    constructor(options: any) {
      this.options = options;
      embedderInstances.push(this);
    }
    async dispose() {}
  },
}));

const clientInstances: any[] = [];
vi.mock('../../../src/infrastructure/embedding/embedding-client.ts', () => ({
  EmbeddingClient: class MockEmbeddingClient {
    port: number;
    constructor(port: number) {
      this.port = port;
      clientInstances.push(this);
    }
    async fetchHealth() {}
    async dispose() {}
  },
}));

vi.mock('../../../src/infrastructure/embedding/embedding-server.ts', () => ({
  EmbeddingServer: class MockEmbeddingServer {
    async startServer() { return 45123; }
    startLeadershipCheck() {}
    async dispose() {}
  },
}));

// The factory port-probes an adopted leader with a real TCP connect; stub the
// socket so "leader is listening" is deterministic (no real server in a unit test).
vi.mock('node:net', () => {
  class MockSocket {
    private connectCb: (() => void) | null = null;
    setTimeout() {}
    once(ev: string, cb: () => void) { if (ev === 'connect') this.connectCb = cb; }
    connect() { setImmediate(() => this.connectCb?.()); }
    destroy() {}
  }
  return { Socket: MockSocket, default: { Socket: MockSocket } };
});

// Leader liveness must not depend on real PIDs in this test.
const mockState: { embeddingServer?: any } = {};
const stateManager = {
  updateState: vi.fn(async (fn: (s: any) => Promise<any> | any) => { await fn(mockState); }),
  getEmbeddingServer: vi.fn(async () => mockState.embeddingServer ?? null),
  clearEmbeddingServer: vi.fn(async () => { delete mockState.embeddingServer; }),
};
const processLifecycle = {
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

function makeConfig(model: string) {
  return {
    EMBEDDING_MODEL: model,
    EMBEDDING_DEVICE: 'cpu',
    EMBEDDING_MODEL_INIT_TIMEOUT_MS: 1000,
  } as any;
}

describe('embedding-factory model-identity guard', () => {
  beforeEach(() => {
    embedderInstances.length = 0;
    clientInstances.length = 0;
    delete mockState.embeddingServer;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await clearEmbeddingInstance();
  });

  it('records the leader model in the state entry when winning the election', async () => {
    await getEmbedder(makeConfig('model-a'));
    expect(mockState.embeddingServer?.model).toBe('model-a');
    expect(mockState.embeddingServer?.pid).toBe(process.pid);
  });

  it('refuses to adopt a live leader serving a DIFFERENT model and falls back to a local in-process embedder', async () => {
    mockState.embeddingServer = {
      port: 8123,
      pid: process.pid + 1,
      startTime: 999,
      serverId: 'other-session',
      model: 'model-b',
    };

    const result = await getEmbedder(makeConfig('model-a'));

    // Fell back to the local Embedder configured with OUR model...
    expect(embedderInstances).toHaveLength(1);
    expect(embedderInstances[0].options.model).toBe('model-a');
    expect(result).toBe(embedderInstances[0]);
    // ...did NOT connect to the mismatched leader...
    expect(clientInstances).toHaveLength(0);
    // ...and did NOT clobber or clear the live leader's entry (no competing election).
    expect(mockState.embeddingServer.serverId).toBe('other-session');
    expect(mockState.embeddingServer.model).toBe('model-b');
  });

  it('tolerates a legacy leader entry WITHOUT a recorded model (adopts it)', async () => {
    mockState.embeddingServer = {
      port: 8123,
      pid: process.pid + 1,
      startTime: 999,
      serverId: 'old-session',
      // no `model` — written by an older process
    };

    const result = await getEmbedder(makeConfig('model-a'));

    expect(clientInstances).toHaveLength(1);
    expect(clientInstances[0].port).toBe(8123);
    expect(result).toBe(clientInstances[0]);
    expect(embedderInstances).toHaveLength(0);
  });
});
