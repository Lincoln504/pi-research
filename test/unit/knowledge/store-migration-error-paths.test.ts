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
    testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-migration-err-test-'));
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

    // Fail only the migration DIR rename — saveManifest also calls rename (for
    // its atomic tmp→manifest swap, including the pre-drop crash-safety save)
    // and those must succeed for this scenario.
    const actualRename = (await vi.importActual('node:fs/promises') as any).rename;
    vi.mocked(fsPromises.rename).mockImplementation(async (src: any, dest: any) => {
      if (String(dest).endsWith(`${path.sep}knowledge.lance`)) {
        throw new Error('Rename failed');
      }
      return actualRename(src, dest);
    });

    await store.initialize();

    expect(fsPromises.rename).toHaveBeenCalled();
    const manifestPath = path.join(testDbDir, 'store-manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.activeTableName).toMatch(/^knowledge_migration_/);
    expect(await store.count()).toBe(1);

    // vi.restoreAllMocks() does not reset vi.fn() module mocks — put the
    // pass-through implementation back for the remaining tests.
    vi.mocked(fsPromises.rename).mockImplementation(actualRename);
  });

  it('migrationReEmbed survives a crash between dropping the old table and the dir rename (manifest already points at temp table; prune spares it)', async () => {
    // Crash window under test: the old table has been dropped, the temp
    // `_migration_` dir holds the only copy of the data, and the process dies
    // before the rename + post-rename manifest save run. We capture the exact
    // on-disk state at that instant (from inside the rename mock) and reopen a
    // fresh store on the snapshot, as a restarted process would.
    const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-migration-crash-test-'));
    try {
      const store1 = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
        embedder: mockEmbedder,
        modelName: 'model-a' });
      await store1.initialize();
      await store1.addDocuments([{ url: 'https://test.com', text: 'test', metadata: {}, timestamp: Date.now() }]);
      await store1.close();

      const actualRename = (await vi.importActual('node:fs/promises') as any).rename;
      vi.mocked(fsPromises.rename).mockImplementation(async (src: any, dest: any) => {
        // Snapshot only on the migration dir rename (saveManifest also renames).
        if (String(dest).endsWith(`${path.sep}knowledge.lance`)) {
          fs.rmSync(crashDir, { recursive: true, force: true });
          fs.cpSync(testDbDir, crashDir, { recursive: true });
        }
        return actualRename(src, dest);
      });

      store = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
        embedder: mockEmbedder,
        modelName: 'model-b',
        migrationStrategy: 're-embed' });
      await store.initialize();
      await store.close();

      // At the crash instant the manifest must already reference the temp
      // table (the only one containing the data), not the dropped old name.
      const crashManifest = JSON.parse(fs.readFileSync(path.join(crashDir, 'store-manifest.json'), 'utf-8'));
      expect(crashManifest.activeTableName).toMatch(/^knowledge_migration_/);

      // A restarted process opens the temp table via the manifest, and
      // pruneOrphanedMigrationDirs must NOT reap the manifest-referenced dir.
      const restarted = new KnowledgeStore({ knowledgeMode: "project", dbDir: crashDir,
        embedder: mockEmbedder,
        modelName: 'model-b',
        migrationStrategy: 're-embed' });
      await restarted.initialize();
      expect(await restarted.count()).toBe(1);
      expect(fs.existsSync(path.join(crashDir, `${crashManifest.activeTableName}.lance`))).toBe(true);
      await restarted.close();
    } finally {
      // vi.restoreAllMocks() does not reset vi.fn() module mocks — put the
      // pass-through implementation back for the remaining tests.
      const actual = (await vi.importActual('node:fs/promises') as any).rename;
      vi.mocked(fsPromises.rename).mockImplementation(actual);
      fs.rmSync(crashDir, { recursive: true, force: true });
    }
  });

  it('migrationReEmbed failure falls back to BACKUP strategy (fresh table; old data preserved in backup dir)', async () => {
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

    // Should NOT throw because it falls back to backup (fresh table)
    await store.initialize();

    // Fresh table after backup fallback (0 documents); the old rows live on in
    // a *_backup_* directory rather than being dropped.
    expect(await store.count()).toBe(0);
    const backupDirs = fs.readdirSync(testDbDir).filter((d) => d.includes('_backup_'));
    expect(backupDirs.length).toBeGreaterThan(0);

    mockEmbedder.embedMany = originalEmbedMany;
  });

  it('prune retains the NEWEST backup by its _backup_ timestamp across mixed basenames', async () => {
    // Both spellings are legitimate — the prefix is the table name AT BACKUP
    // TIME: a plain `knowledge_backup_*`, or a backup of a persisted re-embed
    // temp table, `knowledge_migration_*_backup_*`. A whole-name lexicographic
    // sort ranks `knowledge_m…` above `knowledge_b…` regardless of timestamps,
    // deleting the newest snapshot while retaining an older one.
    const older = 'knowledge_migration_2026-01-01T00-00-00-000Z_backup_2026-01-02T00-00-00-000Z.lance';
    const newer = 'knowledge_backup_2026-03-04T05-06-07-890Z.lance';
    fs.mkdirSync(path.join(testDbDir, older));
    fs.mkdirSync(path.join(testDbDir, newer));

    store = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-a' });
    await store.initialize();

    expect(fs.existsSync(path.join(testDbDir, newer))).toBe(true);
    expect(fs.existsSync(path.join(testDbDir, older))).toBe(false);
  });

  it('prune falls back to directory mtime for backup names without a parseable timestamp', async () => {
    // mkdir sets mtime to "now" — newer than the 2020 timestamp embedded in the
    // parseable name — so the unparseable dir is the newest snapshot and must be
    // the one retained.
    const unparseable = 'knowledge_backup_manual.lance';
    const parseableOld = 'knowledge_backup_2020-01-01T00-00-00-000Z.lance';
    fs.mkdirSync(path.join(testDbDir, unparseable));
    fs.mkdirSync(path.join(testDbDir, parseableOld));

    store = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-a' });
    await store.initialize();

    expect(fs.existsSync(path.join(testDbDir, unparseable))).toBe(true);
    expect(fs.existsSync(path.join(testDbDir, parseableOld))).toBe(false);
  });

  it('backup migration failure ABORTS the open — never escalates to a data-destroying drop', async () => {
    // Regression: the fallback ladder used to escalate backup→drop, so a
    // (possibly transient) backup failure under the DEFAULT strategy silently
    // wiped every row. A failed backup must abort; the store stays on the old
    // model and the next open() retries.
    store = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-b',
      migrationStrategy: 'backup' });

    const store1 = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-a' });
    await store1.initialize();
    await store1.addDocuments([{ url: 'https://test.com', text: 'test', metadata: {}, timestamp: Date.now() }]);
    await store1.close();

    // Fail only the backup dir rename (transient IO error); manifest renames
    // must keep working.
    const actualRename = (await vi.importActual('node:fs/promises') as any).rename;
    vi.mocked(fsPromises.rename).mockImplementation(async (src: any, dest: any) => {
      if (String(dest).includes('_backup_')) {
        throw new Error('EIO: transient rename failure');
      }
      return actualRename(src, dest);
    });

    await expect(store.initialize()).rejects.toThrow(/migration failed/i);

    vi.mocked(fsPromises.rename).mockImplementation(actualRename);

    // The data survived: reopening under the ORIGINAL model still sees the row.
    const reopened = new KnowledgeStore({ knowledgeMode: "project", dbDir: testDbDir,
      embedder: mockEmbedder,
      modelName: 'model-a' });
    await reopened.initialize();
    expect(await reopened.count()).toBe(1);
    await reopened.close();
  });
});
