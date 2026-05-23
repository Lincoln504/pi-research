export type MigrationStrategy = 'drop' | 're-embed' | 'continue' | 'error';

export interface MigrationResult {
  strategy: MigrationStrategy;
  success: boolean;
  documentsProcessed: number;
  error?: string;
}

export interface ModelCompatibility {
  isCompatible: boolean;
  reason?: string;
  oldDimension?: number;
  newDimension?: number;
}

export const VALID_MIGRATION_STRATEGIES: MigrationStrategy[] = ['drop', 're-embed', 'continue', 'error'];