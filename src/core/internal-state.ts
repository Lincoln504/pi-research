/**
 * Internal State Management for pi-research
 *
 * This module provides internal state management that replaces global state
 * while avoiding circular dependencies. It's a low-level module that should
 * only be imported by core infrastructure modules.
 *
 * This is intentionally kept simple and separate from the service registry
 * to break circular dependencies between browser-manager and service-registry.
 *
 * Note: Health check cache state has been moved to health-cache-manager.ts
 * to avoid circular dependencies between healthcheck and knowledge modules.
 */

import { logger } from '../logger.ts';

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
// Utilities for Testing
// ============================================================================

/**
 * Reset all internal state (primarily for testing)
 */
export function resetAllInternalState(): void {
  clearSchedulerState();
  logger.debug('[InternalState] All internal state reset');
}