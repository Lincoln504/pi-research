/**
 * Health Check Service Interfaces
 */

import type { IService } from '../service-registry.ts';

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
  getPendingCheck(): Promise<HealthCheckResult> | null;
  setPendingCheck(promise: Promise<HealthCheckResult> | null): void;
  getFailureCount(): number;
  incrementFailureCount(): void;
  resetFailureCount(): void;
  getBackoffUntil(): number;
  setBackoffUntil(timestamp: number): void;
  clear(): void;
  isBackoffActive(): boolean;
  getBackoffRemainingMs(): number;
  }

  /**
  * Health check registry interface
  */
  export interface IHealthRegistryService extends IService {
  register(name: string, check: (options?: { force?: boolean }) => Promise<{ healthy: boolean; error?: string; diagnostic?: Record<string, any> }>, options?: { timeoutMs?: number; critical?: boolean }): void;
  isCritical(componentName: string): boolean;
  runAll(options?: { force?: boolean }): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; components: any[]; timestamp: string }>;
  }