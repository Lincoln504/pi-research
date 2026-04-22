
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createResearchTool: vi.fn(() => ({ name: 'research' })),
}));

vi.mock('../../src/tool.ts', () => ({
  createResearchTool: mocks.createResearchTool,
}));

vi.mock('../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => 'MOCK_USAGE_PROMPT'),
}));

import { activate } from '../../src/index.ts';

type SessionHandler = (...args: any[]) => any;

function createPiMock() {
  const handlers = new Map<string, SessionHandler>();

  return {
    handlers,
    pi: {
      on: vi.fn((event: string, handler: SessionHandler) => {
        handlers.set(event, handler);
      }),
      registerTool: vi.fn(),
    },
  };
}

describe('extension entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers research tool', async () => {
    const { pi } = createPiMock();

    await activate(pi as any, {} as any);

    expect(mocks.createResearchTool).toHaveBeenCalledTimes(1);
    expect(pi.registerTool).toHaveBeenCalledWith({ name: 'research' });
  });

  it('augments system prompt during before_agent_start', async () => {
    const { pi, handlers } = createPiMock();
    await activate(pi as any, {} as any);

    const event = { systemPrompt: 'ORIGINAL' };
    const result = await handlers.get('before_agent_start')?.(event);

    expect(result.systemPrompt).toContain('ORIGINAL');
    expect(result.systemPrompt).toContain('MOCK_USAGE_PROMPT');
  });
});
