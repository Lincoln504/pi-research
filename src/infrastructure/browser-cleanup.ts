/**
 * Browser Cleanup Utilities
 *
 * Functions for cleaning up orphaned browser processes and related resources.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../logger.ts';

const execAsync = promisify(exec);

/**
 * Find and kill orphaned Camoufox browser processes.
 *
 * Orphaned processes are those that:
 * 1. Are running Camoufox/Firefox browsers
 * 2. Have a parent PID that no longer exists
 * 3. Are not part of an active browser pool
 *
 * This should be called after pool destruction to clean up any stragglers.
 */
export async function cleanupOrphanedCamoufoxProcesses(): Promise<void> {
  const platform = os.platform();
  
  try {
    if (platform === 'darwin' || platform === 'linux') {
      await cleanupOrphanedProcessesUnix();
    } else if (platform === 'win32') {
      await cleanupOrphanedProcessesWindows();
    } else {
      logger.warn(`[BrowserCleanup] Platform ${platform} not supported for orphan cleanup`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[BrowserCleanup] Failed to cleanup orphaned processes: ${msg}`);
  }
}

/**
 * Cleanup orphaned processes on Unix-like systems (macOS, Linux)
 */
async function cleanupOrphanedProcessesUnix(): Promise<void> {
  try {
    // Find Camoufox/firefox processes and their parent PIDs
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,comm | grep -E "(firefox|camoufox)" | grep -v grep',
    );
    
    const lines = stdout.trim().split('\n');
    let cleanedCount = 0;
    
    for (const line of lines) {
      const match = line.trim().match(/^\s*(\d+)\s+(\d+)\s+(\S+)/);
      if (!match || !match[1] || !match[2] || !match[3]) continue;
      
      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const comm = match[3];
      
      // Check if parent process is still alive
      try {
        process.kill(ppid, 0);
        // Parent is alive, this is not an orphan
        continue;
      } catch {
        // Parent is dead - this is an orphan
        logger.log(`[BrowserCleanup] Found orphaned ${comm} process: PID ${pid}, dead parent PID ${ppid}`);
        
        try {
          // Kill the orphaned process gracefully
          process.kill(pid, 'SIGTERM');
          cleanedCount++;
          
          // Give it a moment to exit gracefully
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Check if it's still running and force kill if needed
          try {
            process.kill(pid, 0);
            // Still running, force kill
            process.kill(pid, 'SIGKILL');
            logger.warn(`[BrowserCleanup] Force killed orphaned process: PID ${pid}`);
          } catch {
            // Process exited
            logger.log(`[BrowserCleanup] Terminated orphaned process: PID ${pid}`);
          }
        } catch (killError) {
          const msg = killError instanceof Error ? killError.message : String(killError);
          logger.warn(`[BrowserCleanup] Failed to kill orphaned process PID ${pid}: ${msg}`);
        }
      }
    }
    
    if (cleanedCount > 0) {
      logger.log(`[BrowserCleanup] Cleaned up ${cleanedCount} orphaned browser process(es)`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[BrowserCleanup] Failed to find orphaned processes: ${msg}`);
  }
}

/**
 * Cleanup orphaned processes on Windows
 */
async function cleanupOrphanedProcessesWindows(): Promise<void> {
  try {
    // Use tasklist to find firefox processes
    const { stdout } = await execAsync(
      'tasklist /FI "IMAGENAME eq firefox.exe" /FO CSV /NH',
    );
    
    const lines = stdout.trim().split('\n');
    let cleanedCount = 0;
    
    for (const line of lines) {
      if (!line.includes('firefox.exe')) continue;
      
      const match = line.match(/"(\d+)"/);
      if (!match || !match[1]) continue;
      
      const pid = parseInt(match[1], 10);
      
      // Check if parent process is still alive
      try {
        // On Windows, we need to use wmic to get parent PID
        const { stdout: parentInfo } = await execAsync(
          `wmic process where ProcessId=${pid} get ParentProcessId /VALUE`,
        );
        const parentMatch = parentInfo.match(/ParentProcessId=(\d+)/);
        if (!parentMatch || !parentMatch[1]) continue;
        
        const ppid = parseInt(parentMatch[1], 10);
        
        // Check if parent is alive by checking if process exists
        try {
          await execAsync(`tasklist /FI "PID eq ${ppid}" /NH`);
          // Parent is alive, not an orphan
          continue;
        } catch {
          // Parent is dead - orphan
          logger.log(`[BrowserCleanup] Found orphaned firefox.exe process: PID ${pid}, dead parent PID ${ppid}`);
        }
      } catch {
        // Couldn't determine parent, assume it might be orphaned
        logger.log(`[BrowserCleanup] Potentially orphaned firefox.exe process: PID ${pid}`);
      }
      
      try {
        // Kill the process
        await execAsync(`taskkill /PID ${pid} /F`);
        cleanedCount++;
        logger.log(`[BrowserCleanup] Terminated orphaned process: PID ${pid}`);
      } catch (killError) {
        const msg = killError instanceof Error ? killError.message : String(killError);
        logger.warn(`[BrowserCleanup] Failed to kill orphaned process PID ${pid}: ${msg}`);
      }
    }
    
    if (cleanedCount > 0) {
      logger.log(`[BrowserCleanup] Cleaned up ${cleanedCount} orphaned browser process(es)`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[BrowserCleanup] Failed to find orphaned processes on Windows: ${msg}`);
  }
}

/**
 * Get the temp directory where Camoufox stores profiles
 */
export async function getCamoufoxTempDir(): Promise<string> {
  const tmpdir = os.tmpdir();
  // Camoufox uses playwright_firefoxdev_profile- prefix for profile directories
  return tmpdir;
}

/**
 * Get list of active Camoufox profile directories
 */
export async function getActiveCamoufoxProfiles(): Promise<string[]> {
  const tmpdir = await getCamoufoxTempDir();
  const profiles: string[] = [];
  
  try {
    const entries = await fs.readdir(tmpdir);
    const prefix = 'playwright_firefoxdev_profile-';
    
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        const fullPath = path.join(tmpdir, entry);
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          profiles.push(fullPath);
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[BrowserCleanup] Failed to list Camoufox profiles: ${msg}`);
  }
  
  return profiles;
}

// ============================================================================
// Browser Manager Cleanup Functions
// ============================================================================