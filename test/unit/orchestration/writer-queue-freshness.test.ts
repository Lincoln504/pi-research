/**
 * ResearchOrchestrationService.storeLinkDescriptions — writer-queue freshness
 * across a Knowledge Store rebuild (a Knowledge Mode/cwd change between
 * research rounds).
 *
 * storeLinkDescriptions() used to resolve the writer queue via
 * getService(WRITER_QUEUE, ctx, container). The ServiceContainer permanently
 * caches the first raw IWriterQueue object that factory ever returns —
 * WriterQueue.initialize() is a no-arg lifecycle no-op that never rebuilds
 * its bound store/chunker, so the get()'s ctx-reinit branch never actually
 * refreshes it. After a Knowledge Mode/cwd change disposes and rebuilds
 * KnowledgeStoreService's internal writer queue (its OWN service identity is
 * unchanged — only its internal handles are rebuilt in place), every
 * subsequent call kept enqueueing onto the stale, disposed writer — silent,
 * permanent knowledge-store write loss. The fix resolves the writer queue
 * directly from the already-fresh ksService instead of through the cached
 * WRITER_QUEUE registration.
 *
 * Uses a REAL ServiceContainer (not vi.mock'd) so the registry's actual
 * caching behavior is exercised — a mocked getService() can't reproduce
 * this, since a plain vi.fn() has no caching of its own.
 */

import { describe, it, expect, vi } from 'vitest';
import { ResearchOrchestrationService } from '../../../src/orchestration/research-orchestration-service.ts';
import { ServiceContainer } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

describe('storeLinkDescriptions — writer-queue freshness across a store rebuild', () => {
  it('enqueues onto the CURRENT writer queue, not one cached from before a Knowledge Store rebuild', async () => {
    const container = new ServiceContainer({ enableLogging: false });

    const writers: any[] = [];
    function makeWriter() {
      const w = {
        enqueue: vi.fn(),
        drain: vi.fn().mockResolvedValue(undefined),
        // Mirrors the real WriterQueue: a no-arg lifecycle no-op that does NOT
        // rebuild the bound store/chunker — this is exactly why a DI cache of
        // this object goes stale.
        initialize: vi.fn(async () => {}),
      };
      writers.push(w);
      return w;
    }
    let currentWriter = makeWriter();

    // ksService's own identity never changes across the simulated rebuild —
    // mirrors KnowledgeStoreService.initialize()'s in-place rebuild, which
    // keeps the same registered instance but replaces its internal handles.
    const ksService = {
      isReady: () => true,
      getWriterQueue: vi.fn(async () => currentWriter),
    };
    container.register(ServiceNames.KNOWLEDGE_STORE, () => ksService as any);

    // Mirrors the REAL production registration in service-initialization.ts:
    // resolves KNOWLEDGE_STORE once and caches whatever writer it got.
    container.register(ServiceNames.WRITER_QUEUE, async () => {
      const store = await container.get<any>(ServiceNames.KNOWLEDGE_STORE);
      return store.getWriterQueue();
    });

    let round = 1;
    const reports1 = new Map([['1.res1', 'CITED LINKS\n[1] https://foo.example.com [Source: Test] — First round']]);
    const reports2 = new Map([['2.res1', 'CITED LINKS\n[1] https://bar.example.com [Source: Test] — Second round']]);
    const synthesisService = {
      getAllReports: vi.fn(() => (round === 1 ? reports1 : reports2)),
    };
    container.register(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, () => synthesisService as any);

    const service = new ResearchOrchestrationService();
    const ctx = { container };
    const config = { KNOWLEDGE_STORE_MODE: 'project' } as any;

    // Round 1: resolves and uses the first writer.
    await service.storeLinkDescriptions('s1', 1, 'r1', config, ctx);
    expect(writers[0].enqueue).toHaveBeenCalledTimes(1);

    // Simulate a Knowledge Mode/cwd change rebuilding the store's writer
    // queue in place.
    currentWriter = makeWriter();
    round = 2;

    await service.storeLinkDescriptions('s1', 2, 'r1', config, ctx);

    // The second round must land on the fresh writer, not the stale first one.
    expect(writers[1].enqueue).toHaveBeenCalledTimes(1);
    expect(writers[0].enqueue).toHaveBeenCalledTimes(1); // unchanged since round 1
  });
});
