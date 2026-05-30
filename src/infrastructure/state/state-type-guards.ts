/**
 * State Type Guards
 *
 * Type guard functions for validating state structures.
 */

import type {
  SessionInfo,
  SingletonState,
} from '../types/state-types.ts';
import { SessionInfoSchema, SingletonStateSchema } from '../types/state-types.ts';
import { Value } from 'typebox/value';

/**
 * Type guard to check if a value is a SingletonState
 */
export function isSingletonState(value: unknown): value is SingletonState {
  return Value.Check(SingletonStateSchema, value);
}

/**
 * Type guard to check if a value is a SessionInfo
 */
export function isSessionInfo(value: unknown): value is SessionInfo {
  return Value.Check(SessionInfoSchema, value);
}