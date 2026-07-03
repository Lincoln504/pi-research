/**
 * State Backup Manager
 *
 * Handles backup creation, cleanup, and recovery for state files.
 */

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { logger } from '../../logger.ts';
import type { IService } from '../../core/service-registry.ts';
import { ServiceLifecycle } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/interfaces/service-names.ts';
import { StateValidator } from './state-validator.ts';
import { CURRENT_STATE_VERSION } from '../types/state-types.ts';

// How many newest .quarantine copies to retain. Small: they exist only for forensic
// inspection of a newer-build/older-reader collision, never for restore.
const QUARANTINE_KEEP = 5;

/**
 * Manages backup and recovery for state files
 */
export class StateBackupManager implements IService {
  readonly name = ServiceNames.STATE_BACKUP_MANAGER;
  lifecycle = ServiceLifecycle.UNINITIALIZED;
  private _initialized = false;

  private readonly stateFilePath: string;
  private readonly backupDirPath: string;
  private readonly maxBackups: number;
  // Stateless schema validation/migration; constructed inline (no DI plumbing
  // needed since validateState/migrateAndValidate don't depend on initialize()).
  private readonly validator = new StateValidator();

  constructor(stateFilePath: string, backupDirPath: string, maxBackups: number = 5) {
    this.stateFilePath = stateFilePath;
    this.backupDirPath = backupDirPath;
    this.maxBackups = maxBackups;
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    // Ensure backup directory exists
    await fs.mkdir(this.backupDirPath, { recursive: true, mode: 0o700 });
    this._initialized = true;
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    // Nothing to dispose
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Create a backup of the current state file
   * @throws Error if unable to create backup
   */
  async createBackup(): Promise<void> {
    try {
      // Check if state file exists
      try {
        await fs.access(this.stateFilePath);
      } catch {
        // No state file to backup
        return;
      }

      // Ensure backup directory exists
      await fs.mkdir(this.backupDirPath, { recursive: true, mode: 0o700 });

      // Timestamp + random suffix: two writers in the same millisecond would
      // otherwise produce the same filename and silently overwrite one backup
      // generation. The random suffix keeps both. Prefix/suffix still match the
      // `research-state-*.json` patterns used by cleanup and recovery.
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `research-state-${timestamp}-${crypto.randomBytes(4).toString('hex')}.json`;
      const backupFilePath = path.join(this.backupDirPath, backupFileName);

      await fs.copyFile(this.stateFilePath, backupFilePath);
    } catch (error: unknown) {
      throw new Error(`Failed to create backup: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Clean up old backups, keeping only the most recent maxBackups
   */
  async cleanupOldBackups(): Promise<void> {
    try {
      const entries = await fs.readdir(this.backupDirPath);

      if (entries.length <= this.maxBackups) {
        return;
      }

      // Get file stats and sort by modification time (newest first)
      const backupFiles: Array<{ name: string; mtime: Date }> = [];

      for (const entry of entries) {
        const filePath = path.join(this.backupDirPath, entry);
        const stats = await fs.stat(filePath);

        if (stats.isFile() && entry.startsWith('research-state-') && entry.endsWith('.json')) {
          backupFiles.push({ name: entry, mtime: stats.mtime });
        }
      }

      // Sort by mtime, newest first
      backupFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Remove backups beyond the max count
      const backupsToRemove = backupFiles.slice(this.maxBackups);
      for (const backupFile of backupsToRemove) {
        const filePath = path.join(this.backupDirPath, backupFile.name);
        await fs.unlink(filePath);
      }
    } catch (error: unknown) {
      logger.error(`Failed to cleanup old backups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Recover from corruption by restoring a backup or writing a default state.
   */
  async recoverFromCorruption(): Promise<void> {
    try {
      // Collect candidate backups, newest first. The newest backup can itself be a
      // partial write (e.g. a crash during createBackup) OR well-formed JSON that
      // nonetheless fails the state schema, so we do NOT blindly restore it. We
      // parse, migrate, and schema-validate each, and restore the first that
      // passes. JSON-parse alone is insufficient: a parseable-but-invalid backup
      // would be restored, fail validation on the next read, and trigger recovery
      // again — a loop that never converges and never persists a usable state.
      let backups: Array<{ name: string; mtime: Date }> = [];
      try {
        const entries = await fs.readdir(this.backupDirPath);
        for (const entry of entries) {
          const filePath = path.join(this.backupDirPath, entry);
          const stats = await fs.stat(filePath);
          if (stats.isFile() && entry.startsWith('research-state-') && entry.endsWith('.json')) {
            backups.push({ name: entry, mtime: stats.mtime });
          }
        }
      } catch {
        // Backup directory unreadable — fall through to default state
      }
      backups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      for (const backup of backups) {
        const backupPath = path.join(this.backupDirPath, backup.name);
        let restoreContent: string;
        try {
          const content = await fs.readFile(backupPath, 'utf-8');
          // Parse + migrate-forward + schema-validate. Persist the validated
          // (and possibly migrated) object so the restored file is a current,
          // well-formed state — never a raw older/odd backup. A future-version
          // or schema-invalid backup throws here and is skipped.
          const validated = this.validator.migrateAndValidate(JSON.parse(content));
          restoreContent = JSON.stringify(validated, null, 2);
        } catch (err) {
          logger.warn(`[StateManager] Skipping invalid backup ${backup.name}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        // Atomic restore so a crash mid-recovery can't leave a half-written state file.
        await this.atomicWriteStateFile(restoreContent);
        logger.log(`[StateManager] Recovered state from backup: ${backup.name}`);
        return;
      }

      // No backups (or none valid) — write default state directly (atomic, no lock needed)
      await this.writeDefaultState();
      logger.log('[StateManager] Recovered with default state (no valid backups available)');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[StateManager] Failed to recover from corruption: ${message}`);
      throw error;
    }
  }

  /**
   * Preserve a copy of a state file written by a NEWER build before this (older)
   * process continues on an in-memory default. The original is left untouched —
   * the newer build still owns and reads it. The quarantine copy is named so it
   * matches neither the backup-recovery nor cleanup glob (`research-state-*.json`):
   * it must never be restored into an older reader or pruned as an old backup.
   */
  async quarantineFutureState(fileVersion: number): Promise<void> {
    try {
      await fs.access(this.stateFilePath);
    } catch {
      return; // nothing on disk to preserve
    }
    await fs.mkdir(this.backupDirPath, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `research-state-future-v${fileVersion}-${timestamp}.quarantine`;
    const dest = path.join(this.backupDirPath, name);
    await fs.copyFile(this.stateFilePath, dest);
    logger.warn(`[StateManager] Quarantined newer-build state (v${fileVersion}) copy at ${dest}`);
    // Quarantine files are deliberately excluded from cleanupOldBackups (they must never be
    // restored into an older reader), so nothing else prunes them. Cap retention here so a
    // machine that repeatedly runs an older build against newer state (rollback, bisect,
    // flip-flopping installs) can't accumulate them without bound.
    await this.pruneQuarantineFiles(QUARANTINE_KEEP);
  }

  /** Keep only the newest `keep` *.quarantine files; delete the rest. Best-effort. */
  private async pruneQuarantineFiles(keep: number): Promise<void> {
    try {
      const entries = await fs.readdir(this.backupDirPath);
      const quarantines: Array<{ name: string; mtime: number }> = [];
      for (const entry of entries) {
        if (!entry.endsWith('.quarantine')) continue;
        try {
          const stats = await fs.stat(path.join(this.backupDirPath, entry));
          if (stats.isFile()) quarantines.push({ name: entry, mtime: stats.mtimeMs });
        } catch { /* raced away — ignore */ }
      }
      if (quarantines.length <= keep) return;
      quarantines.sort((a, b) => b.mtime - a.mtime);
      for (const stale of quarantines.slice(keep)) {
        try {
          await fs.unlink(path.join(this.backupDirPath, stale.name));
        } catch { /* already gone — ignore */ }
      }
    } catch { /* backup dir unreadable — nothing to prune */ }
  }

  /**
   * Atomically write the given content to the state file (temp file + rename, with
   * a Windows copy+delete fallback since rename fails on NTFS when the target exists).
   */
  private async atomicWriteStateFile(content: string): Promise<void> {
    const stateDir = path.dirname(this.stateFilePath);
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tempFile = `research-state-${crypto.randomBytes(16).toString('hex')}.tmp`;
    const tempPath = path.join(stateDir, tempFile);
    // 0o600: the state file holds browserServer.authSecret. The primary writer
    // (state-manager) forces owner-only; this recovery/default path must match so a
    // corruption-recovery write never lands world-readable.
    // Open + write + fsync + close before rename, mirroring the primary writer's
    // durability: a crash immediately after recovery must not resurrect the very
    // corruption we just recovered from (an un-synced rename can expose a
    // zero-length file after a power loss).
    const fh = await fs.open(tempPath, 'w', 0o600);
    try {
      await fh.writeFile(content, { encoding: 'utf-8' });
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fs.rename(tempPath, this.stateFilePath);
    } catch (renameErr) {
      if (process.platform === 'win32') {
        await fs.copyFile(tempPath, this.stateFilePath);
        await fs.unlink(tempPath).catch(() => { /* best-effort cleanup */ });
      } else {
        await fs.unlink(tempPath).catch(() => { /* best-effort cleanup */ });
        throw renameErr;
      }
    }
  }

  /**
   * Write a default state to the state file
   */
  async writeDefaultState(): Promise<void> {
    const defaultState = this.getDefaultState();
    defaultState.lastUpdated = Date.now();
    await this.atomicWriteStateFile(JSON.stringify(defaultState, null, 2));
  }

  /**
   * Get the default state object
   */
  private getDefaultState() {
    return {
      version: CURRENT_STATE_VERSION,
      containerId: '',
      containerName: '',
      port: 0,
      sessions: {},
      lastUpdated: Date.now(),
    };
  }
}