/**
 * Internal State Management for pi-research
 *
 * This module provides internal state management that replaces global state
 * while avoiding circular dependencies. It's a low-level module that should
 * only be imported by core infrastructure modules.
 *
 * This is intentionally kept simple and separate from the service registry
 * to break circular dependencies between browser-manager and service-registry.
 */

import { logger } from '../logger.ts';
import type { HealthCheckResult } from './service-interfaces.ts';

// Generic scheduler type to avoid circular dependencies
type IScheduler = {
  shutdown(): Promise<void>;
  schedulerId?: string;
  [key: string]: any;
};

// ============================================================================
// Scheduler State Management
// ============================================================================

interface SchedulerState {
  scheduler: IScheduler | null;
  schedulerVersion: string | null;
  initializationPromise: Promise<IScheduler> | null;
  isRestartInProgress: boolean;
}

let _schedulerState: SchedulerState = {
  scheduler: null,
  schedulerVersion: null,
  initializationPromise: null,
  isRestartInProgress: false,
};

/**
 * Get the current scheduler state
 */
export function getSchedulerState(): Readonly<SchedulerState> {
  return _schedulerState;
}

/**
 * Set the scheduler instance
 */
export function setScheduler(scheduler: IScheduler | null): void {
  _schedulerState.scheduler = scheduler;
}

/**
 * Get the scheduler instance
 */
export function getSchedulerInstance(): IScheduler | null {
  return _schedulerState.scheduler;
}

/**
 * Set the scheduler version
 */
export function setSchedulerVersion(version: string | null): void {
  _schedulerState.schedulerVersion = version;
}

/**
 * Get the scheduler version
 */
export function getSchedulerVersionState(): string | null {
  return _schedulerState.schedulerVersion;
}

/**
 * Set the initialization promise
 */
export function setSchedulerInitializationPromise(promise: Promise<IScheduler> | null): void {
  _schedulerState.initializationPromise = promise;
}

/**
 * Get the initialization promise
 */
export function getSchedulerInitializationPromise(): Promise<IScheduler> | null {
  return _schedulerState.initializationPromise;
}

/**
 * Check if a restart is in progress
 */
export function isSchedulerRestartInProgress(): boolean {
  return _schedulerState.isRestartInProgress;
}

/**
 * Set restart in progress state
 */
export function setSchedulerRestartInProgress(inProgress: boolean): void {
  _schedulerState.isRestartInProgress = inProgress;
}

/**
 * Clear all scheduler state
 */
export function clearSchedulerState(): void {
  _schedulerState.scheduler = null;
  _schedulerState.schedulerVersion = null;
  _schedulerState.initializationPromise = null;
  _schedulerState.isRestartInProgress = false;
  logger.debug('[InternalState] Scheduler state cleared');
}

// ============================================================================
// Health Check State Management
// ============================================================================

interface HealthCheckState {
  pending: Promise<HealthCheckResult> | null;
  failureCount: number;
  backoffUntil: number;
}

let _healthCheckState: HealthCheckState = {
  pending: null,
  failureCount: 0,
  backoffUntil: 0,
};

/**
 * Get the health check state
 */
export function getHealthCheckState(): Readonly<HealthCheckState> {
  return _healthCheckState;
}

/**
 * Get the pending health check promise
 */
export function getHealthCheckPending(): Promise<HealthCheckResult> | null {
  return _healthCheckState.pending;
}

/**
 * Set the pending health check promise
 */
export function setHealthCheckPending(promise: Promise<HealthCheckResult> | null): void {
  _healthCheckState.pending = promise;
}

/**
 * Get the health check failure count
 */
export function getHealthCheckFailureCount(): number {
  return _healthCheckState.failureCount;
}

/**
 * Increment the health check failure count
 */
export function incrementHealthCheckFailureCount(): number {
  _healthCheckState.failureCount++;
  // Calculate exponential backoff: 2^(failureCount-1) * 2000ms, max 30s
  const backoffMs = Math.min(30000, 2000 * Math.pow(2, _healthCheckState.failureCount - 1));
  _healthCheckState.backoffUntil = Date.now() + backoffMs;
  logger.warn(
    `[InternalState] HealthCheck failure count: ${_healthCheckState.failureCount}, ` +
    `backoff set for ${backoffMs}ms`
  );
  return _healthCheckState.failureCount;
}

/**
 * Reset the health check failure count
 */
export function resetHealthCheckFailureCount(): void {
  if (_healthCheckState.failureCount > 0) {
    logger.log(
      `[InternalState] Resetting healthcheck failure count from ${_healthCheckState.failureCount} to 0`
    );
  }
  _healthCheckState.failureCount = 0;
  _healthCheckState.backoffUntil = 0;
}

/**
 * Get the health check backoff timestamp
 */
export function getHealthCheckBackoffUntil(): number {
  return _healthCheckState.backoffUntil;
}

/**
 * Set the health check backoff timestamp
 */
export function setHealthCheckBackoffUntil(timestamp: number): void {
  _healthCheckState.backoffUntil = timestamp;
}

/**
 * Check if health check backoff is active
 */
export function isHealthCheckBackoffActive(): boolean {
  return Date.now() < _healthCheckState.backoffUntil;
}

/**
 * Get remaining health check backoff time in milliseconds
 */
export function getHealthCheckBackoffRemainingMs(): number {
  const remaining = _healthCheckState.backoffUntil - Date.now();
  return Math.max(0, remaining);
}

/**
 * Clear all health check state
 */
export function clearHealthCheckState(): void {
  _healthCheckState.pending = null;
  _healthCheckState.failureCount = 0;
  _healthCheckState.backoffUntil = 0;
  logger.debug('[InternalState] Health check state cleared');
}

// ============================================================================
// Utilities for Testing
// ============================================================================

/**
 * Reset all internal state (primarily for testing)
 */
export function resetAllInternalState(): void {
  clearSchedulerState();
  clearHealthCheckState();
  logger.debug('[InternalState] All internal state reset');
}