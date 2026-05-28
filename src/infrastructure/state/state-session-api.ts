/**
 * State Session API
 *
 * Session management API that delegates to StateSessionManager.
 * This separates the public API from the internal session manager.
 */

import type { SingletonState } from '../types/state-types.ts';
import type { StateSessionManager } from './state-session-manager.ts';

/**
 * Provides session management operations on top of StateSessionManager
 */
export class StateSessionApi {
  constructor(private readonly sessionManager: StateSessionManager) {}

  /**
   * Add a new session to the state
   * @param sessionId The session ID to add
   * @param param PID (number) or container name (string)
   * @param updateState Function to update state atomically
   * @param getCurrentProcess Function to get current process pid
   * @throws Error if unable to update state
   */
  async addSession(
    sessionId: string,
    param: number | string,
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>,
    processPid: number
  ): Promise<void> {
    const pid = typeof param === 'number' ? param : processPid;
    await updateState(async (state): Promise<SingletonState> => {
      return this.sessionManager.addSession(state, sessionId, pid);
    });
  }

  /**
   * Remove a session from the state
   * @param sessionId The session ID to remove
   * @param updateState Function to update state atomically
   */
  async removeSession(
    sessionId: string,
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>
  ): Promise<void> {
    await updateState((state): SingletonState => {
      return this.sessionManager.removeSession(state, sessionId);
    });
  }

  /**
   * Update the heartbeat timestamp for a session
   * @param sessionId The session ID to update
   * @param updateState Function to update state atomically
   */
  async updateHeartbeat(
    sessionId: string,
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>
  ): Promise<void> {
    await updateState((state): SingletonState => {
      return this.sessionManager.updateHeartbeat(state, sessionId);
    });
  }

  /**
   * Clean up stale sessions based on timeout and process liveness
   * @param timeoutMs Timeout in milliseconds for session staleness
   * @param readState Function to read state
   * @param updateState Function to update state atomically
   * @returns Number of sessions removed
   */
  async cleanupStaleSessions(
    timeoutMs: number,
    readState: () => Promise<SingletonState>,
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>
  ): Promise<number> {
    const state = await readState();
    const sessionsToRemove = this.sessionManager.classifyStaleSessions(state, timeoutMs);

    // Remove stale sessions under a fresh lock. Re-validate lastSeen so a
    // session that received a heartbeat between the two lock acquisitions is
    // not accidentally deleted (TOCTOU guard).
    if (sessionsToRemove.size > 0) {
      await updateState((state): SingletonState => {
        return this.sessionManager.removeStaleSessions(state, sessionsToRemove);
      });
    }

    return sessionsToRemove.size;
  }
}