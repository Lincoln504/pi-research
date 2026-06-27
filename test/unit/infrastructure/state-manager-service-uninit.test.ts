import { describe, it, expect } from 'vitest';
import { StateManagerService } from '../../../src/infrastructure/state/state-manager-service.ts';

describe('StateManagerService when never initialized', () => {
  it('getBrowserServer() returns null instead of throwing', async () => {
    // A run that never registered a browser server (e.g. KNOWLEDGE_STORE_MODE=none
    // or an early failure) leaves the inner state manager uninitialized. Shutdown
    // probes for a browser server; the read-only query must degrade to null rather
    // than throwing "State manager not initialized" and logging a misleading error.
    const svc = new StateManagerService();
    await expect(svc.getBrowserServer()).resolves.toBeNull();
  });

  it('still throws for operations that genuinely require initialization', async () => {
    // The tolerance is scoped to the read-only browser-server query; real
    // state operations must still surface the uninitialized error.
    const svc = new StateManagerService();
    await expect(svc.getMetrics()).rejects.toThrow(/not initialized/i);
  });
});
