/**
 * State Types
 *
 * Shared types for state management.
 * Extracted to separate file to avoid circular dependencies.
 */

import { Type, type Static } from 'typebox';

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
export const SessionInfoSchema = Type.Object({
  pid: Type.Number(),
  startTime: Type.Optional(Type.Number()),
  lastSeen: Type.Number(),
  connectedAt: Type.Number(),
});

export type SessionInfo = Static<typeof SessionInfoSchema>;

/**
 * Main state structure interface
 */
export const SingletonStateSchema = Type.Object({
  version: Type.Literal(1),
  containerId: Type.String(),
  containerName: Type.String(),
  port: Type.Number(),
  sessions: Type.Record(Type.String(), SessionInfoSchema),
  lastUpdated: Type.Number(),
  browserServer: Type.Optional(Type.Object({
    port: Type.Number(),
    pid: Type.Number(),
    startTime: Type.Optional(Type.Number()),
    schedulerId: Type.Optional(Type.String()),
  })),
  schedulerVersion: Type.Optional(Type.String()),
  gpuOwner: Type.Optional(Type.Object({
    pid: Type.Number(),
    startTime: Type.Optional(Type.Number()),
    startedAt: Type.Number(),
    sessionId: Type.Optional(Type.String()),
  })),
  embeddingServer: Type.Optional(Type.Object({
    port: Type.Number(),
    pid: Type.Number(),
    startTime: Type.Optional(Type.Number()),
    serverId: Type.String(),
  })),
});

export type SingletonState = Static<typeof SingletonStateSchema>;