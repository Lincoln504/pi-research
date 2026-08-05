/**
 * State Manager Service Interface
 */

import type { IService } from '../service-registry.ts';

/**
 * State manager service interface
 */
export interface IStateManager extends IService {
  readState(): Promise<any>;
  writeState(state: any): Promise<void>;
  updateState(updater: (state: any) => any | Promise<any>): Promise<void>;
  addSession(sessionId: string, param: number | string): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  updateHeartbeat(sessionId: string): Promise<void>;
  cleanupStaleSessions(timeoutMs: number): Promise<number>;
  getBrowserServer(): Promise<{ port: number; pid: number; schedulerId?: string; authSecret?: string } | null>;
  setBrowserServer(port: number, pid: number, schedulerId?: string, authSecret?: string): Promise<void>;
  clearBrowserServer(): Promise<void>;
  getEmbeddingServer(): Promise<{ port: number; pid: number; startTime?: number; serverId: string; model?: string; authSecret?: string } | null>;
  // `expected` makes the clear a compare-and-delete: the entry is only removed when
  // the provided identity fields match, so a stale caller cannot deregister a leader
  // it does not own. Omit only when the caller has just verified ownership under the
  // same state lock.
  clearEmbeddingServer(expected?: { pid?: number; serverId?: string }): Promise<void>;
  isPidAlive(pid: number, expectedSchedulerId?: string, skipLock?: boolean): Promise<boolean>;
  acquireGpuLock(sessionId?: string, timeoutMs?: number): Promise<boolean>;
  releaseGpuLock(pid?: number): Promise<void>;
  getGpuOwner(): Promise<any | null>;
  getMetrics(): Promise<any>;
  cleanup(): Promise<void>;
}
