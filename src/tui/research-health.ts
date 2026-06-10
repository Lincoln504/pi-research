/**
 * Research Health Helpers
 *
 * Helper functions for health checking during research
 */

import { runHealthCheck, healthRegistry } from '../healthcheck/index.ts';
import { logger } from '../logger.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import {
  addSlice,
  activateSlice,
  removeSlice,
  type ResearchPanelState,
} from './research-panel.ts';

export interface HealthCheckContext {
  panelState: ResearchPanelState;
  onUpdate: () => void;
}

export interface HealthCheckResult {
  success: boolean;
  error?: string;
}

/**
 * Ensure functional health before starting research
 * Displays a health check slice and runs verification
 */
export async function ensureFunctionalHealth(
  ctx: HealthCheckContext
): Promise<void> {
  const { panelState, onUpdate } = ctx;
  
  // Check if already healthy (quick check)
  const isHealthy = await isHealthCheckSuccessful();
  if (isHealthy) {
    return;
  }

  const sliceLabel = 'health check ...';
  addSlice(panelState, sliceLabel, sliceLabel, false);
  activateSlice(panelState, sliceLabel);
  onUpdate();

  try {
    const health = await runHealthCheck();
    if (!health.success) {
      const raw = health.error || '';
      const msg = formatHealthError(raw);
      throw new Error(msg);
    }
  } finally {
    removeSlice(panelState, sliceLabel);
    onUpdate();
  }
}

/**
 * Check if a health check was successful without running a full new one if possible.
 * Since we're stateless, we run a quick check of critical components.
 */
async function isHealthCheckSuccessful(): Promise<boolean> {
  try {
    const health = await healthRegistry.runAll();
    return health.status === 'healthy' || health.status === 'degraded';
  } catch {
    return false;
  }
}

/**
 * Format health check error into user-friendly message
 */
function formatHealthError(raw: string): string {
  if (raw.includes('not found') || raw.includes('not installed') || raw.includes('binaries')) {
    return 'Browser engine not installed. Run `npm run setup` to install it.';
  } else if (raw.includes('Timeout') || raw.includes('timeout') || raw.includes('timed out')) {
    return 'Unable to reach the web (connection timed out). Check your internet connection.';
  } else if (raw.includes('net::ERR') || raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND')) {
    return 'Unable to reach the web (network error). Check your internet connection.';
  } else {
    return `Browser readiness check failed. Enable debug logging (PI_RESEARCH_DEBUG=true) for details. (${raw || 'unknown error'})`;
  }
}

/**
 * Periodic health monitoring for long-running research
 */
export interface HealthMonitor {
  start: () => void;
  stop: () => void;
}

export function createHealthMonitor(): HealthMonitor {
  let timer: NodeJS.Timeout | null = null;

  const start = () => {
    if (timer) return;
    
    timer = setInterval(async () => {
      try {
        const health = await healthRegistry.runAll();
        const failedNonCritical = health.components.filter(c => !c.healthy && !healthRegistry.isCritical(c.component));
        if (failedNonCritical.length > 0) {
          logger.warn(`[research] Periodic health check: non-critical components degraded: ${failedNonCritical.map(c => c.component).join(', ')}`);
        }
      } catch (error) {
        logger.debug('[research] Periodic health check failed (non-blocking):', error);
      }
    }, 30000); // Every 30 seconds
    safeUnref(timer);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop };
}
