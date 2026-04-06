import { logger } from '../logger.ts';

export type CleanupTask = () => Promise<void> | void;

export class ShutdownManager {
  private tasks: CleanupTask[] = [];
  private cleanupPromise: Promise<void> | null = null;

  register(task: CleanupTask) {
    if (this.tasks.includes(task)) {
      return;
    }

    this.tasks.push(task);
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
      this.cleanupPromise = null;
    }
  }
}

export const shutdownManager = new ShutdownManager();
