/**
 * Simple TUI Widget (Production-Ready)
 *
 * Displays SearXNG status and research coordinator status in a clean,
 * compact format using pi's built-in TUI components for proper spacing.
 *
 * Layout:
 * ┌─ Research Panel ─────────────────────────┐
 * │ ● active  http://localhost:8080  tk: 10.2k │
 * │ ● Coordinator  ●1 ●2 ●3              │
 * └────────────────────────────────────────────┘
 */

import { Box, Container, Text } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { SearxngStatus } from '../searxng-lifecycle.js';

export interface AgentDot {
  label: string;
  flash: 'green' | 'red' | null;
}

export interface SimplePanelState {
  searxngStatus: SearxngStatus;
  totalTokens: number;
  agents: Map<string, AgentDot>;
}

// Track all active flash timeouts for cleanup
const activeTimeouts = new Set<NodeJS.Timeout>();

/**
 * Clear all active flash timeouts (called on panel disposal)
 */
export function clearAllFlashTimeouts(): void {
  for (const timeout of activeTimeouts) {
    clearTimeout(timeout);
  }
  activeTimeouts.clear();
}

// Global captured TUI reference for triggering re-renders
let capturedTui: { requestRender?(): void } | null = null;

export function getCapturedTui(): { requestRender?(): void } | null {
  return capturedTui;
}

/**
 * Format token count for display
 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1000000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

/**
 * Create simple TUI widget component
 */
export function createSimplePanel(state: SimplePanelState): (tui: unknown, theme: Theme) => Component & { dispose?(): void } {
  return (tui: unknown, theme: any) => {
    // Capture TUI reference for external re-render triggers
    capturedTui = tui as { requestRender?(): void };

    // Create container for our content
    const container = new Container();
    const box = new Box(2, 1, () => ''); // No background

    // Header
    const header = new Text('', 2, 1);
    box.addChild(header);

    // Line 1: Status + URL + tokens
    const line1 = new Text('', 2, 1);
    box.addChild(line1);

    // Line 2: Coordinator + agent dots
    const line2 = new Text('', 2, 1);
    box.addChild(line2);

    // Bottom border
    const footer = new Text('', 2, 1);
    box.addChild(footer);

    container.addChild(box);

    // Update function to refresh all text with current state
    const updateDisplay = (): void => {
      // Update header
      header.setText(theme.fg('accent', theme.bold('┌─ Research Panel')));

      // Update line 1
      const status = state.searxngStatus;
      let statusStr: string;
      switch (status.state) {
        case 'starting_up':
          statusStr = theme.fg('muted', '● starting');
          break;
        case 'active':
          statusStr = theme.fg('success', '● active');
          break;
        case 'inactive':
          statusStr = theme.fg('muted', '● inactive');
          break;
        case 'error':
          statusStr = theme.fg('error', '● error');
          break;
        default:
          statusStr = theme.fg('muted', '● ?');
      }

      const urlStr = status.url ? theme.fg('muted', `  ${status.url}`) : '';
      const tokStr = theme.fg('muted', `  tk: ${formatTokens(state.totalTokens)}`);
      line1.setText(`│ ${statusStr}${urlStr}${tokStr} │`);

      // Update line 2
      const dots = Array.from(state.agents.values()).map((agent) => {
        const marker =
          agent.flash === 'green'
            ? theme.fg('success', '●')
            : agent.flash === 'red'
              ? theme.fg('error', '●')
              : '○';
        return `${marker}${agent.label}`;
      }).join(' ');
      line2.setText(`│ ● Coordinator  ${dots.padEnd(20)} │`);

      // Update footer
      footer.setText(theme.fg('accent', theme.bold('└────────────────────────────────────────────┘')));
    };

    // Initial update
    updateDisplay();

    const component: Component = {
      render(width: number): string[] {
        return container.render(width);
      },

      invalidate(): void {
        container.invalidate();
        updateDisplay();
      },
    };

    return component;
  };
}

/**
 * Set flash indicator for an agent with automatic cleanup
 */
export function setAgentFlash(
  agents: Map<string, AgentDot>,
  label: string,
  color: 'green' | 'red',
  timeoutMs: number
): void {
  const agent = agents.get(label);
  if (agent) {
    agent.flash = color;
    getCapturedTui()?.requestRender?.();

    const timeout = setTimeout(() => {
      agent.flash = null;
      getCapturedTui()?.requestRender?.();
      activeTimeouts.delete(timeout);
    }, timeoutMs);

    activeTimeouts.add(timeout);
  }
}
