/**
 * fetch_url — the review step's contract, shared by the tool and the safety
 * checker (kept here so neither imports the other), plus the confirm helper.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Config } from '../config.ts';
import { logger } from '../logger.ts';
import type { CachedPage } from './cache.ts';
import type { Chunk } from './chunking.ts';
import type { SafetyStatus } from './format.ts';

export interface ReviewInput {
  page: CachedPage;
  chunk: Chunk;
  ctx: ExtensionContext;
  config: Config;
  signal?: AbortSignal;
}

export type ReviewOutcome =
  | { action: 'show'; safety: SafetyStatus; details?: Record<string, unknown> }
  | { action: 'withhold'; message: string; details?: Record<string, unknown> };

export type ReviewFn = (input: ReviewInput) => Promise<ReviewOutcome>;

/** No review: every chunk is shown (still framed as untrusted). */
export const passThroughReview: ReviewFn = async () => ({ action: 'show', safety: { kind: 'not-run' } });

/** How long a confirmation dialog waits before answering "no". */
export const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/** Ask the user; "no" when there is no UI, on timeout, or if the dialog fails. */
export async function confirmWithUser(ctx: ExtensionContext, title: string, message: string, signal?: AbortSignal): Promise<boolean> {
  if (!ctx.hasUI) return false;
  try {
    return await ctx.ui.confirm(title, message, { timeout: CONFIRM_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  } catch (err) {
    logger.debug('[fetch_url] confirm dialog failed; treating as "no":', err);
    return false;
  }
}
