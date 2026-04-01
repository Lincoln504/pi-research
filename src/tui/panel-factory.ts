/**
 * TUI Panel Factory
 *
 * Creates appropriate TUI panel widget based on configuration (TUI_MODE).
 * Uses pi's built-in component system (Box, Container, Text) for proper spacing.
 */

import type { Component } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import { TUI_MODE } from '../config.js';
import type { SearxngStatus } from '../searxng-lifecycle.js';
import {
  createSimplePanel,
  getCapturedTui as getSimpleCapturedTui,
  type SimplePanelState as ImportedSimplePanelState,
  clearAllFlashTimeouts as clearSimpleTimeouts,
  setAgentFlash as setSimpleAgentFlash,
} from './simple-widget.js';
import {
  createFullPanel,
  getCapturedTui as getFullCapturedTui,
  type FullPanelState as ImportedFullPanelState,
  clearAllFlashTimeouts as clearTimeouts,
  setAgentFlash as setFullAgentFlash,
  addAgent as addFullAgent,
} from './full-widget.js';

/**
 * State for simple TUI mode (compact boxed display)
 */
export type SimplePanelState = ImportedSimplePanelState;

/**
 * State for full TUI mode (boxed grid layout)
 */
export type FullPanelState = ImportedFullPanelState;

/**
 * Panel state (union type for both modes)
 */
export type PanelState = SimplePanelState | FullPanelState;

/**
 * Create appropriate panel widget based on TUI_MODE configuration
 */
export function createPanel(state: PanelState): (tui: unknown, theme: Theme) => Component & { dispose?(): void } {
  if (TUI_MODE === 'full') {
    return createFullPanel(state as FullPanelState);
  }
  return createSimplePanel(state as SimplePanelState);
}

/**
 * Get captured TUI reference for active panel
 */
export function getCapturedTui(): { requestRender?(): void } | null {
  if (TUI_MODE === 'full') {
    return getFullCapturedTui();
  }
  return getSimpleCapturedTui();
}

/**
 * Clear all active flash timeouts
 */
export function clearAllFlashTimeouts(): void {
  if (TUI_MODE === 'full') {
    clearTimeouts();
  } else {
    clearSimpleTimeouts();
  }
}

/**
 * Set flash indicator for an agent
 */
export function setAgentFlash(
  agents: Map<string, any>,
  label: string,
  color: 'green' | 'red',
  timeoutMs: number
): void {
  if (TUI_MODE === 'full') {
    setFullAgentFlash(agents, label, color, timeoutMs);
  } else {
    setSimpleAgentFlash(agents, label, color, timeoutMs);
  }
}

/**
 * Add a new agent to panel state (full mode only)
 */
export function addAgent(
  state: PanelState,
  agentId: string,
  sliceNumber: number,
  depthNumber?: number
): void {
  if (TUI_MODE === 'full') {
    addFullAgent(state as FullPanelState, agentId, sliceNumber, depthNumber);
  } else {
    // In simple mode, just add to Map
    (state as SimplePanelState).agents.set(agentId, { label: agentId, flash: null });
  }
}

/**
 * Create initial panel state based on TUI_MODE
 */
export function createInitialPanelState(searxngStatus: SearxngStatus): PanelState {
  if (TUI_MODE === 'full') {
    return {
      totalTokens: 0,
      agents: new Map(),
      sliceGroups: new Map(),
    } as FullPanelState;
  }
  return {
    searxngStatus,
    totalTokens: 0,
    agents: new Map(),
  } as SimplePanelState;
}
