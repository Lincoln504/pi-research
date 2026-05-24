/**
 * Disk Space Checker
 *
 * Checks available disk space for logging.
 */

import * as fs from 'node:fs';

export class DiskSpaceChecker {
  private readonly MIN_DISK_SPACE_BYTES = 1_048_576; // 1MB minimum
  private readonly DISK_SPACE_CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds
  private lastDiskSpaceCheck: number = 0;
  private hasDiskSpace: boolean = true;

  /**
   * Check if there is sufficient disk space for logging.
   * Checks are throttled to avoid excessive filesystem operations.
   */
  checkDiskSpace(logDir: string): boolean {
    const now = Date.now();
    
    // Only check periodically (every 60 seconds)
    if (now - this.lastDiskSpaceCheck < this.DISK_SPACE_CHECK_INTERVAL_MS) {
      return this.hasDiskSpace;
    }
    
    this.lastDiskSpaceCheck = now;
    
    try {
      // POSIX: use statfs for accurate disk space information
      if (typeof fs.statfs !== 'undefined') {
        const stats = fs.statfsSync(logDir);
        const availableBytes = stats.bavail * stats.bsize;
        
        if (availableBytes < this.MIN_DISK_SPACE_BYTES) {
          this.hasDiskSpace = false;
          // Only log once (not via this.emit to avoid recursion)
          console.error('[Logger] Insufficient disk space for logging:', 
            `${Math.round(availableBytes / 1024 / 1024)}MB available, minimum ${this.MIN_DISK_SPACE_BYTES / 1024 / 1024}MB required`);
        } else {
          this.hasDiskSpace = true;
        }
      } else {
        // Non-POSIX: assume OK (Windows has different disk management)
        this.hasDiskSpace = true;
      }
    } catch (_error) {
      // On error, assume OK to avoid blocking logging
      this.hasDiskSpace = true;
    }
    
    return this.hasDiskSpace;
  }
}