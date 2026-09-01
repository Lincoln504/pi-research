/**
 * research-knowledge-search — disabled-store miss reasons
 *
 * The tool must distinguish WHY the store returned no store object: a user
 * choice (Knowledge Mode = none → 'store_disabled'), a host whose store
 * packages are not installed (availability 'native' disable →
 * 'store_packages_missing'), and a store still initializing or failed init
 * (→ 'store_not_ready'). Collapsing the first two would tell a user whose
 * optional embedding dependency was skipped at install to go flip a settings
 * toggle that cannot help — the same truth-telling rule the changeset applied
 * to knowledge-config, the /research-config menu, and the healthcheck.
 *
 * Kept in a separate file so its service-registry/config mocks do not leak
 * into research-knowledge-search.test.ts's hermetic pure-function tests
 * (same convention as research-knowledge-search-retry.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetService, mockTryGetContainer } = vi.hoisted(() => ({
  mockGetService: vi.fn(),
  mockTryGetContainer: vi.fn((ctx: any) => ctx?.container || { isReady: true }),
}));

vi.mock('../../../src/core/service-registry.ts', () => ({
  getService: mockGetService,
  tryGetServiceContainerFromCtx: mockTryGetContainer,
}));

// Pin Knowledge Mode away from 'none' so the mode short-circuit is out of the
// picture and the service's own disable reason is what decides the message.
vi.mock('../../../src/config.ts', () => ({
  getConfig: vi.fn(() => ({ KNOWLEDGE_STORE_MODE: 'global' })),
}));

import { createResearchKnowledgeSearchTool } from '../../../src/tools/research-knowledge-search.ts';

/** A service whose getStore() resolves null with the given disable reason. */
function disabledService(disabledReason: 'mode' | 'native' | null) {
  return {
    getStore: vi.fn(async () => null),
    getDisabledReason: vi.fn(() => disabledReason),
  };
}

const CTX = { mode: 'web', cwd: '/test/cwd' } as any;

describe('research_knowledge_search — disabled-store miss reasons', () => {
  beforeEach(() => {
    mockGetService.mockReset();
  });

  it("a 'mode' disable reports store_disabled — the settings toggle is the real fix", async () => {
    mockGetService.mockResolvedValue(disabledService('mode'));
    const result = await createResearchKnowledgeSearchTool().execute('id', { queries: ['q'] }, undefined, undefined as any, CTX);
    expect(result.details).toMatchObject({ found: false, reason: 'store_disabled' });
    expect((result.content[0] as any).text).toContain('disabled in settings');
  });

  it("a 'native' disable reports store_packages_missing — not 'disabled in settings'", async () => {
    // The store is OFF because packages are missing; pointing the user at the
    // Knowledge Mode toggle would send them hunting for a setting that cannot help.
    mockGetService.mockResolvedValue(disabledService('native'));
    const result = await createResearchKnowledgeSearchTool().execute('id', { queries: ['q'] }, undefined, undefined as any, CTX);
    expect(result.details).toMatchObject({ found: false, reason: 'store_packages_missing' });
    const text = (result.content[0] as any).text as string;
    expect(text).toContain('required packages are not installed');
    expect(text).not.toContain('disabled in settings');
  });

  it('a null disable reason (not yet disabled — still initializing or failed init) reports store_not_ready', async () => {
    mockGetService.mockResolvedValue(disabledService(null));
    const result = await createResearchKnowledgeSearchTool().execute('id', { queries: ['q'] }, undefined, undefined as any, CTX);
    expect(result.details).toMatchObject({ found: false, reason: 'store_not_ready' });
    expect((result.content[0] as any).text).toContain('initializing');
  });
});
