/**
 * Health Command Module
 *
 * Handles health-related commands:
 * - Run health checks
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { logger } from '../logger.ts';
import { healthRegistry } from '../healthcheck/index.ts';

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
    case 'history':
    case 'summary':
      ctx.ui.notify(`Action '${action}' is no longer supported. Health checks are now stateless.`, 'info');
      break;
    default:
      ctx.ui.notify(`Unknown health action: ${action}. Use: run`, 'error');
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
