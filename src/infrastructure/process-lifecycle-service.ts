/**
 * Process Lifecycle Service
 *
 * Provides PID checks and process monitoring functionality.
 * Stateless service for checking if processes are alive.
 */

/**
 * Process Lifecycle Service
 *
 * Provides utilities for checking process liveness and monitoring.
 */
export class ProcessLifecycleService {
  /**
   * Check if a process is alive by sending signal 0.
   * Works on Linux, Mac, and Windows (Node.js implementation).
   *
   * @param pid Process ID to check
   * @returns true if process is alive, false otherwise
   */
  isProcessAlive(pid: number): boolean {
    try {
      // Try to send signal 0 to check if process exists
      // Works on Linux, Mac, and Windows (Node.js implementation)
      process.kill(pid, 0);
      return true;
    } catch {
      // Process doesn't exist or we can't check it
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
    }
  ): Promise<boolean> {
    const alive = this.isProcessAlive(pid);
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
   * @param timeoutMs Maximum time to wait in milliseconds (default: 5000ms)
   * @param checkIntervalMs Interval between checks in milliseconds (default: 100ms)
   * @returns true if process terminated, false if timeout
   */
  async waitForProcessTermination(
    pid: number,
    timeoutMs: number = 5000,
    checkIntervalMs: number = 100
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (!this.isProcessAlive(pid)) {
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
  async getProcessInfo(pid: number): Promise<{ pid: number; alive: boolean } | null> {
    const alive = this.isProcessAlive(pid);
    return {
      pid,
      alive,
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

/**
 * Global singleton ProcessLifecycleService instance
 */
let _sharedProcessLifecycleService: ProcessLifecycleService | null = null;

/**
 * Get the shared ProcessLifecycleService instance.
 * Module-level singleton for efficiency.
 */
export function getSharedProcessLifecycleService(): ProcessLifecycleService {
  if (!_sharedProcessLifecycleService) {
    _sharedProcessLifecycleService = new ProcessLifecycleService();
  }
  return _sharedProcessLifecycleService;
}