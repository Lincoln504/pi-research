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
 * Parse the POSIX `ps -o etime=` elapsed-time format into whole seconds.
 * Accepted shapes: `MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`. Returns null if it does
 * not parse, so a caller degrades to "unknown" rather than to a bogus number.
 */
export function parseEtime(value: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const minutes = parseInt(m[3]!, 10);
  const seconds = parseInt(m[4]!, 10);
  if ([days, hours, minutes, seconds].some((n) => isNaN(n))) return null;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Does this `process.kill(pid, 0)` failure mean the process is GONE?
 *
 * Only `ESRCH` does. `EPERM` (POSIX) and `EACCES` — which is what libuv surfaces
 * on Windows when `OpenProcess` returns ERROR_ACCESS_DENIED — both mean the
 * process EXISTS but is not ours to signal: another user on a shared host, a CI
 * side-car, a different Windows session. Reporting those as dead lets a caller
 * reclaim a live lock, run slot or leader out from under its owner, which is how
 * two writers end up racing the state file. The orphan guard and the browser
 * sweep already get this right; this is the same rule.
 */
function isDefinitelyGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EPERM' || code === 'EACCES') return false;
  return true;
}

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

    // Cross-platform fallback (macOS/BSD): derive start time from elapsed time.
    //
    // `etimes` (elapsed WHOLE SECONDS) is a procps-ng/FreeBSD extension. Apple's
    // ps (adv_cmds) does not implement it — it has only the POSIX `etime`
    // ([[dd-]hh:]mm:ss). Asking for an unsupported keyword does not fail loudly:
    // procps-ng writes an error to stderr and still exits 0 with EMPTY stdout,
    // BSD ps exits non-zero. Both collapse to `null` here, which meant every
    // PID+start-time guard on macOS silently degraded to a bare signal-0 check —
    // the file lock, the run-slot semaphore, the GPU lock and both leader
    // elections all advertise PID-reuse safety they were not actually getting.
    //
    // So: try `etimes`, and fall back to parsing POSIX `etime` when it yields
    // nothing. `etime` is mandated by POSIX, so the fallback works everywhere.
    const elapsedSec = await this.readElapsedSeconds(pid);
    if (elapsedSec === null) return null;
    return Math.floor(Date.now() / 1000) - elapsedSec;
  }

  /** Elapsed seconds for `pid` via ps, or null. Tries `etimes`, then POSIX `etime`. */
  private async readElapsedSeconds(pid: number): Promise<number | null> {
    const run = async (fmt: string): Promise<string | null> => {
      try {
        return await new Promise<string>((resolve, reject) => {
          const child = execFile(
            'ps', ['-o', fmt, '-p', String(pid)],
            { encoding: 'utf8', timeout: 3000 },
            (err, stdout) => err ? reject(err) : resolve(stdout),
          );
          child.unref?.();
        });
      } catch {
        return null;
      }
    };

    const etimes = await run('etimes=');
    if (etimes && etimes.trim()) {
      const n = parseInt(etimes.trim(), 10);
      if (!isNaN(n)) return n;
    }

    const etime = await run('etime=');
    if (etime && etime.trim()) return parseEtime(etime.trim());

    return null;
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
    // 1. EXISTENCE. Separate from identity (step 2) on purpose: a permission error
    //    means the process exists but is not ours to signal, which must NOT
    //    short-circuit the start-time comparison — a PID-reuse impostor owned by
    //    another user would otherwise read as a live owner and deadlock the lock,
    //    run slot or leadership it forged.
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (isDefinitelyGone(err)) return false;
      // EPERM/EACCES: exists, not signalable by us — continue to the identity check.
    }

    try {
      // 2. IDENTITY. If start time verification requested, check it.
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
          // CI). So re-confirm existence instead of guessing: if the PID is STILL
          // there the process is alive → true; if it has gone it died between the
          // two probes → false. A genuine death is therefore still detected within
          // one poll tick (~100ms); the only behavioural change is that a
          // confirmed-alive PID is never again misreported as dead on a transient
          // start-time lookup failure.
          try {
            process.kill(pid, 0);
            return true;
          } catch (reconfirmErr) {
            return !isDefinitelyGone(reconfirmErr);
          }
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
      // The start-time lookup itself blew up (not a signal error — those are
      // handled above). Existence was already established, so treat it as alive:
      // reclaiming a confirmed-present owner is the worse failure.
      return true;
    }
  }

  /**
   * Sync version of basic liveness check (no start-time verification)
   */
  isProcessAliveSync(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return !isDefinitelyGone(err);
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