/**
 * researcher (session factory) Unit Tests
 *
 * Covers the post-create tail of createResearcherSession: once createAgentSession
 * has returned, the session is LIVE but not yet owned by any cleanup machinery —
 * a throw between creation and return must abort it before rethrowing, or it
 * leaks unaborted for the life of the process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearcherSession } from '../../../src/orchestration/researcher.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockCreateAgentSession } = vi.hoisted(() => ({
  mockCreateAgentSession: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/tools/index.ts', () => ({
  createResearchTools: vi.fn(() => []),
}));

vi.mock('../../../src/utils/make-resource-loader.ts', () => ({
  makeResourceLoader: vi.fn(() => ({})),
}));

vi.mock('../../../src/utils/tool-usage-tracker.ts', () => ({
  // `new`-ed in the factory — must be constructible, so a class, not an arrow fn.
  ToolUsageTracker: class MockToolUsageTracker {},
  createDefaultToolLimits: vi.fn(() => ({})),
}));

vi.mock('../../../src/core/llm/research-model-resolver.ts', () => ({
  resolveResearchModel: vi.fn(() => ({ id: 'test-model', provider: 'test-provider', contextWindow: 100_000 })),
}));

vi.mock('../../../src/core/llm/model-registry-factory.ts', () => ({
  getRuntimeForRegistry: vi.fn(() => undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'print',
    hasUI: true,
    ui: { setHiddenThinkingLabel: vi.fn() },
    ...overrides,
  } as any;
}

function baseOptions(extensionCtx: any) {
  return {
    cwd: '/tmp',
    ctxModel: { id: 'test-model' } as any,
    modelRegistry: {} as any,
    systemPrompt: 'researcher system prompt',
    extensionCtx,
    researcherId: '1.1',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createResearcherSession', () => {
  beforeEach(() => {
    mockCreateAgentSession.mockReset();
  });

  it('returns the created session and does not abort it on the success path', async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    mockCreateAgentSession.mockResolvedValue({ session: { abort } });

    const { session } = await createResearcherSession(baseOptions(makeCtx()));

    expect(session).toBeDefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it('clamps the session model max_tokens to RESEARCHER_MAX_TOKENS', async () => {
    // Regression: the session sends model.maxTokens as the per-request max_tokens,
    // so a ~230k catalog ceiling reached the provider verbatim — OpenRouter
    // budget-checks it against remaining credits and 402'd every researcher call
    // on a low balance ("You requested up to 231037 tokens").
    const { resolveResearchModel } = await import('../../../src/core/llm/research-model-resolver.ts');
    vi.mocked(resolveResearchModel).mockReturnValueOnce(
      { id: 'big-model', provider: 'openrouter', contextWindow: 262_144, maxTokens: 231_072 } as any);
    mockCreateAgentSession.mockResolvedValue({ session: { abort: vi.fn() } });

    const { resolvedModel } = await createResearcherSession(baseOptions(makeCtx()));

    const passed = mockCreateAgentSession.mock.calls[0]![0] as any;
    expect(passed.model.maxTokens).toBe(16_384);
    // The clamped copy is what usage/cost extraction sees too.
    expect((resolvedModel as any).maxTokens).toBe(16_384);
  });

  it('leaves a model already at or under the cap untouched', async () => {
    const { resolveResearchModel } = await import('../../../src/core/llm/research-model-resolver.ts');
    const small = { id: 'small-model', provider: 'p', contextWindow: 32_768, maxTokens: 8_192 } as any;
    vi.mocked(resolveResearchModel).mockReturnValueOnce(small);
    mockCreateAgentSession.mockResolvedValue({ session: { abort: vi.fn() } });

    await createResearcherSession(baseOptions(makeCtx()));

    const passed = mockCreateAgentSession.mock.calls[0]![0] as any;
    expect(passed.model).toBe(small);
  });

  it('honors a config-level RESEARCHER_MAX_TOKENS override', async () => {
    const { resolveResearchModel } = await import('../../../src/core/llm/research-model-resolver.ts');
    vi.mocked(resolveResearchModel).mockReturnValueOnce(
      { id: 'big-model', provider: 'openrouter', contextWindow: 262_144, maxTokens: 231_072 } as any);
    mockCreateAgentSession.mockResolvedValue({ session: { abort: vi.fn() } });

    await createResearcherSession({
      ...baseOptions(makeCtx()),
      config: { RESEARCHER_MAX_TOKENS: 32_768 } as any,
    });

    const passed = mockCreateAgentSession.mock.calls[0]![0] as any;
    expect(passed.model.maxTokens).toBe(32_768);
  });

  it('aborts the never-returned session when the post-create tail throws (host UI callback)', async () => {
    // Regression: a throw from ctx.ui.setHiddenThinkingLabel AFTER
    // createAgentSession succeeded rethrew without aborting the session — the
    // caller never received it, so no finally/cleanup path could ever reach it.
    const abort = vi.fn().mockResolvedValue(undefined);
    mockCreateAgentSession.mockResolvedValue({ session: { abort } });
    const ctx = makeCtx({
      ui: { setHiddenThinkingLabel: vi.fn(() => { throw new Error('host UI exploded'); }) },
    });

    await expect(createResearcherSession(baseOptions(ctx))).rejects.toThrow('host UI exploded');
    expect(abort).toHaveBeenCalled();
  });

  it('still rejects (with the abort swallowed) when the leaked-session abort itself fails', async () => {
    const abort = vi.fn().mockRejectedValue(new Error('abort failed'));
    mockCreateAgentSession.mockResolvedValue({ session: { abort } });
    const ctx = makeCtx({
      ui: { setHiddenThinkingLabel: vi.fn(() => { throw new Error('host UI exploded'); }) },
    });

    // The ORIGINAL tail error must surface, not the best-effort abort's failure.
    await expect(createResearcherSession(baseOptions(ctx))).rejects.toThrow('host UI exploded');
    expect(abort).toHaveBeenCalled();
  });
});
