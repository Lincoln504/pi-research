/**
 * Log Rotation
 *
 * Handles log file rotation and cleanup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
export interface RotationLogger {
  log(...args: unknown[]): void;
}

export class LogRotation {
  private readonly MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB max file size
  private readonly MAX_LOG_FILES = 10; // Keep last 10 archived logs
  private lastRotationCheck: number = 0;
  private readonly logger: RotationLogger;

  constructor(logger: RotationLogger) {
    this.logger = logger;
  }

  /**
   * Clear all research logs including archives.
   */
  clearLogs(logFile: string, logDir: string): void {
    try {
      if (fs.existsSync(logFile)) {
        fs.unlinkSync(logFile);
      }
      
      const files = fs.readdirSync(logDir);
      const baseName = path.basename(logFile);
      const archives = files.filter(f => f.startsWith(baseName) && f !== baseName);
      
      for (const archive of archives) {
        try {
          fs.unlinkSync(path.join(logDir, archive));
        } catch { /* ignore */ }
      }
      
      this.logger.log('[Logger] All logs and archives cleared.');
    } catch (err) {
      this.logger.log('[Logger] Failed to clear logs:', err);
    }
  }

  /**
   * Rotate log files when they exceed MAX_LOG_SIZE.
   * Archives are created with ISO timestamp suffix.
   * Old archives beyond MAX_LOG_FILES are cleaned up.
   */
  rotateLogFile(logFile: string, logDir: string): void {
    try {
      const stats = fs.statSync(logFile);
      const fileSize = stats.size;
      
      if (fileSize <= this.MAX_LOG_SIZE) {
        return; // No rotation needed
      }
      
      // Create archive filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = `${logFile}.${timestamp}`;
      
      // Rename current log file to archive
      try {
        fs.renameSync(logFile, archivePath);
      } catch (renameErr) {
        // fs.renameSync fails on Windows if target exists (NTFS). Fall back to copy+delete.
        if (process.platform === 'win32') {
          fs.copyFileSync(logFile, archivePath);
          fs.unlinkSync(logFile);
        } else {
          throw renameErr;
        }
      }
      
      // Clean up old archives
      try {
        const files = fs.readdirSync(logDir);
        const logFiles = files
          .filter(f => f.startsWith(path.basename(logFile)) && f !== path.basename(logFile))
          .sort(); // Sort by timestamp (oldest first)
        
        // Remove excess archives
        const toDelete = logFiles.slice(0, -this.MAX_LOG_FILES);
        for (const file of toDelete) {
          try {
            fs.unlinkSync(path.join(logDir, file));
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch {
        // Ignore cleanup errors
      }
      
      this.logger.log('[Logger] Rotated log file to:', archivePath);
    } catch (_error) {
      // Ignore rotation errors (file might not exist yet, etc.)
    }
  }

  /**
   * Check if rotation is needed and perform if necessary.
   *
   * Throttled to one filesystem stat per 60s. We deliberately do NOT offer a
   * `force` bypass: a previous version forced a check on every WARN/ERROR, which
   * turned into a synchronous fs.statSync per line (thousands per heavy run) and
   * also reset the throttle so the timer path never fired. The 60s timer
   * preserves all log data on rotation regardless of when it lands — a file may
   * transiently exceed MAX_LOG_SIZE by at most one check interval, which is fine.
   * @returns true if a rotation check was performed
   */
  checkAndRotate(logFile: string, logDir: string): boolean {
    const now = Date.now();
    if (now - this.lastRotationCheck > 60_000) {
      this.rotateLogFile(logFile, logDir);
      this.lastRotationCheck = now;
      return true;
    }
    return false;
  }
}