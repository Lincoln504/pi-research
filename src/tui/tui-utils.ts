/**
 * TUI Utilities
 *
 * Reusable patterns and helpers for Pi TUI components.
 */

import type { Component, TUI } from '@earendil-works/pi-tui';
import type { Theme } from '../types/research-panel-types.ts';

import { truncateToWidth } from '@earendil-works/pi-tui';

/**
 * Component Proxy
 *
 * Wraps a component with a proxy that can override or extend its behavior.
 * Useful for layout components (like Box) that don't forward input events.
 */
export function createComponentProxy(
  base: Component,
  overrides: Partial<Component>
): Component {
  return {
    render: (width: number) => overrides.render ? overrides.render(width) : base.render(width),
    handleInput: (data: string) => {
      if (overrides.handleInput) {
        overrides.handleInput(data);
      } else if (base.handleInput) {
        base.handleInput(data);
      }
    },
    invalidate: () => {
      if (overrides.invalidate) {
        overrides.invalidate();
      }
      base.invalidate();
    },
    wantsKeyRelease: overrides.wantsKeyRelease ?? base.wantsKeyRelease,
  };
}

/**
 * Safe TUI Widget Factory
 *
 * Wraps a widget factory with error handling to prevent the entire extension from 
 * crashing if a single widget fails to render.
 */
export function createSafeWidget(
  factory: (tui: TUI, theme: Theme) => Component
): (tui: TUI, theme: Theme) => Component {
  return (tui: TUI, theme: Theme) => {
    try {
      const component = factory(tui, theme);
      const originalRender = component.render;
      component.render = (width: number) => {
        try {
          if (width < 4) return [];
          return originalRender.call(component, width);
        } catch {
          return [truncateToWidth('[TUI Error]', width)];
        }
      };
      return component;
    } catch {
      // Fallback component on factory error
      return {
        render: (width: number) => [truncateToWidth('[TUI Error]', width)],
        invalidate: () => {},
      };
    }
  };
}
