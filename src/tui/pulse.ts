/**
 * TUI Animation Pulse
 * 
 * Centralized clock for TUI animations to ensure visual synchronization
 * across multiple widgets and panels.
 */

import { logger } from '../logger.ts';

// ~60 FPS. This matches pi-tui's own render cap (MIN_RENDER_INTERVAL_MS = 16),
// so every pulse can produce a rendered frame — pi-tui coalesces/throttles and
// only diffs the changed line, so the cost is one short line write per frame.
// The wave-geometry constants in research-panel-wave.ts are scaled to this
// interval to keep the on-screen animation speed unchanged.
const FRAME_INTERVAL_MS = 16;

interface PulseSubscriber {
  (frame: number): void;
}

class TuiPulse {
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private subscribers = new Set<PulseSubscriber>();

  /**
   * Start the pulse if not already running
   */
  public start(): void {
    if (this.timer) return;
    
    logger.debug('[Pulse] Starting global TUI pulse');
    this.timer = setInterval(() => {
      this.frame++;
      for (const subscriber of this.subscribers) {
        try {
          subscriber(this.frame);
        } catch (err) {
          logger.error('[Pulse] Error in subscriber:', err);
        }
      }
    }, FRAME_INTERVAL_MS);
    
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stop the pulse if no subscribers remain
   */
  public stop(): void {
    if (this.timer && this.subscribers.size === 0) {
      logger.debug('[Pulse] Stopping global TUI pulse (no subscribers)');
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Subscribe to the pulse. Returns an unsubscribe function.
   */
  public subscribe(callback: PulseSubscriber): () => void {
    this.subscribers.add(callback);
    this.start();
    
    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stop();
      }
    };
  }

  /**
   * Get the current global frame count
   */
  public getFrame(): number {
    return this.frame;
  }
}

export const tuiPulse = new TuiPulse();
