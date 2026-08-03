/**
 * Process Lifecycle Service
 *
 * Provides PID checks and process monitoring functionality.
 * Stateless service for checking if processes are alive.
 */

import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { IProcessLifecycle } from '../core/interfaces/process-interfaces.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';

/**
 * Process Lifecycle Service
 *
 * Provides utilities for checking process liveness and monitoring.
 */
export class ProcessLifecycleService implements IProcessLifecycle {
  readonly name = ServiceNames.PROCESS_LIFECYCLE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private cachedStartTime: number | null = null;

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    // Stateless service
  }

  /**
   * Get the start time of a process (Linux only).
   * Combined with PID, this provides a globally unique identifier for a process
   * even if PIDs are recycled by the OS.
   * 
   * @param pid Process ID
   * @returns Start time identifier (Linux: jiffies; cross-platform: epoch seconds) or null
   */
  async getProcessStartTime(pid: number): Promise<number | null> {
    // Linux: read from /proc/{pid}/stat (field 22 = starttime in jiffies)
    if (process.platform === 'linux') {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        const lastParenIndex = stat.lastIndexOf(')');
        if (lastParenIndex === -1) return null;
        const partsAfterName = stat.substring(lastParenIndex + 2).trim().split(/\s+/);
        const startTimeStr = partsAfterName[19];
        return startTimeStr ? parseInt(startTimeStr, 10) : null;
      } catch (_err) {
        // ENOENT is common if process just died
        return null;
      }
    }

    // Windows: use powershell to get process creation time
    if (process.platform === 'win32') {
      try {
        const output = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            'powershell', 
            ['-NoProfile', '-Command', `[Math]::Floor(([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeSeconds())`],
            { encoding: 'utf8', timeout: 5000 },
            (err, stdout) => err ? reject(err) : resolve(stdout),
          );
          child.unref?.();
        });
        if (!output || !output.trim()) return null;
        const startTime = parseInt(output.trim(), 10);
        return isNaN(startTime) ? null : startTime;
      } catch {
        return null;
      }
    }

    // Cross-platform fallback (macOS/Unix): `ps -o etimes=` returns elapsed seconds.
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'ps', ['-o', 'etimes=', '-p', String(pid)],
          { encoding: 'utf8', timeout: 3000 },
          (err, stdout) => err ? reject(err) : resolve(stdout),
        );
        child.unref?.();
      });
      if (!output || !output.trim()) return null;
      const elapsedSec = parseInt(output.trim(), 10);
      if (isNaN(elapsedSec)) return null;
      return Math.floor(Date.now() / 1000) - elapsedSec;
    } catch {
      return null;
    }
  }

  /**
   * Get the start time for the current process
   */
  async getCurrentProcessStartTime(): Promise<number | null> {
    if (this.cachedStartTime !== null) return this.cachedStartTime;
    this.cachedStartTime = await this.getProcessStartTime(process.pid);
    return this.cachedStartTime;
  }

  /**
   * Check if a process is alive by sending signal 0.
   * Optionally verifies that the start time matches to prevent PID reuse races.
   *
   * @param pid Process ID to check
   * @param expectedStartTime Optional start time to verify (from getProcessStartTime)
   * @returns true if process is alive (and matches start time if provided)
   */
  async isProcessAlive(pid: number, expectedStartTime?: number | null): Promise<boolean> {
    try {
      // 1. Basic liveness check via signal 0
      process.kill(pid, 0);
      
      // 2. If start time verification requested, check it
      if (expectedStartTime !== undefined && expectedStartTime !== null) {
        const actualStartTime = await this.getProcessStartTime(pid);
        if (actualStartTime === null) {
          // signal(0) above confirmed a live process at this PID, but we couldn't
          // resolve its start time to verify it's the SAME instance (the PID-reuse
          // guard). The two failure modes collapse to the same null here but must
          // NOT be treated identically:
          //   • Linux: usually the process exited in the microsecond gap between
          //     signal(0) and the /proc/{pid}/stat read → genuinely dead.
          //   • Windows/macOS: far more often the start-time lookup subprocess
          //     (powershell `Get-Process` / `ps`) simply failed or hit its timeout
          //     while the process is still very much alive → NOT dead.
          // Reporting that confirmed-alive PID as DEAD is catastrophic for every
          // caller — a live lock/leader/run-cap owner is reclaimed from under it
          // → two writers collide (lost update) or the run-cap admits extra
          // concurrent runs (the flaky duplicate-slot/cap-breach we saw on Windows
          // CI). So re-confirm liveness instead of guessing: if signal(0) STILL
          // succeeds the process is alive → return true; if it now throws it died
          // between the two probes and the outer catch returns false. A genuine
          // death is therefore still detected within one poll tick (~100ms); the
          // only behavioural change is that a confirmed-alive PID is never again
          // misreported as dead on a transient start-time lookup failure.
          process.kill(pid, 0); // re-confirm; a throw (process died) → outer catch → false
          return true;
        }
        // Allow ±1s slack. The macOS/BSD fallback derives start time as
        // floor(Date.now()/1000) - `ps etimes` (elapsed whole seconds); both terms are
        // independently quantized, so the SAME process can compute start times 1s apart
        // across two reads. A strict === there makes a live lock/leader owner read as
        // dead → the lock is reclaimed from under a live writer (lost update). PID reuse
        // within a 1s window at the identical PID is not a realistic false-match.
        return Math.abs(actualStartTime - expectedStartTime) <= 1;
      }
      
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sync version of basic liveness check (no start-time verification)
   */
  isProcessAliveSync(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a process is alive with optional scheduler ID verification.
   * This method is designed to work with state that contains scheduler information.
   *
   * @param pid Process ID to check
   * @param expectedSchedulerId Optional scheduler ID to verify
   * @param getState Function to retrieve current state for scheduler ID verification
   * @param skipLock If true, skip locking when retrieving state (useful to prevent deadlocks)
   * @returns true if process is alive and (if provided) matches expected scheduler ID
   */
  async isPidAlive<TState>(
    pid: number,
    expectedSchedulerId?: string,
    options?: {
      getState?: (skipLock?: boolean) => Promise<TState>;
      skipLock?: boolean;
      getSchedulerIdFromState?: (state: TState) => string | undefined;
      expectedStartTime?: number | null;
    }
  ): Promise<boolean> {
    const alive = await this.isProcessAlive(pid, options?.expectedStartTime);
    if (!alive) return false;

    if (expectedSchedulerId && options?.getState && options?.getSchedulerIdFromState) {
      // Use skipLock if true to prevent deadlocks when called inside updateState
      const state = await options.getState(options.skipLock);
      const schedulerId = options.getSchedulerIdFromState(state);
      return schedulerId === expectedSchedulerId;
    }

    return true;
  }

  /**
   * Get the current process ID
   */
  getCurrentPid(): number {
    return process.pid;
  }

  /**
   * Wait for a process to terminate
   *
   * @param pid Process ID to wait for
   * @param timeoutMs Maximum time to wait in milliseconds
   * @param checkIntervalMs Interval between checks in milliseconds
   * @param expectedStartTime Optional start time to verify
   * @returns true if process terminated, false if timeout
   */
  async waitForProcessTermination(
    pid: number,
    timeoutMs: number = 5000,
    checkIntervalMs: number = 100,
    expectedStartTime?: number | null
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (!(await this.isProcessAlive(pid, expectedStartTime))) {
        return true;
      }
      await this.sleep(checkIntervalMs);
    }

    return false;
  }

  /**
   * Check if the current process is the one with the given PID
   *
   * @param pid Process ID to check
   * @returns true if the current process has the given PID
   */
  isCurrentProcess(pid: number): boolean {
    return process.pid === pid;
  }

  /**
   * Get process information (platform-specific)
   *
   * @param pid Process ID to get information for
   * @returns Process information or null if not available
   */
  async getProcessInfo(pid: number): Promise<{ pid: number; alive: boolean; startTime?: number | null } | null> {
    const startTime = await this.getProcessStartTime(pid);
    const alive = await this.isProcessAlive(pid, startTime);
    return {
      pid,
      alive,
      startTime,
    };
  }

  /**
   * Sleep for a specified number of milliseconds
   * @param ms The number of milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}