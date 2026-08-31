/**
 * Structured-completion helpers (buildConstrainedSubmitTool /
 * completeSimpleStructured) — the tool-call path, the text fallback, and the
 * request shape pi-ai must see for constrained sampling to engage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  completeSimple: vi.fn(),
}));

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { completeSimple } from '@earendil-works/pi-ai/compat';
import {
  buildConstrainedSubmitTool,
  completeSimpleStructured,
} from '../../../../src/core/llm/llm-utils.ts';
import { Type } from '@earendil-works/pi-ai';

const STUB_MODEL = { id: 'stub', provider: 'stub', api: 'openai-completions', maxTokens: 4096 } as any;

const SCHEMA = Type.Object({
  action: Type.String(),
  researchers: Type.Array(Type.Object({ id: Type.String(), goal: Type.String() })),
});

function textResponse(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'stub',
    model: 'stub',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 0,
  } as unknown as AssistantMessage;
}

function toolCallResponse(name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    ...textResponse(''),
    content: [{ type: 'toolCall', id: 'tc_1', name, arguments: args }],
  } as unknown as AssistantMessage;
}

describe('buildConstrainedSubmitTool', () => {
  it('sets strict-prefer json_schema constrained sampling', () => {
    const tool = buildConstrainedSubmitTool('submit_plan', 'Submit the plan.', SCHEMA);
    expect(tool.name).toBe('submit_plan');
    expect(tool.description).toBe('Submit the plan.');
    expect(tool.parameters).toBe(SCHEMA);
    // 'prefer' (not 'require') is the load-bearing choice: custom
    // OpenAI-compatible endpoints must keep working as plain tool calls.
    expect(tool.constrainedSampling).toEqual({ type: 'json_schema', strict: 'prefer' });
  });
});

describe('completeSimpleStructured', () => {
  const TOOL = buildConstrainedSubmitTool('submit_plan', 'Submit the plan.', SCHEMA);

  beforeEach(() => {
    vi.mocked(completeSimple).mockReset();
  });

  it('offers the tool with toolChoice auto and returns parsed args on a tool call', async () => {
    vi.mocked(completeSimple).mockResolvedValue(toolCallResponse('submit_plan', { action: 'delegate', researchers: [] }));

    const result = await completeSimpleStructured(
      STUB_MODEL,
      { systemPrompt: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'plan' }], timestamp: 0 }] },
      TOOL,
      { apiKey: 'k' },
      'Coordinator',
    );

    expect(result.kind).toBe('toolCall');
    if (result.kind === 'toolCall') {
      expect(result.args['action']).toBe('delegate');
    }

    const [model, context, options] = vi.mocked(completeSimple).mock.calls[0]!;
    expect(model).toBe(STUB_MODEL);
    expect((context as any).tools).toEqual([TOOL]);
    expect((options as any).toolChoice).toBe('auto');
  });

  it('returns text when the model answers in prose (fallback contract)', async () => {
    vi.mocked(completeSimple).mockResolvedValue(textResponse('{"action":"delegate"}'));

    const result = await completeSimpleStructured(
      STUB_MODEL,
      { systemPrompt: 'sys', messages: [] as any },
      TOOL,
      {},
      'Coordinator',
    );

    expect(result.kind).toBe('text');
    if (result.kind === 'text') expect(result.text).toBe('{"action":"delegate"}');
  });

  it('ignores tool calls to a different tool name and falls back to text', async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      ...toolCallResponse('some_other_tool', { nope: true }),
      // Also carries text — the model called a wrong tool AND wrote prose.
      content: [
        { type: 'toolCall', id: 'tc_1', name: 'some_other_tool', arguments: { nope: true } },
        { type: 'text', text: '{"action":"delegate"}' },
      ],
    } as unknown as AssistantMessage);

    const result = await completeSimpleStructured(
      STUB_MODEL,
      { systemPrompt: 'sys', messages: [] as any },
      TOOL,
      {},
      'Coordinator',
    );
    expect(result.kind).toBe('text');
  });

  it('maps provider errors identically to validateAndExtractText', async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      ...textResponse(''),
      stopReason: 'error',
      errorMessage: 'limit exhausted for your plan (1310)',
    } as unknown as AssistantMessage);

    await expect(
      completeSimpleStructured(STUB_MODEL, { messages: [] as any }, TOOL, {}, 'Coordinator'),
    ).rejects.toThrow('API Rate Limit Exhausted');
  });

  it('throws an actionable error when neither the tool call nor text arrives', async () => {
    vi.mocked(completeSimple).mockResolvedValue(textResponse('   '));

    await expect(
      completeSimpleStructured(STUB_MODEL, { messages: [] as any }, TOOL, {}, 'Coordinator'),
    ).rejects.toThrow('returned no text content and no submit_plan tool call');
  });

  it('classifies the empty-response error as RETRIABLE (retry → degrade, never abort)', async () => {
    // Regression (audit HIGH): the original message "neither a … tool call nor
    // text content" does NOT contain the legacy classifier substring
    // 'no text content', so an empty structured response aborted the run at
    // the first occurrence instead of retrying and degrading to the fallback
    // plan like the text path always did.
    vi.mocked(completeSimple).mockResolvedValue(textResponse('   '));
    const err = await completeSimpleStructured(STUB_MODEL, { messages: [] as any }, TOOL, {}, 'Coordinator').catch((e: unknown) => e);
    const { isRetriableLlmError } = await import('../../../../src/core/planning-service.ts');
    expect(err).toBeInstanceOf(Error);
    expect(isRetriableLlmError(err)).toBe(true);
  });
});
