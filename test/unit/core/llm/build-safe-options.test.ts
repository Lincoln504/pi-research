import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildSafeOptions } from '../../../../src/core/llm/llm-utils.ts';
import { completeSimple } from '@earendil-works/pi-ai/compat';

const STUB_MODEL = {
  id: 'qwen3p8-max',
  provider: 'fireworks',
  api: 'anthropic-messages',
  baseUrl: 'https://api.fireworks.ai/inference',
  maxTokens: 32768,
  reasoning: false,
} as any;

describe('buildSafeOptions', () => {
  it('normalizes the default off level to undefined for the compat API', () => {
    expect(buildSafeOptions(STUB_MODEL, {}).reasoning).toBeUndefined();
  });

  it('normalizes an explicit caller-provided off', () => {
    expect(buildSafeOptions(STUB_MODEL, { reasoning: 'off' as any }).reasoning).toBeUndefined();
  });

  it('preserves valid non-off reasoning levels', () => {
    expect(buildSafeOptions(STUB_MODEL, { reasoning: 'low' }).reasoning).toBe('low');
    expect(buildSafeOptions(STUB_MODEL, {}, 4096, 'medium').reasoning).toBe('medium');
  });

  it('caller reasoning wins over the thinkingLevel argument', () => {
    expect(buildSafeOptions(STUB_MODEL, { reasoning: 'high' }, 4096, 'low').reasoning).toBe('high');
  });

  it('fills maxTokens from the default cap, clamped to the model ceiling', () => {
    expect(buildSafeOptions(STUB_MODEL, {}).maxTokens).toBe(4096);
    expect(buildSafeOptions({ ...STUB_MODEL, maxTokens: 1000 }, {}).maxTokens).toBe(1000);
    expect(buildSafeOptions(STUB_MODEL, { maxTokens: 8192 }).maxTokens).toBe(8192);
  });

  it('preserves unrelated options', () => {
    const opts = buildSafeOptions(STUB_MODEL, { sessionId: 's1', apiKey: 'k' } as any);
    expect((opts as any).sessionId).toBe('s1');
    expect(opts.apiKey).toBe('k');
  });
});

// End-to-end through the real compat API with a stubbed transport: a truthy
// 'off' takes pi-ai's thinking path, where the unknown level yields an undefined
// budget and maxTokens goes out as null (Fireworks 400s on it). Regression for
// that serialization, not just the helper's return value.
describe('compat serialization (real pi-ai, stubbed transport)', () => {
  const FIREWORKS_MODEL = {
    ...STUB_MODEL,
    contextWindow: 131072,
    input: ['text'],
    output: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as any;

  const SSE_OK = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"stub","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');

  async function captureRequestBody(options: any): Promise<any> {
    let body: any;
    const fetchStub = vi.fn(async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    await completeSimple(
      FIREWORKS_MODEL,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }] } as any,
      { apiKey: 'test-key', fetch: fetchStub, ...options } as any,
    );
    return body;
  }

  it('off (the default) sends a finite positive max_tokens, never null', async () => {
    const body = await captureRequestBody(buildSafeOptions(FIREWORKS_MODEL, {}));
    expect(Number.isInteger(body.max_tokens)).toBe(true);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('an explicit off is equally safe', async () => {
    const body = await captureRequestBody(buildSafeOptions(FIREWORKS_MODEL, { reasoning: 'off' as any }));
    expect(Number.isInteger(body.max_tokens)).toBe(true);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('off does not take the thinking path (no budget inflates max_tokens)', async () => {
    const off = await captureRequestBody(buildSafeOptions(FIREWORKS_MODEL, {}));
    const low = await captureRequestBody(buildSafeOptions(FIREWORKS_MODEL, { reasoning: 'low' }));
    expect(low.max_tokens).toBe(4096 + 2048); // 'low' budget is 2048 in pi-ai
    expect(off.max_tokens).toBe(4096);
  });
});
