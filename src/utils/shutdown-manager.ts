import { logger } from '../logger.ts';

type CleanupTask = () => Promise<void> | void;

class ShutdownManager {
  private tasks: CleanupTask[] = [];
  private isShuttingDown = false;

  register(task: CleanupTask) {
    this.tasks.push(task);
  }

  async shutdown(signal: string) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    logger.log(`[ShutdownManager] Received ${signal}, running cleanup tasks...`);
    
    // Run in reverse order of registration
    for (const task of this.tasks.reverse()) {
      try {
        await task();
      } catch (error) {
        logger.error(`[ShutdownManager] Error during cleanup task:`, error);
      }
    }
    
    logger.log(`[ShutdownManager] Cleanup complete. Exiting.`);
    process.exit(0);
  }

  setup() {
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    // Do not hook 'exit' for async tasks as the event loop is already unwinding.
    // Instead hook beforeExit
    process.on('beforeExit', () => {
      // only if not already shutting down
      if (!this.isShuttingDown) {
         this.shutdown('beforeExit').catch(() => {});
      }
    });
  }
}

export const shutdownManager = new ShutdownManager();
