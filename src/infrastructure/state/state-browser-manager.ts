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
  getBrowserServer(state: SingletonState): { port: number; pid: number; schedulerId?: string; startTime?: number | null; authSecret?: string } | null {
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
    startTime?: number | null,
    authSecret?: string
  ): SingletonState {
    state.browserServer = { port, pid, schedulerId, startTime: startTime ?? undefined, authSecret };
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