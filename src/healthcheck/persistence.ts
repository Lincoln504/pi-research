/**
 * Health Status Persistence
 *
 * Tracks health check results over time for monitoring and diagnostics.
 */

import * as fss from 'node:fs';
import * as pathmod from 'node:path';
import * as os from 'node:os';

import type { SystemHealth } from './registry.ts';
import { logger } from '../logger.ts';

const MAX_HEALTH_HISTORY = 50; // Keep last 50 health check results

interface HealthHistoryEntry {
  timestamp: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: Array<{
    component: string;
    healthy: boolean;
    durationMs: number;
    error?: string;
  }>;
}

function getHealthHistoryPath(): string {
  const xdgStateHome = process.env['XDG_STATE_HOME'] || pathmod.join(os.homedir(), '.local', 'state');
  return pathmod.join(xdgStateHome, 'pi-research', 'health-history.jsonl');
}

/**
 * Record a health check result to history
 */
export function recordHealthCheck(systemHealth: SystemHealth): void {
  try {
    const historyPath = getHealthHistoryPath();
    const dir = pathmod.dirname(historyPath);
    
    if (!fss.existsSync(dir)) {
      fss.mkdirSync(dir, { recursive: true });
    }
    
    const entry: HealthHistoryEntry = {
      timestamp: systemHealth.timestamp,
      status: systemHealth.status,
      components: systemHealth.components.map(c => ({
        component: c.component,
        healthy: c.healthy,
        durationMs: c.durationMs,
        error: c.error,
      })),
    };
    
    // Append to history file
    const line = JSON.stringify(entry) + '\n';
    fss.appendFileSync(historyPath, line, 'utf-8');
    
    // Trim history to keep only recent entries
    trimHealthHistory();
    
    logger.debug(`[health-persistence] Recorded health check: ${systemHealth.status}`);
  } catch (error) {
    logger.warn('[health-persistence] Failed to record health check:', error);
  }
}

/**
 * Get recent health check history
 */
export function getHealthHistory(limit: number = 20): HealthHistoryEntry[] {
  try {
    const historyPath = getHealthHistoryPath();
    if (!fss.existsSync(historyPath)) {
      return [];
    }
    
    const content = fss.readFileSync(historyPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    // Parse entries (most recent first)
    const entries = lines
      .reverse()
      .map(line => {
        try {
          return JSON.parse(line) as HealthHistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is HealthHistoryEntry => e !== null);
    
    return entries.slice(0, limit);
  } catch (error) {
    logger.warn('[health-persistence] Failed to read health history:', error);
    return [];
  }
}

/**
 * Get health summary statistics
 */
export function getHealthSummary(): {
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  lastCheck?: string;
  lastStatus?: 'healthy' | 'degraded' | 'unhealthy';
} {
  const history = getHealthHistory(MAX_HEALTH_HISTORY);
  
  const summary = {
    total: history.length,
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    lastCheck: history[0]?.timestamp,
    lastStatus: history[0]?.status,
  };
  
  for (const entry of history) {
    summary[entry.status]++;
  }
  
  return summary;
}

/**
 * Clear health history
 */
export function clearHealthHistory(): void {
  try {
    const historyPath = getHealthHistoryPath();
    if (fss.existsSync(historyPath)) {
      fss.unlinkSync(historyPath);
      logger.log('[health-persistence] Health history cleared');
    }
  } catch (error) {
    logger.warn('[health-persistence] Failed to clear health history:', error);
  }
}

/**
 * Trim health history to keep only recent entries
 */
function trimHealthHistory(): void {
  try {
    const historyPath = getHealthHistoryPath();
    if (!fss.existsSync(historyPath)) {
      return;
    }
    
    const content = fss.readFileSync(historyPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    if (lines.length <= MAX_HEALTH_HISTORY) {
      return;
    }
    
    // Keep only the most recent entries
    const recentLines = lines.slice(-MAX_HEALTH_HISTORY);
    fss.writeFileSync(historyPath, recentLines.join('\n') + '\n', 'utf-8');
  } catch (error) {
    logger.warn('[health-persistence] Failed to trim health history:', error);
  }
}