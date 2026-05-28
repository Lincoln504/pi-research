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
  readonly name = 'research-session-service';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // Map of sessionId -> Map<id, SessionEntry>
  private sessions = new Map<string, Map<string, SessionEntry>>();

  private getSessionMap(sessionId: string): Map<string, SessionEntry> {
    let sessionMap = this.sessions.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map<string, SessionEntry>();
      this.sessions.set(sessionId, sessionMap);
    }
    return sessionMap;
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
    return this.getSessionMap(sessionId).get(id);
  }

  /**
   * Check if a session is active
   */
  hasSession(sessionId: string, id: string): boolean {
    return this.getSessionMap(sessionId).has(id);
  }

  /**
   * Unregister a session (no abort)
   */
  unregisterSession(sessionId: string, id: string): void {
    this.getSessionMap(sessionId).delete(id);
  }

  /**
   * Abort and unregister a specific session
   */
  async abortSession(sessionId: string, id: string): Promise<void> {
    const sessionMap = this.getSessionMap(sessionId);
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
   * Abort all active sessions for a specific sessionId, or all sessions if sessionId is omitted
   */
  async abortAllSessions(sessionId?: string): Promise<void> {
    if (sessionId) {
      const sessionMap = this.getSessionMap(sessionId);
      const aborts = Array.from(sessionMap.values()).map((entry, index) =>
        entry.abort().catch((err) => {
          logger.warn(`[ResearchSessionService] Failed to abort session ${index}:`, err);
        })
      );
      await Promise.all(aborts);
      sessionMap.clear();
      this.sessions.delete(sessionId);
    } else {
      const aborts: Promise<void>[] = [];
      for (const sessionMap of this.sessions.values()) {
        aborts.push(...Array.from(sessionMap.values()).map((entry, index) =>
          entry.abort().catch((err) => {
            logger.warn(`[ResearchSessionService] Failed to abort session ${index}:`, err);
          })
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
    return this.getSessionMap(sessionId).size;
  }

  /**
   * Get all active session IDs
   */
  getActiveSessionIds(sessionId: string): string[] {
    return Array.from(this.getSessionMap(sessionId).keys());
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