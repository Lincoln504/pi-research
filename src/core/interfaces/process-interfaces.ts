/**
 * Process Service Interfaces
 */

import type { IService } from '../service-registry.ts';

/**
 * Process Lifecycle Service Interface
 */
export interface IProcessLifecycle extends IService {
  isProcessAlive(pid: number): boolean;
  isPidAlive<TState>(
    pid: number,
    expectedSchedulerId?: string,
    options?: {
      getState?: (skipLock?: boolean) => Promise<TState>;
      skipLock?: boolean;
      getSchedulerIdFromState?: (state: TState) => string | undefined;
    }
  ): Promise<boolean>;
  getCurrentPid(): number;
  waitForProcessTermination(pid: number, timeoutMs?: number, checkIntervalMs?: number): Promise<boolean>;
  isCurrentProcess(pid: number): boolean;
  getProcessInfo(pid: number): Promise<{ pid: number; alive: boolean } | null>;
}
