/**
 * YouTube PoToken minting (BotGuard / Proof-of-Origin)
 *
 * YouTube's 2026 BotGuard attestation requires a Proof-of-Origin Token (PoToken)
 * for caption/transcript requests. Without one, the timedtext endpoint returns
 * HTTP 200 with an EMPTY body (a silent failure). This module mints tokens with
 * `bgutils-js`, running the BotGuard VM under a `jsdom` DOM.
 *
 * Hard-won implementation details (validated live against youtubei.js@17 /
 * bgutils-js@3 / jsdom@29):
 *
 *  1. Cross-realm typed arrays. The BotGuard VM must run in the SAME JS realm as
 *     bgutils' `base64ToU8` (the Node realm). So the interpreter is eval'd via
 *     `new Function(interp)()` in the Node realm and jsdom's browser globals
 *     (window/document/…) are bridged onto Node `globalThis`. Running the VM in
 *     jsdom's own realm makes the minter factory return a non-function
 *     ("APF:Failed") because of an `instanceof Uint8Array` realm mismatch.
 *
 *  2. The VM references `window` during EVERY mint call (not just setup), so we
 *     mint all identifiers (the session visitorData + every video ID) up front
 *     while the realm is bridged, then unbridge and close the DOM.
 *
 *  3. Mutating `globalThis` is process-global, so the whole bridged section is
 *     serialized behind a module-level async mutex to prevent concurrent
 *     researchers from racing on the shared globals.
 *
 *  4. Content binding. timedtext needs a token minted with `identifier =
 *     videoId`; the session token (identifier = visitorData) is only used to
 *     create the Innertube session. We mint both from a single challenge.
 */

import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';

/**
 * Well-known request key for the YouTube web PoToken program. This is a public
 * constant baked into the YouTube web player; it is overridable via env in case
 * YouTube rotates it (see config YOUTUBE_POTOKEN_REQUEST_KEY).
 */
export const DEFAULT_REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

/** Browser globals the BotGuard VM probes; bridged from jsdom onto globalThis. */
const BRIDGED_GLOBALS = ['window', 'document', 'location', 'navigator', 'origin'] as const;

export interface MintOptions {
  /** Override the PoToken program request key (defaults to the web key). */
  requestKey?: string;
  /** Fetch implementation (defaults to global fetch); lets callers route/proxy. */
  fetchImpl?: typeof fetch;
  /** Cancellation signal — aborts the BotGuard challenge/integrity network calls. */
  signal?: AbortSignal;
}

/** A bgutils-js error carrying a `.code` (e.g. VM_ERROR, INTEGRITY_ERROR). */
function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { code?: string; message?: string };
    if (e.code && e.message) return `${e.code}: ${e.message}`;
    if (e.message) return e.message;
  }
  return String(error);
}

// Module-level mutex: serialize all globalThis mutation across concurrent callers.
let mintChain: Promise<unknown> = Promise.resolve();

/**
 * Mint a session-bound token (for `identifiers[0]`, the visitorData) plus one
 * content-bound token per remaining identifier (the video IDs), all from a
 * single BotGuard challenge. Returns a map keyed by identifier.
 *
 * Throws on challenge/attestation/integrity failure — the caller decides how to
 * degrade (typically: mark every video's transcript as unavailable).
 */
export async function mintPoTokens(
  identifiers: string[],
  opts: MintOptions = {},
): Promise<Map<string, string>> {
  // Chain on the mutex so only one bridged section runs at a time.
  const run = mintChain.then(() => doMint(identifiers, opts), () => doMint(identifiers, opts));
  // Keep the chain alive regardless of this call's success/failure.
  mintChain = run.then(() => undefined, () => undefined);
  return run;
}

async function doMint(
  identifiers: string[],
  opts: MintOptions,
): Promise<Map<string, string>> {
  if (identifiers.length === 0) return new Map();

  const requestKey = opts.requestKey || process.env['PI_RESEARCH_YOUTUBE_POTOKEN_REQUEST_KEY'] || DEFAULT_REQUEST_KEY;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();

  // Lazy-load heavy deps — never imported at module load (keeps startup native-free).
  const bgMod = (await import('bgutils-js')) as unknown as BgModule;
  const BG = bgMod.BG ?? bgMod.default;
  const { buildURL, getHeaders } = bgMod;
  const { JSDOM } = await import('jsdom');

  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><body></body></html>', {
    url: 'https://www.youtube.com/',
  });

  const savedDescriptors: Record<string, PropertyDescriptor | undefined> = {};
  const bridge = () => {
    for (const key of BRIDGED_GLOBALS) {
      savedDescriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
      try {
        Object.defineProperty(globalThis, key, {
          value: (dom.window as unknown as Record<string, unknown>)[key],
          configurable: true,
          writable: true,
        });
      } catch {
        // Some globals (e.g. navigator) may be non-configurable on certain
        // runtimes; skip — the VM only needs the ones it can read.
      }
    }
  };
  const unbridge = () => {
    for (const key of BRIDGED_GLOBALS) {
      try {
        const saved = savedDescriptors[key];
        if (saved) Object.defineProperty(globalThis, key, saved);
        else delete (globalThis as Record<string, unknown>)[key];
      } catch {
        // Best-effort restore: never let one non-restorable global abort the
        // loop (which would leave later globals dirty and skip DOM teardown).
      }
    }
  };

  bridge();
  try {
    const bgConfig: BgConfig = {
      fetch: (input: unknown, init?: unknown) =>
        fetchImpl(input as Parameters<typeof fetch>[0], {
          ...(init as RequestInit | undefined),
          signal: (init as RequestInit | undefined)?.signal ?? opts.signal,
        }),
      globalObj: globalThis,
      identifier: identifiers[0]!,
      requestKey,
    };

    const challenge = await BG.Challenge.create(bgConfig);
    if (!challenge) throw new Error('BotGuard challenge unavailable');

    const interpreter = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!interpreter) throw new Error('BotGuard interpreter script missing');
    // Eval in the Node realm so the VM and bgutils share one Uint8Array realm.
    // The interpreter is YouTube's BotGuard VM, fetched over HTTPS from Google's
    // attestation endpoint by bgutils — running it is required and inherent to
    // PoToken generation; trust rests on that TLS connection.
    new Function(interpreter)();

    const botguard = await BG.BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObj: globalThis,
    });

    const webPoSignalOutput: unknown[] = [];
    const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

    const integrityResponse = await fetchImpl(buildURL('GenerateIT', false), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify([requestKey, botguardResponse]),
      signal: opts.signal,
    });
    const integrityJson = (await integrityResponse.json()) as unknown[];
    const integrityToken = integrityJson?.[0] as string | undefined;
    if (!integrityToken) {
      throw new Error('Integrity token rejected by attestation server (likely a non-residential IP)');
    }

    const minter = await BG.WebPoMinter.create({ integrityToken }, webPoSignalOutput);

    const tokens = new Map<string, string>();
    for (const id of identifiers) {
      tokens.set(id, await minter.mintAsWebsafeString(id));
    }

    metrics.observe('youtube_potoken_mint_duration_ms', Date.now() - started, { status: 'success' });
    metrics.increment('youtube_potoken_mints_total', tokens.size, { status: 'success' });
    logger.log(`[youtube] Minted ${tokens.size} PoToken(s) in ${Date.now() - started}ms`);
    return tokens;
  } catch (error) {
    metrics.increment('youtube_potoken_mints_total', 1, { status: 'error' });
    logger.warn(`[youtube] PoToken minting failed: ${describeError(error)}`);
    throw error instanceof Error ? error : new Error(describeError(error));
  } finally {
    // Always restore globals and tear down the DOM, even if unbridge throws.
    try {
      unbridge();
    } catch {
      // unbridge is already per-key best-effort; this guards the loop itself.
    }
    try {
      dom.window.close();
    } catch {
      // best-effort teardown
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal structural types for the loosely-typed bgutils-js surface we touch.
// ---------------------------------------------------------------------------

interface BgConfig {
  fetch: (input: unknown, init?: unknown) => Promise<Response>;
  globalObj: unknown;
  identifier: string;
  requestKey: string;
}

interface BgNamespace {
  Challenge: {
    create(config: BgConfig): Promise<{
      interpreterJavascript?: { privateDoNotAccessOrElseSafeScriptWrappedValue?: string };
      program: string;
      globalName: string;
    } | undefined>;
  };
  BotGuardClient: {
    create(opts: { program: string; globalName: string; globalObj: unknown }): Promise<{
      snapshot(args: { webPoSignalOutput: unknown[] }): Promise<string>;
    }>;
  };
  WebPoMinter: {
    create(
      integrity: { integrityToken: string },
      webPoSignalOutput: unknown[],
    ): Promise<{ mintAsWebsafeString(identifier: string): Promise<string> }>;
  };
}

interface BgModule {
  BG?: BgNamespace;
  default: BgNamespace;
  buildURL(endpoint: string, useYouTubeAPI?: boolean): string;
  getHeaders(): Record<string, string>;
}
