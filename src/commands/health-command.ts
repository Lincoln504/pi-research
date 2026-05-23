/**
 * Health Command Module
 *
 * Handles health-related commands:
 * - Run health checks
 * - View health history
 * - View health summary
 * - Clear health check cache
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { logger } from '../logger.ts';
import { healthRegistry, clearHealthCheckCache } from '../healthcheck/index.ts';
import { getHealthHistory, getHealthSummary } from '../healthcheck/persistence.ts';

export interface CommandContext {
  ui: {
    notify: (message: string, type: string) => void;
  };
  hasUI?: boolean;
  cwd?: string;
}

/**
 * Handle health-related actions
 */
export async function handleHealthAction(
  action: string | undefined,
  _params: string[],
  ctx: CommandContext,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'run':
    case undefined:
      await runHealthCheck(ctx, pi);
      break;
    case 'clear':
      clearHealthCheckCache();
      ctx.ui.notify('Health check cache cleared', 'info');
      break;
    case 'history':
      showHealthHistory(ctx, pi);
      break;
    case 'summary':
      showHealthSummary(ctx, pi);
      break;
    default:
      ctx.ui.notify(`Unknown health action: ${action}. Use: run, clear, history, summary`, 'error');
  }
}

/**
 * Run a health check and display results
 */
export async function runHealthCheck(ctx: CommandContext, pi: ExtensionAPI): Promise<void> {
  ctx.ui.notify('Running health checks...', 'info');

  try {
    const systemHealth = await healthRegistry.runAll();

    const outputLines: string[] = [];
    outputLines.push('## System Health Status');
    outputLines.push('');

    const statusIcon = systemHealth.status === 'healthy' ? '✅' :
                      systemHealth.status === 'degraded' ? '⚠️' : '❌';
    const statusText = systemHealth.status === 'healthy' ? 'All systems operational' :
                      systemHealth.status === 'degraded' ? 'System degraded (non-critical issues)' :
                      'System unhealthy (critical failures)';

    outputLines.push(`**${statusIcon} ${statusText}**`);
    outputLines.push('');

    for (const component of systemHealth.components) {
      const icon = component.healthy ? '✅' : '❌';
      const criticalMark = healthRegistry.isCritical(component.component) ? ' [CRITICAL]' : '';
      outputLines.push(`${icon} **${component.component}**${criticalMark}`);
      if (component.error) {
        outputLines.push(`  - Error: ${component.error}`);
      }
      if (component.diagnostic) {
        const diagnostics = Object.entries(component.diagnostic)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        if (diagnostics) {
          outputLines.push(`  - ${diagnostics}`);
        }
      }
      outputLines.push(`  - Duration: ${component.durationMs.toFixed(0)}ms`);
      outputLines.push('');
    }

    outputLines.push(`Checked at: ${new Date(systemHealth.timestamp).toLocaleString()}`);

    pi.sendMessage({
      customType: 'health-result',
      content: outputLines.join('\n'),
      display: true,
      details: { health: systemHealth },
    });

    ctx.ui.notify(`Health check complete: ${systemHealth.status}`, systemHealth.status === 'healthy' ? 'info' : 'warning');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[pi-research] Health check failed:', error);

    pi.sendMessage({
      customType: 'health-result',
      content: `**Health check failed**\n\n${message}`,
      display: true,
    });

    ctx.ui.notify(`❌ Health check failed: ${message}`, 'error');
  }
}

/**
 * Display health check history
 */
export function showHealthHistory(ctx: CommandContext, pi: ExtensionAPI): void {
  const summary = getHealthSummary();
  const history = getHealthHistory(15);

  const outputLines: string[] = [];
  outputLines.push('## Health Check Statistics');
  outputLines.push('');
  outputLines.push(`- **Total checks:** ${summary.total}`);
  outputLines.push(`- **Healthy:** ${summary.healthy}`);
  outputLines.push(`- **Degraded:** ${summary.degraded}`);
  outputLines.push(`- **Unhealthy:** ${summary.unhealthy}`);
  outputLines.push(`- **Last check:** ${summary.lastCheck ? new Date(summary.lastCheck).toLocaleString() : 'Never'}`);
  outputLines.push(`- **Last status:** ${summary.lastStatus?.toUpperCase() || 'Unknown'}`);
  outputLines.push('');

  if (history.length > 0) {
    outputLines.push('## Recent Checks (Last 15)');
    outputLines.push('');
    for (const entry of history) {
      const icon = entry.status === 'healthy' ? '✅' :
                  entry.status === 'degraded' ? '⚠️' : '❌';
      const time = new Date(entry.timestamp).toLocaleTimeString();
      outputLines.push(`${icon} **${entry.status.toUpperCase()}** — ${time}`);

      const failedComponents = entry.components.filter(c => !c.healthy);
      if (failedComponents.length > 0) {
        outputLines.push(`  Failed: ${failedComponents.map(c => c.component).join(', ')}`);
      }
      outputLines.push('');
    }
  } else {
    outputLines.push('_No health check history available._');
  }

  pi.sendMessage({
    customType: 'health-history-result',
    content: outputLines.join('\n'),
    display: true,
    details: { summary, history },
  });

  ctx.ui.notify(`Health history: ${summary.total} checks recorded`, 'info');
}

/**
 * Display health check summary
 */
export function showHealthSummary(_ctx: CommandContext, pi: ExtensionAPI): void {
  const summary = getHealthSummary();

  const outputLines: string[] = [];
  outputLines.push('## Health Summary');
  outputLines.push('');
  outputLines.push(`Total checks: ${summary.total}`);
  outputLines.push(`Healthy: ${summary.healthy} (${summary.total > 0 ? ((summary.healthy / summary.total) * 100).toFixed(1) : 0}%)`);
  outputLines.push(`Degraded: ${summary.degraded} (${summary.total > 0 ? ((summary.degraded / summary.total) * 100).toFixed(1) : 0}%)`);
  outputLines.push(`Unhealthy: ${summary.unhealthy} (${summary.total > 0 ? ((summary.unhealthy / summary.total) * 100).toFixed(1) : 0}%)`);
  outputLines.push('');
  if (summary.lastCheck) {
    outputLines.push(`Last check: ${new Date(summary.lastCheck).toLocaleString()}`);
    outputLines.push(`Last status: ${summary.lastStatus?.toUpperCase() || 'Unknown'}`);
  }

  pi.sendMessage({
    customType: 'health-summary-result',
    content: outputLines.join('\n'),
    display: true,
    details: { summary },
  });
}

/**
 * Clear health check cache
 */
export function clearHealthCache(ctx: CommandContext): void {
  clearHealthCheckCache();
  ctx.ui.notify('Health check cache cleared', 'info');
}