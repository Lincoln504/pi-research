/**
 * The quick path renders the same researcher template as the deep path, and must
 * substitute every placeholder in it.
 *
 * `src/prompts/researcher.md` has TWO callers — `researcher-executor` (depth 1+) and
 * `QuickResearchOrchestrator` (depth 0) — each with its own independent chain of
 * `.replace('{{...}}', ...)` calls. Nothing links the two, and `populatePrompt`-style
 * substitution fails silently: an unhandled placeholder is not an error, it is literal
 * `{{braces}}` shipped to the model as an instruction it cannot act on.
 *
 * That is not hypothetical. `{{digest_section}}` was added to the template for the
 * router protocol and had to be wired into both callers separately; the quick path
 * deliberately substitutes it with EMPTY (it has no research lead, no next round, and
 * its report goes straight to the user) — which is a substitution, not an omission, and
 * the difference is invisible without a test that reads the shipped file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL = 'stop-after-prompt-render';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn(), setGauge: vi.fn(), measure: vi.fn(), session: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() } },
}));

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async () => undefined),
  tryGetServiceContainerFromCtx: vi.fn(() => ({ isReady: true })),
}));

vi.mock('../../../src/healthcheck/index.ts', () => ({
  runHealthCheck: vi.fn(async () => ({ success: true, components: [] })),
  isBusyPoolHealthFailure: vi.fn(() => false),
}));

// Identity so the assertion sees the template's own text rather than a dated preamble.
vi.mock('../../../src/core/llm/inject-date.ts', () => ({
  injectCurrentDate: vi.fn((t: string) => t),
}));

// The capture point: the prompt is fully rendered by the time this is called, so
// throwing here ends the run without needing a whole session lifecycle stubbed out.
const createResearcherSession = vi.fn(async (): Promise<any> => { throw new Error(SENTINEL); });
vi.mock('../../../src/orchestration/researcher.ts', () => ({
  createResearcherSession: (...args: unknown[]) => createResearcherSession(...(args as [])),
}));

import { QuickResearchOrchestrator } from '../../../src/orchestration/quick-research-orchestrator.ts';
import { getConfig } from '../../../src/config.ts';

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '../../../src/prompts/researcher.md',
);
const PLACEHOLDER = /\{\{[a-z_0-9]+\}\}/gi;

async function renderQuickPrompt(): Promise<string> {
  const orchestrator = new QuickResearchOrchestrator({
    ctx: { cwd: '/test/cwd' } as any,
    model: { id: 'test-model', contextWindow: 128_000 } as any,
    query: 'what is a coverage digest',
    sessionId: 'quick-prompt-session',
    researchId: 'quick-prompt-research',
    // 'none' keeps LanceDB out of a unit test; the store section is then empty, which is
    // still a substitution and still has to happen.
    config: { ...getConfig('/test/cwd'), KNOWLEDGE_STORE_MODE: 'none' } as any,
  });

  await expect(orchestrator.run()).rejects.toThrow();

  const call = createResearcherSession.mock.calls.at(-1) as unknown as [{ systemPrompt: string }];
  expect(call, 'createResearcherSession was never reached — the prompt was not rendered').toBeDefined();
  return call[0].systemPrompt;
}

describe('quick research renders the shipped researcher template', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves no placeholder behind', async () => {
    const real = readFileSync(PROMPT_PATH, 'utf-8');
    expect(real.match(PLACEHOLDER)?.length ?? 0).toBeGreaterThan(0); // it really is a template

    const prompt = await renderQuickPrompt();

    expect(prompt.match(PLACEHOLDER) ?? []).toEqual([]);
  });

  it('asks for no coverage digest — there is no research lead to read one', async () => {
    // Not an oversight to be "fixed" later: quick research has no router and no second
    // round, and its report IS the deliverable. Asking for routing metadata here would
    // spend output tokens on a reader that does not exist, tell the model about a
    // "research lead" that is not part of its run, and put a COVERAGE DIGEST block at the
    // head of the document the user reads.
    const prompt = await renderQuickPrompt();

    expect(prompt).not.toContain('COVERAGE DIGEST');
    expect(prompt).not.toContain('research lead');
  });

  it('still substitutes the values the quick path does supply, and keeps per-run data OUT', async () => {
    // Guards the inverse failure of the two above: a chain that replaced everything with
    // '' would satisfy "no placeholder left behind" while shipping an empty prompt.
    const prompt = await renderQuickPrompt();

    expect(prompt).toContain('Round 1 only');                 // {{extra_tool_guidelines}}
    // Prompt-cache prefix invariance: the goal is per-run data and belongs in the
    // initial USER message, never the system prompt — any per-run byte here would
    // bust the cacheable system+tools prefix across back-to-back quick runs.
    expect(prompt).not.toContain('what is a coverage digest');
  });

  it('tells the model to open with the report rather than narrate its way into one', async () => {
    // Observed in a live quick run: the delivered document opened with "I have gathered
    // extensive material… Let me now synthesize my findings into a comprehensive report."
    // Quick mode has no synthesis step to strip that, so it reached the reader verbatim.
    const prompt = await renderQuickPrompt();

    expect(prompt).toContain('No preamble');
    expect(prompt).toContain('no narration of what you are about to do');
  });

  it('delivers the goal and quick-mode workflow instructions in the initial USER message', async () => {
    // The capture point moves one step later than renderQuickPrompt's: the session is
    // created successfully and session.prompt() (the user message) throws instead.
    const captured: string[] = [];
    createResearcherSession.mockImplementationOnce(async () => ({
      session: {
        prompt: vi.fn(async (msg: string) => { captured.push(msg); throw new Error(SENTINEL); }),
        abort: vi.fn(async () => {}),
        subscribe: vi.fn(() => vi.fn()),
        steer: vi.fn(async () => {}),
      },
      resolvedModel: { id: 'test-model' },
    }));
    const { getService } = await import('../../../src/core/service-registry.ts');
    const { ServiceNames } = await import('../../../src/core/service-interfaces.ts');
    vi.mocked(getService).mockImplementation(async (name: unknown) => {
      if (name === ServiceNames.RESEARCH_SESSION_SERVICE) {
        return { registerSession: vi.fn(), unregisterSession: vi.fn() } as any;
      }
      return undefined;
    });

    const orchestrator = new QuickResearchOrchestrator({
      ctx: { cwd: '/test/cwd' } as any,
      model: { id: 'test-model', contextWindow: 128_000 } as any,
      query: 'what is a coverage digest',
      sessionId: 'quick-prompt-session',
      researchId: 'quick-prompt-research',
      config: { ...getConfig('/test/cwd'), KNOWLEDGE_STORE_MODE: 'none' } as any,
    });
    await expect(orchestrator.run()).rejects.toThrow();
    // vi.clearAllMocks() clears calls, not implementations — restore the module-scope
    // default so a test added after this one doesn't inherit the session service.
    vi.mocked(getService).mockImplementation(async () => undefined as any);

    expect(captured.length, 'session.prompt was never reached').toBeGreaterThan(0);
    const userMessage = captured[0]!;
    expect(userMessage).toContain('Goal: what is a coverage digest');
    expect(userMessage).toContain('EXACTLY ONE search call');   // quick evidence section
    expect(userMessage).toContain('Perform your research and submit your full report now.');
  });
});
