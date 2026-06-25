/**
 * TUI Animation Pulse
 * 
 * Centralized clock for TUI animations to ensure visual synchronization
 * across multiple widgets and panels.
 */

import { logger } from '../logger.ts';

// ~30 FPS. Deliberately kept ABOVE pi-tui's render cap
// (MIN_RENDER_INTERVAL_MS = 16). Matching the cap (16ms) makes the pulse and
// the renderer beat against each other — render delay is max(0, 16 - elapsed),
// so two timers of the same period produce irregular spacing (visible jitter)
// for no gain: the wave head is one discrete cell wide, so it only steps a cell
// roughly every other 60fps frame anyway. 33ms gives a steady, even cadence
// where every pulse renders once. The real smoothness fix is renderImmediate()
// in the observer (bypassing the 100ms state-refresh debounce), not raw FPS.
const FRAME_INTERVAL_MS = 33;

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
