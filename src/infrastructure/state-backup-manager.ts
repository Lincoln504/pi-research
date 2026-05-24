/**
 * State Backup Manager
 *
 * Handles backup creation, cleanup, and recovery for state files.
 */

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { logger } from '../logger.ts';

/**
 * Manages backup and recovery for state files
 */
export class StateBackupManager {
  private readonly stateFilePath: string;
  private readonly backupDirPath: string;
  private readonly maxBackups: number;

  constructor(stateFilePath: string, backupDirPath: string, maxBackups: number = 5) {
    this.stateFilePath = stateFilePath;
    this.backupDirPath = backupDirPath;
    this.maxBackups = maxBackups;
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

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `research-state-${timestamp}.json`;
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
      // Find the newest valid backup
      let newestBackup: { name: string; mtime: Date } | null = null;
      try {
        const entries = await fs.readdir(this.backupDirPath);
        for (const entry of entries) {
          const filePath = path.join(this.backupDirPath, entry);
          const stats = await fs.stat(filePath);
          if (stats.isFile() && entry.startsWith('research-state-') && entry.endsWith('.json')) {
            if (newestBackup === null || stats.mtime > newestBackup.mtime) {
              newestBackup = { name: entry, mtime: stats.mtime };
            }
          }
        }
      } catch {
        // Backup directory unreadable — fall through to default state
      }

      if (newestBackup !== null) {
        const backupPath = path.join(this.backupDirPath, newestBackup.name);
        await fs.copyFile(backupPath, this.stateFilePath);
        logger.log(`[StateManager] Recovered state from backup: ${newestBackup.name}`);
      } else {
        // No backups — write default state directly (atomic rename, no lock needed)
        await this.writeDefaultState();
        logger.log('[StateManager] Recovered with default state (no backups available)');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[StateManager] Failed to recover from corruption: ${message}`);
      throw error;
    }
  }

  /**
   * Write a default state to the state file
   */
  async writeDefaultState(): Promise<void> {
    const defaultState = this.getDefaultState();
    defaultState.lastUpdated = Date.now();
    const tempFile = `research-state-${crypto.randomBytes(16).toString('hex')}.tmp`;
    const tempPath = path.join(path.dirname(this.stateFilePath), tempFile);
    await fs.writeFile(tempPath, JSON.stringify(defaultState, null, 2), 'utf-8');
    await fs.rename(tempPath, this.stateFilePath);
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