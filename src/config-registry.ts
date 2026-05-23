/**
 * Config Registry for Research Configuration
 *
 * Central registry for research config commands and routing
 */

export type MenuSection = 'main' | 'health' | 'errors' | 'knowledge' | 'settings' | 'metrics';

export interface MenuItem {
  id: string;
  label: string;
  description: string;
  action?: () => Promise<void> | void;
  submenu?: MenuSection;
  hidden?: () => boolean;
}

export interface CommandArgs {
  section?: string;
  action?: string;
  params?: string[];
}

/**
 * Parse command arguments into section, action, and params
 */
export function parseCommandArgs(args: string): CommandArgs {
  const parts = args.trim().split(/\s+/).filter(p => p);
  if (parts.length === 0) {
    return {};
  }

  return {
    section: parts[0],
    action: parts[1],
    params: parts.slice(2),
  };
}

/**
 * Known sections for routing
 */
export const KNOWN_SECTIONS = ['health', 'errors', 'knowledge', 'settings', 'metrics'] as const;

/**
 * Backward compatibility command map
 */
export interface CommandMap {
  [key: string]: () => Promise<void>;
}

export function createBackwardCompatibilityMap(
  context: any,
  pi: any,
  healthModule: any,
  errorsModule: any,
  knowledgeModule: any
): CommandMap {
  return {
    'health-clear': () => {
      healthModule.clearHealthCache(context);
      return Promise.resolve();
    },
    'health-history': () => {
      healthModule.showHealthHistory(context, pi);
      return Promise.resolve();
    },
    'errors-clear': () => {
      errorsModule.clearErrorHistory(context);
      return Promise.resolve();
    },
    'errors-export': () => {
      errorsModule.exportErrorReport(undefined, context);
      return Promise.resolve();
    },
    'knowledge-migrate': () => {
      knowledgeModule.handleKnowledgeMigration(undefined, context);
      return Promise.resolve();
    },
  };
}