/**
 * Metrics Command Module
 *
 * Handles metrics and monitoring commands:
 * - View system metrics
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { metrics } from '../utils/metrics.ts';
import type { CommandContext } from './command-types.ts';

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
    case 'clear':
    case 'reset':
      metrics.clear();
      ctx.ui.notify('Metrics cleared', 'info');
      break;
    default:
      ctx.ui.notify(`Unknown metrics action: ${action}. Use: view, clear`, 'error');
  }
}

/**
 * Display system metrics
 */
export function showMetrics(ctx: CommandContext, pi: ExtensionAPI): void {
  const snapshot = metrics.getSnapshot();
  const outputLines: string[] = [];
  
  outputLines.push('## System Metrics');
  outputLines.push('');
  
  const hasCounters = Object.keys(snapshot.counters).length > 0;
  const hasGauges = Object.keys(snapshot.gauges).length > 0;
  const hasHistograms = Object.keys(snapshot.histograms).length > 0;

  if (!hasCounters && !hasGauges && !hasHistograms) {
    outputLines.push('_No metrics recorded in the current session._');
  }

  if (hasCounters) {
    outputLines.push('### 🔢 Counters');
    for (const [key, value] of Object.entries(snapshot.counters)) {
      outputLines.push(`- **${key}:** ${value}`);
    }
    outputLines.push('');
  }

  if (hasGauges) {
    outputLines.push('### 🌡️ Gauges');
    for (const [key, value] of Object.entries(snapshot.gauges)) {
      outputLines.push(`- **${key}:** ${value.toFixed(2)}`);
    }
    outputLines.push('');
  }

  if (hasHistograms) {
    outputLines.push('### 📊 Histograms');
    for (const [key, stats] of Object.entries(snapshot.histograms)) {
      outputLines.push(`- **${key}:**`);
      outputLines.push(`  - Count: ${stats.count}`);
      outputLines.push(`  - Avg: ${stats.avg.toFixed(2)}ms`);
      outputLines.push(`  - P90: ${stats.p90.toFixed(2)}ms`);
      outputLines.push(`  - P99: ${stats.p99.toFixed(2)}ms`);
    }
    outputLines.push('');
  }

  pi.sendMessage({
    customType: 'metrics-result',
    content: outputLines.join('\n'),
    display: true,
    details: { metrics: snapshot },
  });

  ctx.ui.notify('Metrics displayed', 'info');
}