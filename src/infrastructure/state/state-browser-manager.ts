/**
 * State Browser Manager
 *
 * Handles browser server coordination within the state.
 */

import type { SingletonState } from '../types/state-types.ts';
import { ServiceLifecycle, type IService } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/interfaces/service-names.ts';

/**
 * Manages browser server information in state
 */
export class StateBrowserManager implements IService {
  readonly name = ServiceNames.STATE_BROWSER_MANAGER;
  lifecycle = ServiceLifecycle.UNINITIALIZED;
  /**
   * Get the current browser server information
   * @param state The current state
   * @returns Browser server info or null if not set
   */
  getBrowserServer(state: SingletonState): { port: number; pid: number; schedulerId?: string; startTime?: number | null } | null {
    return state.browserServer ?? null;
  }

  /**
   * Set the current browser server information
   * @param state The current state
   * @param port The browser server port
   * @param pid The browser server process ID
   * @param schedulerId Optional scheduler ID
   * @param startTime Optional process start time
   * @returns Updated state with browser server info
   */
  setBrowserServer(
    state: SingletonState,
    port: number,
    pid: number,
    schedulerId?: string,
    startTime?: number | null
  ): SingletonState {
    state.browserServer = { port, pid, schedulerId, startTime: startTime ?? undefined };
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

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }
}