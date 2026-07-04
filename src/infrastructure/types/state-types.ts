/**
 * State Types
 *
 * Shared types for state management.
 * Extracted to separate file to avoid circular dependencies.
 */

import { Type, type Static } from 'typebox';

/**
 * Current on-disk state schema version. Bump this (and add a migration step in
 * state-migration.ts) whenever the persisted shape changes incompatibly. The
 * schema's `version` literal is pinned to this value so a reader only accepts a
 * state it actually understands; older/newer files are routed through migration
 * or future-version quarantine rather than being silently overwritten.
 */
export const CURRENT_STATE_VERSION = 1 as const;

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

/**
 * Main state structure interface
 */
export const SingletonStateSchema = Type.Object({
  version: Type.Literal(CURRENT_STATE_VERSION),
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
    authSecret: Type.Optional(Type.String()),
  })),
  schedulerVersion: Type.Optional(Type.String()),
  gpuOwner: Type.Optional(Type.Object({
    pid: Type.Number(),
    startTime: Type.Optional(Type.Number()),
    startedAt: Type.Number(),
    sessionId: Type.Optional(Type.String()),
    // Re-entrant hold count for the owning process. The lock is shared by N
    // concurrent in-process embedding calls (activeEmbeddings is designed > 1);
    // each re-entrant acquire increments and each release decrements, so the
    // cross-process owner record is only cleared when the last in-process hold
    // is released. Absent on state written before refcounting — treated as 1.
    holds: Type.Optional(Type.Number()),
  })),
  embeddingServer: Type.Optional(Type.Object({
    port: Type.Number(),
    pid: Type.Number(),
    startTime: Type.Optional(Type.Number()),
    serverId: Type.String(),
    // EMBEDDING_MODEL the leader serves. A follower configured with a DIFFERENT
    // model must not adopt this leader (same-dimension models would silently
    // cross-embed and corrupt the vector space) — it falls back to a local
    // in-process embedder instead. Optional for entries written by older
    // processes, which are tolerated as matching.
    model: Type.Optional(Type.String()),
  })),
});

export type SingletonState = Static<typeof SingletonStateSchema>;