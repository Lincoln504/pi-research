/**
 * Research Session Service
 *
 * Manages the lifecycle of researcher agent sessions.
 * Responsible for:
 * - Session creation and tracking
 * - Session cleanup and abort handling
 * - Active sessions registry management
 */

import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { logger } from '../logger.ts';

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
export class ResearchSessionService {
  private activeSessions = new Map<string, SessionEntry>();

  /**
   * Register an active researcher session
   */
  registerSession(id: string, session: AgentSession, abortFn: () => Promise<void>): void {
    this.activeSessions.set(id, { session, abort: abortFn });
  }

  /**
   * Get an active session by ID
   */
  getSession(id: string): SessionEntry | undefined {
    return this.activeSessions.get(id);
  }

  /**
   * Check if a session is active
   */
  hasSession(id: string): boolean {
    return this.activeSessions.has(id);
  }

  /**
   * Unregister a session (no abort)
   */
  unregisterSession(id: string): void {
    this.activeSessions.delete(id);
  }

  /**
   * Abort and unregister a specific session
   */
  async abortSession(id: string): Promise<void> {
    const entry = this.activeSessions.get(id);
    if (!entry) return;

    try {
      await entry.abort();
    } catch (err) {
      logger.warn(`[ResearchSessionService] Failed to abort session ${id}:`, err);
    }
    this.activeSessions.delete(id);
  }

  /**
   * Abort all active sessions
   */
  async abortAllSessions(): Promise<void> {
    const aborts = Array.from(this.activeSessions.values()).map((entry, index) =>
      entry.abort().catch((err) => {
        logger.warn(`[ResearchSessionService] Failed to abort session ${index}:`, err);
      })
    );
    await Promise.all(aborts);
    this.activeSessions.clear();
  }

  /**
   * Get count of active sessions
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Get all active session IDs
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  /**
   * Clean up all sessions (alias for abortAllSessions)
   */
  async cleanup(): Promise<void> {
    await this.abortAllSessions();
  }

  /**
   * Reset service state
   */
  reset(): void {
    this.activeSessions.clear();
  }
}