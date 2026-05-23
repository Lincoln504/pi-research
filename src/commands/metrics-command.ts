/**
 * Metrics Command Module
 *
 * Handles metrics and monitoring commands:
 * - View system metrics
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { metrics } from '../utils/metrics.ts';

export interface CommandContext {
  ui: {
    notify: (message: string, type: string) => void;
  };
}

/**
 * Handle metrics-related actions
 */
export async function handleMetricsAction(
  action: string | undefined,
  _params: string[],
  ctx: CommandContext,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'view':
    case undefined:
      showMetrics(ctx, pi);
      break;
    default:
      ctx.ui.notify(`Unknown metrics action: ${action}. Use: view`, 'error');
  }
}

/**
 * Display system metrics
 */
export function showMetrics(ctx: CommandContext, pi: ExtensionAPI): void {
  const metricsData = metrics.getSnapshot();
  const outputLines: string[] = [];
  
  outputLines.push('## System Metrics');
  outputLines.push('');
  
  if (Object.keys(metricsData).length === 0) {
    outputLines.push('_No metrics available._');
  } else {
    for (const [key, value] of Object.entries(metricsData)) {
      outputLines.push(`**${key}:** ${typeof value === 'number' ? value.toFixed(2) : JSON.stringify(value)}`);
    }
  }

  pi.sendMessage({
    customType: 'metrics-result',
    content: outputLines.join('\n'),
    display: true,
    details: { metrics: metricsData },
  });

  ctx.ui.notify('Metrics displayed', 'info');
}