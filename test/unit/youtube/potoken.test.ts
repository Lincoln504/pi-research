/**
 * Unit tests for the YouTube PoToken minter.
 *
 * bgutils-js and jsdom are mocked so the BotGuard flow is deterministic and
 * offline. These tests cover the load-bearing correctness invariants that the
 * rest of the feature depends on: the empty short-circuit, the happy path,
 * globalThis restoration on success AND failure (no global pollution leak), and
 * the module-level mutex that serializes the globalThis-mutating critical section
 * across concurrent callers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock jsdom: a minimal window exposing the bridged globals + close(). ---
const windowClose = vi.fn();
function makeWindow(): Record<string, unknown> {
  const win: Record<string, unknown> = {
    document: { kind: 'doc' },
    location: { href: 'https://www.youtube.com/' },
    navigator: { userAgent: 'test' },
    origin: 'https://www.youtube.com',
    close: windowClose,
  };
  win['window'] = win; // window.window === window, like a real DOM
  return win;
}
vi.mock('jsdom', () => ({
  // Must be a regular function so `new JSDOM(...)` works (arrow fns can't construct).
  JSDOM: vi.fn(function (this: unknown) {
    return { window: makeWindow() };
  }),
}));

// --- Mock bgutils-js. challengeCreate is overridable per test (for the mutex/delay test). ---
// bgutils-js 4 has no barrel entry — the package's "exports" map defines only the three
// subpaths below — so each is mocked separately. Mocking the bare specifier instead
// resolves to nothing and the suite fails to import at all.
const challengeCreate = vi.fn();
const snapshot = vi.fn(async () => 'botguard-response');
const mintAsWebsafeString = vi.fn(async (id: string) => `tok-${id}`);
const botGuardCreate = vi.fn(async (_opts?: Record<string, unknown>) => ({ snapshot }));
vi.mock('bgutils-js/botguard', () => ({
  getChallenge: (...a: unknown[]) => challengeCreate(...a),
  BotGuardClient: { create: (...a: unknown[]) => botGuardCreate(...(a as [])) },
}));
vi.mock('bgutils-js/webpo', () => ({
  WebPoMinter: { create: vi.fn(async () => ({ mintAsWebsafeString })) },
}));
vi.mock('bgutils-js/utils', () => ({
  buildURL: () => 'https://jnn-pa.googleapis.com/$rpc/GenerateIT',
  getHeaders: () => ({ 'content-type': 'application/json+protobuf' }),
}));

import { mintPoTokens } from '../../../src/youtube/potoken.ts';

const okChallenge = {
  interpreterJavascript: { privateDoNotAccessOrElseSafeScriptWrappedValue: '/* noop vm */' },
  program: 'program-bytecode',
  globalName: 'vmGlobalName',
};

beforeEach(() => {
  vi.clearAllMocks();
  challengeCreate.mockResolvedValue(okChallenge);
  // Integrity-token POST returns [integrityToken, ttl, ...]
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ['integrity-token-abc', 43200] })));
});

describe('youtube/potoken', () => {
  it('short-circuits on empty identifiers without touching the DOM/network', async () => {
    const result = await mintPoTokens([]);
    expect(result.size).toBe(0);
    expect(challengeCreate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('mints one token per identifier and restores globalThis afterwards', async () => {
    const hadWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    const tokens = await mintPoTokens(['VISITOR', 'vid00000001', 'vid00000002']);

    expect(tokens.get('VISITOR')).toBe('tok-VISITOR');
    expect(tokens.get('vid00000001')).toBe('tok-vid00000001');
    expect(tokens.get('vid00000002')).toBe('tok-vid00000002');
    // globalThis must be restored to its original state (no window leak).
    expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(hadWindow);
    expect(windowClose).toHaveBeenCalled(); // DOM torn down
    vi.unstubAllGlobals();
  });

  it('calls the bgutils-js 4 API with the names that version actually reads', async () => {
    // These three renames are load-bearing and all fail SILENTLY rather than loudly:
    // bgutils-js 4 renamed BotGuardClient's `globalObj` to `globalObject` (the VM then
    // has no global to attach to and the minter factory returns a non-function), replaced
    // BG.Challenge.create with a free getChallenge(), and renamed its `fetch` config field
    // to `fetchFunction` (an unset fetcher falls back to the ambient one, losing the
    // caller's AbortSignal). A structural mock accepts either spelling, so pin them.
    await mintPoTokens(['VISITOR']);

    const challengeConfig = challengeCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof challengeConfig['fetchFunction']).toBe('function');
    expect(challengeConfig).not.toHaveProperty('fetch');
    expect(challengeConfig['requestKey']).toBeTruthy();

    const clientOptions = botGuardCreate.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(clientOptions['globalObject']).toBe(globalThis);
    expect(clientOptions).not.toHaveProperty('globalObj');
    vi.unstubAllGlobals();
  });

  it('throws AND restores globalThis when the challenge fails (no global pollution leak)', async () => {
    const hadWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    challengeCreate.mockRejectedValueOnce(new Error('attestation rejected'));

    await expect(mintPoTokens(['VISITOR', 'vid00000001'])).rejects.toThrow(/attestation rejected/);

    expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(hadWindow);
    expect(windowClose).toHaveBeenCalled(); // DOM still torn down on failure
    vi.unstubAllGlobals();
  });

  it('rejects when the attestation server returns no integrity token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [undefined, 0] })));
    await expect(mintPoTokens(['VISITOR'])).rejects.toThrow(/integrity token/i);
    vi.unstubAllGlobals();
  });

  it('rejects an HTTP-error attestation response without reading its body as JSON', async () => {
    const jsonSpy = vi.fn(async () => { throw new Error('should never be parsed'); });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: jsonSpy })));
    await expect(mintPoTokens(['VISITOR'])).rejects.toThrow(/HTTP 503/);
    expect(jsonSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('serializes concurrent callers through the mutex (no overlapping bridged sections)', async () => {
    let active = 0;
    let maxConcurrent = 0;
    // Gate the challenge so we can hold the first call inside its critical section.
    challengeCreate.mockImplementation(async () => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return okChallenge;
    });

    await Promise.all([
      mintPoTokens(['A']),
      mintPoTokens(['B']),
      mintPoTokens(['C']),
    ]);

    // If the mutex works, the bridged critical sections never overlap.
    expect(maxConcurrent).toBe(1);
    vi.unstubAllGlobals();
  });

  it('rejects a new mint while a hard-release-freed doMint() is still bridging globalThis, then allows one again once it settles', async () => {
    // Regression: the 5-minute hard-release timer force-frees the mint mutex
    // even when doMint() is merely slow (not permanently hung). Pre-fix, the
    // very next mintPoTokens() call would start its OWN doMint() — bridging
    // globalThis a second time while the first bridge is still installed —
    // and its unbridge() would restore the WRONG (already-bridged)
    // descriptors, permanently corrupting globalThis for the process. The fix
    // marks the mutex "wedged" instead: further mints fail fast (no second
    // bridge) until the stuck call actually settles and unbridges for real.
    vi.useFakeTimers();
    try {
      const hadWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
      let resolveChallenge!: (v: unknown) => void;
      const hangingChallenge = new Promise((resolve) => { resolveChallenge = resolve; });
      challengeCreate.mockImplementationOnce(() => hangingChallenge);

      const firstMint = mintPoTokens(['VISITOR']);
      firstMint.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // globalThis is bridged (bridge() runs before the first await inside
      // doMint()) and stays that way while the challenge never resolves.
      expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).not.toEqual(hadWindow);

      // Cross the 5-minute hard-release bound.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      await expect(mintPoTokens(['OTHER'])).rejects.toThrow(/wedged/i);
      expect(challengeCreate).toHaveBeenCalledTimes(1);
      // Still bridged to the FIRST call's descriptors — untouched by the
      // rejected second attempt.
      expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).not.toEqual(hadWindow);

      // Once the stuck call actually settles, unbridge() restores the true
      // originals and the mutex is no longer wedged.
      resolveChallenge(okChallenge);
      await vi.advanceTimersByTimeAsync(0);
      await firstMint;
      expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(hadWindow);

      const result = await mintPoTokens(['THIRD']);
      expect(result.get('THIRD')).toBe('tok-THIRD');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('a queued caller rejected at dequeue does not clear the wedge for later callers', async () => {
    // Regression: every mintPoTokens() call used to register an unconditional
    // wedge-clearing handler on its own settle — including a caller whose run
    // rejects BECAUSE of the dequeue wedge check. That rejected caller's
    // settle then cleared the flag microtasks after the hard release set it,
    // so the next caller passed both checks and bridged globalThis while the
    // abandoned mint was still mid-bridge. The clear is now gated on the call
    // actually having entered doMint().
    vi.useFakeTimers();
    try {
      const hadWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
      let resolveChallenge!: (v: unknown) => void;
      const hangingChallenge = new Promise((resolve) => { resolveChallenge = resolve; });
      challengeCreate.mockImplementationOnce(() => hangingChallenge);

      const firstMint = mintPoTokens(['VISITOR']);
      firstMint.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      // Queue a second caller BEFORE the hard release fires — it passes the
      // entry check (not wedged yet) and parks on the chain.
      const queuedMint = mintPoTokens(['QUEUED']);
      const queuedRejection = expect(queuedMint).rejects.toThrow(/wedged/i);

      // Hard release: frees the chain, sets the wedge, dequeues the parked
      // caller — which must reject without starting its own doMint().
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await queuedRejection;
      expect(challengeCreate).toHaveBeenCalledTimes(1);

      // The queued caller's settle must NOT have cleared the wedge: a third
      // caller still fails fast, with no second bridge installed.
      await expect(mintPoTokens(['THIRD'])).rejects.toThrow(/wedged/i);
      expect(challengeCreate).toHaveBeenCalledTimes(1);
      expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).not.toEqual(hadWindow);

      // Only the mint that actually bridged clears the wedge when it settles.
      resolveChallenge(okChallenge);
      await vi.advanceTimersByTimeAsync(0);
      await firstMint;
      expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(hadWindow);
      const result = await mintPoTokens(['FOURTH']);
      expect(result.get('FOURTH')).toBe('tok-FOURTH');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
