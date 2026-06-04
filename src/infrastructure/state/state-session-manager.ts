/**
 * State Session Manager
 *
 * Handles session lifecycle and cleanup operations for the StateManager.
 */

import type { ProcessLifecycleService } from '../process-lifecycle-service.ts';
import type { SingletonState } from '../types/state-types.ts';
import { ServiceLifecycle, type IService } from '../../core/service-registry.ts';

/**
 * Manages session operations for state
 */
export class StateSessionManager implements IService {
  readonly name = 'state-session-manager';
  lifecycle = ServiceLifecycle.UNINITIALIZED;
  constructor(private readonly processLifecycle: ProcessLifecycleService) {}

  /**
   * Add a new session to the state
   * @param state The current state
   * @param sessionId The session ID to add
   * @param pid The process ID
   * @returns Updated state with new session
   */
  addSession(state: SingletonState, sessionId: string, pid: number): SingletonState {
    state.sessions[sessionId] = {
      pid,
      lastSeen: Date.now(),
      connectedAt: Date.now(),
    };

    return state;
  }

  /**
   * Remove a session from the state
   * @param state The current state
   * @param sessionId The session ID to remove
   * @returns Updated state without the session
   */
  removeSession(state: SingletonState, sessionId: string): SingletonState {
    if (state.sessions[sessionId] !== undefined) {
      delete state.sessions[sessionId];
    }
    return state;
  }

  /**
   * Update the heartbeat timestamp for a session
   * @param state The current state
   * @param sessionId The session ID to update
   * @returns Updated state with updated heartbeat
   */
  updateHeartbeat(state: SingletonState, sessionId: string): SingletonState {
    const session = state.sessions[sessionId];
    if (session !== undefined) {
      session.lastSeen = Date.now();
    }
    return state;
  }

  /**
   * Clean up stale sessions based on timeout and process liveness
   * @param state The current state
   * @param timeoutMs Timeout in milliseconds for session staleness
   * @returns Number of sessions to remove and their lastSeen timestamps
   */
  classifyStaleSessions(state: SingletonState, timeoutMs: number): Map<string, number> {
    const now = Date.now();
    const sessionsToRemove = new Map<string, number>();

    for (const [sessionId, sessionInfo] of Object.entries(state.sessions)) {
      // Primary check: lastSeen timeout
      const lastSeenAge = now - sessionInfo.lastSeen;

      if (lastSeenAge > timeoutMs) {
        sessionsToRemove.set(sessionId, sessionInfo.lastSeen);
        continue;
      }

      // Secondary check: is process still alive?
      const isAlive = this.processLifecycle.isProcessAlive(sessionInfo.pid);

      if (!isAlive) {
        sessionsToRemove.set(sessionId, sessionInfo.lastSeen);
      }
    }

    return sessionsToRemove;
  }

  /**
   * Remove stale sessions from state
   * @param state The current state
   * @param sessionsToRemove Map of session IDs to their lastSeen timestamps
   * @returns Updated state with stale sessions removed
   */
  removeStaleSessions(state: SingletonState, sessionsToRemove: Map<string, number>): SingletonState {
    for (const [sessionId, lastSeenAtClassify] of sessionsToRemove) {
      const current = state.sessions[sessionId];
      if (current && current.lastSeen === lastSeenAtClassify) {
        delete state.sessions[sessionId];
      }
    }
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