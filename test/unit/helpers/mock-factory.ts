import { vi } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
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
export function createMockModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider: 'openai',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    ...overrides,
  } as Model<Api>;
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
