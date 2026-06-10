import { logger } from '../logger.ts';
import { safeUnref } from './safe-unref.ts';

export type CleanupTask = () => Promise<void> | void;

// Minimal interface matching Node.js EventEmitter and process
interface EventEmitterLike {
  on(event: string | symbol, listener: (...args: any[]) => void): any;
  off?(event: string | symbol, listener: (...args: any[]) => void): any;
  removeListener?(event: string | symbol, listener: (...args: any[]) => void): any;
}

interface EventListenerCleanup {
  target: EventEmitterLike;
  event: string;
  listener: (...args: any[]) => void;
}

export class ShutdownManager {
  private tasks: CleanupTask[] = [];
  private eventListeners: EventListenerCleanup[] = [];
  private cleanupPromise: Promise<void> | null = null;

  register(task: CleanupTask) {
    if (this.tasks.includes(task)) {
      return;
    }

    this.tasks.push(task);
  }

  registerEventListener<T extends EventEmitterLike>(
    target: T,
    event: string,
    listener: (...args: any[]) => void
  ) {
    target.on(event, listener);
    this.eventListeners.push({ target, event, listener });
  }

  unregisterEventListener<T extends EventEmitterLike>(
    target: T,
    event: string,
    listener: (...args: any[]) => void
  ) {
    if (target.off) {
      target.off(event, listener);
    } else if (target.removeListener) {
      target.removeListener(event, listener);
    }
    this.eventListeners = this.eventListeners.filter(
      el => el.target !== target || el.event !== event || el.listener !== listener
    );
  }

  async runCleanup(reason: string): Promise<void> {
    if (this.cleanupPromise !== null) {
      return this.cleanupPromise;
    }

    const tasksToRun = [...this.tasks].reverse();
    this.cleanupPromise = (async () => {
      if (tasksToRun.length === 0) {
        logger.log(`[ShutdownManager] No cleanup tasks registered (${reason}).`);
        return;
      }

      logger.log(`[ShutdownManager] Running cleanup tasks (${reason})...`);

      // Detach the current task set so repeated cleanup calls are idempotent,
      // while future sessions can register a fresh cleanup set.
      this.tasks = [];

      for (const task of tasksToRun) {
        try {
          await task();
        } catch (error) {
          logger.error('[ShutdownManager] Error during cleanup task:', error);
        }
      }

      logger.log('[ShutdownManager] Cleanup complete.');
    })();

    try {
      await this.cleanupPromise;
    } finally {
      // Remove all registered event listeners to allow clean process exit
      for (const { target, event, listener } of this.eventListeners) {
        try {
          if (target.off) {
            target.off(event, listener);
          } else if (target.removeListener) {
            target.removeListener(event, listener);
          }
        } catch (error) {
          logger.error('[ShutdownManager] Error removing event listener:', error);
        }
      }
      this.eventListeners = [];
      this.cleanupPromise = null;
    }
  }

  /**
   * Force exit the process after a timeout if shutdown is hanging
   * This should be called after runCleanup() with a short delay
   */
  forceExitAfter(timeoutMs: number, code = 0) {
    const timer = setTimeout(() => {
      logger.warn(`[ShutdownManager] Forcing exit after ${timeoutMs}ms timeout`);
      process.exit(code);
    }, timeoutMs);
    safeUnref(timer); // unref() allows Node.js to exit if this is the only timer
  }
}

export const shutdownManager = new ShutdownManager();
