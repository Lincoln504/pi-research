/**
 * rg_grep Tool (Ripgrep)
 *
 * Standalone grep tool using ripgrep (rg) or fallback to grep.
 */

import { spawn } from 'node:child_process';
import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';

const DEFAULT_MAX_BYTES = 100 * 1024; // 100KB
const DEFAULT_MAX_LINES = 200;
const STREAM_MAX_BYTES = 10 * 1024 * 1024; // 10MB max in stream (prevent RangeError)

interface RgGrepParams {
  pattern: string;
  path?: string;
  flags?: string;
}

function truncateHead(content: string, maxBytes: number, maxLines: number): string {
  const lines = content.split('\n');

  if (lines.length <= maxLines && new Blob([content]).size <= maxBytes) {
    return content;
  }

  // Truncate by lines first
  const truncatedLines = lines.slice(0, maxLines);
  let result = truncatedLines.join('\n');

  // Then check bytes
  const blob = new Blob([result]);
  if (blob.size > maxBytes) {
    let byteCount = 0;
    const charArray: string[] = [];

    for (const char of result) {
      byteCount += new Blob([char]).size;
      if (byteCount > maxBytes) break;
      charArray.push(char);
    }

    result = charArray.join('');
  }

  return result;
}

async function execCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null; wasTruncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    let wasTruncated = false;

    child.stdout?.on('data', (data) => {
      // Check if adding this chunk would exceed stream limit
      const chunk = data.toString();
      if (stdout.length + chunk.length > STREAM_MAX_BYTES) {
        // Stop collecting data to prevent RangeError
        wasTruncated = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code, wasTruncated });
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

function sanitizeInput(input: string): string[] {
  // Simple sanitization: split on whitespace, preserve quoted strings
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of input) {
    if (char === '"' || char === "'") {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    result.push(current);
  }

  return result;
}

export function createGrepTool(options: {
  tracker: ToolUsageTracker;
}): ToolDefinition {
  return {
    name: 'grep',
    label: 'Code Search',
    description: 'Search codebase using ripgrep (rg) or grep fallback. Fast recursive text search.',
    promptSnippet: 'Search codebase using ripgrep/grep',
    promptGuidelines: [
      'Use grep for fast recursive text search in codebases.',
      'Pattern supports regex. Path and flags are optional.',
      'Falls back to grep if rg is not available.',
      'CRITICAL: You are allowed a maximum of 6 gathering calls total across ALL tools. Use them for breadth.',
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: 'Search pattern (regex supported)' }),
      path: Type.Optional(Type.String({ description: 'Directory to search (default: current directory)' })),
      flags: Type.Optional(Type.String({ description: 'Additional flags (e.g., "-i" for case-insensitive)' })),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      // Record call in tracker - returns false if limit reached
      const allowed = options.tracker.recordCall('grep');
      if (!allowed) {
        return {
          content: [{ type: 'text', text: options.tracker.getLimitMessage('grep') }],
          details: { blocked: true },
        };
      }

      const record = params as RgGrepParams;
      const { pattern } = record;
      const path = record.path ?? '.';
      const flags = record.flags ?? '';

      if (!pattern) {
        return {
          content: [{ type: 'text', text: 'Error: pattern is required' }],
          details: {},
        };
      }

      // Sanitize inputs to prevent shell injection
      const patternParts = sanitizeInput(pattern);
      const flagParts = flags ? sanitizeInput(flags) : [];

      // Try rg first
      try {
        const rgArgs = ['--no-heading', '-n', ...flagParts, ...patternParts, path];
        const { stdout, stderr, exitCode, wasTruncated } = await execCommand('rg', rgArgs);

        const truncated = truncateHead(stdout, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES);

        let markdown = '# Search Results (rg)\n\n';
        markdown += `**Pattern:** \`${pattern}\`\n`;
        markdown += `**Path:** \`${path}\`\n`;
        if (flags) markdown += `**Flags:** \`${flags}\`\n`;
        markdown += `**Exit Code:** ${exitCode}\n\n`;

        if (wasTruncated) {
          markdown += '⚠️ **Output was truncated to prevent memory overflow (>10MB)**\n\n';
        }

        if (truncated) {
          markdown += '```\n' + truncated + '\n```';
        } else {
          markdown += 'No matches found.';
        }

        if (stderr) {
          markdown += '\n\n**Stderr:**\n```\n' + stderr + '\n```';
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: {
            command: 'rg',
            args: rgArgs,
            exitCode,
            wasTruncated,
          },
        };
      } catch (rgError) {
        // rg not found, try grep
        try {
          const grepArgs = ['-rn', ...flagParts, pattern, path];
          const { stdout, stderr, exitCode, wasTruncated } = await execCommand('grep', grepArgs);

          const truncated = truncateHead(stdout, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES);

          let markdown = '# Search Results (grep)\n\n';
          markdown += `**Pattern:** \`${pattern}\`\n`;
          markdown += `**Path:** \`${path}\`\n`;
          if (flags) markdown += `**Flags:** \`${flags}\`\n`;
          markdown += `**Exit Code:** ${exitCode}\n\n`;
          markdown += '*Note: Using grep fallback (rg not available)*\n\n';

          if (wasTruncated) {
            markdown += '⚠️ **Output was truncated to prevent memory overflow (>10MB)**\n\n';
          }

          if (truncated) {
            markdown += '```\n' + truncated + '\n```';
          } else {
            markdown += 'No matches found.';
          }

          if (stderr) {
            markdown += '\n\n**Stderr:**\n```\n' + stderr + '\n```';
          }

          return {
            content: [{ type: 'text', text: markdown }],
            details: {
              command: 'grep',
              args: grepArgs,
              exitCode,
              wasTruncated,
            },
          };
        } catch (grepError) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Neither rg nor grep is available.\n\nrg error: ${rgError}\ngrep error: ${grepError}`,
              },
            ],
            details: {},
          };
        }
      }
    },
  };
}

/**
 * Standalone function to execute rg/grep search
 */
export async function grep(pattern: string, path: string = '.', flags: string = ''): Promise<string> {
  if (!pattern) {
    throw new Error('Pattern is required');
  }

  // Sanitize inputs to prevent shell injection
  const patternParts = sanitizeInput(pattern);
  const flagParts = flags ? sanitizeInput(flags) : [];

  // Try rg first
  try {
    const rgArgs = ['--no-heading', '-n', ...flagParts, ...patternParts, path];
    const { stdout, stderr, exitCode, wasTruncated } = await execCommand('rg', rgArgs);

    let markdown = '# Search Results (rg)\n\n';
    markdown += `**Pattern:** \`${pattern}\`\n`;
    markdown += `**Path:** \`${path}\`\n`;
    if (flags) markdown += `**Flags:** \`${flags}\`\n`;
    markdown += `**Exit Code:** ${exitCode}\n\n`;

    const truncated = truncateHead(stdout, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES);

    if (wasTruncated) {
      markdown += '⚠️ **Output was truncated to prevent memory overflow (>10MB)**\n\n';
    }

    if (truncated) {
      markdown += '```\n' + truncated + '\n```';
    } else {
      markdown += 'No matches found.';
    }

    if (stderr) {
      markdown += '\n\n**Stderr:**\n```\n' + stderr + '\n```';
    }

    return markdown;
  } catch (rgError) {
    // rg not found, try grep
    try {
      const grepArgs = ['-rn', ...flagParts, pattern, path];
      const { stdout, stderr, exitCode, wasTruncated } = await execCommand('grep', grepArgs);

      let markdown = '# Search Results (grep)\n\n';
      markdown += `**Pattern:** \`${pattern}\`\n`;
      markdown += `**Path:** \`${path}\`\n`;
      if (flags) markdown += `**Flags:** \`${flags}\`\n`;
      markdown += `**Exit Code:** ${exitCode}\n\n`;
      markdown += '*Note: Using grep fallback (rg not available)*\n\n';

      const truncated = truncateHead(stdout, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES);

      if (wasTruncated) {
        markdown += '⚠️ **Output was truncated to prevent memory overflow (>10MB)**\n\n';
      }

      if (truncated) {
        markdown += '```\n' + truncated + '\n```';
      } else {
        markdown += 'No matches found.';
      }

      if (stderr) {
        markdown += '\n\n**Stderr:**\n```\n' + stderr + '\n```';
      }

      return markdown;
    } catch (grepError) {
      return `Error: Neither rg nor grep is available.\n\nrg error: ${rgError}\ngrep error: ${grepError}`;
    }
  }
}
