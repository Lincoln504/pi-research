/**
 * Full TUI Widget (Intended Sophisticated Design)
 *
 * Displays research coordinator status, total tokens, and active researcher agents
 * in a boxed grid layout that visualizes multi-level decomposition structure.
 *
 * Layout:
 * ┌─ Research Coordinator ── tk: 42.3k ──────┐
 * │    1         2         3                │
 * │   ●●        ●●        ●●               │
 * │   ○1.1      ○         ○                │
 * │   ○1.2      ○         ○                │
 * └──────────────────────────────────────────┘
 */

import { Box, Container, Text } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';

export interface AgentState {
  label: string;
  sliceNumber: number;
  depthNumber?: number;
  flash: 'green' | 'red' | null;
}

/**
 * Get display label for agent
 */
function getAgentDisplayLabel(agent: AgentState): string {
  if (agent.depthNumber === undefined) {
    return agent.sliceNumber.toString();
  }
  return `${agent.sliceNumber}.${agent.depthNumber}`;
}

export interface FullPanelState {
  totalTokens: number;
  agents: Map<string, AgentState>;
  sliceGroups: Map<number, string[]>; // slice# → array of agent IDs
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
 * Create full TUI widget component
 */
export function createFullPanel(state: FullPanelState): (tui: unknown, theme: Theme) => Component & { dispose?(): void } {
  return (tui: unknown, theme: any) => {
    // Capture TUI reference for external re-render triggers
    capturedTui = tui as { requestRender?(): void };

    const container = new Container();
    const box = new Box(2, 1, () => ''); // No background

    // Header text
    const header = new Text('', 2, 1);
    box.addChild(header);

    // Dynamic rows (we'll recreate these on invalidate)
    const rowTexts: Text[] = [];

    // Footer text
    const footer = new Text('', 2, 1);
    box.addChild(footer);

    container.addChild(box);

    // Rebuild content based on current state
    const rebuildContent = (): void => {
      // Clear existing rows
      for (const rowText of rowTexts) {
        box.removeChild(rowText);
      }
      rowTexts.length = 0;

      // Update header
      const headerText = `│${theme.bold('─ Research Coordinator ── tk: ')}${formatTokens(state.totalTokens).padStart(7)} │`;
      header.setText(headerText);

      // If no active researchers, show message
      if (state.sliceGroups.size === 0) {
        const noAgents = new Text('', 2, 1);
        noAgents.setText(`│ ${theme.fg('muted', 'No active researchers'.padEnd(38))} │`);
        box.addChild(noAgents);
        rowTexts.push(noAgents);
      } else {
        // Get sorted slice numbers
        const sliceNumbers = Array.from(state.sliceGroups.keys()).sort((a, b) => a - b);

        // Calculate column width
        const columnWidth = Math.max(10, Math.floor((80 - 6) / sliceNumbers.length));

        // Column header row (slice numbers)
        const headerRow = new Text('', 2, 1);
        const parts = sliceNumbers.map((sliceNum) => {
          return theme.fg('accent', sliceNum.toString().padEnd(columnWidth));
        });
        headerRow.setText(`│ ${parts.join(' ')} │`);
        box.addChild(headerRow);
        rowTexts.push(headerRow);

        // For each slice, build its content
        const sliceContents = sliceNumbers.map((sliceNum) => {
          const agentKeys = state.sliceGroups.get(sliceNum) || [];
          const sliceAgents = agentKeys.map((key) => state.agents.get(key)).filter(Boolean) as AgentState[];
          return {
            sliceNum,
            agents: sliceAgents,
          };
        });

        // Agent rows
        const maxAgents = Math.max(...sliceContents.map((s) => s.agents.length));

        for (let row = 0; row < maxAgents; row++) {
          const agentRow = new Text('', 2, 1);
          const parts = sliceContents.map((slice) => {
            const agent = slice.agents[row];
            if (!agent) return ' '.repeat(columnWidth);

            const displayLabel = getAgentDisplayLabel(agent);
            const flashColor = agent.flash === 'green'
              ? theme.fg('success', '')
              : agent.flash === 'red'
                ? theme.fg('error', '')
                : '';
            const flashMarker = agent.flash ? (agent.flash === 'green' ? '●' : '●') : '○';
            const prefix = agent.flash ? flashColor : '';
            const suffix = agent.flash ? theme.fg('muted', '') : '';

            // For depth agents, show full label, for top-level just show marker
            const labelText = agent.depthNumber !== undefined ? displayLabel : '';
            const agentText = `${prefix}${flashMarker} ${labelText}${suffix}`;

            // Pad to column width
            return agentText.slice(0, columnWidth).padEnd(columnWidth);
          });
          agentRow.setText(`│ ${parts.join(' ')} │`);
          box.addChild(agentRow);
          rowTexts.push(agentRow);
        }
      }

      // Update footer
      const borderLength = 42;
      footer.setText(theme.fg('accent', theme.bold(`└${'─'.repeat(borderLength)}┘`)));
    };

    // Initial rebuild
    rebuildContent();

    const component: Component = {
      render(width: number): string[] {
        return container.render(width);
      },

      invalidate(): void {
        container.invalidate();
        rebuildContent();
      },
    };

    return component;
  };
}

/**
 * Set flash indicator for an agent with automatic cleanup
 */
export function setAgentFlash(
  agents: Map<string, AgentState>,
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

/**
 * Add a new agent to the panel state
 */
export function addAgent(
  state: FullPanelState,
  agentId: string,
  sliceNumber: number,
  depthNumber?: number
): void {
  state.agents.set(agentId, {
    label: agentId,
    sliceNumber,
    depthNumber,
    flash: null,
  });

  // Add to slice group
  if (!state.sliceGroups.has(sliceNumber)) {
    state.sliceGroups.set(sliceNumber, []);
  }
  state.sliceGroups.get(sliceNumber)!.push(agentId);
}
