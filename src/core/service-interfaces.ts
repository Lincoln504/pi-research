/**
 * Service Interfaces for pi-research
 *
 * This module defines the TypeScript interfaces for all services
 * that will be managed by the ServiceRegistry.
 */

import type { IService } from './service-registry.ts';

// ============================================================================
// Scheduler Service Interface
// ============================================================================

/**
 * Scheduler search result
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  [key: string]: any;
}

/**
 * Base scheduler interface
 */
export interface IScheduler extends IService {
  /**
   * Run a search query
   */
  runSearch(query: string, config?: any): Promise<SearchResult[]>;

  /**
   * Scrape a URL
   */
  runScrape(url: string, config?: any): Promise<any>;

  /**
   * Run a health check
   */
  runHealthCheck(config?: any): Promise<{ success: boolean }>;

  /**
   * Shutdown the scheduler
   */
  shutdown(): Promise<void>;

  /**
   * Reset idle timer (for scheduler instances)
   */
  resetIdleTimerOnActivity?(): void;
}

/**
 * Scheduler service metadata
 */
export interface SchedulerMetadata {
  schedulerId: string;
  schedulerVersion: string;
  port?: number;
  pid: number;
  isLeader: boolean;
}

// ============================================================================
// Health Check Service Interface
// ============================================================================

/**
 * Health check result
 */
export interface HealthCheckResult {
  success: boolean;
  searchOk: boolean;
  scrapeOk: boolean;
  error?: string;
  timestamp: string;
}

/**
 * Health check cache state
 */
export interface HealthCheckCache {
  pending: Promise<HealthCheckResult> | null;
  failureCount: number;
  backoffUntil: number;
}

/**
 * Health check service interface
 */
export interface IHealthCheckService extends IService {
  /**
   * Get the cached pending health check promise
   */
  getPendingCheck(): Promise<HealthCheckResult> | null;

  /**
   * Set a pending health check promise
   */
  setPendingCheck(promise: Promise<HealthCheckResult> | null): void;

  /**
   * Get the failure count
   */
  getFailureCount(): number;

  /**
   * Increment the failure count
   */
  incrementFailureCount(): void;

  /**
   * Reset the failure count
   */
  resetFailureCount(): void;

  /**
   * Get the backoff timestamp
   */
  getBackoffUntil(): number;

  /**
   * Set the backoff timestamp
   */
  setBackoffUntil(timestamp: number): void;

  /**
   * Clear all cache state
   */
  clear(): void;

  /**
   * Check if a backoff is currently active
   */
  isBackoffActive(): boolean;

  /**
   * Get remaining backoff time in milliseconds
   */
  getBackoffRemainingMs(): number;
}

// ============================================================================
// Browser Manager Service Interface
// ============================================================================

/**
 * Browser manager service interface
 */
export interface IBrowserManagerService extends IService {
  /**
   * Get the current scheduler
   */
  getScheduler(config?: any): Promise<IScheduler>;

  /**
   * Get the current scheduler version
   */
  getSchedulerVersion(config?: any): string;

  /**
   * Force a scheduler restart
   */
  forceRestart(forceClearRemoteState?: boolean): Promise<void>;

  /**
   * Check if the browser is available
   */
  isBrowserAvailable(): boolean;

  /**
   * Run a browser task
   */
  runTask<T>(task: any, type: 'search' | 'scrape', config?: any, retries?: number): Promise<T>;

  /**
   * Run a health check
   */
  runHealthCheck(config?: any, retries?: number): Promise<{ success: boolean }>;

  /**
   * Stop the browser manager
   */
  stop(): Promise<void>;
}

// ============================================================================
// Service Names (Constants)
// ============================================================================

/**
 * Standard service names used throughout the application
 */
export const ServiceNames = {
  /**
   * Browser scheduler service
   */
  SCHEDULER: 'scheduler',

  /**
   * Health check cache service
   */
  HEALTH_CHECK_CACHE: 'health-check-cache',

  /**
   * Browser manager service
   */
  BROWSER_MANAGER: 'browser-manager',
} as const;

/**
 * Type of service names
 */
export type ServiceName = typeof ServiceNames[keyof typeof ServiceNames];