/**
 * Research Panel Formatting Utilities
 *
 * Functions for formatting tokens, costs, and progress.
 */

import type { ResearchProgress } from '../types/research-panel-types.ts';

/**
 * Format tokens for display
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Render a percentage string for the header.
 * Returns empty string when progress data is absent or not yet initialised.
 * Rounds to nearest 10% increment (10, 20, 30, ..., 90, 100).
 */
export function renderProgressPct(progress: ResearchProgress | undefined): string {
  if (!progress || progress.expected <= 0) return '';
  const pct = Math.min(1, progress.made / progress.expected) * 100;
  const rounded = Math.round(pct / 10) * 10;
  return `${Math.min(100, rounded)}%`;
}

/**
 * Format cost for display
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.0001) return '<$0.01';
  if (cost < 1) {
    const s = cost.toFixed(4);
    return `$${parseFloat(s)}`;
  }
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost)}`;
}

// Export internal functions for testing
export function _formatTokens(tokens: number): string {
  return formatTokens(tokens);
}

export function _renderProgressPct(progress: ResearchProgress | undefined): string {
  return renderProgressPct(progress);
}

export function _formatCost(cost: number): string {
  return formatCost(cost);
}