/**
 * State Path Configuration Service
 *
 * Computes and provides file paths for state management components.
 * This service is registered first so that FileLockService and StateBackupManager
 * can depend on it for their path configuration.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { IService } from '../../core/service-registry.ts';
import { ServiceLifecycle } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/interfaces/service-names.ts';

export interface StatePaths {
  stateFilePath: string;
  lockDirPath: string;
  backupDirPath: string;
  lockFilePath: string;
}

/**
 * State Path Configuration Service
 *
 * Provides centralized path configuration for state management.
 */
export class StatePathConfiguration implements IService {
  readonly name = ServiceNames.STATE_PATH_CONFIGURATION;
  lifecycle = ServiceLifecycle.UNINITIALIZED;
  private _initialized = false;

  private readonly stateDir: string;
  private readonly stateFilePath: string;
  private readonly lockDirPath: string;
  private readonly backupDirPath: string;
  private readonly lockFilePath: string;

  constructor(stateDir?: string) {
    const resolvedStateDir = stateDir || path.join(os.homedir(), '.pi', 'state');
    this.stateDir = resolvedStateDir;
    this.stateFilePath = path.join(resolvedStateDir, 'research-state.json');
    this.lockDirPath = path.join(resolvedStateDir, '.locks');
    this.backupDirPath = path.join(resolvedStateDir, 'backups');
    this.lockFilePath = path.join(this.lockDirPath, 'research-state.lock');
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    // Nothing to dispose
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Get all state paths
   */
  getPaths(): StatePaths {
    return {
      stateFilePath: this.stateFilePath,
      lockDirPath: this.lockDirPath,
      backupDirPath: this.backupDirPath,
      lockFilePath: this.lockFilePath,
    };
  }

  /**
   * Get the state directory
   */
  getStateDir(): string {
    return this.stateDir;
  }

  /**
   * Get the state file path
   */
  getStateFilePath(): string {
    return this.stateFilePath;
  }

  /**
   * Get the lock directory path
   */
  getLockDirPath(): string {
    return this.lockDirPath;
  }

  /**
   * Get the backup directory path
   */
  getBackupDirPath(): string {
    return this.backupDirPath;
  }

  /**
   * Get the lock file path
   */
  getLockFilePath(): string {
    return this.lockFilePath;
  }
}