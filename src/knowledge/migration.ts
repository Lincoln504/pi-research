/**
 * Simplified migration system for Knowledge Store.
 *
 * For a local research tool, we only need 2 strategies:
 * - 'drop': Recreate table (fast, simple, data loss)
 * - 're-embed': Preserve data by re-embedding with new model
 */

export type MigrationStrategy = 'drop' | 're-embed';

export interface MigrationResult {
  strategy: MigrationStrategy;
  success: boolean;
  documentsProcessed: number;
  error?: string;
}

export const VALID_MIGRATION_STRATEGIES: MigrationStrategy[] = ['drop', 're-embed'];