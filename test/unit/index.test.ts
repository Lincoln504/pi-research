import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecute = vi.fn<() => Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }>>();

const mocks = vi.hoisted(() => ({
  createResearchTool: vi.fn(() => ({
    name: 'research',
    execute: mockExecute,
    description: 'Perform deep research using a coordinated team of agents.',
  })),
  randomUUID: vi.fn(() => 'mock-uuid-123'),
}));

vi.mock('node:crypto', () => ({
  randomUUID: mocks.randomUUID,
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
  },
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => 'MOCK_USAGE_PROMPT'),
}));

import activate from '../../src/index.ts';

type CommandHandler = (args: string, ctx: Record<string, unknown>) => Promise<void>;

function createPiMock() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { description?: string; handler: CommandHandler }>();

  return {
    handlers,
    commands,
    pi: {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        handlers.set(event, handler);
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, opts: { description?: string; handler: CommandHandler }) => {
        commands.set(name, opts);
      }),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signal: undefined,
    ui: { notify: vi.fn() },
    ...overrides,
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
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'research', execute: expect.any(Function) }),
    );
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

      expect(pi.registerCommand).toHaveBeenCalledWith(
        'research',
        expect.objectContaining({ handler: expect.any(Function) }),
      );
      expect(commands.has('research')).toBe(true);
    });

    it('directly invokes the research tool and sends result to chat', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      mockExecute.mockResolvedValueOnce({
        content: [{ type: 'text', text: '## Research Result\n\nFound interesting data.' }],
        details: { totalTokens: 1234 },
      });

      const ctx = makeCtx();
      await commands.get('research')!.handler('what is typescript', ctx);

      expect(mockExecute).toHaveBeenCalledWith(
        'mock-uuid-123',
        { query: 'what is typescript' },
        undefined,
        undefined,
        expect.any(Object),
      );

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: 'research-result',
          content: '## Research Result\n\nFound interesting data.',
          display: true,
          details: { totalTokens: 1234 },
        }),
      );
    });

    it('shows a success notification after completion', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      mockExecute.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Done' }],
        details: { totalTokens: 0 },
      });

      const notify = vi.fn();
      const ctx = makeCtx({ ui: { notify } });
      await commands.get('research')!.handler('test query', ctx);

      expect(notify).toHaveBeenCalledWith('✅ Research complete', 'info');
    });

    it('does nothing when called with empty args', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      const ctx = makeCtx();
      await commands.get('research')!.handler('   ', ctx);

      expect(mockExecute).not.toHaveBeenCalled();
      expect(pi.sendMessage).not.toHaveBeenCalled();
    });

    it('handles tool execution errors gracefully', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      mockExecute.mockRejectedValueOnce(new Error('Model API rate limit (429)'));

      const notify = vi.fn();
      const ctx = makeCtx({ ui: { notify } });
      await commands.get('research')!.handler('broken query', ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: 'research-result',
          content: expect.stringContaining('**Research failed**'),
          details: { error: 'Model API rate limit (429)' },
        }),
      );

      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('❌ Research failed'),
        'error',
      );
    });

    it('handles non-Error throws gracefully', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      mockExecute.mockRejectedValueOnce('string error');

      const notify = vi.fn();
      const ctx = makeCtx({ ui: { notify } });
      await commands.get('research')!.handler('fail', ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('string error'),
        }),
      );
    });

    it('sends the error details correctly when research fails', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any, {} as any);

      mockExecute.mockRejectedValueOnce(new Error('Rate limited'));

      const ctx = makeCtx();
      await commands.get('research')!.handler('test', ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: 'research-result',
          details: { error: 'Rate limited' },
        }),
      );
    });
  });
});
