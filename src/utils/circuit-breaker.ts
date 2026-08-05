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
  // Number of trial calls currently executing in HALF_OPEN. Caps concurrent probes so a burst of
  // parallel callers doesn't all hit a still-recovering dependency the instant the breaker half-opens.
  private halfOpenInFlight = 0;
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

    // HALF_OPEN admission control: allow only halfOpenMaxCalls trial calls to execute at once and
    // fast-fail the rest. Without this, once the first caller flips OPEN→HALF_OPEN every other
    // concurrent caller sees state !== 'OPEN', skips the gate, and hits the still-down dependency
    // simultaneously — defeating the single-trial probe and immediately re-opening the breaker.
    let admittedAsProbe = false;
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenInFlight >= this.options.halfOpenMaxCalls) {
        metrics.increment('circuit_breaker_rejected_total', 1, { breaker: this.options.name, reason: 'half_open_probe_limit' });
        throw new Error(`CircuitBreaker '${this.options.name}' is HALF_OPEN (trial in progress). Fast-failing to limit probes.`);
      }
      this.halfOpenInFlight++;
      admittedAsProbe = true;
    }

    try {
      const result = await action();
      const duration = Date.now() - startTime;
      metrics.observe('circuit_breaker_call_duration_ms', duration, { breaker: this.options.name, status: 'success' });
      this.onSuccess(admittedAsProbe);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.observe('circuit_breaker_call_duration_ms', duration, { breaker: this.options.name, status: 'error' });
      if (this.options.isTransientError(error)) {
        this.onFailure(error);
      } else if (admittedAsProbe && this.state === 'HALF_OPEN') {
        // The trial probe failed for a reason this breaker does not count. That is
        // INCONCLUSIVE, not healthy — so re-open and wait out another reset window
        // rather than staying HALF_OPEN.
        //
        // Without this the breaker pins permanently: onFailure is the only path to
        // OPEN, and it is skipped for non-counted errors, while transitionTo(HALF_OPEN)
        // never re-arms nextAttemptTime. The admission gate above then fast-fails every
        // caller beyond halfOpenMaxCalls (default 1) forever. This is not a corner case
        // for the browser pool: DEFAULT_BREAKER_CONFIG.isTransientError deliberately
        // excludes pool-shutdown, draining, Cloudflare and task-timeout errors — exactly
        // what a recovering or blocked pool returns — so the probe most likely to run is
        // also the one most likely to pin the breaker. Observed effect: 19 of a 20-query
        // parallel burst fast-failing instantly, surfacing to the researcher as
        // "your query may be too narrow".
        logger.warn(
          `[CircuitBreaker] '${this.options.name}' HALF_OPEN probe failed with a non-counted error; ` +
            `treating as inconclusive and re-opening: ${error instanceof Error ? error.message : String(error)}`
        );
        this.transitionTo('OPEN');
      }
      throw error;
    } finally {
      if (admittedAsProbe) this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
  }

  private onSuccess(admittedAsProbe: boolean) {
    metrics.increment('circuit_breaker_success_total', 1, { breaker: this.options.name, state: this.state });
    if (this.state === 'HALF_OPEN') {
      // Only a call admitted through the HALF_OPEN gate is evidence of recovery.
      // A call admitted while CLOSED that merely settles after the breaker tripped
      // and re-half-opened carries PRE-outage evidence — counting it would close
      // the circuit while the real probe is still in flight against a dependency
      // that may still be down. Its success is simply not counted; the in-flight
      // probe's own outcome decides the transition.
      if (!admittedAsProbe) return;
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
      this.halfOpenInFlight = 0;
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
    this.halfOpenInFlight = 0;
    this.nextAttemptTime = 0;
    metrics.setGauge('circuit_breaker_state', 0, { breaker: this.options.name });
  }
}
