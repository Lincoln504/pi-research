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
   * @param expected Optional identity the caller believes is currently registered.
   *   When supplied, this is a compare-and-delete: the entry is only removed if it
   *   still matches (mirrors StateManager.clearEmbeddingServer). browserServer is
   *   shared cross-process state, and an unconditional delete lets a caller who
   *   decided the *previous* leader was dead deregister a DIFFERENT process's
   *   fresh, live registration that claimed the slot in the meantime — that new
   *   leader then runs undiscoverable (state shows no browserServer), so the next
   *   getScheduler() caller elects a second, redundant leader. A mismatch means
   *   someone else already claimed the slot, and the clear must no-op.
   * @returns Updated state without browser server info
   */
  clearBrowserServer(state: SingletonState, expected?: { pid?: number; schedulerId?: string }): SingletonState {
    const entry = state.browserServer;
    if (entry && expected !== undefined) {
      if (expected.schedulerId !== undefined && entry.schedulerId !== expected.schedulerId) return state;
      if (expected.pid !== undefined && entry.pid !== expected.pid) return state;
    }
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