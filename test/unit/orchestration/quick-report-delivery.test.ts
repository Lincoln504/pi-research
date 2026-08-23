/**
 * What quick mode actually hands back.
 *
 * Quick mode has no synthesis step behind it: whatever the researcher writes IS the
 * delivered document, so two transforms run on it here that nothing else would apply —
 * the narration preamble is dropped, and a report with no analysis in it is flagged
 * rather than shipped as a clean success. Both were driven by live runs, and both live
 * in a handful of lines that a refactor could silently drop, so the wiring is pinned
 * here rather than only the helpers they call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const increment = vi.fn();
vi.mock('../../../src/utils/metrics.ts', () => ({
  metrics: {
    increment: (...a: unknown[]) => increment(...(a as [])),
    observe: vi.fn(), setGauge: vi.fn(), measure: vi.fn(),
    session: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() },
  },
}));

vi.mock('../../../src/healthcheck/index.ts', () => ({
  runHealthCheck: vi.fn(async () => ({ success: true, components: [] })),
  isBusyPoolHealthFailure: vi.fn(() => false),
}));

vi.mock('../../../src/core/llm/inject-date.ts', () => ({
  injectCurrentDate: vi.fn((t: string) => t),
}));

// A synthesis service that stores and returns the report verbatim, so the assertions
// below see exactly what the orchestrator did to it and nothing the service did.
const stored = new Map<string, string>();
const synthesisService = {
  storeReport: vi.fn((id: string, kind: string, report: string) => { stored.set(`${id}.${kind}`, report); }),
  getReport: vi.fn((id: string, kind: string) => stored.get(`${id}.${kind}`)),
  ensureCitedLinks: vi.fn((_id: string, text: string) => text),
  appendSteeringGuidance: vi.fn((text: string) => text),
};
const sessionService = { registerSession: vi.fn(), unregisterSession: vi.fn() };
vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: vi.fn(async (name: string) => {
    if (name === 'research-synthesis-service') return synthesisService;
    if (name === 'research-session-service') return sessionService;
    return undefined;
  }),
  tryGetServiceContainerFromCtx: vi.fn(() => ({ isReady: true })),
}));

let reportText = '';
vi.mock('../../../src/orchestration/researcher.ts', () => ({
  createResearcherSession: vi.fn(async () => ({
    resolvedModel: { id: 'test-model', contextWindow: 128_000 },
    session: {
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      subscribe: vi.fn(() => vi.fn()),
      get messages() {
        return [{ role: 'assistant', content: [{ type: 'text', text: reportText }] }];
      },
    },
  })),
}));

import { QuickResearchOrchestrator } from '../../../src/orchestration/quick-research-orchestrator.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';
import { getConfig } from '../../../src/config.ts';

const REAL_BODY =
  '# What Changed in the WebGPU Specification During 2026\n\n' +
  'The specification advanced from Working Draft to Candidate Recommendation during 2026, ' +
  'with the CRD published on 20 August [1]. Every major browser shipped stable support in ' +
  'the same period, and the group expects to demonstrate interoperability before advancing [2].';

async function deliver(report: string): Promise<string> {
  reportText = report;
  const orchestrator = new QuickResearchOrchestrator({
    ctx: { cwd: '/test/cwd' } as any,
    model: { id: 'test-model', contextWindow: 128_000 } as any,
    query: 'what changed in the WebGPU specification during 2026',
    sessionId: `quick-delivery-${report.length}`,
    researchId: `quick-delivery-${report.length}`,
    config: { ...getConfig('/test/cwd'), KNOWLEDGE_STORE_MODE: 'none' } as any,
  });
  return orchestrator.run();
}

describe('quick mode delivers the report, not the narration about it', () => {
  beforeEach(() => { stored.clear(); increment.mockClear(); });

  it('names the services it resolves', () => {
    // The getService mock above dispatches on these literals; if a name ever changes,
    // the mock silently returns undefined and every test here fails obscurely.
    expect(ServiceNames.RESEARCH_SYNTHESIS_SERVICE).toBe('research-synthesis-service');
    expect(ServiceNames.RESEARCH_SESSION_SERVICE).toBe('research-session-service');
  });

  it('drops the announcement line the model opens with', async () => {
    const result = await deliver(
      'I have gathered sufficient material from multiple authoritative sources. I will now synthesize the full report.' +
      `\n\n${REAL_BODY}`,
    );

    expect(result).not.toContain('I will now synthesize');
    expect(result.startsWith('# What Changed')).toBe(true);
    expect(increment).toHaveBeenCalledWith('research_report_preamble_stripped_total', 1, { mode: 'quick' });
  });

  it('leaves a report that opens correctly untouched, and adds no notice', async () => {
    const result = await deliver(REAL_BODY);

    expect(result).toBe(REAL_BODY);
    expect(increment).not.toHaveBeenCalledWith(
      'research_report_preamble_stripped_total', 1, { mode: 'quick' });
    expect(increment).not.toHaveBeenCalledWith(
      'research_synthesis_analysis_free_total', 1, { mode: 'quick' });
  });

  it('flags a report with no analysis in it rather than shipping a clean success', async () => {
    const result = await deliver('# Survey Of Small Open-Weight Vision-Language Models Released In 2026');

    expect(result).toContain('did not produce a substantive write-up');
    expect(increment).toHaveBeenCalledWith(
      'research_synthesis_analysis_free_total', 1, { mode: 'quick' });
  });

  it('judges the report AFTER the preamble is removed, not the narration in front of it', async () => {
    // The preamble is a complete sentence. Checking before stripping would let a
    // title-only report pass on the strength of the line that is about to be deleted.
    const result = await deliver(
      'I have gathered sufficient material from the sources and will now synthesize the report.' +
      '\n\n# Survey Of Small Open-Weight Vision-Language Models Released In 2026 ' +
      'Covering Architecture Training Data Licensing And Benchmark Position Across Vendors',
    );

    expect(result).toContain('did not produce a substantive write-up');
    expect(result).not.toContain('I have gathered');
  });
});
