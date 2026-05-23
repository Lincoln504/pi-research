import { logger } from '../logger.ts';
import { metrics } from './metrics.ts';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** How many consecutive failures to open the circuit (default: 5) */
  failureThreshold?: number;
  /** How long to wait before testing recovery in HALF_OPEN state (default: 30000ms) */
  resetTimeoutMs?: number;
  /** How many successful calls needed in HALF_OPEN to close the circuit (default: 1) */
  halfOpenMaxCalls?: number;
  /** Optional name for logging */
  name?: string;
  /** 
   * Function to determine if an error should count towards failure limit.
   * If it returns false, the error is passed through without tripping the breaker.
   * (default: counts all errors) 
   */
  isTransientError?: (error: unknown) => boolean;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private nextAttemptTime = 0;
  private options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeoutMs: options.resetTimeoutMs ?? 30000,
      halfOpenMaxCalls: options.halfOpenMaxCalls ?? 1,
      name: options.name ?? 'CircuitBreaker',
      isTransientError: options.isTransientError ?? (() => true),
    };
  }

  async execute<T>(action: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    metrics.increment('circuit_breaker_calls_total', 1, { breaker: this.options.name, state: this.state });
    
    if (this.state === 'OPEN') {
      if (Date.now() >= this.nextAttemptTime) {
        this.transitionTo('HALF_OPEN');
      } else {
        metrics.increment('circuit_breaker_rejected_total', 1, { breaker: this.options.name, reason: 'open' });
        throw new Error(`CircuitBreaker '${this.options.name}' is OPEN. Fast-failing to prevent cascading failure.`);
      }
    }

    try {
      const result = await action();
      const duration = Date.now() - startTime;
      metrics.observe('circuit_breaker_call_duration_ms', duration, { breaker: this.options.name, status: 'success' });
      this.onSuccess();
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.observe('circuit_breaker_call_duration_ms', duration, { breaker: this.options.name, status: 'error' });
      if (this.options.isTransientError(error)) {
        this.onFailure(error);
      }
      throw error;
    }
  }

  private onSuccess() {
    metrics.increment('circuit_breaker_success_total', 1, { breaker: this.options.name, state: this.state });
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.options.halfOpenMaxCalls) {
        this.transitionTo('CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      // Reset consecutive failures on success
      this.failureCount = 0;
    }
  }

  private onFailure(error: unknown) {
    this.failureCount++;
    const errMsg = error instanceof Error ? error.message : String(error);
    metrics.increment('circuit_breaker_failures_total', 1, { breaker: this.options.name, state: this.state });
    
    if (this.state === 'HALF_OPEN') {
      logger.warn(`[CircuitBreaker] '${this.options.name}' failed during HALF_OPEN state: ${errMsg}`);
      this.transitionTo('OPEN');
    } else if (this.state === 'CLOSED') {
      if (this.failureCount >= this.options.failureThreshold) {
        logger.error(`[CircuitBreaker] '${this.options.name}' reached failure threshold (${this.failureCount}): ${errMsg}`);
        this.transitionTo('OPEN');
      }
    }
  }

  private transitionTo(newState: CircuitState) {
    logger.warn(`[CircuitBreaker] '${this.options.name}' transitioning from ${this.state} to ${newState}`);
    metrics.increment('circuit_breaker_state_transitions_total', 1, { breaker: this.options.name, from: this.state, to: newState });
    metrics.setGauge('circuit_breaker_state', newState === 'CLOSED' ? 0 : newState === 'OPEN' ? 1 : 2, { breaker: this.options.name });
    this.state = newState;
    if (newState === 'OPEN') {
      this.nextAttemptTime = Date.now() + this.options.resetTimeoutMs;
    } else if (newState === 'HALF_OPEN') {
      this.successCount = 0;
    } else if (newState === 'CLOSED') {
      this.failureCount = 0;
      this.successCount = 0;
    }
  }

  public getState(): CircuitState {
    return this.state;
  }

  public reset(): void {
    metrics.increment('circuit_breaker_resets_total', 1, { breaker: this.options.name });
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptTime = 0;
    metrics.setGauge('circuit_breaker_state', 0, { breaker: this.options.name });
  }
}
