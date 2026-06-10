import { logger } from '../logger.ts';

/**
 * Robust detector for "History Echoes" in terminal input.
 * 
 * This helps prevent accidental re-injection of large tool results
 * (e.g. from GitHub scrapes) when a user hits UP arrow in a terminal
 * and the emulator/shell re-outputs previous results into the input buffer.
 */
export class EchoGuard {
  private static readonly MAX_CACHE_SIZE = 10;
  private static readonly MIN_CONTENT_LENGTH = 200;
  private static readonly PREFIX_MATCH_LENGTH = 150;

  private recentResults: string[] = [];

  /**
   * Clear the cache. Useful for testing and between distinct research sessions.
   */
  public reset(): void {
    this.recentResults = [];
  }

  /**
   * Track a new large tool result that might be echoed later.
   */
  public trackResult(text: string): void {
    if (!text || text.length < EchoGuard.MIN_CONTENT_LENGTH) return;

    // Clean text (remove ANSI, normalize whitespace)
    const cleaned = this.cleanText(text);
    if (cleaned.length < EchoGuard.MIN_CONTENT_LENGTH) return;

    // Add to rolling cache (newest first)
    this.recentResults.unshift(cleaned);
    if (this.recentResults.length > EchoGuard.MAX_CACHE_SIZE) {
      this.recentResults.pop();
    }
  }

  /**
   * Check if input text looks like an accidental history echo.
   */
  public isEcho(text: string): boolean {
    if (!text) return false;

    // Slash commands are never valid steering — they bypass the steer handler
    // and go through pi's command dispatch. If one arrives here, it's a
    // terminal history leak, not legitimate steering.
    if (text.trim().startsWith('/')) return true;

    const cleaned = this.cleanText(text);
    if (cleaned.length < 50) return false;

    // Check against cache
    for (const result of this.recentResults) {
      // 1. Exact match after normalization
      if (cleaned === result) {
        logger.debug('[EchoGuard] Detected exact match echo');
        return true;
      }

      // 2. Prefix/substring match — common for truncated terminal history recall.
      //    If the first PREFIX_MATCH_LENGTH chars of input appear in any recent
      //    result, it's highly likely a history echo rather than original input.
      const prefix = cleaned.substring(0, EchoGuard.PREFIX_MATCH_LENGTH);
      if (result.includes(prefix)) {
        logger.debug('[EchoGuard] Detected prefix/substring match echo');
        return true;
      }

      // 3. Large subset match — if the full cleaned input (>500 chars) is
      //    contained within a recent result, it's almost certainly an echo.
      if (cleaned.length > 500 && result.includes(cleaned)) {
        logger.debug('[EchoGuard] Detected large subset match echo');
        return true;
      }
    }

    return false;
  }

  /**
   * Remove ANSI escape sequences and normalize text for robust matching.
   *
   * Handles:
   * - CSI sequences: ESC[ params letter (colors, cursor movement, SGR)
   * - OSC sequences: ESC] ... ST (ESC\) or BEL (\x07) — window title, hyperlinks
   * - DCS/APC/PM/SOS sequences: ESC P/X/^/_ ... ST
   * - Standalone ESC + single char (DECSC, DECRC, DECKPAM, etc.)
   */
  private cleanText(text: string): string {
    /* eslint-disable no-control-regex */
    return text
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')               // CSI
      .replace(/\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/g, '')    // OSC
      .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\|\x07)/g, '')    // DCS/APC/PM/SOS
      .replace(/\x1b[^[\]]PX^_]/g, '')                      // Standalone ESC+char
      /* eslint-enable no-control-regex */
      .replace(/\s+/g, ' ')                                  // Normalize whitespace
      .trim();
  }
}

/**
 * Global singleton instance for the extension lifecycle.
 */
export const echoGuard = new EchoGuard();