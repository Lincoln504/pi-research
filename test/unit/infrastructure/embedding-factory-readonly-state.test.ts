/**
 * Read-only state (mixed-version window) must degrade embedding to a
 * coordination-free mode.
 *
 * When a NEWER build's state file is on disk, the state manager suppresses all
 * writes (read-only mode) — so the port=-1 candidacy claim is never visible to
 * other processes, every process would "win" its own election, and the GPU lock
 * always reads as unowned: the concurrent-GPU-init segfault class election and
 * lock exist to prevent. The factory must instead skip election entirely and
 * build a local in-process embedder forced onto CPU (a CPU device never touches
 * the GPU lock, and concurrent CPU inference across processes is safe).
 *
 * The flag is set LAZILY by the first read that encounters the newer file —
 * which can be the candidacy updateState itself — so the factory checks both
 * before the claim and after it.
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

const serverInstances: any[] = [];
vi.mock('../../../src/infrastructure/embedding/embedding-server.ts', () => ({
  EmbeddingServer: class MockEmbeddingServer {
    constructor() {
      serverInstances.push(this);
    }
    async startServer() { return 45123; }
    startLeadershipCheck() {}
    async dispose() {}
  },
  getEmbeddingServerAuthSecret: () => 'mock-embedding-secret',
}));

const mockState: { embeddingServer?: any } = {};
let readOnly = false;
// Set to make updateState flip `readOnly` mid-call, simulating the lazy
// flag: the candidacy update's own read is the first to see the newer file.
let flipReadOnlyDuringUpdate = false;
const stateManager = {
  isReadOnly: vi.fn(() => readOnly),
  updateState: vi.fn(async (fn: (s: any) => Promise<any> | any) => {
    if (flipReadOnlyDuringUpdate) readOnly = true;
    // In real read-only mode the mutation is silently discarded (write
    // suppressed); model that by running the updater against a throwaway copy.
    await fn(readOnly ? {} : mockState);
  }),
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

function makeConfig(device: string) {
  return {
    EMBEDDING_MODEL: 'model-a',
    EMBEDDING_DEVICE: device,
    EMBEDDING_MODEL_INIT_TIMEOUT_MS: 1000,
  } as any;
}

describe('embedding-factory read-only-state degradation', () => {
  beforeEach(() => {
    embedderInstances.length = 0;
    clientInstances.length = 0;
    serverInstances.length = 0;
    delete mockState.embeddingServer;
    readOnly = false;
    flipReadOnlyDuringUpdate = false;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await clearEmbeddingInstance();
  });

  it('skips election entirely and builds a local CPU embedder when the state is already read-only', async () => {
    readOnly = true;

    const result = await getEmbedder(makeConfig('webgpu'));

    // Local in-process embedder, forced onto CPU despite the webgpu config —
    // a CPU device never touches the GPU lock.
    expect(embedderInstances).toHaveLength(1);
    expect(embedderInstances[0].options.device).toBe('cpu');
    expect(result).toBe(embedderInstances[0]);
    // No election attempt, no server, no client, no state entry.
    expect(stateManager.updateState).not.toHaveBeenCalled();
    expect(serverInstances).toHaveLength(0);
    expect(clientInstances).toHaveLength(0);
    expect(mockState.embeddingServer).toBeUndefined();
  });

  it('catches the LAZY flag: read-only discovered by the candidacy update itself still degrades to local CPU', async () => {
    flipReadOnlyDuringUpdate = true;

    const result = await getEmbedder(makeConfig('webgpu'));

    // The claim write was suppressed — the factory must NOT proceed as leader.
    expect(serverInstances).toHaveLength(0);
    expect(embedderInstances).toHaveLength(1);
    expect(embedderInstances[0].options.device).toBe('cpu');
    expect(result).toBe(embedderInstances[0]);
    expect(mockState.embeddingServer).toBeUndefined();
  });

  it('normal (writable) state still elects a leader and starts the server', async () => {
    const result = await getEmbedder(makeConfig('cpu'));

    expect(serverInstances).toHaveLength(1);
    expect(mockState.embeddingServer?.pid).toBe(process.pid);
    expect(result).toBeDefined();
  });

  it('a state manager WITHOUT isReadOnly (structural test double) is treated as writable', async () => {
    delete (stateManager as any).isReadOnly;
    try {
      const result = await getEmbedder(makeConfig('cpu'));
      expect(serverInstances).toHaveLength(1);
      expect(result).toBeDefined();
    } finally {
      (stateManager as any).isReadOnly = vi.fn(() => readOnly);
    }
  });
});
