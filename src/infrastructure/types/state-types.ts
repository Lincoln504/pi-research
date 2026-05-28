/**
 * State Types
 *
 * Shared types for state management.
 * Extracted to separate file to avoid circular dependencies.
 */

/**
 * State metrics interface
 */
export interface StateMetrics {
  totalSessions: number;
  activeSessions: number;
  oldestSession: number | null;
  newestSession: number | null;
  containerUptime: number | null;
  lastHeartbeatAge: number | null;
}

/**
 * Session information interface
 */
export interface SessionInfo {
  pid: number;
  lastSeen: number;
  connectedAt: number;
}

/**
 * Main state structure interface
 */
export interface SingletonState {
  version: 1;
  containerId: string;
  containerName: string;
  port: number;
  sessions: { [sessionId: string]: SessionInfo };
  lastUpdated: number;
  browserServer?: { port: number; pid: number; schedulerId?: string };
  schedulerVersion?: string; // Track scheduler config version for detecting changes
  gpuOwner?: { pid: number; startedAt: number; sessionId?: string };
  embeddingServer?: { port: number; pid: number; serverId: string };
}