/**
 * security_search Tool
 *
 * Search security vulnerability databases (NVD, CISA KEV, GitHub Advisories, OSV).
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { searchSecurityDatabases } from '../security/index.js';
import type { SecuritySearchParams } from '../security/types.js';

interface SecuritySearchParamsType {
  databases?: string[];
  terms: string[];
  severity?: string;
  maxResults?: number;
  includeExploited?: boolean;
  ecosystem?: string;
  githubRepo?: string;
  [key: string]: unknown;
}

export function createSecuritySearchTool(_options: {
  searxngUrl: string;
  ctx: ExtensionContext;
}): ToolDefinition {

  return {
    name: 'security_search',
    label: 'Security Search',
    description: 'Search security vulnerability databases (NVD, CISA KEV, GitHub Advisories, OSV). Returns CVEs, advisories, and vulnerability details. Filter by severity, CVE ID, package name, or include only actively exploited vulnerabilities.',
    promptSnippet: 'Search security vulnerability databases for CVEs and advisories',
    promptGuidelines: [
      'Use security_search to look up CVE IDs, package vulnerabilities, or security advisories.',
      'Supports databases: NVD (340k+ CVEs), CISA KEV (actively exploited), GitHub Advisories (open source), OSV (packages).',
      'Filter by severity, CVE ID, package name, or include only actively exploited vulnerabilities.',
    ],
    parameters: Type.Object({
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
    }),
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      _extensionCtx,
    ): Promise<AgentToolResult<unknown>> {
      const startTime = Date.now();
      const paramsRecord = params as Record<string, unknown>;

      if (!isSecuritySearchParams(paramsRecord)) {
        throw new Error('Invalid parameters for security_search');
      }

      const terms = paramsRecord['terms'] as string[];
      if (terms.length === 0) {
        throw new Error('At least one search term is required');
      }

      const databasesParam = paramsRecord['databases'] as string[] | undefined;
      const databases = databasesParam !== undefined && databasesParam.length > 0
        ? databasesParam
        : ['nvd', 'cisa_kev', 'github', 'osv'];

      const maxResults = (paramsRecord['maxResults'] as number | undefined) ?? 20;


      const results = await searchSecurityDatabases({
        databases,
        terms,
        severity: paramsRecord['severity'] as string | undefined,
        maxResults,
        includeExploited: (paramsRecord['includeExploited'] as boolean | undefined) ?? false,
        ecosystem: paramsRecord['ecosystem'] as string | undefined,
        githubRepo: paramsRecord['githubRepo'] as string | undefined,
      } as SecuritySearchParams);

      const elapsed = Date.now() - startTime;

      let markdown = '# Security Vulnerability Search Results\n\n';
      markdown += `**Searched:** ${databases.join(', ')}\n`;
      markdown += `**Terms:** ${terms.join(', ')}\n`;
      markdown += `**Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;
      markdown += `**Total Vulnerabilities Found:** ${results.totalVulnerabilities}\n\n`;

      if (results.results.nvd !== undefined) {
        markdown += '## NIST NVD\n\n';
        if (results.results.nvd.error !== undefined) {
          markdown += `❌ **Error:** ${results.results.nvd.error}\n\n`;
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
              markdown += '- ⚠️ **Actively Exploited**\n';
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
          markdown += `❌ **Error:** ${results.results.cisa_kev.error}\n\n`;
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
          markdown += `❌ **Error:** ${results.results.github.error}\n\n`;
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
          markdown += `❌ **Error:** ${results.results.osv.error}\n\n`;
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

function isSecuritySearchParams(params: Record<string, unknown>): params is SecuritySearchParamsType {
  return (
    typeof params === 'object' &&
    params !== null &&
    'terms' in params &&
    Array.isArray(params['terms']) &&
    (params['terms'] as unknown[]).every((t: unknown) => typeof t === 'string')
  );
}
