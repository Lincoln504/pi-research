/**
 * State Validator
 *
 * Validates state structure and values.
 */

import type { SingletonState } from '../types/state-types.ts';
import { SingletonStateSchema } from '../types/state-types.ts';
import { Value } from 'typebox/value';
import { ServiceLifecycle, type IService } from '../../core/service-registry.ts';

/**
 * Validates state objects using TypeBox schemas
 */
export class StateValidator implements IService {
  readonly name = 'state-validator';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  /**
   * Validate the structure and version of a state object
   * @param state The state object to validate
   * @returns The validated and potentially coerced SingletonState
   * @throws Error if state structure or version is invalid
   */
  validateState(state: unknown): SingletonState {
    if (!state || typeof state !== 'object') {
      throw new Error('Invalid state: not an object');
    }

    // Coerce values if possible
    const coerced = Value.Convert(SingletonStateSchema, state);

    // Validate against schema
    if (!Value.Check(SingletonStateSchema, coerced)) {
      // Use coerced state for error reporting to get better paths
      const errors = [...Value.Errors(SingletonStateSchema, coerced)];
      const errorMsg = errors.map((e: any) => {
        const path = String(e.path || 'root');
        return `${path}: ${e.message} (${JSON.stringify(e.value)})`;
      }).join(', ');
      throw new Error(`Invalid state: ${errorMsg}`);
    }

    // Additional value range checks not easily covered by basic schemas
    if (coerced.port < 0 || coerced.port > 65535) {
      throw new Error(`Invalid state: port must be 0-65535, got ${coerced.port}`);
    }

    if (coerced.browserServer && (coerced.browserServer.port < 0 || coerced.browserServer.port > 65535)) {
      throw new Error(`Invalid state: browserServer.port must be 0-65535, got ${coerced.browserServer.port}`);
    }

    return coerced;
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