/**
 * State Browser Manager
 *
 * Handles browser server coordination within the state.
 */

import type { SingletonState } from './types/state-types.ts';

/**
 * Manages browser server information in state
 */
export class StateBrowserManager {
  /**
   * Get the current browser server information
   * @param state The current state
   * @returns Browser server info or null if not set
   */
  getBrowserServer(state: SingletonState): { port: number; pid: number; schedulerId?: string } | null {
    return state.browserServer ?? null;
  }

  /**
   * Set the current browser server information
   * @param state The current state
   * @param port The browser server port
   * @param pid The browser server process ID
   * @param schedulerId Optional scheduler ID
   * @returns Updated state with browser server info
   */
  setBrowserServer(
    state: SingletonState,
    port: number,
    pid: number,
    schedulerId?: string
  ): SingletonState {
    state.browserServer = { port, pid, schedulerId };
    return state;
  }

  /**
   * Clear the browser server information
   * @param state The current state
   * @returns Updated state without browser server info
   */
  clearBrowserServer(state: SingletonState): SingletonState {
    delete state.browserServer;
    return state;
  }

  /**
   * Check if a process is alive and optionally verify scheduler ID
   * @param state The current state
   * @param pid The process ID to check
   * @param expectedSchedulerId Optional scheduler ID to verify
   * @param isPidAlive Function to check if PID is alive
   * @returns true if process is alive and scheduler ID matches (if provided)
   */
  isPidAlive(
    state: SingletonState,
    pid: number,
    expectedSchedulerId: string | undefined,
    isPidAlive: (pid: number) => boolean
  ): boolean {
    const alive = isPidAlive(pid);
    if (!alive) return false;

    if (expectedSchedulerId) {
      return state.browserServer?.schedulerId === expectedSchedulerId;
    }

    return true;
  }
}