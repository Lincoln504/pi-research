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
      // partial write (e.g. a crash during createBackup), so we do NOT blindly
      // restore it — we validate each (JSON-parse, which catches the truncated/partial
      // corruption mode) and restore the first one that is well-formed.
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
        let content: string;
        try {
          content = await fs.readFile(backupPath, 'utf-8');
          JSON.parse(content); // reject partial/corrupt backups before restoring
        } catch {
          logger.warn(`[StateManager] Skipping unreadable/corrupt backup: ${backup.name}`);
          continue;
        }
        // Atomic restore so a crash mid-recovery can't leave a half-written state file.
        await this.atomicWriteStateFile(content);
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
    await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
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
      version: 1,
      containerId: '',
      containerName: '',
      port: 0,
      sessions: {},
      lastUpdated: Date.now(),
    };
  }
}