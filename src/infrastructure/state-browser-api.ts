/**
 * State Browser API
 *
 * Browser server management API that delegates to StateBrowserManager.
 */

import type { StateBrowserManager } from './state-browser-manager.ts';
import type { SingletonState } from './types/state-types.ts';

/**
 * Provides browser server management operations
 */
export class StateBrowserApi {
  constructor(private readonly browserManager: StateBrowserManager) {}

  /**
   * Get the current browser server information
   * @param readState Function to read state
   * @returns Browser server info or null if not set
   */
  async getBrowserServer(
    readState: () => Promise<SingletonState>
  ): Promise<{ port: number; pid: number; schedulerId?: string } | null> {
    const state = await readState();
    return this.browserManager.getBrowserServer(state);
  }

  /**
   * Set the current browser server information (atomic: only overwrites if no live server exists)
   * @param port The browser server port
   * @param pid The browser server process ID
   * @param schedulerId Optional scheduler ID
   * @param updateState Function to update state atomically
   */
  async setBrowserServer(
    port: number,
    pid: number,
    schedulerId: string | undefined,
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>
  ): Promise<void> {
    await updateState((state) => {
      return this.browserManager.setBrowserServer(state, port, pid, schedulerId);
    });
  }

  /**
   * Clear the browser server information
   * @param updateState Function to update state atomically
   */
  async clearBrowserServer(
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>
  ): Promise<void> {
    await updateState((state) => {
      return this.browserManager.clearBrowserServer(state);
    });
  }

  /**
   * Check if a process is alive with optional scheduler ID verification
   * @param pid The process ID to check
   * @param expectedSchedulerId Optional scheduler ID to verify
   * @param readState Function to read state (can skip lock)
   * @param isPidAlive Function to check if PID is alive
   * @param skipLock Whether to skip lock when reading state
   * @returns true if process is alive and scheduler ID matches (if provided)
   */
  async isPidAlive(
    pid: number,
    expectedSchedulerId: string | undefined,
    readState: () => Promise<SingletonState>,
    isPidAlive: (pid: number) => boolean
  ): Promise<boolean> {
    const alive = isPidAlive(pid);
    if (!alive) return false;

    if (expectedSchedulerId) {
      const state = await readState();
      return this.browserManager.isPidAlive(state, pid, expectedSchedulerId, isPidAlive);
    }

    return true;
  }
}