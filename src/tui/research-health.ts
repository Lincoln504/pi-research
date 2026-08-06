/**
 * Research Health Helpers
 *
 * Helper functions for health checking during research
 */

import { runHealthCheck, healthRegistry, isBusyPoolHealthFailure } from '../healthcheck/index.ts';
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
      // Distinguish a DEAD/uninitialized pool (must abort) from one that is merely
      // BUSY: under concurrent load the BrowserRuntime readiness probe queues behind
      // in-flight scrapes and times out even though the pool is operational. Mirror
      // the quick orchestrator and proceed-with-warning rather than aborting — the
      // per-task timeouts bound the work. Without this the TUI aborts the exact
      // contention case formatHealthError now (correctly) describes as non-fatal.
      if (isBusyPoolHealthFailure(health)) {
        logger.warn('[ResearchHealth] Browser pool busy — readiness probe queued out under load, but the pool is operational. Proceeding; per-task timeouts bound the work.');
      } else {
        const raw = health.error || '';
        const msg = formatHealthError(raw);
        throw new Error(msg);
      }
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
  // Critical components already warned this run, so a persistently failing check
  // logs once rather than on every 30s tick.
  const warnedCritical = new Set<string>();

  const start = () => {
    if (timer) return;
    warnedCritical.clear();

    // Note: the registry API (runAll) only supports { force } — there is no surface
    // for selecting/skipping individual checks, so each tick runs the full set
    // (including the real BrowserRuntime page-load probe when the pool is active).
    timer = setInterval(async () => {
      try {
        const health = await healthRegistry.runAll();
        const failed = health.components.filter(c => !c.healthy);
        const failedNonCritical = failed.filter(c => !healthRegistry.isCritical(c.component));
        if (failedNonCritical.length > 0) {
          logger.warn(`[research] Periodic health check: non-critical components degraded: ${failedNonCritical.map(c => c.component).join(', ')}`);
        }
        // Critical failures are worth surfacing too — the run itself keeps going
        // (per-task timeouts bound the real work), but silently burning probes while
        // a critical component is down left the monitor with no output at all.
        for (const c of failed.filter(f => healthRegistry.isCritical(f.component))) {
          if (warnedCritical.has(c.component)) continue;
          warnedCritical.add(c.component);
          logger.warn(`[research] Periodic health check: critical component unhealthy mid-run: ${c.component}${c.error ? ` (${c.error})` : ''}`);
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
