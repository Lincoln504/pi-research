# Example Migration: BrowserManager Force Restart Function

This document shows a complete example of migrating a real function from the browser-manager module to use structured logging.

## Before (Old Pattern)

```typescript
export async function forceSchedulerRestart(forceClearRemoteState: boolean = false): Promise<void> {
    if (isSchedulerRestartInProgress()) {
        logger.log('[Scheduler] Restart already in progress, skipping concurrent call.');
        return;
    }
    setSchedulerRestartInProgress(true);
    try {
    logger.log('[Scheduler] Forcing scheduler restart due to config change...');

    // Grab the current scheduler BEFORE clearing the reference so we can
    // shut it down properly. Without this, the old scheduler's leadership-check
    // timer keeps firing for up to 60s after the restart, and its pool workers
    // keep running until the leadership loss is detected.
    const oldScheduler = getSchedulerInstance();

    // Clear cache immediately so new requests spawn a fresh scheduler.
    setScheduler(null);
    setSchedulerVersion(null);
    setSchedulerInitializationPromise(null);

    if (oldScheduler && forceClearRemoteState) {
        // Try to clear remote state if the old scheduler is unreachable
        try {
            const serverInfo = await getSharedStateManager().getBrowserServerInfo();
            if (serverInfo && serverInfo.pid !== process.pid) {
                // Live scheduler exists on another process
                logger.log(`[Scheduler] Skipping clearBrowserServer — live scheduler (PID ${serverInfo.pid}) owns state.`);
                setSchedulerRestartInProgress(false);
                return;
            }
        } catch (error) {
            // State manager might be unreachable, proceed with clear
            logger.log(`[Scheduler] Force clearing remote state for PID ${serverInfo.pid} due to unreachability.`);
        }
    }
    // ... rest of function
    } finally {
        setSchedulerRestartInProgress(false);
    }
}
```

## After (New Pattern)

```typescript
import { createStructuredLogger } from '../utils/structured-logger';

const logger = createStructuredLogger('Scheduler');

export async function forceSchedulerRestart(forceClearRemoteState: boolean = false): Promise<void> {
    if (isSchedulerRestartInProgress()) {
        logger.warn('Restart already in progress, skipping concurrent call');
        return;
    }
    
    setSchedulerRestartInProgress(true);
    
    try {
        logger.info('Forcing scheduler restart due to config change', {
            forceClearRemoteState,
            pid: process.pid
        });

        // Grab the current scheduler BEFORE clearing the reference so we can
        // shut it down properly. Without this, the old scheduler's leadership-check
        // timer keeps firing for up to 60s after the restart, and its pool workers
        // keep running until the leadership loss is detected.
        const oldScheduler = getSchedulerInstance();

        // Clear cache immediately so new requests spawn a fresh scheduler.
        setScheduler(null);
        setSchedulerVersion(null);
        setSchedulerInitializationPromise(null);

        if (oldScheduler && forceClearRemoteState) {
            // Try to clear remote state if the old scheduler is unreachable
            try {
                const serverInfo = await getSharedStateManager().getBrowserServerInfo();
                if (serverInfo && serverInfo.pid !== process.pid) {
                    // Live scheduler exists on another process
                    logger.info('Skipping clearBrowserServer — live scheduler owns state', {
                        schedulerPid: serverInfo.pid,
                        currentPid: process.pid
                    });
                    setSchedulerRestartInProgress(false);
                    return;
                }
            } catch (error) {
                // State manager might be unreachable, proceed with clear
                logger.warn('Force clearing remote state due to unreachability', {
                    serverPid: serverInfo?.pid,
                    currentPid: process.pid
                }, error);
            }
        }
        // ... rest of function
    } catch (error) {
        logger.error('Scheduler restart failed', error, {
            forceClearRemoteState,
            pid: process.pid
        });
        throw error;
    } finally {
        setSchedulerRestartInProgress(false);
    }
}
```

## Key Changes

### 1. Import Change
```diff
- import { logger } from '../logger.ts';
+ import { createStructuredLogger } from '../utils/structured-logger';
```

### 2. Logger Instance Creation
```diff
+ const logger = createStructuredLogger('Scheduler');
```

### 3. Remove Manual Prefixes
```diff
- logger.log('[Scheduler] Restart already in progress, skipping concurrent call.');
+ logger.warn('Restart already in progress, skipping concurrent call');
```

### 4. Use Structured Context
```diff
- logger.log(`[Scheduler] Forcing scheduler restart due to config change...`);
+ logger.info('Forcing scheduler restart due to config change', {
+     forceClearRemoteState,
+     pid: process.pid
+ });
```

### 5. Proper Error Handling
```diff
- logger.log(`[Scheduler] Force clearing remote state for PID ${serverInfo.pid} due to unreachability.`);
+ logger.warn('Force clearing remote state due to unreachability', {
+     serverPid: serverInfo?.pid,
+     currentPid: process.pid
+ }, error);
```

### 6. Add Error Tracking
```diff
+ } catch (error) {
+     logger.error('Scheduler restart failed', error, {
+         forceClearRemoteState,
+         pid: process.pid
+     });
+     throw error;
+ }
```

## Benefits

### Before Issues:
- Manual `[Scheduler]` prefix in every log call
- Template string interpolation mixed with logging
- No structured context for machine parsing
- Error not tracked in catch block
- No correlation ID support
- Hard to test (direct logger import)

### After Improvements:
- Automatic component tagging
- Structured context objects
- Machine-readable log entries
- Proper error object tracking
- Ready for correlation ID support
- Testable via ILogger interface

## Testing

### Before (Hard to test)
```typescript
// Hard to mock the global logger
import { logger } from '../logger.ts';

// Can't easily assert on log output
// Can't suppress logs in tests
```

### After (Easy to test)
```typescript
import { NoOpLogger, InMemoryLogger } from '../utils/structured-logger';
import type { ILogger } from '../utils/structured-logger';

// Suppress logs
const logger = new NoOpLogger();

// Assert on log output
const logger = new InMemoryLogger();
await forceSchedulerRestart(logger);
expect(logger.hasLoggedMessage('Forcing scheduler restart')).toBe(true);
expect(logger.hasLogLevel('info')).toBe(true);

// Dependency injection
function createScheduler(logger: ILogger): Scheduler {
  return new Scheduler(logger);
}
```

## Complete File Example

Here's a more complete example showing multiple functions:

```typescript
import { createStructuredLogger } from '../utils/structured-logger';
import { getSchedulerInstance, setScheduler, setSchedulerVersion, setSchedulerInitializationPromise } from '../core/internal-state.ts';
import { getSharedStateManager } from './state-manager.ts';

const logger = createStructuredLogger('Scheduler');

export async function forceSchedulerRestart(forceClearRemoteState: boolean = false): Promise<void> {
    if (isSchedulerRestartInProgress()) {
        logger.warn('Restart already in progress, skipping concurrent call');
        return;
    }
    
    setSchedulerRestartInProgress(true);
    
    try {
        logger.info('Forcing scheduler restart due to config change', {
            forceClearRemoteState,
            pid: process.pid
        });

        const oldScheduler = getSchedulerInstance();
        setScheduler(null);
        setSchedulerVersion(null);
        setSchedulerInitializationPromise(null);

        if (oldScheduler && forceClearRemoteState) {
            try {
                const serverInfo = await getSharedStateManager().getBrowserServerInfo();
                if (serverInfo && serverInfo.pid !== process.pid) {
                    logger.info('Skipping clearBrowserServer — live scheduler owns state', {
                        schedulerPid: serverInfo.pid,
                        currentPid: process.pid
                    });
                    setSchedulerRestartInProgress(false);
                    return;
                }
            } catch (error) {
                logger.warn('Force clearing remote state due to unreachability', {
                    serverPid: serverInfo?.pid,
                    currentPid: process.pid
                }, error);
            }
        }
        
        if (oldScheduler) {
            try {
                await oldScheduler.shutdown();
                logger.info('Old scheduler shutdown complete');
            } catch (error) {
                logger.error('Error during old scheduler shutdown', error);
            }
        }
        
        logger.info('Scheduler restart complete. Next call will create fresh scheduler');
    } catch (error) {
        logger.error('Scheduler restart failed', error, {
            forceClearRemoteState,
            pid: process.pid
        });
        throw error;
    } finally {
        setSchedulerRestartInProgress(false);
    }
}

export async function initializeScheduler(config: Config): Promise<void> {
    const startTime = Date.now();
    
    try {
        logger.info('Initializing scheduler', {
            workerCount: config.WORKER_THREADS,
            maxConcurrency: config.MAX_CONCURRENT_RESEARCHERS,
            pid: process.pid
        });

        const scheduler = new BrowserTaskScheduler(config);
        await scheduler.initialize();

        setScheduler(scheduler);
        setSchedulerVersion(generateSchedulerVersion(config));
        
        const duration = Date.now() - startTime;
        logger.info('Scheduler initialization complete', {
            durationMs: duration,
            poolSize: scheduler.getPoolSize()
        });
    } catch (error) {
        const duration = Date.now() - startTime;
        logger.error('Scheduler initialization failed', error, {
            durationMs: duration,
            workerCount: config.WORKER_THREADS
        });
        throw error;
    }
}
```

## Pattern Reference

### Timing Operations
```diff
- const start = Date.now();
- // ... work ...
- logger.debug(`[Component] Task completed in ${Date.now() - start}ms`);
+ const startTime = Date.now();
+ // ... work ...
+ const duration = Date.now() - startTime;
+ logger.info('Task completed', { durationMs: duration });
```

### Conditional Logging
```diff
- if (verbose) {
-     logger.debug('[Component] Debug info');
- }
+ logger.debug('Debug info');  // Handled by underlying logger
```

### Error Context
```diff
- logger.error('[Component] Failed to fetch', err);
+ logger.error('Failed to fetch', err, {
+     url: requestUrl,
+     method: 'GET',
+     timeout: 5000
+ });
```

### Retry Logic
```diff
- logger.warn(`[Component] Retrying (${attempt}/${maxAttempts}) after ${delay}ms`);
+ logger.warn('Retrying', {
+     attempt,
+     maxAttempts,
+     delayMs: delay
+ });
```

This example demonstrates the complete migration pattern for browser-manager functions. Use this as a reference when migrating other modules.