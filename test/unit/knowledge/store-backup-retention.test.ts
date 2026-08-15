/**
 * Regression tests for the backup-retention half of pruneOrphanedMigrationDirs.
 *
 * The pruner used to keep only the single newest `_backup_` dir. Two sessions
 * configured with DIFFERENT embedding models alternate migrations against the
 * shared table (each open sees "wrong model" -> back up -> fresh table), so
 * after just two alternations the only surviving copy of the first model's data
 * was deleted: silent, permanent loss. Retention is now time-based (the store's
 * own ttlDays), which is the behaviour these tests pin.
 *
 * The pruner is private and only reachable behind a real LanceDB open, so these
 * drive it directly against a fixture dbDir with a stubbed live-table handle —
 * the unit under test is the directory classification/ranking/retention logic,
 * which is exactly where the data-loss bug lived.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

const mockEmbedder = {
  getDimension: () => 384,
  embed: async () => new Float32Array(384),
  embedMany: async (texts: string[]) => texts.map(() => new Float32Array(384)),
  isInitialized: () => true,
} as any;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Mirror migrationBackup's naming: `_backup_<ISO with : and . mapped to ->`. */
function backupDirName(base: string, at: number): string {
  return `${base}_backup_${new Date(at).toISOString().replace(/[:.]/g, '-')}.lance`;
}

describe('KnowledgeStore backup retention (pruneOrphanedMigrationDirs)', () => {
  let dbDir: string;
  let store: KnowledgeStore;

  const makeDir = (name: string) => fs.mkdirSync(path.join(dbDir, name), { recursive: true });
  const existing = () => fs.readdirSync(dbDir).sort();

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-backup-retention-'));
    store = new KnowledgeStore({
      knowledgeMode: 'project',
      dbDir,
      embedder: mockEmbedder,
      modelName: 'model-a',
      ttlDays: 30,
    });
    // The pruner refuses to run unless a live table is confirmed open, and
    // ranks relative to the manifest's active table name.
    (store as any).table = {};
    (store as any).tableName = 'knowledge';
    makeDir('knowledge.lance');
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('retains every backup still inside ttlDays — the model-alternation data-loss case', async () => {
    const now = Date.now();
    // Three alternations, all recent. Keep-only-newest deleted the first two.
    const oldest = backupDirName('knowledge', now - 3 * DAY_MS);
    const middle = backupDirName('knowledge', now - 2 * DAY_MS);
    const newest = backupDirName('knowledge', now - 1 * DAY_MS);
    [oldest, middle, newest].forEach(makeDir);

    await (store as any).pruneOrphanedMigrationDirs();

    expect(existing()).toEqual([newest, oldest, middle, 'knowledge.lance'].sort());
  });

  it('prunes only backups older than ttlDays', async () => {
    const now = Date.now();
    const expired = backupDirName('knowledge', now - 45 * DAY_MS);
    const fresh = backupDirName('knowledge', now - 5 * DAY_MS);
    const newest = backupDirName('knowledge', now - 1 * DAY_MS);
    [expired, fresh, newest].forEach(makeDir);

    await (store as any).pruneOrphanedMigrationDirs();

    const left = existing();
    expect(left).not.toContain(expired);
    expect(left).toContain(fresh);
    expect(left).toContain(newest);
  });

  it('never deletes the newest backup even when it is older than ttlDays', async () => {
    const now = Date.now();
    // 'backup' must never degrade into a silent 'drop'.
    const older = backupDirName('knowledge', now - 400 * DAY_MS);
    const newest = backupDirName('knowledge', now - 200 * DAY_MS);
    [older, newest].forEach(makeDir);

    await (store as any).pruneOrphanedMigrationDirs();

    const left = existing();
    expect(left).toContain(newest);
    expect(left).not.toContain(older);
  });

  it('ranks by the trailing backup timestamp, not by whole-name sort', async () => {
    const now = Date.now();
    // `knowledge_b...` < `knowledge_m...` lexicographically, so a whole-name
    // sort treated the migration-named backup as newest and deleted the
    // genuinely newer plain backup.
    const olderMigrationNamed = backupDirName('knowledge_migration_1700000000000', now - 400 * DAY_MS);
    const newerPlain = backupDirName('knowledge', now - 300 * DAY_MS);
    [olderMigrationNamed, newerPlain].forEach(makeDir);

    await (store as any).pruneOrphanedMigrationDirs();

    const left = existing();
    expect(left).toContain(newerPlain);
    expect(left).not.toContain(olderMigrationNamed);
  });

  it('reaps orphaned migration temps while leaving backups and the live table alone', async () => {
    const backup = backupDirName('knowledge', Date.now() - DAY_MS);
    makeDir(backup);
    makeDir('knowledge_migration_1700000000000.lance');

    await (store as any).pruneOrphanedMigrationDirs();

    expect(existing()).toEqual([backup, 'knowledge.lance'].sort());
  });

  it('never touches the live table even when its name looks like a temp dir', async () => {
    // A persisted re-embed rename failure leaves live data in a temp-named dir.
    (store as any).tableName = 'knowledge_migration_1700000000000';
    makeDir('knowledge_migration_1700000000000.lance');

    await (store as any).pruneOrphanedMigrationDirs();

    expect(existing()).toContain('knowledge_migration_1700000000000.lance');
  });
});
