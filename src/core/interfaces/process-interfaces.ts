/**
 * Process Service Interfaces
 */

import type { IService } from '../service-registry.ts';

/**
 * Process Lifecycle Service Interface
 */
export interface IProcessLifecycle extends IService {
  isProcessAlive(pid: number, expectedStartTime?: number | null): Promise<boolean>;
  isProcessAliveSync(pid: number): boolean;
  isPidAlive<TState>(
    pid: number,
    expectedSchedulerId?: string,
    options?: {
      getState?: (skipLock?: boolean) => Promise<TState>;
      skipLock?: boolean;
      getSchedulerIdFromState?: (state: TState) => string | undefined;
      expectedStartTime?: number | null;
    }
  ): Promise<boolean>;
  getCurrentPid(): number;
  getProcessStartTime(pid: number): Promise<number | null>;
  getCurrentProcessStartTime(): Promise<number | null>;
  waitForProcessTermination(pid: number, timeoutMs?: number, checkIntervalMs?: number, expectedStartTime?: number | null): Promise<boolean>;
  isCurrentProcess(pid: number): boolean;
  getProcessInfo(pid: number): Promise<{ pid: number; alive: boolean; startTime?: number | null } | null>;
}
