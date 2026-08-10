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

// Numeric equivalent of the 'a' flag string (O_WRONLY|O_APPEND|O_CREAT), with
// O_NOFOLLOW added when the platform defines it (not available on Windows) so
// the open refuses to follow a symlink an attacker with write access to the
// log directory could plant at this path in the window between the preceding
// unlink/rename and this reopen — defense-in-depth on top of an already-narrow
// threat model (it requires local write access to this directory to begin with).
const APPEND_CREATE_NOFOLLOW_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);

/** Best-effort (re)create `filePath` with `mode`, refusing to follow a symlink
 * planted at the path, and unconditionally stamp `mode` on it. Uses fchmodSync
 * on the already-open (and O_NOFOLLOW-verified) descriptor rather than
 * fs.chmodSync(filePath, ...) — chmodSync operates on the path and follows
 * symlinks, which would silently re-open the exact hole O_NOFOLLOW closes if
 * a symlink appears at this path between the open above and a path-based
 * chmod. mode is only applied by open() when O_CREAT actually creates the
 * file, so callers relying on the file always ending up at `mode` (even when
 * a concurrent writer already recreated it) still need this explicit stamp.
 * Failures are swallowed by design — see call sites.
 * Exported for unit testing of the symlink-refusal behavior. */
export function touchOwnerOnly(filePath: string, mode: number): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, APPEND_CREATE_NOFOLLOW_FLAGS, mode);
    fs.fchmodSync(fd, mode);
  } catch { /* best-effort — the next append recreates the file */ }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
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
        // next append would drop the owner-only posture. touchOwnerOnly stamps
        // the mode unconditionally (via fchmod on its own fd), covering the
        // case where a concurrent append already recreated the file at umask
        // perms between the unlink and this call.
        touchOwnerOnly(logFile, 0o600);
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
      // establishes at construction. touchOwnerOnly stamps the mode
      // unconditionally (via fchmod on its own fd) regardless of whether this
      // open created the file or a concurrent append already recreated it
      // between the rename and this call — ENOENT (open itself failed) is
      // tolerable: best-effort posture, same as the recreate itself.
      touchOwnerOnly(logFile, 0o600);


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