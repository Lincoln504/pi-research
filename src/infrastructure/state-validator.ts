/**
 * State Validator
 *
 * Validates state structure and values.
 */

import type { SingletonState } from './types/state-types.ts';
import { isSessionInfo, isSingletonState } from './state-type-guards.ts';

/**
 * Validates state objects
 */
export class StateValidator {
  /**
   * Validate the structure and version of a state object
   * @param state The state object to validate
   * @throws Error if state structure or version is invalid
   */
  validateState(state: unknown): asserts state is SingletonState {
    if (!state || typeof state !== 'object') {
      throw new Error('Invalid state: not an object');
    }

    if (!isSingletonState(state)) {
      throw new Error('Invalid state: structure or version mismatch');
    }

    // Type guard already validated the structure, now validate values
    if (state.port < 0 || state.port > 65535) {
      throw new Error(`Invalid state: port must be a number between 0 and 65535, got ${state.port}`);
    }

    if (state.lastUpdated < 0) {
      throw new Error(`Invalid state: lastUpdated must be a non-negative number, got ${state.lastUpdated}`);
    }

    if (state.browserServer !== undefined) {
      const bs = state.browserServer;
      if (typeof bs.port !== 'number' || typeof bs.pid !== 'number') {
        throw new Error('Invalid state: browserServer must have numeric port and pid fields');
      }
      if (bs.port < 0 || bs.port > 65535) {
        throw new Error(`Invalid state: browserServer.port must be 0-65535, got ${bs.port}`);
      }
    }

    if (state.schedulerVersion !== undefined && typeof state.schedulerVersion !== 'string') {
      throw new Error('Invalid state: schedulerVersion must be a string');
    }

    if (state.gpuOwner !== undefined) {
      const go = state.gpuOwner;
      if (typeof go.pid !== 'number' || typeof go.startedAt !== 'number') {
        throw new Error('Invalid state: gpuOwner must have numeric pid and startedAt fields');
      }
    }

    for (const [sessionId, sessionData] of Object.entries(state.sessions)) {
      if (typeof sessionId !== 'string') {
        throw new Error('Invalid state: session IDs must be strings');
      }

      if (!isSessionInfo(sessionData)) {
        throw new Error(`Invalid state: session data for ${sessionId} has invalid structure`);
      }

      if (sessionData.pid < 0) {
        throw new Error(`Invalid state: pid for ${sessionId} must be a non-negative number, got ${sessionData.pid}`);
      }

      if (sessionData.lastSeen < 0) {
        throw new Error(`Invalid state: lastSeen for ${sessionId} must be a non-negative number, got ${sessionData.lastSeen}`);
      }

      if (sessionData.connectedAt < 0) {
        throw new Error(`Invalid state: connectedAt for ${sessionId} must be a non-negative number, got ${sessionData.connectedAt}`);
      }
    }
  }
}