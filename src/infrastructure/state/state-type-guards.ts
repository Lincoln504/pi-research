/**
 * State Type Guards
 *
 * Type guard functions for validating state structures.
 */

import type {
  SessionInfo,
  SingletonState,
} from '../types/state-types.ts';

/**
 * Type guard to check if a value is a SingletonState
 */
export function isSingletonState(value: unknown): value is SingletonState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const state = value as Partial<SingletonState>;

  return (
    state.version === 1 &&
    typeof state.containerId === 'string' &&
    typeof state.containerName === 'string' &&
    typeof state.port === 'number' &&
    typeof state.sessions === 'object' &&
    typeof state.lastUpdated === 'number'
  );
}

/**
 * Type guard to check if a value is a SessionInfo
 */
export function isSessionInfo(value: unknown): value is SessionInfo {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const session = value as Partial<SessionInfo>;

  return (
    typeof session.pid === 'number' &&
    typeof session.lastSeen === 'number' &&
    typeof session.connectedAt === 'number'
  );
}