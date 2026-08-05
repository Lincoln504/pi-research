import { beforeAll, afterAll, beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
// Real fs (the vi.mock below only replaces readFileSync; the spread keeps the rest).
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockExecute = vi.fn<() => Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }>>();

const mocks = vi.hoisted(() => ({
  createResearchTool: vi.fn(() => ({
    name: 'research',
    execute: mockExecute,
    description: 'Perform web/internet research using an internal multi-source system.',
  })),
  createHealthTool: vi.fn(() => ({
    name: 'health',
    execute: mockExecute,
    description: 'Check system health',
  })),
  randomUUID: vi.fn(() => 'mock-uuid-123'),
}));

vi.mock('node:crypto', () => ({
  randomUUID: mocks.randomUUID,
}));

vi.mock('../../src/tool.ts', () => ({
  createResearchTool: mocks.createResearchTool,
  createHealthTool: mocks.createHealthTool,
}));

// The knowledge-search tool backs `/knowledge-store <query>`. Mock its factory so
// the command path is hermetic (no native vector stack) and assertable. The execute
// spy is created via vi.hoisted so the hoisted vi.mock factory can reference it.
const { mockKnowledgeExecute } = vi.hoisted(() => ({ mockKnowledgeExecute: vi.fn() }));
vi.mock('../../src/tools/research-knowledge-search.ts', () => ({
  createResearchKnowledgeSearchTool: vi.fn(() => ({
    name: 'research_knowledge_search',
    execute: mockKnowledgeExecute,
    description: 'Search the research knowledge store',
  })),
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

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  readFileSync: vi.fn(() => 'MOCK_USAGE_PROMPT'),
}));

import activate from '../../src/index.ts';
import { resetServiceContainer } from '../../src/core/service-registry.ts';

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
      registerShortcut: vi.fn(),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signal: undefined,
    mode: 'tui',
    hasUI: true,
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

describe('extension entrypoint', () => {
  // Insurance against real-HOME mutation: activate() runs reconcileSkillInstalls(),
  // and today only the file-wide node:fs mock (readFileSync → 'MOCK_USAGE_PROMPT'
  // breaks readManifest's JSON.parse) keeps it away from the developer's real
  // skill links — existsSync/unlinkSync/symlinkSync/rmSync stay REAL. Pin HOME
  // (and USERPROFILE for Windows) to a throwaway dir so a future narrowing of
  // that mock can never reach ~/.pi/research/installed-skills.json or
  // ~/.claude/skills/….
  let tmpHome: string;
  let realHome: string | undefined;
  let realUserProfile: string | undefined;

  beforeAll(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'pi-index-home-'));
    realHome = process.env['HOME'];
    realUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
  });

  afterAll(() => {
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
    if (realUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = realUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Reset service container after each test to ensure clean state. MUST be awaited:
    // a fire-and-forget reset can overlap the next test and (before the container
    // learned to wait out an in-flight disposal) surfaced as unhandled
    // "Cannot reset container while disposing" rejections on the Windows CI leg.
    await resetServiceContainer();
  });

  it('registers research tool', async () => {
    const { pi } = createPiMock();
    await activate(pi as any);

    expect(mocks.createResearchTool).toHaveBeenCalledTimes(1);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'research', execute: expect.any(Function) }),
    );
  });

  it('augments system prompt during before_agent_start when research tool available', async () => {
    const { pi, handlers } = createPiMock();
    await activate(pi as any);

    const event = { systemPrompt: 'ORIGINAL', prompt: 'research something' };
    const result = await handlers.get('before_agent_start')?.(event, {});

    expect(result.systemPrompt).toContain('ORIGINAL');
    expect(result.systemPrompt).toContain('MOCK_USAGE_PROMPT');
  });

  it('does not augment system prompt if research tool is not available', async () => {
    const { pi, handlers } = createPiMock();
    await activate(pi as any);

    // Explicitly exclude research tool from selected tools
    const event = { 
      systemPrompt: 'ORIGINAL', 
      prompt: 'research something',
      systemPromptOptions: { selectedTools: ['bash'] } 
    };
    const result = await handlers.get('before_agent_start')?.(event, {});

    expect(result.systemPrompt).toBe('ORIGINAL');
    expect(result.systemPrompt).not.toContain('MOCK_USAGE_PROMPT');
  });

  it('does NOT append steering to researcher sub-agent prompts (executor copy is authoritative)', async () => {
    // Regression: every researcher received each steering message TWICE — once from
    // the executor/quick-orchestrator system-prompt injection ("ADDITIONAL USER
    // GUIDANCE") and once more from this hook ("ADDITIONAL CONSIDERATIONS").
    const { addSteeringMessage, registerSessionPanel, clearAllSessionState } =
      await import('../../src/orchestration/session-state.ts');
    const { pi, handlers } = createPiMock();
    await activate(pi as any);

    try {
      // Make steering visible to the hook: a queued message + one active research run.
      addSteeringMessage(undefined, 'focus on X');
      registerSessionPanel(undefined, 'run-1', {} as any);

      const researcherEvent = { systemPrompt: 'RESEARCHER_AGENT_MARKER body', prompt: 'go' };
      const researcherResult = await handlers.get('before_agent_start')?.(researcherEvent, {});
      expect(researcherResult.systemPrompt).toBe('RESEARCHER_AGENT_MARKER body');
      expect(researcherResult.systemPrompt).not.toContain('ADDITIONAL CONSIDERATIONS');

      // Sanity: the HOST agent (non-researcher) still gets the steering injection.
      const hostEvent = {
        systemPrompt: 'ORIGINAL',
        prompt: 'go',
        systemPromptOptions: { selectedTools: ['bash'] },
      };
      const hostResult = await handlers.get('before_agent_start')?.(hostEvent, {});
      expect(hostResult.systemPrompt).toContain('ADDITIONAL CONSIDERATIONS');
      expect(hostResult.systemPrompt).toContain('focus on X');
    } finally {
      clearAllSessionState();
    }
  });

  describe('/research slash command', () => {
    it('registers the research command', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any);

      expect(pi.registerCommand).toHaveBeenCalledWith(
        'research',
        expect.objectContaining({ handler: expect.any(Function) }),
      );
      expect(commands.has('research')).toBe(true);
    });

    it('directly invokes the research tool and sends result to chat', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any);

      mockExecute.mockResolvedValueOnce({
        content: [{ type: 'text', text: '## Research Result\n\nFound interesting data.' }],
        details: { totalTokens: 1234 },
      });

      const ctx = makeCtx();
      await commands.get('research')!.handler('what is typescript', ctx);

      expect(mockExecute).toHaveBeenCalledWith(
        'mock-uuid-123',
        { query: 'what is typescript', depth: 1 },
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
      await activate(pi as any);

      mockExecute.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Done' }],
        details: { totalTokens: 0 },
      });

      const notify = vi.fn();
      const ctx = makeCtx({ ui: { notify } });
      await commands.get('research')!.handler('test query', ctx);

      expect(notify).toHaveBeenCalledWith('Research finished.', 'info');
    });

    it('does nothing when called with empty args', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any);

      const ctx = makeCtx();
      await commands.get('research')!.handler('   ', ctx);

      expect(mockExecute).not.toHaveBeenCalled();
      expect(pi.sendMessage).not.toHaveBeenCalled();
    });

    it('handles tool execution errors gracefully', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any);

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
        expect.stringContaining('Research failed'),
        'error',
      );
    });

    it('handles non-Error throws gracefully', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any);

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
      await activate(pi as any);

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

  describe('/knowledge-store slash command', () => {
    it('ignores an empty/whitespace query — no search, no message', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any);

      await commands.get('knowledge-store')!.handler('   ', makeCtx());

      expect(mockKnowledgeExecute).not.toHaveBeenCalled();
      expect(pi.sendMessage).not.toHaveBeenCalled();
    });

    it('searches the knowledge store for a query and delivers the result', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any);

      mockKnowledgeExecute.mockResolvedValueOnce({
        content: [{ type: 'text', text: '## From knowledge store\n\nPreviously researched.' }],
        details: { researchId: 'k1' },
      });

      const ctx = makeCtx();
      await commands.get('knowledge-store')!.handler('what is typescript', ctx);

      expect(mockKnowledgeExecute).toHaveBeenCalledWith(
        'mock-uuid-123',
        { queries: ['what is typescript'] },
        undefined,
        undefined,
        expect.any(Object),
      );
      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: 'knowledge-store',
          content: '## From knowledge store\n\nPreviously researched.',
          display: true,
        }),
      );
    });

    it('reports a search failure to chat', async () => {
      const { pi, commands } = createPiMock();
      await activate(pi as any);

      mockKnowledgeExecute.mockRejectedValueOnce(new Error('store exploded'));

      const ctx = makeCtx();
      await commands.get('knowledge-store')!.handler('boom', ctx);

      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: 'knowledge-store',
          details: { error: 'store exploded' },
        }),
      );
    });
  });
});
