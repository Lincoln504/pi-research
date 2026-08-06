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
        // Same rationale as the post-rotation recreate in rotateLogFile: the
        // unlink discarded the 0o600 file, and a umask-default recreate by the
        // next append would drop the owner-only posture.
        try {
          fs.closeSync(fs.openSync(logFile, 'a', 0o600));
        } catch { /* best-effort — the next append recreates the file */ }
        // And, as there, re-stamp the mode: a concurrent append landing between
        // the unlink and the open makes the creation-time 0o600 a no-op.
        try {
          fs.chmodSync(logFile, 0o600);
        } catch { /* best-effort */ }
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
      
      // Rename current log file to archive. The archive name is timestamped, so
      // the target never pre-exists — a rename failure means the SOURCE is held
      // open (Windows sharing semantics). A copy+unlink fallback here would
      // destroy appends the OTHER processes writing this consolidated log (main,
      // embedding server, browser workers) land between the copy and the unlink.
      // Skipping the rotation is the data-preserving choice: the file transiently
      // exceeds the cap until a later check succeeds (accepted by the throttling
      // contract in checkAndRotate).
      try {
        fs.renameSync(logFile, archivePath);
      } catch (renameErr) {
        this.logger.log('[Logger] Log rotation skipped (rename failed; file likely in use):', renameErr);
        return;
      }

      // Rotation moved the 0o600 file aside; without an explicit recreate the next
      // append materializes it at the umask default (typically 0644) in a
      // world-traversable tmpdir, silently dropping the owner-only posture Logger
      // establishes at construction. Mode applies only at creation, so this is
      // harmless where a file already exists or mode semantics differ (win32).
      try {
        fs.closeSync(fs.openSync(logFile, 'a', 0o600));
      } catch { /* best-effort — the next append recreates the file */ }
      // The mode above applies only if THIS open created the file. Several
      // processes append to this consolidated log, so a concurrent async append
      // can recreate it at umask perms between the rename and the open, turning
      // the 0o600 into a no-op — stamp the mode unconditionally to close that
      // window for good. ENOENT (nothing recreated it and the open failed) is
      // tolerable: best-effort posture, same as the recreate itself.
      try {
        fs.chmodSync(logFile, 0o600);
      } catch { /* best-effort */ }


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