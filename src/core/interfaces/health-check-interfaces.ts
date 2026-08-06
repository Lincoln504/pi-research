/**
 * Health Check Service Interfaces
 */

import type { IService } from '../service-registry.ts';

/**
 * Health check registry interface
 */
export interface IHealthRegistryService extends IService {
  register(name: string, check: (options?: { force?: boolean }) => Promise<{ healthy: boolean; error?: string; diagnostic?: Record<string, any> }>, options?: { timeoutMs?: number; critical?: boolean }): void;
  isCritical(componentName: string): boolean;
  runAll(options?: { force?: boolean }): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; components: any[]; timestamp: string }>;
}