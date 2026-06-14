import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

// Mock fs/promises
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises') as any;
  return {
    ...actual,
    rename: vi.fn().mockImplementation(actual.rename),
  };
});

import * as fsPromises from 'node:fs/promises';

// Mock Embedder
const mockEmbedder = {
  getDimension: vi.fn().mockReturnValue(384),
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  embedMany: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(384))),
  isInitialized: vi.fn().mockReturnValue(true),
} as any;

describe('KnowledgeStore Migration Error Paths', () => {
  let testDbDir: string;
  let store: KnowledgeStore;

  beforeEach(() => {
    testDbDir = path.join(os.tmpdir(), `pi-migration-err-test-${Date.now()}`);
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
  });

  afterEach(async () => {
    if (store) {
      await store.close();
    }
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('handleModelChange falls back to backup for unknown strategy', async () => {
    store = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-b',
      migrationStrategy: 'unknown' as any });

    const store1 = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-a' });
    await store1.initialize();
    await store1.addDocuments([{ url: 'https://test.com', text: 'test', metadata: {}, timestamp: Date.now() }]);
    await store1.close();

    await store.initialize();
    expect(await store.count()).toBe(0);
  });

  it('migrationReEmbed handles directory rename failure by persisting temp table name', async () => {
    store = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-b',
      migrationStrategy: 're-embed' });

    const store1 = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-a' });
    await store1.initialize();
    await store1.addDocuments([{ url: 'https://test.com', text: 'test', metadata: {}, timestamp: Date.now() }]);
    await store1.close();

    vi.mocked(fsPromises.rename).mockRejectedValueOnce(new Error('Rename failed'));

    await store.initialize();

    expect(fsPromises.rename).toHaveBeenCalled();
    const manifestPath = path.join(testDbDir, 'store-manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.activeTableName).toMatch(/^knowledge_migration_/);
    expect(await store.count()).toBe(1);
  });

  it('migrationReEmbed failure falls back to drop strategy', async () => {
    store = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-b',
      migrationStrategy: 're-embed' });

    const store1 = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-a' });
    await store1.initialize();
    await store1.addDocuments([{ url: 'https://test.com', text: 'test', metadata: {}, timestamp: Date.now() }]);
    await store1.close();

    // Force error in embedMany to cause migration failure
    const originalEmbedMany = mockEmbedder.embedMany;
    mockEmbedder.embedMany = vi.fn().mockRejectedValue(new Error('Embedding failed'));

    // Should NOT throw because it falls back to drop
    await store.initialize();
    
    // Should have dropped and recreated (0 documents)
    expect(await store.count()).toBe(0);

    mockEmbedder.embedMany = originalEmbedMany;
  });
});
