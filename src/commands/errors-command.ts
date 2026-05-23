/**
 * Errors Command Module
 *
 * Handles error reporting commands:
 * - View error reports
 * - View error patterns
 * - Export error reports
 * - Clear error history
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { errorTracker } from '../utils/error-tracker.ts';
import * as fss from 'node:fs';
import * as pathmod from 'node:path';
import * as os from 'node:os';

export interface CommandContext {
  ui: {
    notify: (message: string, type: string) => void;
  };
  cwd?: string;
}

/**
 * Handle errors-related actions
 */
export async function handleErrorsAction(
  action: string | undefined,
  _params: string[],
  ctx: CommandContext,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'view':
    case undefined:
      showErrorReport(ctx, pi);
      break;
    case 'clear':
      errorTracker.clear();
      ctx.ui.notify('Error history cleared', 'info');
      break;
    case 'export':
      await exportErrorReport(_params[0], ctx);
      break;
    case 'patterns':
      showErrorPatterns(ctx, pi);
      break;
    default:
      ctx.ui.notify(`Unknown errors action: ${action}. Use: view, clear, export, patterns`, 'error');
  }
}

/**
 * Display detailed error report
 */
export function showErrorReport(ctx: CommandContext, pi: ExtensionAPI): void {
  const report = errorTracker.getReport();

  const outputLines: string[] = [];
  outputLines.push('## Error Report');
  outputLines.push('');
  outputLines.push(`- **Total errors:** ${report.totalErrors}`);
  outputLines.push(`- **Unique patterns:** ${report.uniquePatterns}`);
  outputLines.push('');

  if (report.patterns.length > 0) {
    outputLines.push('## Error Patterns (sorted by frequency)');
    outputLines.push('');
    for (const pattern of report.patterns) {
      outputLines.push(`### ${pattern.signature}`);
      outputLines.push(`**Count:** ${pattern.count} | **First seen:** ${new Date(pattern.firstSeen).toLocaleString()} | **Last seen:** ${new Date(pattern.lastSeen).toLocaleString()}`);
      outputLines.push('');
      outputLines.push('**Example message:**');
      outputLines.push('```' + pattern.message.substring(0, 200) + (pattern.message.length > 200 ? '...' : '') + '```');
      outputLines.push('');
      if (pattern.contexts.length > 0) {
        outputLines.push('**Recent contexts:**');
        for (const context of pattern.contexts.slice(-3)) {
          const contextParts = Object.entries(context).map(([k, v]) => `${k}: ${v}`).join(', ');
          outputLines.push(`- ${contextParts}`);
        }
        outputLines.push('');
      }
    }
  } else {
    outputLines.push('_No errors recorded._');
  }

  pi.sendMessage({
    customType: 'error-report',
    content: outputLines.join('\n'),
    display: true,
    details: report,
  });

  ctx.ui.notify(`Error report: ${report.totalErrors} errors, ${report.uniquePatterns} patterns`, 'info');
}

/**
 * Display error patterns summary
 */
export function showErrorPatterns(_ctx: CommandContext, pi: ExtensionAPI): void {
  const report = errorTracker.getReport();

  const outputLines: string[] = [];
  outputLines.push('## Error Patterns Summary');
  outputLines.push('');
  outputLines.push(`Total unique patterns: ${report.uniquePatterns}`);
  outputLines.push('');

  if (report.patterns.length > 0) {
    outputLines.push('| Pattern | Count | Last Seen |');
    outputLines.push('|---------|-------|-----------|');
    for (const pattern of report.patterns.slice(0, 10)) {
      const lastSeen = new Date(pattern.lastSeen).toLocaleDateString();
      outputLines.push(`| ${pattern.signature.substring(0, 40)} | ${pattern.count} | ${lastSeen} |`);
    }
  } else {
    outputLines.push('_No error patterns recorded._');
  }

  pi.sendMessage({
    customType: 'error-patterns-result',
    content: outputLines.join('\n'),
    display: true,
    details: { patterns: report.patterns },
  });
}

/**
 * Export error report to JSON file
 */
export async function exportErrorReport(customPath: string | undefined, ctx: CommandContext): Promise<void> {
  const report = errorTracker.getReport();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  
  let exportPath: string;
  if (customPath) {
    const cwd = ctx.cwd || process.cwd();
    exportPath = pathmod.resolve(cwd, customPath);
    if (!exportPath.endsWith('.json')) {
      exportPath += '.json';
    }
  } else {
    const xdgCacheBase = process.env['XDG_CACHE_HOME'] || pathmod.join(os.homedir(), '.cache');
    const errorReportsDir = pathmod.join(xdgCacheBase, 'pi-research', 'error-reports');
    if (!fss.existsSync(errorReportsDir)) {
      fss.mkdirSync(errorReportsDir, { recursive: true });
    }
    exportPath = pathmod.join(errorReportsDir, `error-report-${timestamp}.json`);
  }

  try {
    const exportData = {
      exportedAt: new Date().toISOString(),
      summary: {
        totalErrors: report.totalErrors,
        uniquePatterns: report.uniquePatterns,
      },
      patterns: report.patterns.map(p => ({
        signature: p.signature,
        message: p.message,
        count: p.count,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        contexts: p.contexts.map(c => {
          const safeContext: Record<string, string> = {};
          for (const [key, value] of Object.entries(c)) {
            if (['researchId', 'mode', 'component', 'operation'].includes(key)) {
              safeContext[key] = String(value);
            }
          }
          return safeContext;
        }),
      })),
    };

    fss.writeFileSync(exportPath, JSON.stringify(exportData, null, 2), 'utf-8');
    
    const cwd = ctx.cwd || process.cwd();
    const relativePath = pathmod.relative(cwd, exportPath);
    ctx.ui.notify(`Error report exported to: ${relativePath}`, 'info');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to export error report: ${message}`, 'error');
  }
}

/**
 * Clear error history
 */
export function clearErrorHistory(ctx: CommandContext): void {
  errorTracker.clear();
  ctx.ui.notify('Error history cleared', 'info');
}