import { describe, it, expect } from 'vitest';
import { initResearchSDK, shutdownResearchSDK, getSDKContainer } from '../../src/sdk.ts';
import { getService } from '../../src/core/service-registry.ts';
import { ServiceNames } from '../../src/core/interfaces/service-names.ts';
import type { ISchedulerInternals } from '../../src/core/interfaces/scheduler-interfaces.ts';
import { BrowserTaskScheduler } from '../../src/infrastructure/browser/browser-task-scheduler.ts';
import { isBrowserAvailable } from '../../src/infrastructure/browser/config.ts';
import { skipsLiveNetwork } from './helpers/setup.ts';

describe('Shutdown Performance', () => {
  it('should initialize, run healthcheck, and dispose within acceptable time', async (ctx) => {
    // The healthcheck below runs a real browser search probe. In CI that hits
    // live DuckDuckGo (blocked from datacenter IPs) and burns the full 105s
    // health-check timeout, so skip it there (visible skip). Runs for real
    // locally, where it measures the actual shutdown time.
    if (!isBrowserAvailable() || skipsLiveNetwork()) return ctx.skip();
    // 1. Initialize
    await initResearchSDK({ model: {} as any });
    
    // 2. Trigger browser pool via healthcheck
    const container = getSDKContainer()!;
    const schedulerService = await getService<ISchedulerInternals>(ServiceNames.SCHEDULER, undefined, container);
    const instance = schedulerService.getSchedulerInstance();
    if (instance && 'runHealthCheck' in instance) {
      await (instance as any).runHealthCheck();
    } else {
      const stateManager = await getService<any>(ServiceNames.STATE_MANAGER, undefined, container);
      const s = new BrowserTaskScheduler('perf-shutdown-test', stateManager, container);
      await s.startServer();
      await s.runHealthCheck();
      schedulerService.setSchedulerInstance(s);
    }
    
    // 3. Measure shutdown time
    const startDispose = Date.now();
    await shutdownResearchSDK();
    const disposeDurationMs = Date.now() - startDispose;
    
    // The shutdown should be fast now (usually ~600-1200ms). We assert it's under 5 seconds to avoid flakiness in CI.
    // The previous bug caused it to take 5000ms+ due to poolifier IPC timeouts.
    expect(disposeDurationMs).toBeLessThan(5000);
  }, 300000);
});
