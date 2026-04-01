/**
 * SearXNG Status Component (Left Box)
 *
 * Super minimal display: [starting] n:0 or [active] n:1 or [inactive] n:0 or [error] n:0
 * This is shown in the left square of the TUI.
 */

import type { Component } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { SearxngStatus } from '../searxng-lifecycle.js';

let capturedTui: { requestRender?(): void } | null = null;

export function getCapturedTui(): { requestRender?(): void } | null {
  return capturedTui;
}

export function createSearxngStatusComponent(initialStatus: SearxngStatus): (tui: unknown, theme: Theme) => Component & { dispose?(): void } {
  let status = initialStatus;

  const updateStatus = (newStatus: SearxngStatus) => {
    status = newStatus;
    capturedTui?.requestRender?.();
  };

  return (tui: unknown, theme: Theme) => {
    // Capture TUI reference for external re-render triggers
    capturedTui = tui as { requestRender?(): void };

    const component: Component = {
      render(width: number): string[] {
        const boxWidth = Math.min(width, 14);
        
        // Format status: [starting] n:0 or [active] n:1 or [inactive] n:0 or [error] n:0
        let statusText: string;
        let statusColor: (text: string) => string;

        switch (status.state) {
          case 'starting_up':
            statusText = '[starting]';
            statusColor = (text: string) => theme.fg('muted', text);
            break;
          case 'active':
            statusText = '[active]';
            statusColor = (text: string) => theme.fg('success', text);
            break;
          case 'inactive':
            statusText = '[inactive]';
            statusColor = (text: string) => theme.fg('muted', text);
            break;
          case 'error':
            statusText = '[error]';
            statusColor = (text: string) => theme.fg('error', text);
            break;
          default:
            statusText = '[?]';
            statusColor = (text: string) => theme.fg('muted', text);
        }

        const connText = `n:${status.connectionCount}`;
        const content = `${statusColor(statusText)} ${theme.fg('muted', connText)}`;

        return [
          `┌${'─'.repeat(boxWidth - 2)}┐`,
          `│${content.padEnd(boxWidth - 2)}│`,
          `└${'─'.repeat(boxWidth - 2)}┘`,
        ];
      },

      invalidate(): void {
        // No cached state to invalidate
      },
    };

    // Expose update method
    (component as any).updateStatus = updateStatus;

    return component;
  };
}
