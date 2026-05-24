/**
 * Scheduler Factory
 *
 * Handles the creation and management of scheduler instances.
 * Refactored from browser-manager.ts for better separation of concerns.
 */

import * as crypto from 'node:crypto';
import type { Config } from '../../config.ts';
import { logger } from '../../logger.ts';
import { metrics } from '../../utils/metrics.ts';
import { getService } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import { SchedulerService } from '../../core/scheduler-service.ts';
import type { IStateManager } from '../../core/interfaces/state-manager-interfaces.ts';
import { generateSchedulerVersion } from './browser-configuration.ts';
import { BrowserClient } from './browser-client.ts';
import { BrowserTaskScheduler } from './browser-task-scheduler.ts';
import type { IScheduler } from './browser-client.ts';

/**
 * Force a restart of the scheduler by clearing the global cache and state.
 * This should be called when configuration changes are detected.
 */
export async function forceSchedulerRestart(forceClearRemoteState: boolean = false): Promise<void> {
    const schedulerService = await getService<SchedulerService>(ServiceNames.SCHEDULER);

    if (schedulerService.isSchedulerRestartInProgress()) {
        logger.log('[Scheduler] Restart already in progress, skipping concurrent call.');
        return;
    }
    schedulerService.setSchedulerRestartInProgress(true);
    try {
        logger.log('[Scheduler] Forcing scheduler restart due to config change...');

        // Grab the current scheduler BEFORE clearing the reference so we can
        // shut it down properly. Without this, the old scheduler's leadership-check
        // timer keeps firing for up to 60s after the restart, and its pool workers
        // keep running until the leadership loss is detected.
        const oldScheduler = schedulerService.getSchedulerInstance();

        // Clear cache immediately so new requests spawn a fresh scheduler.
        schedulerService.setSchedulerInstance(null);
        schedulerService.setSchedulerVersion(null);
        schedulerService.setSchedulerInitializationPromise(null);

        // Find and clear any stale scheduler processes BEFORE clearing state.
        // Only clear if the registered PID is dead or belongs to this process — never
        // wipe state owned by a live remote leader (that would cause split-brain).
        const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER);
        const serverInfo = await stateManager.getBrowserServer();
        let shouldClearState = true;
        if (serverInfo) {
            const isAlive = await stateManager.isPidAlive(serverInfo.pid, serverInfo.schedulerId);
            if (isAlive && serverInfo.pid !== process.pid && !forceClearRemoteState) {
                logger.log(`[Scheduler] Skipping clearBrowserServer — live scheduler (PID ${serverInfo.pid}) owns state.`);
                shouldClearState = false;
            } else if (forceClearRemoteState) {
                logger.log(`[Scheduler] Force clearing remote state for PID ${serverInfo.pid} due to unreachability.`);
            }
        }

        if (shouldClearState) {
            await stateManager.clearBrowserServer().catch((error) => {
                logger.warn('[Scheduler] Failed to clear browser server from state:', error);
            });
        }

        // Shut down the old scheduler in the background so its timers and pool are
        // cleaned up promptly. Fire-and-forget: a restart means the caller already
        // triggered a retry, so we do not block on the old scheduler's teardown.
        if (oldScheduler && 'schedulerId' in oldScheduler && oldScheduler.schedulerId) {
            // This is a BrowserTaskScheduler
            const scheduler = oldScheduler as any;
            if (scheduler instanceof BrowserTaskScheduler) {
                scheduler.shutdown().catch((err) => {
                    logger.warn('[Scheduler] Error during old scheduler shutdown after restart:', err);
                });
            }
        }

        logger.log('[Scheduler] Restart complete. Next call will create fresh scheduler.');
    } finally {
        schedulerService.setSchedulerRestartInProgress(false);
    }
}

/**
 * Get or create a scheduler instance.
 * Handles leader election and client/server mode switching.
 */
export async function getScheduler(config?: Config): Promise<IScheduler> {
    const schedulerService = await getService<SchedulerService>(ServiceNames.SCHEDULER);
    const currentVersion = generateSchedulerVersion(config);
    let existing = schedulerService.getSchedulerInstance();
    const cachedVersion = schedulerService.getSchedulerVersion();

    // Check if cached scheduler has different version (config changed)
    if (existing && cachedVersion && cachedVersion !== currentVersion) {
        logger.log(`[Scheduler] Config changed (old: ${cachedVersion}, new: ${currentVersion}), forcing restart...`);
        await forceSchedulerRestart();
        existing = null; // Clear reference after restart
    }

    if (existing) {
        if ('resetIdleTimerOnActivity' in existing && typeof existing['resetIdleTimerOnActivity'] === 'function') {
            existing['resetIdleTimerOnActivity']();
        }
        return existing as IScheduler;
    }

    const existingPromise = schedulerService.getSchedulerInitializationPromise();
    if (existingPromise) return existingPromise as Promise<IScheduler>;

    let p: Promise<IScheduler>;

    const initializationFunction = async () => {
        const schedulerVersion = currentVersion;
        // Generate a unique ID for this scheduler instance to prevent PID reuse issues
        const schedulerId = crypto.randomUUID();

        const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER);
        const serverInfo = await stateManager.getBrowserServer();

        // Race check: if another process won election while we were starting, serverInfo will be fresh
        // but our modules might have been reloaded.

        // Check if existing scheduler has different config version
        if (serverInfo) {
            const isAlive = await stateManager.isPidAlive(serverInfo.pid, serverInfo.schedulerId);
            if (isAlive) {
                // Get the stored version from state
                const state = await stateManager.readState();
                const storedVersion = state.schedulerVersion;

                // If version mismatch, we need to restart the scheduler
                if (storedVersion && storedVersion !== currentVersion) {
                    logger.log(`[Scheduler] Existing scheduler has stale config (old: ${storedVersion}, new: ${currentVersion}), forcing restart...`);

                    if (serverInfo.pid !== process.pid) {
                        logger.log(`[Scheduler] Bypassing stale scheduler process (PID ${serverInfo.pid}) by clearing state...`);
                    }

                    // Clear server info from state to force a restart
                    await stateManager.clearBrowserServer();

                    // Fall through to start a new scheduler
                } else {
                    // Version matches, use existing scheduler
                    logger.log(`[Scheduler] Connecting to existing scheduler (version: ${currentVersion})`);
                    const client = new BrowserClient(serverInfo.port);

                    // Race check: if initializationPromise was cleared (restart), don't set reference
                    if (schedulerService.getSchedulerInitializationPromise() === p) {
                        schedulerService.setSchedulerInstance(client);
                        schedulerService.setSchedulerVersion(currentVersion);
                    } else {
                        logger.warn('[Scheduler] Initialization finished but was superseded by a restart. Disposing...');
                        await client.shutdown().catch(() => {});
                        throw new Error('Initialization superseded');
                    }
                    return client;
                }
            }
        }

        // Slow path: start a server then atomically claim leadership via compare-and-set.
        const scheduler = new BrowserTaskScheduler(schedulerId, stateManager);
        let port: number;
        try {
            port = await scheduler.startServer();
        } catch (error) {
            logger.error('[Scheduler] Failed to start server, running standalone:', error);
            if (schedulerService.getSchedulerInitializationPromise() === p) {
                schedulerService.setSchedulerInstance(scheduler);
                schedulerService.setSchedulerVersion(currentVersion);
            } else {
                await scheduler.shutdown().catch(() => {});
                throw new Error('Initialization superseded', { cause: error });
            }
            return scheduler;
        }

        let wonElection = false;
        let winnerPort = port;
        try {
            await stateManager.updateState(async (state) => {
                if (state.browserServer) {
                    const alive = await stateManager.isPidAlive(state.browserServer.pid, state.browserServer.schedulerId, true);
                    if (alive) {
                        winnerPort = state.browserServer.port;
                        wonElection = false;
                        return state;
                    }
                }
                state.browserServer = { port, pid: process.pid, schedulerId };
                state.schedulerVersion = schedulerVersion; // Store current version in state
                wonElection = true;
                return state;
            });
        } catch (error) {
            logger.error('[Scheduler] Failed to register as leader, running standalone:', error);
            if (schedulerService.getSchedulerInitializationPromise() === p) {
                schedulerService.setSchedulerInstance(scheduler);
                schedulerService.setSchedulerVersion(currentVersion);
            } else {
                await scheduler.shutdown().catch(() => {});
                throw new Error('Initialization superseded', { cause: error });
            }
            return scheduler;
        }

        if (!wonElection) {
            logger.log(`[Scheduler] Lost election, connecting to winner at port ${winnerPort}`);
            await scheduler.shutdown();
            const client = new BrowserClient(winnerPort);
            if (schedulerService.getSchedulerInitializationPromise() === p) {
                schedulerService.setSchedulerInstance(client);
                schedulerService.setSchedulerVersion(schedulerVersion);
            } else {
                await client.shutdown().catch(() => {});
                throw new Error('Initialization superseded');
            }
            return client;
        }

        logger.log(`[Scheduler] Won election, serving as leader on port ${port} (PID ${process.pid})`);
        logger.log(`[Scheduler] Scheduler version: ${schedulerVersion}`);
        metrics.increment('browser_leadership_wins_total', 1);
        if (schedulerService.getSchedulerInitializationPromise() === p) {
            schedulerService.setSchedulerInstance(scheduler);
            schedulerService.setSchedulerVersion(schedulerVersion);
        } else {
            logger.warn('[Scheduler] Won election but was superseded by restart. Shutting down pool...');
            await scheduler.shutdown().catch(() => {});
            throw new Error('Initialization superseded');
        }
        return scheduler;
    };

    p = initializationFunction();
    schedulerService.setSchedulerInitializationPromise(p as any);
    // Clear on rejection so the next caller retries rather than receiving the same
    // rejected promise forever.
    p.catch(() => {
        if (schedulerService.getSchedulerInitializationPromise() === p) {
            schedulerService.setSchedulerInitializationPromise(null);
        }
    });
    return p;
}