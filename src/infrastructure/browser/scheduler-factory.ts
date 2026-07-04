/**
 * Scheduler Factory
 *
 * Handles the creation and management of scheduler instances.
 * Refactored from browser-manager.ts for better separation of concerns.
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Config } from '../../config.ts';
import { logger } from '../../logger.ts';
import { metrics } from '../../utils/metrics.ts';
import { getService, tryGetService, getServiceContainer } from '../../core/service-registry.ts';
import type { ServiceContainer } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import type { IProcessLifecycle } from '../../core/service-interfaces.ts';
import type { ISchedulerInternals } from '../../core/interfaces/scheduler-interfaces.ts';
import type { IStateManager } from '../../core/interfaces/state-manager-interfaces.ts';
import type { StatePathConfiguration } from '../state/state-path-configuration.ts';
import { FileLockService } from '../file-lock-service.ts';
import { generateSchedulerVersion } from './config.ts';
import { BrowserClient } from './browser-client.ts';
import { BrowserTaskScheduler } from './browser-task-scheduler.ts';
import type { IScheduler } from '../../core/interfaces/scheduler-interfaces.ts';
import { getBrowserServerAuthSecret } from './browser-server.ts';

/**
 * Global map for browser scheduler initialization locks to prevent "thundering herd"
 * while allowing isolation per service container.
 */
const browserInitLocks = new Map<ServiceContainer, FileLockService>();

/**
 * Dispose the browser initialization lock for a specific container.
 */
export async function disposeBrowserInitLock(container: ServiceContainer = getServiceContainer()): Promise<void> {
  const lock = browserInitLocks.get(container);
  if (lock) {
    try {
      await lock.dispose();
    } catch (err) {
      logger.debug('[SchedulerFactory] Error disposing browserInitLock:', err);
    }
    browserInitLocks.delete(container);
  }
}

/**
 * Get the browser initialization lock for a specific container.
 */
async function getBrowserInitLock(container: ServiceContainer): Promise<FileLockService> {
    let lock = browserInitLocks.get(container);
    if (lock) return lock;

    const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION, undefined, container);
    const processLifecycle = await getService<IProcessLifecycle>(ServiceNames.PROCESS_LIFECYCLE, undefined, container);
    const lockFilePath = path.join(pathConfig.getLockDirPath(), 'browser-init.lock');

    lock = new FileLockService({
        lockFilePath,
        lockTimeout: 60000, // 60s timeout for browser startup
        lockRetries: 600,
        lockRetryDelay: 100,
        lockStaleThreshold: 60000, // 60s stale threshold (must be <= lockTimeout)
        processLifecycle,
    });

    await lock.initialize();
    browserInitLocks.set(container, lock);
    return lock;
}

/**
 * Probe whether a TCP port is accepting connections.
 */
async function isPortListening(port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => settle(true));
        socket.once('error', () => settle(false));
        socket.once('timeout', () => settle(false));
        socket.connect(port, '127.0.0.1');
    });
}

/**
 * Force a restart of the scheduler by clearing the global cache and state.
 */
export async function forceSchedulerRestart(forceClearRemoteState: boolean = false, container: ServiceContainer = getServiceContainer()): Promise<void> {
    // Try to get scheduler service
    const schedulerService = tryGetService<ISchedulerInternals>(ServiceNames.SCHEDULER, container);
    
    if (!schedulerService) {
        logger.warn('[Scheduler] Scheduler service not available for restart');
        return;
    }

    if (schedulerService.isSchedulerRestartInProgress()) {
        logger.log('[Scheduler] Restart already in progress, skipping concurrent call.');
        return;
    }
    schedulerService.setSchedulerRestartInProgress(true);
    try {
        logger.log('[Scheduler] Forcing scheduler restart due to config change...');

        const oldScheduler = schedulerService.getSchedulerInstance();

        schedulerService.setSchedulerInstance(null);
        schedulerService.setSchedulerVersion(null);
        schedulerService.setSchedulerInitializationPromise(null);

        const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER, undefined, container);
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

        if (oldScheduler && 'schedulerId' in oldScheduler && oldScheduler.schedulerId) {
            if (oldScheduler instanceof BrowserTaskScheduler) {
                const shutdownPromise: Promise<void> = oldScheduler.shutdown().catch((err: unknown) => {
                    logger.warn('[Scheduler] Error during old scheduler shutdown after restart:', err);
                });
                schedulerService.setPendingShutdownPromise(shutdownPromise);
                shutdownPromise.finally(() => {
                    if (schedulerService.getPendingShutdownPromise() === shutdownPromise) {
                        schedulerService.setPendingShutdownPromise(null);
                    }
                });
            }
        }

        logger.log('[Scheduler] Restart complete. Next call will create fresh scheduler.');
    } finally {
        schedulerService.setSchedulerRestartInProgress(false);
        await disposeBrowserInitLock(container).catch(() => {});
    }
}

/**
 * Get or create a scheduler instance.
 */
export async function getScheduler(config?: Config, container: ServiceContainer = getServiceContainer()): Promise<IScheduler> {
    const schedulerService = await getService<ISchedulerInternals>(ServiceNames.SCHEDULER, undefined, container);
    
    const currentVersion = generateSchedulerVersion(config);
    let existing = schedulerService.getSchedulerInstance();
    const cachedVersion = schedulerService.getSchedulerVersion();

    if (existing && cachedVersion && cachedVersion !== currentVersion) {
        logger.log(`[Scheduler] Config changed (old: ${cachedVersion}, new: ${currentVersion}), forcing restart...`);
        await forceSchedulerRestart(false, container);
        existing = null;
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

    /**
     * True once this initialization must no longer install its product:
     * either the owning container started disposing, or the init-promise slot
     * no longer holds `p` (cleared by forceSchedulerRestart or by
     * SchedulerService.dispose()). Must be re-checked after EVERY await point
     * that could complete post-disposal — a scheduler installed past this
     * check would be a live BrowserTaskScheduler (with a ref'd, listening
     * HTTP server) that nothing will ever shut down.
     */
    const isSuperseded = () =>
        container.isDisposing || schedulerService.getSchedulerInitializationPromise() !== p;

    const initializationFunction = async () => {
        const lock = await getBrowserInitLock(container);

        return await lock.withLock(async () => {
            if (isSuperseded()) {
                throw new Error('Initialization superseded');
            }
            const schedulerVersion = currentVersion;
            const schedulerId = crypto.randomUUID();

            const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER, undefined, container);
            const serverInfo = await stateManager.getBrowserServer();

            if (serverInfo) {
                const isAlive = await stateManager.isPidAlive(serverInfo.pid, serverInfo.schedulerId);
                if (isAlive) {
                    const state = await stateManager.readState();
                    const storedVersion = state.schedulerVersion;

                    if (storedVersion && storedVersion !== currentVersion) {
                        logger.log(`[Scheduler] Existing scheduler has stale config (old: ${storedVersion}, new: ${currentVersion}), forcing restart...`);
                        if (serverInfo.pid !== process.pid) {
                            logger.log(`[Scheduler] Bypassing stale scheduler process (PID ${serverInfo.pid}) by clearing state...`);
                        }
                        await stateManager.clearBrowserServer();
                    } else {
                        const portOk = await isPortListening(serverInfo.port);
                        if (!portOk) {
                            logger.warn(`[Scheduler] PID ${serverInfo.pid} is alive but port ${serverInfo.port} is not listening — clearing stale state and starting fresh.`);
                            await stateManager.clearBrowserServer().catch((e) => {
                                logger.warn('[Scheduler] Failed to clear stale browser server state:', e);
                            });
                        } else {
                            logger.log(`[Scheduler] Connecting to existing scheduler (version: ${currentVersion})`);
                            const client = new BrowserClient(serverInfo.port, serverInfo.authSecret);

                            if (!isSuperseded()) {
                                schedulerService.setSchedulerInstance(client);
                                schedulerService.setSchedulerVersion(currentVersion);
                            } else {
                                logger.warn('[Scheduler] Initialization finished but was superseded by a restart or disposal. Disposing...');
                                await client.shutdown().catch((err) => logger.debug('Swallowed shutdown error:', err));
                                throw new Error('Initialization superseded');
                            }
                            return client;
                        }
                    }
                }
            }

            // Last check before creating a scheduler with a listening server —
            // several state-manager awaits above could have completed after a
            // disposal or restart began.
            if (isSuperseded()) {
                throw new Error('Initialization superseded');
            }

            const scheduler = new BrowserTaskScheduler(schedulerId, stateManager, container);
            let port: number;
            try {
                port = await scheduler.startServer();
            } catch (error) {
                logger.error('[Scheduler] Failed to start server, running standalone:', error);
                if (!isSuperseded()) {
                    schedulerService.setSchedulerInstance(scheduler);
                    schedulerService.setSchedulerVersion(currentVersion);
                } else {
                    await scheduler.shutdown().catch((err) => logger.debug('Swallowed shutdown error:', err));
                    throw new Error('Initialization superseded', { cause: error });
                }
                return scheduler;
            }

            // startServer() bound a ref'd HTTP server; if disposal or a restart
            // won the race while it was starting, tear it down instead of
            // proceeding to register it as election leader.
            if (isSuperseded()) {
                await scheduler.shutdown().catch((err) => logger.debug('Swallowed shutdown error:', err));
                throw new Error('Initialization superseded');
            }

            let wonElection = false;
            let winnerPort = port;
            let winnerAuthSecret: string | undefined;
            try {
                await stateManager.updateState(async (state) => {
                    if (state.browserServer) {
                        const alive = await stateManager.isPidAlive(state.browserServer.pid, state.browserServer.schedulerId, true);
                        if (alive) {
                            winnerPort = state.browserServer.port;
                            winnerAuthSecret = state.browserServer.authSecret;
                            wonElection = false;
                            return state;
                        }
                    }
                    const secret = getBrowserServerAuthSecret();
                    state.browserServer = { port, pid: process.pid, schedulerId, authSecret: secret };
                    state.schedulerVersion = schedulerVersion;
                    wonElection = true;
                    return state;
                });
            } catch (error) {
                logger.error('[Scheduler] Failed to register as leader, running standalone:', error);
                if (!isSuperseded()) {
                    schedulerService.setSchedulerInstance(scheduler);
                    schedulerService.setSchedulerVersion(currentVersion);
                } else {
                    await scheduler.shutdown().catch((err) => logger.debug('Swallowed shutdown error:', err));
                    throw new Error('Initialization superseded', { cause: error });
                }
                return scheduler;
            }

            if (!wonElection) {
                logger.log(`[Scheduler] Lost election, connecting to winner at port ${winnerPort}`);
                await scheduler.shutdown();
                const client = new BrowserClient(winnerPort, winnerAuthSecret);
                if (!isSuperseded()) {
                    schedulerService.setSchedulerInstance(client);
                    schedulerService.setSchedulerVersion(schedulerVersion);
                } else {
                    await client.shutdown().catch((err) => logger.debug('Swallowed shutdown error:', err));
                    throw new Error('Initialization superseded');
                }
                return client;
            }

            logger.log(`[Scheduler] Won election, serving as leader on port ${port} (PID ${process.pid})`);
            metrics.increment('browser_leadership_wins_total', 1);
            if (!isSuperseded()) {
                schedulerService.setSchedulerInstance(scheduler);
                schedulerService.setSchedulerVersion(schedulerVersion);
                // Only now that we are the registered leader is it safe to arm the
                // leadership self-check — otherwise it could race its own
                // registration and self-shut-down mid-init under lock contention.
                scheduler.startLeadershipMonitor();
            } else {
                logger.warn('[Scheduler] Won election but was superseded by restart or disposal. Shutting down pool...');
                await scheduler.shutdown().catch((err) => logger.debug('Swallowed shutdown error:', err));
                throw new Error('Initialization superseded');
            }
            return scheduler;
        });
    };

    p = initializationFunction();
    schedulerService.setSchedulerInitializationPromise(p);
    p.catch(() => {
        if (schedulerService.getSchedulerInitializationPromise() === p) {
            schedulerService.setSchedulerInitializationPromise(null);
        }
    });
    return p;
}
