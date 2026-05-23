/**
 * Health Tool Definition
 *
 * Provides health check functionality for the research system:
 * - Check system health status across all components
 * - View health history and statistics
 * - Clear health history
 */

import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { healthRegistry } from '../healthcheck/index.ts';
import { getHealthSummary, getHealthHistory, clearHealthHistory } from '../healthcheck/persistence.ts';

/**
 * Create the health check tool definition
 */
export function createHealthTool(): ToolDefinition {
  return {
    name: 'health',
    label: 'Health Check',
    description: 'Check system health status across all components (browser pool, knowledge store, GPU lock)',
    promptSnippet: 'Run health checks on the research system',
    parameters: Type.Object({
      verbose: Type.Optional(Type.Boolean({
        description: 'Show detailed diagnostic information for each component',
      })),
      clear: Type.Optional(Type.Boolean({
        description: 'Clear health check history before running new checks',
      })),
      history: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 100,
        description: 'Show health check history for the last N checks (0 for no history)',
      })),
    }),
    renderShell: 'self',
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const { verbose, clear, history: historyLimit } = params as { verbose?: boolean; clear?: boolean; history?: number };

      const outputLines: string[] = [];

      // Clear health history if requested
      if (clear) {
        try {
          clearHealthHistory();
          outputLines.push('✅ Health history cleared.\n');
        } catch (error) {
          outputLines.push(`⚠️  Failed to clear health history: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }

      // Run health checks
      try {
        const systemHealth = await healthRegistry.runAll();

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
          
          if (verbose && component.diagnostic) {
            const diagnostics = Object.entries(component.diagnostic)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ');
            if (diagnostics) {
              outputLines.push(`  - Diagnostic: ${diagnostics}`);
            }
          }
          
          if (verbose) {
            outputLines.push(`  - Duration: ${component.durationMs.toFixed(0)}ms`);
          }
          outputLines.push('');
        }

        outputLines.push(`Checked at: ${new Date(systemHealth.timestamp).toLocaleString()}`);
        outputLines.push('');

        // Add health summary if verbose or history requested
        if (verbose || historyLimit !== undefined) {
          appendHealthSummary(outputLines);
          
          // Show history if requested
          if (historyLimit !== undefined && historyLimit > 0) {
            appendHealthHistory(outputLines, historyLimit);
          }
        }

        return { content: [{ type: 'text', text: outputLines.join('\n') }], details: { health: systemHealth } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `**Health check failed**\n\n${message}` }], details: { error: message } };
      }
    },
  };
}

/**
 * Append health summary to output
 */
function appendHealthSummary(outputLines: string[]): void {
  const summary = getHealthSummary();
  outputLines.push('');
  outputLines.push('## Health Statistics');
  outputLines.push('');
  outputLines.push(`- Total checks: ${summary.total}`);
  outputLines.push(`- Healthy: ${summary.healthy}`);
  outputLines.push(`- Degraded: ${summary.degraded}`);
  outputLines.push(`- Unhealthy: ${summary.unhealthy}`);
  outputLines.push(`- Last check: ${summary.lastCheck ? new Date(summary.lastCheck).toLocaleString() : 'Never'}`);
  outputLines.push(`- Last status: ${summary.lastStatus?.toUpperCase() || 'Unknown'}`);
  outputLines.push('');
}

/**
 * Append health history to output
 */
function appendHealthHistory(outputLines: string[], limit: number): void {
  outputLines.push('## Recent Checks');
  outputLines.push('');
  
  const history = getHealthHistory(limit);
  if (history.length > 0) {
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
    outputLines.push('');
  }
}