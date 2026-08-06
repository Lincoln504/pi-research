/**
 * Research Session Service
 *
 * Manages the lifecycle of researcher agent sessions.
 * Responsible for:
 * - Session creation and tracking
 * - Session cleanup and abort handling
 * - Active sessions registry management
 */

import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { logger } from '../logger.ts';
import { ServiceLifecycle, type IService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import { boundSessionAbort } from './abort-utils.ts';

/**
 * Session entry with abort capability
 */
export interface SessionEntry {
  session: AgentSession;
  abort(): Promise<void>;
}

/**
 * Research Session Service
 *
 * Manages the lifecycle of researcher agent sessions.
 */
export class ResearchSessionService implements IService {
  readonly name = ServiceNames.RESEARCH_SESSION_SERVICE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // Map of sessionId -> Map<id, SessionEntry>
  private sessions = new Map<string, Map<string, SessionEntry>>();

  // Create-on-write: use ONLY from registerSession. Read/delete paths must use peekSessionMap
  // so they never resurrect an empty map (which would leak one entry per completed researchId).
  private getSessionMap(sessionId: string): Map<string, SessionEntry> {
    let sessionMap = this.sessions.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map<string, SessionEntry>();
      this.sessions.set(sessionId, sessionMap);
    }
    return sessionMap;
  }

  // Read-only accessor: never inserts. Returns undefined when no sessions exist for the id.
  private peekSessionMap(sessionId: string): Map<string, SessionEntry> | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Register an active researcher session
   */
  registerSession(sessionId: string, id: string, session: AgentSession, abortFn: () => Promise<void>): void {
    this.getSessionMap(sessionId).set(id, { session, abort: abortFn });
  }

  /**
   * Get an active session by ID
   */
  getSession(sessionId: string, id: string): SessionEntry | undefined {
    return this.peekSessionMap(sessionId)?.get(id);
  }

  /**
   * Check if a session is active
   */
  hasSession(sessionId: string, id: string): boolean {
    return this.peekSessionMap(sessionId)?.has(id) ?? false;
  }

  /**
   * Unregister a session (no abort). Prunes the per-run map once empty so a long-lived host
   * does not accumulate empty maps keyed by completed research runs.
   */
  unregisterSession(sessionId: string, id: string): void {
    const sessionMap = this.peekSessionMap(sessionId);
    if (!sessionMap) return;
    sessionMap.delete(id);
    if (sessionMap.size === 0) this.sessions.delete(sessionId);
  }

  /**
   * Abort and unregister a specific session
   */
  async abortSession(sessionId: string, id: string): Promise<void> {
    const sessionMap = this.peekSessionMap(sessionId);
    if (!sessionMap) return;
    const entry = sessionMap.get(id);
    if (!entry) return;

    try {
      await entry.abort();
    } catch (err) {
      logger.warn(`[ResearchSessionService] Failed to abort session ${id}:`, err);
    }
    sessionMap.delete(id);
  }

  /**
   * Abort all active sessions for a specific sessionId, or all sessions if sessionId is omitted.
   *
   * Each abort is bounded (boundSessionAbort): entry.abort() awaits the very
   * in-flight call it is cancelling, which may never settle — and this method
   * gates both the fast-stop throw (runResearchers) and run()'s finally via
   * cleanup(), so one wedged session would otherwise hang the whole run's
   * return. When the bound fires, teardown proceeds and the abandoned abort
   * keeps draining in the background.
   */
  async abortAllSessions(sessionId?: string): Promise<void> {
    if (sessionId) {
      // Read path: peek, never create — getSessionMap would resurrect an empty
      // bucket for an already-completed researchId and leak it forever.
      const sessionMap = this.peekSessionMap(sessionId);
      if (!sessionMap) return;
      // Snapshot BEFORE awaiting: only the entries aborted below may be removed.
      // A session registered (or re-registered under the same id) DURING the
      // bounded awaits — e.g. a researcher retry building a fresh session — was
      // never aborted here; a blanket clear() would silently orphan it live.
      const snapshot = Array.from(sessionMap.entries());
      const aborts = snapshot.map(([, entry], index) =>
        boundSessionAbort(
          entry.abort().catch((err) => {
            logger.warn(`[ResearchSessionService] Failed to abort session ${index}:`, err);
          }),
          () => logger.debug(`[ResearchSessionService] Session ${index} abort did not settle within bound; continuing teardown`),
        )
      );
      await Promise.all(aborts);
      for (const [id, entry] of snapshot) {
        // Identity check: delete only the exact entry we aborted, not a
        // same-id replacement registered while we awaited.
        if (sessionMap.get(id) === entry) sessionMap.delete(id);
      }
      if (sessionMap.size === 0) this.sessions.delete(sessionId);
    } else {
      const aborts: Promise<void>[] = [];
      for (const sessionMap of this.sessions.values()) {
        aborts.push(...Array.from(sessionMap.values()).map((entry, index) =>
          boundSessionAbort(
            entry.abort().catch((err) => {
              logger.warn(`[ResearchSessionService] Failed to abort session ${index}:`, err);
            }),
            () => logger.debug(`[ResearchSessionService] Session ${index} abort did not settle within bound; continuing teardown`),
          )
        ));
      }
      await Promise.all(aborts);
      this.sessions.clear();
    }
  }

  /**
   * Get count of active sessions
   */
  getActiveSessionCount(sessionId: string): number {
    return this.peekSessionMap(sessionId)?.size ?? 0;
  }

  /**
   * Get all active session IDs
   */
  getActiveSessionIds(sessionId: string): string[] {
    const sessionMap = this.peekSessionMap(sessionId);
    return sessionMap ? Array.from(sessionMap.keys()) : [];
  }

  /**
   * Clean up all sessions (alias for abortAllSessions)
   */
  async cleanup(sessionId?: string): Promise<void> {
    await this.abortAllSessions(sessionId);
  }

  /**
   * Reset service state
   */
  reset(): void {
    this.sessions.clear();
  }

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[ResearchSessionService] Initializing...');
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[ResearchSessionService] Initialized');
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }
    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[ResearchSessionService] Disposing...');
    await this.cleanup();
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[ResearchSessionService] Disposed');
  }
}