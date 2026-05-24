/**
 * Health Tool Definition
 *
 * Provides health check functionality for the research system:
 * - Check system health status across all components (browser pool, knowledge store, GPU lock)
 */

import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { healthRegistry } from '../healthcheck/index.ts';

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
    }),
    renderShell: 'self',
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const { verbose } = params as { verbose?: boolean };

      const outputLines: string[] = [];

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

        return { content: [{ type: 'text', text: outputLines.join('\n') }], details: { health: systemHealth } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `**Health check failed**\n\n${message}` }], details: { error: message } };
      }
    },
  };
}
