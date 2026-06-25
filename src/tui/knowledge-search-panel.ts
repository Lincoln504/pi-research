/**
 * Knowledge Search TUI Panel
 *
 * A minimal, static bordered box displayed while the knowledge store
 * search tool is executing. One line of text inside a box, no header,
 * no animations — just "searching knowledge store" in accent-colored borders.
 *
 * Visual layout (width = terminal width):
 *
 * ┌──────────────────────────────────────────┐
 * │         searching knowledge store        │
 * └──────────────────────────────────────────┘
 *
 * Design principles:
 * - Same architectural pattern as the research panel (widget factory,
 *   Component interface, theme usage)
 * - No header line above the box (unlike the research panel)
 * - 3 rows total (top border + content + bottom border) vs research panel's 4+
 * - Static text, no wave animation or progress tracking
 * - Message is horizontally centered within the box
 * - Narrow terminals are handled the same way as the rest of the project:
 *   the message is fit with truncateToWidth (ellipsis) and measured with
 *   visibleWidth, so multibyte/zero-width content can never overflow the border
 * - Safe rendering: never crashes, graceful fallback on error
 */

import { type Component, visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import type { Theme } from '../types/research-panel-types.ts';

/**
 * The static message displayed while the knowledge store is being searched.
 */
const SEARCHING_MESSAGE = 'searching knowledge store';

/**
 * Create the knowledge search panel component.
 *
 * Returns a Component factory compatible with pi's setWidget() API.
 * The component renders a simple bordered box with the searching message.
 */
export function createKnowledgeSearchPanel(): (tui: unknown, theme: Theme) => Component {
  return (_tui: unknown, theme: Theme) => {
    const component: Component = {
      render(width: number): string[] {
        if (width < 4) return [];

        const innerWidth = Math.max(0, width - 2); // subtract left + right border

        // Fit the message to the inner width, adding an ellipsis when too
        // narrow — the same truncation helper the research panel uses. Measure
        // with visibleWidth so the padding maths is correct even if the message
        // ever contains wide/zero-width characters.
        const displayText = truncateToWidth(SEARCHING_MESSAGE, innerWidth);
        const textWidth = visibleWidth(displayText);

        // Center horizontally within the box.
        const totalPad = Math.max(0, innerWidth - textWidth);
        const leftPad = Math.floor(totalPad / 2);
        const rightPad = totalPad - leftPad;
        const paddedContent = ' '.repeat(leftPad) + displayText + ' '.repeat(rightPad);

        // Row 0: top border ┌───...───┐
        const topBorder = theme.fg('accent', '┌' + '─'.repeat(innerWidth) + '┐');

        // Row 1: content │ text │
        const contentLine = theme.fg('accent', '│') +
          theme.fg('muted', paddedContent) +
          theme.fg('accent', '│');

        // Row 2: bottom border └───...───┘
        const bottomBorder = theme.fg('accent', '└' + '─'.repeat(innerWidth) + '┘');

        return [topBorder, contentLine, bottomBorder];
      },

      invalidate(): void {
        const comp = component as Component & { parent?: { invalidate: () => void } };
        if (comp.parent && typeof comp.parent.invalidate === 'function') {
          comp.parent.invalidate();
        }
      },
    };

    return component;
  };
}
