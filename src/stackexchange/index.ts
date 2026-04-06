/**
 * Stack Exchange Integration for pi-research
 * Main command handler
 */

import type { Question, Answer, User, Site, StackExchangeConfig } from './types';
import { StackExchangeClient } from './rest-client';
import {
  buildSearchQuery,
  buildQuestionsQuery,
  buildUserQuery,
  buildSitesQuery,
  Filters,
} from './queries';
import {
  formatQuestionsTable,
  formatAnswersTable,
  formatUsersTable,
  formatSitesTable,
  formatCompactQuestions,
} from './output';
import {
  formatUsersCompact,
  formatSitesCompact,
} from './output/compact';
import type { ExtensionContext, AgentToolResult } from '@mariozechner/pi-coding-agent';

function notify(
  ctx: ExtensionContext,
  message: string,
  type: 'info' | 'warning' | 'error',
): void {
  ctx.ui?.notify?.(message, type);
}

/**
 * Load configuration from environment variables or defaults
 */
function loadConfig(): StackExchangeConfig {
  return {
    defaultSite: 'stackoverflow.com',
    apiKey: process.env['STACKEXCHANGE_API_KEY'] ?? null,
    requestTimeout: 30000, // 30 seconds
  };
}

/**
 * Main command handler for Stack Exchange operations
 */
export async function stackexchangeCommand(options: {
  command: string;
  params: Record<string, unknown>;
  ctx: ExtensionContext;
  signal?: AbortSignal;
  onUpdate?: (_update: unknown) => void;
}): Promise<AgentToolResult<unknown>> {
  const { command, params, ctx, signal, onUpdate: _onUpdate } = options;

  // Load config
  const config = loadConfig();

  // Initialize client
  const client = new StackExchangeClient(
    config.apiKey,
    config.requestTimeout,
  );

  try {
    // Check quota before making requests
    if (client.isQuotaExhausted()) {
      const quota = client.getQuotaInfo();
      notify(
        ctx,
        `Stack Exchange API quota exhausted (${quota.remaining}/${quota.max} remaining)`,
        'error',
      );
      return {
        content: [{ type: 'text', text: `❌ Stack Exchange API quota exhausted (${quota.remaining}/${quota.max} remaining). Please wait until the quota resets.` }],
        details: {
          quota,
          command,
        },
      };
    }

    // Warn if quota is low
    if (client.isQuotaLow()) {
      const quota = client.getQuotaInfo();
      notify(
        ctx,
        `Stack Exchange API quota low: ${quota.remaining}/${quota.max} remaining`,
        'warning',
      );
    }

    // Execute command
    let result: unknown;
    switch (command) {
    case 'search':
      result = await executeSearch(params, client, config, signal);
      break;
    case 'get':
      result = await executeGet(params, client, config, signal);
      break;
    case 'user':
      result = await executeUser(params, client, config, signal);
      break;
    case 'site':
      result = await executeSite(params, client, config, signal);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
    }

    // Format output
    const format = (params['format'] as string | undefined) ?? 'table';
    let output: string;

    if (format === 'json') {
      output = JSON.stringify(result, null, 2);
    } else if (format === 'compact') {
      output = formatCompact(result);
    } else {
      output = formatTable(result);
    }

    // Add quota info
    const quota = client.getQuotaInfo();
    output += `\n---\n**API Quota:** ${quota.remaining}/${quota.max} remaining\n`;

    return {
      content: [{ type: 'text', text: output }],
      details: {
        quota,
        command,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Stack Exchange error: ${message}`, 'error');
    return {
      content: [{ type: 'text', text: `❌ Stack Exchange error: ${message}` }],
      details: {
        quota: client.getQuotaInfo(),
        command,
      },
    };
  }
}

/**
 * Execute search command
 */
async function executeSearch(
  params: Record<string, unknown>,
  client: StackExchangeClient,
  config: StackExchangeConfig,
  signal?: AbortSignal,
): Promise<Question[]> {
  const query = params['query'] as string | undefined;
  const site = (params['site'] as string | undefined) ?? config.defaultSite;
  const limit = Math.min((params['limit'] as number | undefined) ?? 10, 100);
  const tagsInput = params['tags'] as string | null;
  // Convert tags: "tag1,tag2" is converted to semicolon-separated for API
  const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(t => t.length > 0).join(';') : undefined;

  // Build query parameters
  const queryParams = {
    order: 'desc' as const,
    sort: 'relevance' as const,
    q: query ?? undefined,
    tagged: tags ?? undefined,
    pagesize: limit,
    site,
  };

  const searchParams = buildSearchQuery(queryParams);

  // Make request
  const response = await client.request<Question>(
    { method: 'GET', endpoint: '/search/advanced', params: searchParams },
    signal,
  );

  return response.items;
}

/**
 * Execute get command (get question by ID)
 */
async function executeGet(
  params: Record<string, unknown>,
  client: StackExchangeClient,
  config: StackExchangeConfig,
  signal?: AbortSignal,
): Promise<{ question: Question; answers: Answer[] }> {
  const id = params['id'] as string | number | undefined;
  const site = (params['site'] as string | undefined) ?? config.defaultSite;

  if (id === undefined) {
    throw new Error('ID parameter is required for get command');
  }

  // Get question with full body
  const questionParams = buildQuestionsQuery({
    ids: id,
    site,
    filter: Filters.WITH_BODY,
  });

  const response = await client.request<Question>(
    { method: 'GET', endpoint: `/questions/${id}`, params: questionParams },
    signal,
  );

  if (response.items.length === 0) {
    throw new Error(`Question not found: ${id}`);
  }

  const question = response.items[0];
  if (question === undefined) {
    throw new Error('Question not found');
  }

  // Always get answers
  const answersParams = buildQuestionsQuery({
    ids: id,
    site,
    filter: Filters.ANSWERS_WITH_BODY,
  });

  const answersResponse = await client.request<Answer>(
    { method: 'GET', endpoint: `/questions/${id}/answers`, params: answersParams },
    signal,
  );

  return { question, answers: answersResponse.items };
}

/**
 * Execute user command
 */
async function executeUser(
  params: Record<string, unknown>,
  client: StackExchangeClient,
  config: StackExchangeConfig,
  signal?: AbortSignal,
): Promise<User[]> {
  const id = params['id'] as string | number | undefined;
  const site = (params['site'] as string | undefined) ?? config.defaultSite;
  const limit = Math.min((params['limit'] as number | undefined) ?? 1, 100);

  if (id === undefined) {
    throw new Error('ID parameter is required for user command');
  }

  const userParams = buildUserQuery({
    ids: id,
    site,
    pagesize: limit,
  });

  const response = await client.request<User>(
    { method: 'GET', endpoint: `/users/${id}`, params: userParams },
    signal,
  );

  if (response.items.length === 0) {
    throw new Error(`User not found: ${id}`);
  }

  return response.items;
}

/**
 * Execute site command
 */
async function executeSite(
  _params: Record<string, unknown>,
  client: StackExchangeClient,
  _config: StackExchangeConfig,
  signal?: AbortSignal,
): Promise<Site[]> {
  const sitesParams = buildSitesQuery({ pagesize: 100 });

  const response = await client.request<Site>(
    { method: 'GET', endpoint: '/sites', params: sitesParams },
    signal,
  );

  return response.items;
}

/**
 * Format results as table
 */
function formatTable(result: unknown): string {
  if (Array.isArray(result)) {
    const first = result[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object') {
      if ('badge_counts' in first) {
        // Users
        return formatUsersTable(result as User[]);
      }
      if ('api_site_parameter' in first) {
        // Sites
        return formatSitesTable(result as Site[]);
      }
      if ('question_id' in first || 'answer_id' in first) {
        // Questions or Answers
        if ('answer_id' in first) {
          return formatAnswersTable(result as Answer[]);
        }
        return formatQuestionsTable(result as Question[]);
      }
    }
  } else if (typeof result === 'object' && result !== null) {
    if ('question' in result && 'answers' in result) {
      // Question with answers
      const r = result as { question: Question; answers: Answer[] };
      let output = formatQuestionsTable([r.question]);
      if (r.answers.length > 0) {
        output += `\n${  formatAnswersTable(r.answers)}`;
      }
      return output;
    }
  }

  // Fallback to JSON
  return JSON.stringify(result, null, 2);
}

/**
 * Format results as compact
 */
function formatCompact(result: unknown): string {
  if (Array.isArray(result)) {
    const first = result[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object') {
      if ('badge_counts' in first) {
        return formatUsersCompact(result as User[]);
      }
      if ('api_site_parameter' in first) {
        return formatSitesCompact(result as Site[]);
      }
      if ('question_id' in first) {
        return formatCompactQuestions(result as Question[]);
      }
    }
  }
  return JSON.stringify(result);
}
