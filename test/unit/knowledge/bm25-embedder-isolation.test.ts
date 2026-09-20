import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

/**
 * Embedding-isolation tests for the bm25 (lexical) retrieval mode.
 *
 * The acceptance criterion under test here: selecting PI_RESEARCH_KNOWLEDGE_STORE_RETRIEVAL=bm25
 * must be a HARD dependency boundary — the embedder factory (and behind it
 * @huggingface/transformers) is never invoked, not even resolved, while the
 * store still initializes fully. The embedder factory below THROWS, which fails
 * every test loudly the moment the isolation is violated.
 */

// Track KnowledgeStore construction args so we can assert what the component
// factory actually wired together.
const storeCtorArgs: any[] = [];
vi.mock('../../../src/knowledge/store.ts', () => ({
  KnowledgeStore: vi.fn().mockImplementation(function (...args: any[]) {
    storeCtorArgs.push(args[0]);
    return {
      name: 'knowledge-store',
      lifecycle: 'uninitialized',
      initialize: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('../../../src/knowledge/writer-queue.ts', () => ({
  WriterQueue: vi.fn().mockImplementation(function () {
    return {
      name: 'writer-queue',
      lifecycle: 'uninitialized',
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn(), runCapturingStderr: vi.fn(async (fn: () => any) => fn()) },
}));

import { createKnowledgeStoreComponents } from '../../../src/knowledge/index.ts';
import { DEFAULTS, type Config } from '../../../src/config.ts';

function bm25Config(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    KNOWLEDGE_STORE_MODE: 'project',
    KNOWLEDGE_STORE_RETRIEVAL: 'bm25',
    EMBEDDING_MODEL: 'should-never-be-loaded',
    ...overrides,
  } as Config;
}

describe('bm25 retrieval mode — embedding isolation', () => {
  let testDbDir: string;

  beforeEach(() => {
    storeCtorArgs.length = 0;
    testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-bm25-iso-'));
  });

  it('never invokes the embedder factory — the transformers boundary is hard', async () => {
    const embedderFactory = vi.fn(async () => {
      throw new Error('EMBEDDING ISOLATION VIOLATED — embedder factory was called in bm25 mode');
    });

    const components = await createKnowledgeStoreComponents(
      embedderFactory,
      undefined,
      undefined,
      bm25Config(),
      testDbDir,
      { available: true, missing: [] }, // probe pre-emptied: bm25 does not need transformers
    );

    expect(components).not.toBeNull();
    expect(embedderFactory).not.toHaveBeenCalled();
    // And the resulting components carry NO embedder.
    expect(components!.embedder).toBeNull();
  });

  it('constructs the store in bm25 retrieval mode with a null embedder', async () => {
    const components = await createKnowledgeStoreComponents(
      async () => { throw new Error('EMBEDDING ISOLATION VIOLATED'); },
      undefined,
      undefined,
      bm25Config(),
      testDbDir,
      { available: true, missing: [] },
    );

    expect(components).not.toBeNull();
    expect(storeCtorArgs).toHaveLength(1);
    expect(storeCtorArgs[0]!.retrieval).toBe('bm25');
    expect(storeCtorArgs[0]!.embedder).toBeNull();
    // The (unused) embedding model name must not leak into the store as if real.
    expect(storeCtorArgs[0]!.modelName).toBe('should-never-be-loaded');
  });

  it('vector mode still wires the embedder through (unchanged behavior)', async () => {
    const embedder = {
      getDevice: () => 'cpu',
      getOriginalDevice: () => 'cpu',
      getDimension: () => 384,
      setDimension: () => {},
      isInitialized: () => true,
      embed: async () => new Float32Array(384),
      embedMany: async (texts: string[]) => texts.map(() => new Float32Array(384)),
      dispose: async () => {},
    };
    const embedderFactory = vi.fn(async () => embedder);

    const components = await createKnowledgeStoreComponents(
      embedderFactory,
      undefined,
      undefined,
      bm25Config({ KNOWLEDGE_STORE_RETRIEVAL: 'vector' }),
      testDbDir,
      { available: true, missing: [] },
    );

    expect(components).not.toBeNull();
    expect(embedderFactory).toHaveBeenCalledTimes(1);
    expect(components!.embedder).toBe(embedder);
    expect(storeCtorArgs[0]!.retrieval).toBe('vector');
    expect(storeCtorArgs[0]!.embedder).toBe(embedder);
  });

  it('mode=none still disables the store entirely regardless of retrieval mode', async () => {
    const embedderFactory = vi.fn(async () => { throw new Error('should not be called'); });
    const components = await createKnowledgeStoreComponents(
      embedderFactory,
      undefined,
      undefined,
      bm25Config({ KNOWLEDGE_STORE_MODE: 'none' }),
      testDbDir,
      { available: true, missing: [] },
    );
    expect(components).toBeNull();
    expect(embedderFactory).not.toHaveBeenCalled();
  });
});
