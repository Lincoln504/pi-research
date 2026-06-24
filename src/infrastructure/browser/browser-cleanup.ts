/**
 * Browser Cleanup Utilities
 *
 * Functions for cleaning up orphaned browser processes and related resources.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
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
 * Marker that identifies a browser process as one WE launched (Camoufox via
 * Playwright), never the user's own system Firefox. Camoufox always runs from a
 * `…/camoufox/camoufox-bin` executable and under a `…/pi-research/profiles/…`
 * Playwright profile; the system browser (`/usr/lib/firefox/firefox-bin`) matches
 * neither. Matching on the full command line (not the bare comm "firefox") is what
 * makes the orphan sweep safe to run on a desktop with a personal browser open.
 */
export const PI_BROWSER_MARKER = /camoufox|[/\\]pi-research[/\\]profiles[/\\]/i;

/**
 * Cleanup orphaned processes on Unix-like systems (macOS, Linux)
 */
async function cleanupOrphanedProcessesUnix(): Promise<void> {
  try {
    // Scan by FULL command line (args), not comm, so we can positively identify our
    // own Camoufox processes and never touch the user's system Firefox.
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,args 2>/dev/null',
    );

    const lines = stdout.trim().split('\n');
    const cleanupTasks: Promise<void>[] = [];

    for (const line of lines) {
      // Capture PID, PPID, and the remaining args from each line.
      const match = line.trim().match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match || !match[1] || !match[2]) continue;

      const args = match[3] || '';
      // Only ever consider OUR Camoufox processes — never the user's Firefox.
      if (!PI_BROWSER_MARKER.test(args)) continue;

      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const comm = 'camoufox';
      // Never target ourselves.
      if (pid === process.pid) continue;

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

interface WinProc { pid: number; ppid: number; name: string; commandLine: string; }

/**
 * Snapshot all Windows processes with their parent PID and FULL command line.
 *
 * Uses PowerShell/CIM rather than `wmic` (removed by default in Windows 11 24H2
 * and Server 2025). A single call returns the whole process table, which lets us
 * (a) positively identify OUR Camoufox via {@link PI_BROWSER_MARKER} on the
 * command line — never the user's own firefox.exe — and (b) detect dead parents
 * from the same snapshot without a per-PID query.
 */
async function queryWindowsProcesses(): Promise<WinProc[]> {
  const cmd =
    'powershell -NoProfile -NonInteractive -Command ' +
    '"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"';
  const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 16 }).catch(() => ({ stdout: '' }));
  if (!stdout.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  // ConvertTo-Json emits a bare object for a single result, an array otherwise.
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const procs: WinProc[] = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    const pid = Number(rec['ProcessId']);
    if (!Number.isFinite(pid)) continue;
    const ppid = Number(rec['ParentProcessId']);
    const name = rec['Name'];
    const commandLine = rec['CommandLine'];
    procs.push({
      pid,
      // 0 is an "unknown parent" sentinel (unparseable/missing ParentProcessId).
      // It must NEVER be treated as orphaned — see cleanupOrphanedProcessesWindows.
      ppid: Number.isFinite(ppid) && ppid > 0 ? ppid : 0,
      name: typeof name === 'string' ? name : '',
      commandLine: typeof commandLine === 'string' ? commandLine : '',
    });
  }
  return procs;
}

/**
 * Cleanup orphaned processes on Windows
 */
async function cleanupOrphanedProcessesWindows(): Promise<void> {
  try {
    const procs = await queryWindowsProcesses();
    if (procs.length === 0) return;

    // Live-PID set from the same snapshot. A process whose ParentProcessId is
    // absent from this set has a dead parent — the Windows analogue of the Unix
    // path's `process.kill(ppid, 0)` liveness probe. (Windows does NOT reparent
    // to PID 1, and never resets a dead parent's PID to 0, so absence-from-table
    // is the correct signal.)
    const alivePids = new Set(procs.map((p) => p.pid));
    const cleanupTasks: Promise<void>[] = [];

    for (const proc of procs) {
      // ONLY ever consider our own Camoufox — match the full command line so the
      // user's personal firefox.exe is never a candidate. This is the safety
      // guarantee the old image-name-only match lacked.
      if (!PI_BROWSER_MARKER.test(proc.commandLine)) continue;
      if (proc.pid === process.pid) continue;
      // Unknown parent (sentinel 0): we cannot prove it is orphaned, so we must
      // NOT kill it — a live pool browser must never be force-killed on a guess.
      if (proc.ppid <= 0) continue;
      // Orphaned iff the parent is gone from the live process table.
      if (alivePids.has(proc.ppid)) continue;

      cleanupTasks.push((async () => {
        logger.log(`[BrowserCleanup] Found orphaned Camoufox process: PID ${proc.pid}, dead parent PID ${proc.ppid}`);
        try {
          await execAsync(`taskkill /PID ${proc.pid} /F /T`);
          logger.log(`[BrowserCleanup] Terminated orphaned process: PID ${proc.pid}`);
        } catch (killError) {
          const msg = killError instanceof Error ? killError.message : String(killError);
          logger.warn(`[BrowserCleanup] Failed to kill orphaned process PID ${proc.pid}: ${msg}`);
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
      // wmic-free: one CIM snapshot, matched on the full command line so only
      // OUR Camoufox children of the given workers are returned.
      const procs = await queryWindowsProcesses();
      for (const proc of procs) {
        if (!PI_BROWSER_MARKER.test(proc.commandLine)) continue;
        if (workerPids.includes(proc.ppid)) pids.push(proc.pid);
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