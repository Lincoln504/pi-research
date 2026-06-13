/**
 * Simplified migration system for Knowledge Store.
 *
 * For a local research tool, we only need 3 strategies:
 * - 'drop': Recreate table (fast, simple, data loss)
 * - 're-embed': Preserve data by re-embedding with new model
 * - 'backup': Rename old data and start fresh (safe, no data loss)
 */

export type MigrationStrategy = 'drop' | 're-embed' | 'backup';

export interface MigrationResult {
  strategy: MigrationStrategy;
  success: boolean;
  documentsProcessed: number;
  error?: string;
}
