/**
 * fetch_url — short-lived in-memory page cache.
 *
 * Paging (`start`) must not re-download the page: every chunk of one page comes
 * from the SAME fetched version (a live page could change between calls and make
 * the offsets meaningless), and per-chunk safety verdicts are cached on the entry
 * (phase 2). Keyed by both the requested and the final URL. Process-local, bounded
 * by entry count, total size and TTL; cleared on session shutdown.
 */

import type { RiskFlag } from './heuristics.ts';
import type { HiddenPassage } from './hidden-text.ts';
import type { UnicodeFindings } from './unicode.ts';
import type { OutlineEntry } from './chunking.ts';

export interface CachedPage {
  requestedUrl: string;
  finalUrl: string;
  redirects: string[];
  layer: string;
  contentType: string;
  raw: boolean;
  /** Cleaned page text (invisible Unicode removed) — all offsets refer to it. */
  text: string;
  riskFlags: RiskFlag[];
  hidden: HiddenPassage[];
  hiddenSkipped: boolean;
  unicode: UnicodeFindings;
  outline: { entries: OutlineEntry[]; truncated: boolean };
  fetchedAt: number;
  /** Per-chunk review outcomes, keyed `${start}:${end}` (phase 2). */
  reviews: Map<string, unknown>;
}

export interface PageCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Approximate budget in UTF-16 code units across all cached texts. */
  maxChars?: number;
  now?: () => number;
}

export class PageCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private readonly now: () => number;
  /** Insertion-ordered: oldest first (LRU via delete + re-set on access). */
  private readonly pages = new Map<string, CachedPage>();
  /** requested/final URL → primary key (the requested URL). */
  private readonly aliases = new Map<string, string>();

  constructor(opts: PageCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 20;
    this.maxChars = opts.maxChars ?? 10_000_000; // ~20 MB of UTF-16
    this.now = opts.now ?? Date.now;
  }

  get(url: string): CachedPage | undefined {
    const key = this.aliases.get(url);
    if (!key) return undefined;
    const page = this.pages.get(key);
    if (!page) { this.aliases.delete(url); return undefined; }
    if (this.now() - page.fetchedAt > this.ttlMs) { this.delete(key); return undefined; }
    this.pages.delete(key); // refresh LRU position
    this.pages.set(key, page);
    return page;
  }

  set(page: CachedPage): void {
    const key = page.requestedUrl;
    this.delete(key);
    if (page.finalUrl !== key) this.delete(page.finalUrl);
    this.pages.set(key, page);
    this.aliases.set(key, key);
    this.aliases.set(page.finalUrl, key);
    this.evict();
  }

  clear(): void {
    this.pages.clear();
    this.aliases.clear();
  }

  get size(): number {
    return this.pages.size;
  }

  private delete(key: string): void {
    const primary = this.aliases.get(key) ?? key;
    const page = this.pages.get(primary);
    this.pages.delete(primary);
    for (const [alias, target] of this.aliases) if (target === primary) this.aliases.delete(alias);
    if (page) this.aliases.delete(page.finalUrl);
  }

  private evict(): void {
    let chars = 0;
    for (const p of this.pages.values()) chars += p.text.length;
    const now = this.now();
    for (const [key, page] of this.pages) {
      const expired = now - page.fetchedAt > this.ttlMs;
      if (!expired && this.pages.size <= this.maxEntries && chars <= this.maxChars) break;
      // Oldest first; always keep the newest entry even if it alone exceeds the budget.
      if (this.pages.size === 1) break;
      chars -= page.text.length;
      this.delete(key);
    }
  }
}
