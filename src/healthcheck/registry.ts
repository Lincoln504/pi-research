import type { IHealthRegistryService } from '../core/interfaces/health-check-interfaces.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';

export interface HealthCheckStatus {
  component: string;
  healthy: boolean;
  durationMs: number;
  error?: string;
  diagnostic?: Record<string, any>;
  timestamp: string;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: HealthCheckStatus[];
  timestamp: string;
}

export type HealthCheckFn = (options?: { force?: boolean }) => Promise<{ healthy: boolean; error?: string; diagnostic?: Record<string, any> }>;

interface RegisteredCheck {
  name: string;
  check: HealthCheckFn;
  timeoutMs: number;
  critical: boolean;
}

export class HealthCheckRegistry implements IHealthRegistryService {
  readonly name = ServiceNames.HEALTH_REGISTRY;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private checks: RegisteredCheck[] = [];

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    this.checks = [];
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  public register(name: string, check: HealthCheckFn, options: { timeoutMs?: number; critical?: boolean } = {}) {
    this.checks.push({
      name,
      check,
      timeoutMs: options.timeoutMs ?? 15000,
      critical: options.critical ?? true,
    });
  }

  public isCritical(componentName: string): boolean {
    return this.checks.some(c => c.name === componentName && c.critical);
  }

  public async runAll(options?: { force?: boolean }): Promise<SystemHealth> {
    const promises = this.checks.map(async (registeredCheck) => {
      const start = process.hrtime.bigint();
      const status: HealthCheckStatus = {
        component: registeredCheck.name,
        healthy: false,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      };

      try {
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<{ healthy: boolean; error?: string; diagnostic?: Record<string, any> }>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`Health check timed out after ${registeredCheck.timeoutMs}ms`)), registeredCheck.timeoutMs);
        });

        const checkPromise = registeredCheck.check(options);
        checkPromise.catch((err: any) => console.debug(`[HealthCheck] Background check rejection: ${err instanceof Error ? err.message : String(err)}`));
        const result = await Promise.race([checkPromise, timeoutPromise]);
        if (timeoutId) clearTimeout(timeoutId);
        
        status.healthy = result.healthy;
        status.error = result.error;
        status.diagnostic = result.diagnostic;
        
      } catch (error) {
        status.healthy = false;
        status.error = error instanceof Error ? error.message : String(error);
      } finally {
        const end = process.hrtime.bigint();
        status.durationMs = Number(end - start) / 1_000_000;
      }

      return { status, critical: registeredCheck.critical };
    });

    const results = await Promise.all(promises);
    
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    for (const res of results) {
      if (!res.status.healthy) {
        if (res.critical) {
          overallStatus = 'unhealthy';
          break; // Critical failure means system is unhealthy
        } else {
          overallStatus = 'degraded';
        }
      }
    }

    return {
      status: overallStatus,
      components: results.map(r => r.status),
      timestamp: new Date().toISOString(),
    };
  }
}

// Global singleton for CLI/backward compatibility
export const healthRegistry = new HealthCheckRegistry();
healthRegistry.initialize().catch(() => {});

// Helper function to check if a component is critical
export function isCritical(componentName: string): boolean {
  return healthRegistry.isCritical(componentName);
}
