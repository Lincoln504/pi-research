/**
 * Agent Tools
 *
 * ToolDefinition wrappers for pi-search-scrape tools.
 * These are constructed fresh on each research() call to capture current SearXNG URL and ctx.
 *
 * Supports both relative path imports (development) and npm package imports (production).
 * For npm linking setup: npm link ../pi-search-scrape
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { SecuritySearchParams } from '../../pi-search-scrape/security-databases/types.ts';
import { logger } from './logger.js';

// Import from pi-search-scrape
// Supports both relative paths (development) and npm package (production)
// For npm linking: npm link pi-search-scrape
let searchMultipleQueries: any;
let scrapeBulk: any;
let searchSecurityDatabases: any;

async function loadPiSearchScrapeModules() {
  if (searchMultipleQueries) {
    return; // Already loaded
  }

  // Always use relative paths in development (monorepo setup)
  try {
    const searchModule = await import('../../pi-search-scrape/search.ts');
    const scrapersModule = await import('../../pi-search-scrape/scrapers.ts');
    const securityModule = await import('../../pi-search-scrape/security-databases/index.ts');

    searchMultipleQueries = searchModule.searchMultipleQueries;
    scrapeBulk = scrapersModule.scrapeBulk;
    searchSecurityDatabases = securityModule.searchSecurityDatabases;

    logger.log('[agent-tools] Loaded pi-search-scrape from relative paths');
  } catch (relativeError) {
    const relMsg = relativeError instanceof Error ? relativeError.message : String(relativeError);
    throw new Error(
      `Failed to load pi-search-scrape. Ensure it is available at: ../../pi-search-scrape/\n` +
      `error: ${relMsg}`,
      { cause: relativeError }
    );
  }
}

type ToolCallId = string;
type AbortSignal = globalThis.AbortSignal;

interface CreateAgentToolsOptions {
  searxngUrl: string;
  ctx: ExtensionContext;
}

interface PiSearchParams {
  queries: string[];
}

interface PiScrapeParams {
  urls: string[];
  maxConcurrency?: number;
}

interface PiSecuritySearchParams {
  databases?: string[];
  terms: string[];
  severity?: string;
  maxResults?: number;
  includeExploited?: boolean;
  ecosystem?: string;
  githubRepo?: string;
}

interface PiStackexchangeParams {
  command: string;
  query?: string;
  tags?: string;
  site?: string;
  limit?: number;
  format?: string;
  [key: string]: unknown; // Index signature for compatibility
}

// Tool: pi_search
export function createPiSearchTool(options: CreateAgentToolsOptions): ToolDefinition {
  return {
    name: 'pi_search',
    label: 'PI Search',
    description: 'Search the web via SearXNG and return URLs, titles, and snippets. For full content, use pi_scrape on the returned URLs.',
    promptSnippet: 'Search web for URLs and information (returns snippets only, not full content)',
    promptGuidelines: [
      'Use pi_search when you need to find URLs or information about a topic.',
      'This returns search results with snippets. Use pi_scrape to get full content from specific URLs.',
      'For security research, use pi_security_search to query vulnerability databases.',
    ],
    parameters: Type.Object({
      queries: Type.Array(
        Type.String({
          description: 'Search queries - plain text strings, one or more',
        }),
        { minItems: 1 },
      ),
    }),
    async execute(
      _toolCallId: ToolCallId,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const record = params as PiSearchParams;
      const { queries } = record;

      if (!queries || queries.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: at least one query is required' }],
          details: {},
        };
      }

      // Load pi-search-scrape modules (lazy loading, happens once)
      await loadPiSearchScrapeModules();

      // Set SearXNG URL in environment for search.ts to pick up
      const originalUrl = process.env['SEARXNG_URL'];
      process.env['SEARXNG_URL'] = options.searxngUrl;

      try {
        const results = await searchMultipleQueries(queries);

        let markdown = '# Web Search Results\n\n';

        for (const qr of results) {
          markdown += `## Query: ${qr.query}\n\n`;

          if (qr.error !== undefined) {
            const errorIcon = qr.error.type === 'empty_results' ? '📭' : '⚠️';
            markdown += `${errorIcon} **${qr.error.type === 'empty_results' ? 'No results' : 'Error'}:** ${qr.error.message}\n\n`;
          } else {
            markdown += `**Results:** ${qr.results.length} found\n\n`;

            const resultsArray = qr.results;
            for (let i = 0; i < Math.min(resultsArray.length, 20); i++) {
              const result = resultsArray[i];
              if (!result) continue;
              markdown += `### ${i + 1}. ${result.title}\n\n`;
              markdown += `- **URL:** ${result.url}\n`;
              if (result.content) {
                const content = result.content;
                markdown += `- **Snippet:** ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}\n`;
              }
              markdown += '\n';
            }
          }
          markdown += '\n---\n\n';
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: { results, totalQueries: queries.length },
        };
      } catch (error) {
        // Return error as tool result — never let it propagate through the agent loop
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn('[pi_search] Error:', msg);
        return {
          content: [{ type: 'text', text: `Search failed: ${msg}. Proceeding with available information.` }],
          details: { error: msg },
        };
      } finally {
        // Always restore original URL
        if (originalUrl !== undefined) {
          process.env['SEARXNG_URL'] = originalUrl;
        } else {
          delete process.env['SEARXNG_URL'];
        }
      }
    },
  };
}

// Tool: pi_scrape
export function createPiScrapeTool(_options: CreateAgentToolsOptions): ToolDefinition {
  return {
    name: 'pi_scrape',
    label: 'PI Scrape',
    description: 'Scrape full content from one or more URLs using 2-layer architecture: fetch (fast, concurrent) → Playwright+Chromium (JS-heavy fallback). Returns markdown content.',
    promptSnippet: 'Scrape full content from URLs (returns full markdown)',
    promptGuidelines: [
      'Use pi_scrape to get full content from specific URLs.',
      'Uses 2-layer scraping: fetch first, then Playwright for JS-heavy pages.',
      'Set maxConcurrency for bulk scraping (default: 10 parallel requests).',
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String({ description: 'URLs to scrape - one or more' }), { minItems: 1 }),
      maxConcurrency: Type.Optional(
        Type.Number({
          description: 'Max parallel scrapes (default: 10)',
          default: 10,
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(
      _toolCallId: ToolCallId,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const record = params as PiScrapeParams;
      const { urls } = record;
      const maxConcurrency = record.maxConcurrency ?? 10;

      if (!urls || urls.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: at least one URL is required' }],
          details: {},
        };
      }

      // Load pi-search-scrape modules (lazy loading, happens once)
      await loadPiSearchScrapeModules();

      let scrapeResults: any[];
      try {
        scrapeResults = await scrapeBulk(urls, maxConcurrency, signal);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn('[pi_scrape] Error:', msg);
        return {
          content: [{ type: 'text', text: `Scrape failed: ${msg}. Proceeding with available information.` }],
          details: { error: msg },
        };
      }

      const successful = scrapeResults.filter((r: any) => r.source !== 'failed');
      const failed = scrapeResults.filter((r: any) => r.source === 'failed');

      let markdown = '# URL Scrape Results\n\n';
      markdown += `**URLs Processed:** ${urls.length}\n`;
      markdown += `**Concurrency:** ${maxConcurrency}\n\n`;
      markdown += `**Successful:** ${successful.length}\n`;
      markdown += `**Failed:** ${failed.length}\n\n`;

      if (successful.length > 0) {
        markdown += '## Successful Scrapes\n\n';

        for (const result of successful) {
          markdown += `### ${result.url}\n\n`;
          markdown += `- **Layer:** ${result.layer ?? 'unknown'}\n`;
          markdown += `- **Characters:** ${result.markdown.length}\n`;
          markdown += '\n---\n\n';
          markdown += result.markdown;
          markdown += '\n\n---\n\n';
        }
      }

      if (failed.length > 0) {
        markdown += '## Failed Scrapes\n\n';
        markdown += '| URL | Error |\n';
        markdown += '|-----|-------|\n';

        for (const result of failed) {
          const error = result.error ?? 'Unknown error';
          markdown += `| ${result.url} | ${error} |\n`;
        }
        markdown += '\n';
      }

      return {
        content: [{ type: 'text', text: markdown }],
        details: {
          results: scrapeResults,
          totalUrls: urls.length,
          successful: successful.length,
          failed: failed.length,
        },
      };
    },
  };
}

// Tool: pi_security_search
export function createPiSecuritySearchTool(_options: CreateAgentToolsOptions): ToolDefinition {
  return {
    name: 'pi_security_search',
    label: 'PI Security Search',
    description: 'Search security vulnerability databases (NVD, CISA KEV, GitHub Advisories, OSV). Returns CVEs, advisories, and vulnerability details.',
    promptSnippet: 'Search security vulnerability databases for CVEs and advisories',
    promptGuidelines: [
      'Use pi_security_search to look up CVE IDs, package vulnerabilities, or security advisories.',
      'Supports databases: NVD, CISA KEV, GitHub Advisories, OSV.',
      'Filter by severity, CVE ID, package name, or include only actively exploited vulnerabilities.',
    ],
    parameters: Type.Object({
      databases: Type.Optional(
        Type.Array(Type.String({
          description: 'Databases to search (default: all): nvd, cisa_kev, github, osv',
        })),
      ),
      terms: Type.Array(
        Type.String({
          description: 'Search terms: CVE IDs, package names, keywords',
        }),
        { minItems: 1 },
      ),
      severity: Type.Optional(
        Type.String({
          description: 'Filter by severity: LOW, MEDIUM, HIGH, CRITICAL',
        }),
      ),
      maxResults: Type.Optional(
        Type.Number({
          description: 'Max results per database (default: 20)',
          default: 20,
          minimum: 1,
          maximum: 100,
        }),
      ),
      includeExploited: Type.Optional(
        Type.Boolean({
          description: 'Include only actively exploited vulnerabilities (default: false)',
          default: false,
        }),
      ),
      ecosystem: Type.Optional(
        Type.String({
          description: 'Filter by package ecosystem (e.g., npm, pip, maven)',
        }),
      ),
      githubRepo: Type.Optional(
        Type.String({
          description: 'Filter by GitHub repository (owner/repo format)',
        }),
      ),
    }),
    async execute(
      _toolCallId: ToolCallId,
      params: unknown,
      _signal?: AbortSignal | undefined,
      _onUpdate?: unknown,
      _ctx?: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const record = params as PiSecuritySearchParams;
      const { terms } = record;

      if (!terms || terms.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: at least one search term is required' }],
          details: {},
        };
      }

      const databases = record.databases ?? ['nvd', 'cisa_kev', 'github', 'osv'];

      // Load pi-search-scrape modules (lazy loading, happens once)
      await loadPiSearchScrapeModules();

      const securityParams: SecuritySearchParams = {
        databases,
        terms,
        severity: record.severity,
        maxResults: record.maxResults ?? 20,
        includeExploited: record.includeExploited ?? false,
        ecosystem: record.ecosystem,
        githubRepo: record.githubRepo,
      };

      let results: any;
      try {
        results = await searchSecurityDatabases(securityParams);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn('[pi_security_search] Error:', msg);
        return {
          content: [{ type: 'text', text: `Security search failed: ${msg}. Proceeding with available information.` }],
          details: { error: msg },
        };
      }

      let markdown = '# Security Vulnerability Search Results\n\n';
      markdown += `**Searched:** ${databases.join(', ')}\n`;
      markdown += `**Terms:** ${terms.join(', ')}\n\n`;
      markdown += `**Total Vulnerabilities Found:** ${results.totalVulnerabilities}\n\n`;

      if (results.results.nvd !== undefined) {
        markdown += '## NIST NVD\n\n';

        if (results.results.nvd.error !== undefined) {
          markdown += `❌ **Error:** ${results.results.nvd.error}\n\n`;
        } else {
          markdown += `Found: ${results.results.nvd.count} vulnerabilities\n\n`;

          for (const vuln of results.results.nvd.vulnerabilities.slice(0, 10)) {
            markdown += `### ${vuln.id}\n`;
            markdown += `- **Severity:** ${vuln.severity}\n`;

            if (vuln.cvssScore !== undefined) {
              markdown += `- **CVSS Score:** ${vuln.cvssScore}\n`;
            }

            if (vuln.description !== undefined) {
              markdown += `- **Description:** ${vuln.description}\n`;
            }

            markdown += '\n';
          }
        }
      }

      // Add similar sections for other databases...

      return {
        content: [{ type: 'text', text: markdown }],
        details: { results },
      };
    },
  };
}

// Tool: pi_code_search (rg-grep)
export function createRgGrepTool(): ToolDefinition {
  return {
    name: 'pi_code_search',
    label: 'PI Code Search',
    description: 'Search for code patterns using ripgrep (rg). Supports regex, glob patterns, and flags.',
    promptSnippet: 'Search code for patterns using ripgrep',
    promptGuidelines: [
      'Use pi_code_search to find code patterns, function definitions, or references.',
      'Supports regex patterns for flexible matching.',
      'Use flags like -i for case-insensitive, -C for context lines.',
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description: 'Regex pattern to search for',
      }),
      path: Type.Optional(
        Type.String({
          description: 'Directory path to search (default: current directory)',
          default: '.',
        }),
      ),
      flags: Type.Optional(
        Type.String({
          description: 'rg flags (e.g., -i for case-insensitive, -C 3 for 3 context lines)',
          default: '',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const record = params as { pattern: string; path?: string; flags?: string };
      const { pattern } = record;
      const path = record.path ?? '.';
      const flags = record.flags ?? '';

      if (!pattern) {
        return {
          content: [{ type: 'text', text: 'Error: pattern is required' }],
          details: {},
        };
      }

      // Import rg-grep module dynamically
      const { rgGrep } = await import('./rg-grep.js');
      const result = await rgGrep(pattern, path, flags);

      return {
        content: [{ type: 'text', text: result }],
        details: { pattern, path, flags },
      };
    },
  };
}

// Tool: pi_stackexchange
export function createPiStackexchangeTool(options: CreateAgentToolsOptions): ToolDefinition {
  return {
    name: 'pi_stackexchange',
    label: 'PI Stack Exchange',
    description: 'Search Stack Exchange sites (Stack Overflow, etc.) for Q&A content.',
    promptSnippet: 'Search Stack Exchange for answers',
    promptGuidelines: [
      'Use pi_stackexchange to find answers on Stack Overflow and other Stack Exchange sites.',
      'Good for debugging help, programming questions, and technical discussions.',
    ],
    parameters: Type.Object({
      command: Type.String({
        description: 'Stack Exchange command to execute (e.g., search)',
      }),
      query: Type.Optional(
        Type.String({
          description: 'Search query',
        }),
      ),
      tags: Type.Optional(
        Type.String({
          description: 'Filter by tags (comma-separated)',
        }),
      ),
      site: Type.Optional(
        Type.String({
          description: 'Stack Exchange site (default: stackoverflow.com)',
          default: 'stackoverflow.com',
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Results count (1-100, default: 10)',
          default: 10,
          minimum: 1,
          maximum: 100,
        }),
      ),
      format: Type.Optional(
        Type.String({
          description: 'Output format: table, json, or compact (default: table)',
          default: 'table',
        }),
      ),
    }),
    async execute(
      _toolCallId: ToolCallId,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const record = params as PiStackexchangeParams;
      const { command } = record;

      // Load pi-search-scrape modules (lazy loading, happens once)
      await loadPiSearchScrapeModules();

      // Dynamically import stackexchange module
      const stackexchangeModule = await import('../../pi-search-scrape/stackexchange/index.ts');

      const { stackexchangeCommand } = stackexchangeModule;

      return stackexchangeCommand({
        command,
        params: record,
        ctx: options.ctx as any, // Pass outer extension context
        signal,
      });
    },
  };
}

// Create all agent tools
export function createAgentTools(options: CreateAgentToolsOptions): ToolDefinition[] {
  return [
    createPiSearchTool(options),
    createPiScrapeTool(options),
    createPiSecuritySearchTool(options),
    createRgGrepTool(),
    createPiStackexchangeTool(options),
  ];
}
