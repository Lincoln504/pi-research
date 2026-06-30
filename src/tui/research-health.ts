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
 * Format health check error into user-friendly message
 */
export function formatHealthError(raw: string): string {
  if (raw.includes('Xvfb') || raw.includes('xvfb') || raw.includes('virtual display') || raw.includes('display server') || raw.includes('DISPLAY not set')) {
    return 'No display server found on Linux. Install Xvfb for TTY/Wayland use: sudo apt install xvfb';
  } else if (raw.includes('not found') || raw.includes('not installed') || raw.includes('binaries')) {
    return 'Browser engine not installed. Run `npx camoufox-js fetch` to install it.';
  } else if (raw.includes('Timeout') || raw.includes('timeout') || raw.includes('timed out')) {
    // The readiness probes check browser/state/knowledge availability — they do NOT perform a
    // web search, so a timeout here is NOT the search engine blocking us. It is almost always
    // slow browser startup, resource contention (several research runs sharing the pool/GPU at
    // once, which makes these probes time out together), or a teardown race when a run is
    // cancelled mid-flight. Keep this message honest so a contention timeout is not misread as
    // bot-blocking.
    return 'A readiness check timed out before the browser/services were ready. This is usually slow browser startup, resource contention (e.g. multiple research runs at once sharing the pool), or a cancelled run. It is not a sign the search engine is refusing automated traffic — these readiness probes do not run a search. Retry; if it persists, reduce concurrency and check system resources.';
  } else if (raw.includes('net::ERR') || raw.includes('ECONNREFUSED') || raw.includes('ENOTFOUND')) {
    return 'The browser hit a network error reaching the web. Check your internet connection.';
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
