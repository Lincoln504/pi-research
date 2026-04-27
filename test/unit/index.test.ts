
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

import activate from '../../src/index.ts';

type SessionHandler = (...args: any[]) => any;

function createPiMock() {
  const handlers = new Map<string, SessionHandler>();
  const commands = new Map<string, { description?: string; handler: SessionHandler }>();

  return {
    handlers,
    commands,
    pi: {
      on: vi.fn((event: string, handler: SessionHandler) => {
        handlers.set(event, handler);
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, opts: { description?: string; handler: SessionHandler }) => {
        commands.set(name, opts);
      }),
      sendUserMessage: vi.fn(),
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

  describe('/research slash command', () => {
    it('registers the research command', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      expect(pi.registerCommand).toHaveBeenCalledWith('research', expect.objectContaining({ handler: expect.any(Function) }));
      expect(commands.has('research')).toBe(true);
    });

    it('sends a quick research message for a plain query', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      await commands.get('research')!.handler('what is typescript');

      expect(pi.sendUserMessage).toHaveBeenCalledWith('Research: what is typescript');
    });

    it('sends a deep research message when --deep flag is present', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      await commands.get('research')!.handler('--deep distributed systems');

      expect(pi.sendUserMessage).toHaveBeenCalledWith('Deep research: distributed systems');
    });

    it('handles the -d short flag for deep research', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      await commands.get('research')!.handler('-d memory safety in rust');

      expect(pi.sendUserMessage).toHaveBeenCalledWith('Deep research: memory safety in rust');
    });

    it('strips the flag whether at start, middle, or end of args', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      await commands.get('research')!.handler('query text --deep');
      expect(pi.sendUserMessage).toHaveBeenCalledWith('Deep research: query text');
    });

    it('does nothing when called with empty args', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      await commands.get('research')!.handler('   ');
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    });

    it('does nothing when only the flag is given with no query', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      await commands.get('research')!.handler('--deep');
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    });
  });
});
