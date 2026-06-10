import { describe, it, expect, vi, beforeEach } from 'vitest';
import { repairJsonWithLlm } from '../../../src/utils/agentic-repair.ts';
import { Type } from 'typebox';
import type { Model } from '@earendil-works/pi-ai';

const stubModel: Model<any> = { id: 'test-model' } as Model<any>;

describe('repairJsonWithLlm', () => {
  const mockCompleter = vi.fn();
  const auth = { apiKey: 'test' };
  const schema = Type.Object({
    foo: Type.String(),
    bar: Type.Number()
  });

  beforeEach(() => {
    mockCompleter.mockReset();
  });

  it('salvages valid JSON from a malformed response', async () => {
    mockCompleter.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n{"foo": "fixed", "bar": 42}\n```' }]
    });

    const result = await repairJsonWithLlm('{"foo": "broken", "bar": "nan"', mockCompleter, auth, {
      model: stubModel,
      schema,
      serviceName: 'TestService'
    });

    expect(result).toEqual({ foo: 'fixed', bar: 42 });
    expect(mockCompleter).toHaveBeenCalledOnce();
    const prompt = mockCompleter.mock.calls[0][1].messages[0].content[0].text;
    expect(prompt).toContain('JSON Schema');
    expect(prompt).toContain('MALFORMED RESPONSE');
  });

  it('returns null if repair pass still produces invalid JSON', async () => {
    mockCompleter.mockResolvedValue({
      content: [{ type: 'text', text: 'still not json' }]
    });

    const result = await repairJsonWithLlm('{', mockCompleter, auth, {
      model: stubModel
    });

    expect(result).toBeNull();
  });

  it('returns null if LLM returns empty response', async () => {
    mockCompleter.mockResolvedValue({ content: [] });

    const result = await repairJsonWithLlm('{', mockCompleter, auth, {
      model: stubModel
    });

    expect(result).toBeNull();
  });

  it('coerces values if schema is provided', async () => {
    mockCompleter.mockResolvedValue({
      content: [{ type: 'text', text: '{"foo": "fixed", "bar": "42"}' }] // Note "42" as string
    });

    const result = await repairJsonWithLlm('{', mockCompleter, auth, {
      model: stubModel,
      schema
    });

    expect(result).toEqual({ foo: 'fixed', bar: 42 }); // Coerced to number
  });
});
