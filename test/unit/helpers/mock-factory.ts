import { vi } from 'vitest';
import type { ExtensionContext } from '../../../src/types/extension-context.ts';
import type { Model } from '../../../src/types/llm.ts';
import { ToolUsageTracker } from '../../../src/utils/tool-usage-tracker.ts';

/**
 * Creates a mock ExtensionContext for unit tests.
 */
export function createMockExtensionContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: '/tmp',
    model: createMockModel(),
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
    } as any,
    ui: {
      setWidget: vi.fn(),
    } as any,
    settingsManager: {
        get: vi.fn(),
        set: vi.fn(),
    } as any,
    ...overrides,
  } as ExtensionContext;
}

/**
 * Creates a mock Model for unit tests.
 */
export function createMockModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider: 'openai',
    ...overrides,
  };
}

/**
 * Creates a mock ToolUsageTracker for unit tests.
 */
export function createMockToolUsageTracker(limits: Record<string, number> = {}): ToolUsageTracker {
  return new ToolUsageTracker(limits);
}

/**
 * Mock for the logger module.
 */
export const mockLogger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/**
 * Mock for PI AI complete/completeSimple.
 */
export const mockAi = {
  complete: vi.fn(),
  completeSimple: vi.fn(),
};
