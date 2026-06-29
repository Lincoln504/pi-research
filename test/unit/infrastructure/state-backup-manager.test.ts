import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateBackupManager } from '../../../src/infrastructure/state/state-backup-manager.ts';
import { CURRENT_STATE_VERSION } from '../../../src/infrastructure/types/state-types.ts';

function validState(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: CURRENT_STATE_VERSION,
    containerId: 'abc',
    containerName: 'pi-research-shared-state',
    port: 0,
    sessions: {},
    lastUpdated: Date.now(),
    ...overrides,
  });
}

describe('StateBackupManager recovery', () => {
  const testDir = mkdtempSync(path.join(os.tmpdir(), 'pi-test-backup-'));
  const stateFile = path.join(testDir, 'research-state.json');
  const backupDir = path.join(testDir, 'backups');
  let mgr: StateBackupManager;

  beforeEach(async () => {
    await fs.mkdir(backupDir, { recursive: true });
    mgr = new StateBackupManager(stateFile, backupDir, 10);
    await mgr.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function writeBackup(name: string, content: string) {
    await fs.writeFile(path.join(backupDir, name), content);
  }

  it('skips a parseable-but-schema-invalid backup and restores the next valid one', async () => {
    // Newest backup is valid JSON but fails the schema (port out of range);
    // older backup is fully valid. Recovery must skip the first and restore the second.
    await writeBackup('research-state-2026-01-01.json', validState({ port: 999999 }));
    await new Promise(r => setTimeout(r, 5));
    await writeBackup('research-state-2025-01-01.json', validState({ containerId: 'good' }));

    // Make the older one newer by touching mtime via re-write order is unreliable;
    // instead, force mtimes explicitly.
    const now = Date.now();
    await fs.utimes(path.join(backupDir, 'research-state-2026-01-01.json'), new Date(now), new Date(now));
    await fs.utimes(path.join(backupDir, 'research-state-2025-01-01.json'), new Date(now - 10000), new Date(now - 10000));

    await mgr.recoverFromCorruption();

    const restored = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    // The invalid (newest) one was skipped; the valid older one restored.
    expect(restored.containerId).toBe('good');
    expect(restored.version).toBe(CURRENT_STATE_VERSION);
  });

  it('writes a default state when no backup is valid', async () => {
    await writeBackup('research-state-bad1.json', '{ truncated');
    await writeBackup('research-state-bad2.json', validState({ port: -7 }));

    await mgr.recoverFromCorruption();

    const restored = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(restored.version).toBe(CURRENT_STATE_VERSION);
    expect(restored.sessions).toEqual({});
  });

  it('skips a future-version backup (does not restore it into an older reader)', async () => {
    await writeBackup('research-state-future.json', validState({ version: CURRENT_STATE_VERSION + 1 }));

    await mgr.recoverFromCorruption();

    // Falls back to default since the only backup is a future version.
    const restored = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(restored.version).toBe(CURRENT_STATE_VERSION);
  });

  it('quarantineFutureState copies the live file aside without modifying it', async () => {
    await fs.writeFile(stateFile, validState({ version: CURRENT_STATE_VERSION + 1, containerId: 'newer' }));

    await mgr.quarantineFutureState(CURRENT_STATE_VERSION + 1);

    // Original untouched.
    const original = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(original.containerId).toBe('newer');

    // A quarantine copy exists, and it does NOT match the recovery/cleanup glob
    // (research-state-*.json) so it can never be restored or pruned.
    const entries = await fs.readdir(backupDir);
    const quarantined = entries.filter(e => e.includes('.quarantine'));
    expect(quarantined.length).toBe(1);
    expect(quarantined[0].endsWith('.json')).toBe(false);
  });

  it('a quarantine file is not picked up as a recovery candidate', async () => {
    // Only a quarantine file present — recovery must ignore it and write default.
    await fs.writeFile(path.join(backupDir, 'research-state-future-v2-x.quarantine'), validState({ version: 2 }));

    await mgr.recoverFromCorruption();

    const restored = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(restored.version).toBe(CURRENT_STATE_VERSION);
  });
});
