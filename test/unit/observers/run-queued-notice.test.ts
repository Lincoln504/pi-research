import { describe, it, expect, afterEach } from 'vitest';

import {
  createResearchObserver,
  createObserverState,
  type ObserverState,
} from '../../../src/observers/research-observer-impl.ts';
import {
  createInitialPanelState,
  clearAllFlashTimeouts,
  type ResearchPanelState,
} from '../../../src/tui/research-panel.ts';

/**
 * onRunQueued must surface the "run is queued behind the machine-wide run cap"
 * notice on the TUI. It fires BEFORE any other lifecycle event, so with no
 * handler the whole acquire wait (up to ~10 minutes at the default cap/window)
 * rendered as an empty panel — indistinguishable from a hang, the exact
 * condition the callback documents. The placeholder box must appear with a
 * persistent status and be removed by onStart once a slot is acquired (both
 * quick and deep fire onStart before any real work).
 */
describe('TUI run-queued notice', () => {
  const researchIds: string[] = [];

  function makeObserver(complexity: number): { panelState: ResearchPanelState; obs: ReturnType<typeof createResearchObserver>; state: ObserverState } {
    const researchId = `rid-${researchIds.length}`;
    researchIds.push(researchId);
    const panelState = createInitialPanelState(`sess-${researchIds.length}`, researchId, 'q', 'model');
    const state = createObserverState();
    const obs = createResearchObserver(
      { panelState, debouncedRefresh: () => {}, researchComplexity: complexity },
      state,
    );
    return { panelState, obs, state };
  }

  afterEach(() => {
    for (const r of researchIds) clearAllFlashTimeouts(r);
    researchIds.length = 0;
  });

  it('shows a queued placeholder with slot count and wait bound as a persistent status', () => {
    const { panelState, obs } = makeObserver(2);

    obs.onRunQueued!(3, 600_000);

    const slice = panelState.slices.get('run-queued');
    expect(slice).toBeDefined();
    expect(slice!.queued).toBe(false); // queued=true would HIDE the box from render
    expect(slice!.completed).toBe(false);
    // Non-numeric label → persistent status write (not a timed pop), carrying
    // the cap and the wait bound so the user knows what is happening and for
    // how long at most.
    expect(slice!.status).toContain('3');
    expect(slice!.status).toContain('10m');
  });

  it('removes the placeholder when a deep run actually starts', () => {
    const { panelState, obs } = makeObserver(2);

    obs.onRunQueued!(3, 600_000);
    expect(panelState.slices.has('run-queued')).toBe(true);

    obs.onStart!('q', 2);
    expect(panelState.slices.has('run-queued')).toBe(false);
  });

  it('removes the placeholder when a quick run actually starts (quick slice replaces it)', () => {
    const { panelState, obs } = makeObserver(0);

    obs.onRunQueued!(3, 600_000);
    obs.onStart!('q', 0);

    expect(panelState.slices.has('run-queued')).toBe(false);
    // The quick researcher slice took over the panel.
    expect(panelState.slices.size).toBe(1);
  });

  it('onStart is a no-op for the placeholder when the run never queued', () => {
    const { panelState, obs } = makeObserver(2);
    obs.onStart!('q', 2);
    expect(panelState.slices.has('run-queued')).toBe(false);
  });
});
