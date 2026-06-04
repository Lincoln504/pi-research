/**
 * State Metrics
 *
 * Handles metrics collection for the StateManager.
 */

import type { StateMetrics, SingletonState } from '../types/state-types.ts';
import { metrics } from '../../utils/metrics.ts';
import { ServiceLifecycle, type IService } from '../../core/service-registry.ts';

/**
 * Collects metrics from state
 */
export class StateMetricsCollector implements IService {
  readonly name = 'state-metrics-collector';
  lifecycle = ServiceLifecycle.UNINITIALIZED;
  /**
   * Get metrics about the current state
   * @param state The current state
   * @returns StateMetrics object with various statistics
   */
  getMetrics(state: SingletonState): StateMetrics {
    const now = Date.now();

    const sessionEntries = Object.entries(state.sessions);
    const totalSessions = sessionEntries.length;

    let activeSessions = 0;
    let oldestSession: number | null = null;
    let newestSession: number | null = null;
    let lastHeartbeatAge: number | null = null;

    for (const [, sessionInfo] of sessionEntries) {
      // Check if session is active (lastSeen within last 5 minutes)
      if (now - sessionInfo.lastSeen < 300000) {
        activeSessions++;
      }

      // Track oldest and newest connection times
      if (oldestSession === null || sessionInfo.connectedAt < oldestSession) {
        oldestSession = sessionInfo.connectedAt;
      }

      if (newestSession === null || sessionInfo.connectedAt > newestSession) {
        newestSession = sessionInfo.connectedAt;
      }

      // Track last heartbeat age
      const heartbeatAge = now - sessionInfo.lastSeen;
      if (lastHeartbeatAge === null || heartbeatAge > lastHeartbeatAge) {
        lastHeartbeatAge = heartbeatAge;
      }
    }

    // Calculate container uptime if container exists
    let containerUptime: number | null = null;
    if (state.containerId !== '') {
      // Use lastUpdated as approximation for container uptime
      containerUptime = now - state.lastUpdated;
    }

    // Export to metrics system
    metrics.setGauge('state_sessions_total', totalSessions);
    metrics.setGauge('state_sessions_active', activeSessions);
    metrics.setGauge('state_browser_server_exists', state.browserServer ? 1 : 0);
    metrics.setGauge('state_gpu_lock_owner_exists', state.gpuOwner ? 1 : 0);

    return {
      totalSessions,
      activeSessions,
      oldestSession,
      newestSession,
      containerUptime,
      lastHeartbeatAge,
    };
  }

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }
}