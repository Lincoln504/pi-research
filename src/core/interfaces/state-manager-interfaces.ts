/**
 * State Manager Service Interface
 */

import type { IService } from '../service-registry.ts';

/**
 * State manager service interface
 */
export interface IStateManager extends IService {
  /**
   * True once a newer-build state file forced this process into read-only mode
   * (writes suppressed) — state-file-based coordination (GPU lock, embedding
   * leader election) is then void and consumers must degrade to a
   * coordination-free mode. Optional so structural test doubles need not
   * implement it; callers use `isReadOnly?.()` (absent ⇒ not read-only).
   */
  isReadOnly?(): boolean;
  readState(): Promise<any>;
  writeState(state: any): Promise<void>;
  updateState(updater: (state: any) => any | Promise<any>): Promise<void>;
  addSession(sessionId: string, param: number | string): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  updateHeartbeat(sessionId: string): Promise<void>;
  cleanupStaleSessions(timeoutMs: number): Promise<number>;
  getBrowserServer(): Promise<{ port: number; pid: number; schedulerId?: string; authSecret?: string } | null>;
  // `expected` makes the clear a compare-and-delete: the entry is only removed when
  // the provided identity fields match, so a stale caller cannot deregister a leader
  // it does not own. Omit only when the caller has just verified ownership under the
  // same state lock.
  clearBrowserServer(expected?: { pid?: number; schedulerId?: string }): Promise<void>;
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
