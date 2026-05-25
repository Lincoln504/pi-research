/**
 * Knowledge Command Module
 *
 * Handles knowledge store commands:
 * - View knowledge store status
 * - View entry count
 * - Migrate knowledge store
 * - Clear knowledge store
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { logger } from '../logger.ts';
import { getConfig, getDbDir } from '../config.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import { KnowledgeStoreService } from '../infrastructure/knowledge-store-service.ts';

export interface CommandContext {
  ui: {
    notify: (message: string, type: string) => void;
  };
}

/**
 * Handle knowledge-related actions
 */
export async function handleKnowledgeAction(
  action: string | undefined,
  _params: string[],
  ctx: CommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
  
  switch (action) {
    case 'status':
    case undefined:
      await showKnowledgeStatus(ctx, pi);
      break;
    case 'migrate':
      await handleKnowledgeMigration(_params[0], ctx);
      break;
    case 'clear':
      await service.clear();
      ctx.ui.notify('Knowledge store cleared', 'info');
      break;
    case 'count':
      await showKnowledgeCount(ctx, pi);
      break;
    default:
      ctx.ui.notify(`Unknown knowledge action: ${action}. Use: status, migrate, clear, count`, 'error');
  }
}

/**
 * Display knowledge store status
 */
export async function showKnowledgeStatus(ctx: CommandContext, pi: ExtensionAPI): Promise<void> {
  const config = getConfig();
  const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
  const outputLines: string[] = [];
  
  outputLines.push('## Knowledge Store Status');
  outputLines.push('');
  outputLines.push(`**Enabled:** ${config.KNOWLEDGE_STORE_ENABLED ? 'Yes' : 'No'}`);
  outputLines.push(`**Model:** ${config.EMBEDDING_MODEL}`);
  outputLines.push(`**Device:** ${service.getDevice() || config.EMBEDDING_DEVICE}`);
  outputLines.push(`**Cache TTL:** ${config.KNOWLEDGE_STORE_CACHE_TTL_DAYS} days`);
  outputLines.push('');

  if (config.KNOWLEDGE_STORE_ENABLED) {
    const ready = service.isReady();
    outputLines.push(`**Status:** ${ready ? 'Ready' : 'Not initialized'}`);
    
    if (ready) {
      try {
        const store = await service.getStore();
        const count = await store.count();
        outputLines.push(`**Entries:** ${count}`);
      } catch (_error) {
        outputLines.push(`**Entries:** Error retrieving count`);
      }
    }
  }

  outputLines.push('');
  outputLines.push(`**Database directory:** ${getDbDir()}`);

  pi.sendMessage({
    customType: 'knowledge-status-result',
    content: outputLines.join('\n'),
    display: true,
  });

  ctx.ui.notify('Knowledge store status displayed', 'info');
}

/**
 * Display knowledge store entry count
 */
export async function showKnowledgeCount(ctx: CommandContext, pi: ExtensionAPI): Promise<void> {
  const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
  if (!service.isReady()) {
    ctx.ui.notify('Knowledge store is not ready', 'warning');
    return;
  }

  try {
    const store = await service.getStore();
    const count = await store.count();

    pi.sendMessage({
      customType: 'knowledge-count-result',
      content: `**Knowledge Store Entries:** ${count}`,
      display: true,
      details: { count },
    });

    ctx.ui.notify(`Knowledge store has ${count} entries`, 'info');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to retrieve knowledge store count: ${message}`, 'error');
  }
}

/**
 * Handle knowledge store migration
 */
export async function handleKnowledgeMigration(strategy: string | undefined, ctx: CommandContext): Promise<void> {
  const validStrategies = ['drop', 're-embed', 'continue'];
  
  if (!strategy || !validStrategies.includes(strategy)) {
    ctx.ui.notify(`Usage: /research-config knowledge migrate <${validStrategies.join('|')}>`, 'error');
    return;
  }
  
  ctx.ui.notify(`Starting knowledge store migration with strategy: ${strategy}...`, 'info');
  
  try {
    process.env['PI_KNOWLEDGE_STORE_MIGRATION_STRATEGY'] = strategy;
    
    const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
    await service.dispose();
    await service.initialize();
    
    delete process.env['PI_KNOWLEDGE_STORE_MIGRATION_STRATEGY'];
    
    ctx.ui.notify(`Knowledge store migration complete: ${strategy}`, 'info');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[pi-research] Knowledge store migration failed:', error);
    ctx.ui.notify(`❌ Migration failed: ${message}`, 'error');
  }
}
