/**
 * State Browser API
 *
 * Browser server management API that delegates to StateBrowserManager.
 */

import type { StateBrowserManager } from './state-browser-manager.ts';
import type { SingletonState } from '../types/state-types.ts';

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
  ): Promise<{ port: number; pid: number; schedulerId?: string; startTime?: number | null; authSecret?: string } | null> {
    const state = await readState();
    return this.browserManager.getBrowserServer(state);
  }

  /**
   * Clear the browser server information
   * @param updateState Function to update state atomically
   * @param expected Optional expected-owner identity forwarded to the CAS check
   *   in StateBrowserManager.clearBrowserServer.
   */
  async clearBrowserServer(
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>,
    expected?: { pid?: number; schedulerId?: string }
  ): Promise<void> {
    await updateState((state) => {
      return this.browserManager.clearBrowserServer(state, expected);
    });
  }

}