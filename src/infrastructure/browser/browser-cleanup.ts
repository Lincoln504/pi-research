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
import { logger } from '../../logger.ts';

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
    // Simplified regex to just match PID and PPID reliably
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,comm | grep -E "(firefox|camoufox)" | grep -v grep',
    );
    
    const lines = stdout.trim().split('\n');
    const cleanupTasks: Promise<void>[] = [];
    
    for (const line of lines) {
      // Capture PID and PPID from the start of the line
      const match = line.trim().match(/^\s*(\d+)\s+(\d+)/);
      if (!match || !match[1] || !match[2]) continue;
      
      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const comm = line.trim().split(/\s+/)[2] || 'unknown';
      
      // Determine if orphan:
      // 1. PPID is 1 (adopted by init)
      // 2. Parent PID is dead (process.kill(ppid, 0) throws)
      let isOrphan = false;
      if (ppid === 1) {
        isOrphan = true;
      } else {
        try {
          process.kill(ppid, 0);
          isOrphan = false;
        } catch {
          isOrphan = true;
        }
      }

      if (isOrphan) {
        cleanupTasks.push((async () => {
          logger.log(`[BrowserCleanup] Found orphaned ${comm} process: PID ${pid}, parent PID ${ppid}`);
          
          try {
            // Kill the orphaned process gracefully
            process.kill(pid, 'SIGTERM');
            
            // Give it a moment to exit gracefully (wait in parallel)
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
        })());
      }
    }
    
    if (cleanupTasks.length > 0) {
      await Promise.all(cleanupTasks);
      logger.log(`[BrowserCleanup] Cleaned up ${cleanupTasks.length} orphaned browser process(es)`);
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
    const cleanupTasks: Promise<void>[] = [];
    
    for (const line of lines) {
      if (!line.includes('firefox.exe')) continue;
      
      const match = line.match(/"(\d+)"/);
      if (!match || !match[1]) continue;
      
      const pid = parseInt(match[1], 10);
      
      cleanupTasks.push((async () => {
        // Check if parent process is still alive
        try {
          // On Windows, we need to use wmic to get parent PID
          const { stdout: parentInfo } = await execAsync(
            `wmic process where ProcessId=${pid} get ParentProcessId /VALUE`,
          );
          const parentMatch = parentInfo.match(/ParentProcessId=(\d+)/);
          if (!parentMatch || !parentMatch[1]) return;
          
          const ppid = parseInt(parentMatch[1], 10);
          
          // Check if parent is alive by checking if process exists
          try {
            await execAsync(`tasklist /FI "PID eq ${ppid}" /NH`);
            // Parent is alive, not an orphan
            return;
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
          logger.log(`[BrowserCleanup] Terminated orphaned process: PID ${pid}`);
        } catch (killError) {
          const msg = killError instanceof Error ? killError.message : String(killError);
          logger.warn(`[BrowserCleanup] Failed to kill orphaned process PID ${pid}: ${msg}`);
        }
      })());
    }
    
    if (cleanupTasks.length > 0) {
      await Promise.all(cleanupTasks);
      logger.log(`[BrowserCleanup] Cleaned up ${cleanupTasks.length} orphaned browser process(es)`);
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

/**
 * Snapshot browser PIDs that are children of the given worker PIDs
 */
export async function getBrowserPidsForWorkers(workerPids: number[]): Promise<number[]> {
  const platform = os.platform();
  const pids: number[] = [];
  if (!workerPids || workerPids.length === 0) return pids;

  try {
    if (platform === 'darwin' || platform === 'linux') {
      const { stdout } = await execAsync('ps -eo pid,ppid,comm | grep -E "(firefox|camoufox)" | grep -v grep').catch(() => ({ stdout: '' }));
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const match = line.trim().match(/^\s*(\d+)\s+(\d+)\s+/);
        if (match && match[1] && match[2]) {
          const pid = parseInt(match[1], 10);
          const ppid = parseInt(match[2], 10);
          if (workerPids.includes(ppid)) pids.push(pid);
        }
      }
    } else if (platform === 'win32') {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq firefox.exe" /FO CSV /NH').catch(() => ({ stdout: '' }));
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        if (!line.includes('firefox.exe')) continue;
        const match = line.match(/"(\d+)"/);
        if (!match || !match[1]) continue;
        const pid = parseInt(match[1], 10);
        try {
          const { stdout: parentInfo } = await execAsync(`wmic process where ProcessId=${pid} get ParentProcessId /VALUE`);
          const parentMatch = parentInfo.match(/ParentProcessId=(\d+)/);
          if (parentMatch && parentMatch[1]) {
            const ppid = parseInt(parentMatch[1], 10);
            if (workerPids.includes(ppid)) pids.push(pid);
          }
        } catch {
          // Ignore errors for individual process lookups
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[BrowserCleanup] Failed to get browser PIDs for workers: ${msg}`);
  }
  return pids;
}

/**
 * Kill specific browser processes in parallel
 */
export async function killBrowserProcesses(pids: number[]): Promise<void> {
  if (!pids || pids.length === 0) return;
  const platform = os.platform();
  
  // Parallelize killing processes for speed
  await Promise.all(pids.map(async (pid) => {
    try {
      if (platform === 'win32') {
        await execAsync(`taskkill /PID ${pid} /F /T`);
        logger.debug(`[BrowserCleanup] Terminated worker browser process: PID ${pid}`);
      } else {
        process.kill(pid, 'SIGTERM');
        // Reduce wait time for graceful exit from 500ms to 200ms
        await new Promise(resolve => setTimeout(resolve, 200));
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
          logger.debug(`[BrowserCleanup] Force killed worker browser process: PID ${pid}`);
        } catch {
          logger.debug(`[BrowserCleanup] Terminated worker browser process: PID ${pid}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`[BrowserCleanup] Failed to kill browser process PID ${pid}: ${msg}`);
    }
  }));
}