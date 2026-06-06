/**
 * security_search Tool
 *
 * Search security vulnerability databases (NVD, CISA KEV, GitHub Advisories, OSV).
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { searchSecurityDatabases } from '../security/index.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import { MAX_GATHERING_CALLS } from '../constants.ts';
import { metrics } from '../utils/metrics.ts';
import type { SecuritySearchParams } from '../security/types.ts';

export function createSecuritySearchTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
}): ToolDefinition {

  const SecuritySearchParamsSchema = Type.Object({
    databases: Type.Optional(Type.Array(Type.String({
      description: 'Databases to search (default: all): nvd, cisa_kev, github, osv',
    }))),
    terms: Type.Array(Type.String({
      description: 'Search terms: CVE IDs (e.g., CVE-2024-1234), package names, keywords',
    }), { minItems: 1 }),
    severity: Type.Optional(Type.String({
      description: 'Filter by severity: LOW, MEDIUM, HIGH, CRITICAL',
    })),
    maxResults: Type.Optional(Type.Number({
      description: 'Max results per database (default: 20)',
      default: 20,
      minimum: 1,
      maximum: 100,
    })),
    includeExploited: Type.Optional(Type.Boolean({
      description: 'Only include actively exploited vulnerabilities',
      default: false,
    })),
    ecosystem: Type.Optional(Type.String({
      description: 'Package ecosystem for OSV: npm, pip, maven, go, rust, cargo, etc.',
    })),
    githubRepo: Type.Optional(Type.String({
      description: 'GitHub repository for advisories: "owner/repo" format',
    })),
  });

  type SecuritySearchParamsType = Static<typeof SecuritySearchParamsSchema>;

  return {
    name: 'security_search',
    label: 'Security Search',
    description: 'Search security vulnerability databases (NVD, CISA KEV, GitHub Advisories, OSV). Returns CVEs, advisories, and vulnerability details. Filter by severity, CVE ID, package name, or include only actively exploited vulnerabilities.',
    promptSnippet: 'Search security vulnerability databases for CVEs and advisories',
    promptGuidelines: [
      'Available for looking up CVE IDs, package vulnerabilities, or security advisories.',
      'Supports databases: NVD (340k+ CVEs), CISA KEV (actively exploited), GitHub Advisories (open source), OSV (packages).',
      'Filter by severity, CVE ID, package name, or include only actively exploited vulnerabilities.',
      `CRITICAL: You are allowed a maximum of ${MAX_GATHERING_CALLS} gathering calls total across ALL tools. Use them for breadth.`,
    ],
    parameters: SecuritySearchParamsSchema,
    executionMode: 'parallel',
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _extensionCtx,
    ): Promise<AgentToolResult<unknown>> {
      const startTime = Date.now();
      metrics.increment('tool_security_search_calls_total', 1);

      // Record call in tracker - returns false if limit reached
      const allowed = options.tracker.recordCall('security_search');
      if (!allowed) {
          metrics.increment('tool_security_search_calls_total', 1, { status: 'rate_limited' });
          return {
            content: [{ type: 'text', text: options.tracker.getLimitMessage('security_search') }],
            details: { blocked: true, reason: 'limit_reached' },
          };
      }

      if (!Value.Check(SecuritySearchParamsSchema, params)) {
          metrics.increment('tool_security_search_calls_total', 1, { status: 'invalid_params' });
          return {
            content: [{ type: 'text', text: 'Invalid parameters for security_search tool.' }],
            details: { error: 'invalid_parameters' },
          };
      }

      const p = params as SecuritySearchParamsType;

      const terms = p.terms;
      if (terms.length === 0) {
        metrics.increment('tool_security_search_calls_total', 1, { status: 'no_terms' });
        throw new Error('At least one search term is required');
      }

      const databases: readonly ('nvd' | 'cisa_kev' | 'github' | 'osv')[] = p.databases !== undefined && p.databases.length > 0
        ? p.databases as readonly ('nvd' | 'cisa_kev' | 'github' | 'osv')[]
        : ['nvd', 'cisa_kev', 'github', 'osv'];
      const maxResults = p.maxResults ?? 20;

      metrics.increment('tool_security_search_terms_total', terms.length);
      metrics.increment('tool_security_search_databases_total', databases.length);

      let results;
      try {
        const searchParams: SecuritySearchParams = {
          terms,
          databases,
          severity: p.severity,
          maxResults,
          includeExploited: p.includeExploited ?? false,
          ecosystem: p.ecosystem,
          githubRepo: p.githubRepo,
        };
        results = await searchSecurityDatabases(searchParams);
      } catch (error) {
        const duration = Date.now() - startTime;
        metrics.observe('tool_security_search_duration_ms', duration, { status: 'error' });
        metrics.increment('tool_security_search_calls_total', 1, { status: 'error' });
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `# Security Vulnerability Search Failed\n\n**Error:** ${errorMsg}\n\n**Databases:** ${databases.join(', ')}\n\n**Terms:** ${terms.join(', ')}\n\nUnable to search security databases. This may be a temporary issue - try again later.`,
            },
          ],
          details: {
            error: errorMsg,
            databases,
            terms,
            duration,
          },
        };
      }

      const elapsed = Date.now() - startTime;
      metrics.observe('tool_security_search_duration_ms', elapsed, { status: 'success' });
      metrics.increment('tool_security_search_calls_total', 1, { status: 'success' });
      metrics.increment('tool_security_search_vulnerabilities_total', results.totalVulnerabilities);

      if (results.results.nvd?.count) {
        metrics.increment('tool_security_search_vulnerabilities_total', results.results.nvd.count, { database: 'nvd' });
      }
      if (results.results.cisa_kev?.count) {
        metrics.increment('tool_security_search_vulnerabilities_total', results.results.cisa_kev.count, { database: 'cisa_kev' });
      }
      if (results.results.github?.count) {
        metrics.increment('tool_security_search_vulnerabilities_total', results.results.github.count, { database: 'github' });
      }
      if (results.results.osv?.count) {
        metrics.increment('tool_security_search_vulnerabilities_total', results.results.osv.count, { database: 'osv' });
      }

      let markdown = '# Security Vulnerability Search Results\n\n';
      markdown += `**Source: Security Databases**\n\n`;
      markdown += `**Searched:** ${databases.join(', ')}\n`;
      markdown += `**Terms:** ${terms.join(', ')}\n`;
      markdown += `**Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;
      markdown += `**Total Vulnerabilities Found:** ${results.totalVulnerabilities}\n\n`;

      if (results.results.nvd !== undefined) {
        markdown += '## NIST NVD\n\n';
        if (results.results.nvd.error !== undefined) {
          markdown += `[Error] ${results.results.nvd.error}\n\n`;
        } else {
          markdown += `Found: ${results.results.nvd.count} vulnerabilities\n\n`;
          for (const vuln of results.results.nvd.vulnerabilities.slice(0, 20)) {
            markdown += `### ${vuln.id}\n`;
            markdown += `- **Severity:** ${vuln.severity}\n`;
            if (vuln.cvssScore !== undefined) {
              markdown += `- **CVSS Score:** ${vuln.cvssScore}\n`;
              if (vuln.cvssVector !== undefined) {
                markdown += `- **CVSS Vector:** ${vuln.cvssVector}\n`;
              }
            }
            const description = vuln.description;
            markdown += `- **Description:** ${description.length > 300 ? `${description.substring(0, 300)}...` : description}\n`;
            if (vuln.knownExploited === true) {
              markdown += '- **[Actively Exploited]**\n';
            }
            if (vuln.published !== undefined) {
              markdown += `- **Published:** ${vuln.published}\n`;
            }
            if (vuln.cwes !== undefined && vuln.cwes.length > 0) {
              markdown += `- **CWEs:** ${vuln.cwes.join(', ')}\n`;
            }
            if (vuln.references !== undefined && vuln.references.length > 0) {
              markdown += `- **References:** ${vuln.references.slice(0, 3).join(', ')}\n`;
            }
            markdown += '\n';
          }
          if (results.results.nvd.vulnerabilities.length > 20) {
            const moreCount = results.results.nvd.vulnerabilities.length - 20;
            const moreText = moreCount === 1 ? 'vulnerability' : 'vulnerabilities';
            markdown += `\n*... and ${moreCount} more ${moreText} not shown.*\n`;
          }
        }
        markdown += '\n---\n\n';
      }

      if (results.results.cisa_kev !== undefined) {
        markdown += '## CISA Known Exploited Vulnerabilities\n\n';
        if (results.results.cisa_kev.error !== undefined) {
          markdown += `[Error] ${results.results.cisa_kev.error}\n\n`;
        } else {
          markdown += `Found: ${results.results.cisa_kev.count} actively exploited vulnerabilities\n\n`;
          for (const vuln of results.results.cisa_kev.vulnerabilities.slice(0, 20)) {
            markdown += `### ${vuln.id}\n`;
            if (vuln.vendor !== undefined) {
              markdown += `- **Vendor:** ${vuln.vendor}\n`;
            }
            if (vuln.product !== undefined) {
              markdown += `- **Product:** ${vuln.product}\n`;
            }
            const description = vuln.description;
            markdown += `- **Description:** ${description.length > 300 ? `${description.substring(0, 300)}...` : description}\n`;
            if (vuln.dueDate !== undefined) {
              markdown += `- **Due Date:** ${vuln.dueDate}\n`;
            }
            if (vuln.requiredAction !== undefined) {
              markdown += `- **Required Action:** ${vuln.requiredAction}\n`;
            }
            markdown += '\n';
          }
          if (results.results.cisa_kev.vulnerabilities.length > 20) {
            const moreCount = results.results.cisa_kev.vulnerabilities.length - 20;
            const moreText = moreCount === 1 ? 'vulnerability' : 'vulnerabilities';
            markdown += `\n*... and ${moreCount} more ${moreText} not shown.*\n`;
          }
        }
        markdown += '\n---\n\n';
      }

      if (results.results.github !== undefined) {
        markdown += '## GitHub Security Advisories\n\n';
        if (results.results.github.error !== undefined) {
          markdown += `[Error] ${results.results.github.error}\n\n`;
        } else {
          markdown += `Found: ${results.results.github.count} advisories\n\n`;
          for (const adv of results.results.github.advisories.slice(0, 20)) {
            markdown += `### ${adv.id}\n`;
            markdown += `- **Severity:** ${adv.severity}\n`;
            if (adv.cveId) {
              markdown += `- **CVE ID:** ${adv.cveId}\n`;
            }
            markdown += `- **Summary:** ${adv.summary}\n`;
            const description = adv.description ?? '';
            markdown += `- **Description:** ${description.length > 300 ? `${description.substring(0, 300)}...` : description}\n`;
            if (adv.published) {
              markdown += `- **Published:** ${adv.published}\n`;
            }
            if (adv.affectedPackages && adv.affectedPackages.length > 0) {
              markdown += `- **Affected:** ${adv.affectedPackages.join(', ')}\n`;
            }
            markdown += '\n';
          }
          if (results.results.github.advisories.length > 20) {
            const moreCount = results.results.github.advisories.length - 20;
            const moreText = moreCount === 1 ? 'advisory' : 'advisories';
            markdown += `\n*... and ${moreCount} more ${moreText} not shown.*\n`;
          }
        }
        markdown += '\n---\n\n';
      }

      if (results.results.osv !== undefined) {
        markdown += '## Open Source Vulnerabilities (OSV)\n\n';
        if (results.results.osv.error !== undefined) {
          markdown += `[Error] ${results.results.osv.error}\n\n`;
        } else {
          markdown += `Found: ${results.results.osv.count} vulnerabilities\n\n`;
          for (const vuln of results.results.osv.vulnerabilities.slice(0, 20)) {
            markdown += `### ${vuln.id}\n`;
            markdown += `- **Severity:** ${vuln.severity}\n`;
            const description = vuln.description;
            markdown += `- **Description:** ${description.length > 300 ? `${description.substring(0, 300)}...` : description}\n`;
            if (vuln.affectedProducts && vuln.affectedProducts.length > 0) {
              markdown += `- **Affected:** ${vuln.affectedProducts.join(', ')}\n`;
            }
            if (vuln.fixes && vuln.fixes.length > 0) {
              markdown += `- **Fixes:** ${vuln.fixes.slice(0, 3).join('; ')}\n`;
            }
            markdown += '\n';
          }
          if (results.results.osv.vulnerabilities.length > 20) {
            const moreCount = results.results.osv.vulnerabilities.length - 20;
            const moreText = moreCount === 1 ? 'vulnerability' : 'vulnerabilities';
            markdown += `\n*... and ${moreCount} more ${moreText} not shown.*\n`;
          }
        }
        markdown += '\n---\n\n';
      }

      return {
        content: [{ type: 'text', text: markdown }],
        details: {
          results,
          totalDatabases: results.totalDatabases,
          totalVulnerabilities: results.totalVulnerabilities,
          duration: elapsed,
        },
      };
    },
  };
}
