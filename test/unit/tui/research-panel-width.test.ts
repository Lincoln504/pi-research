/**
 * Panel box alignment with wide (CJK) and astral (emoji) characters.
 *
 * Unlike research-panel.test.ts, this file does NOT mock @earendil-works/pi-tui:
 * the whole point is that the panel must measure/pad/truncate by DISPLAY width
 * (visibleWidth / truncateToWidth), not by UTF-16 code units. A quick-mode slice
 * label carries the raw user query, so CJK/emoji labels previously desynced the
 * top border row from the body rows (String.length undercounts CJK cells) and
 * the tight-space branch could emit a lone surrogate (labelStr[0] on an emoji).
 */
import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  createInitialPanelState,
  addSlice,
  updateSliceStatus,
  createMasterResearchPanel,
  _centerPadToWidth,
  type Theme,
} from '../../../src/tui/research-panel.ts';

const theme = { fg: (_c: string, t: string) => t } as unknown as Theme;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function render(state: ReturnType<typeof createInitialPanelState>, width: number): string[] {
  const component = createMasterResearchPanel('width-test-session', () => [state])({} as never, theme);
  return component.render(width);
}

/** Box rows are lines 1..4 (line 0 is the header, lines 5+ are steering/hints). */
function boxRows(lines: string[]): string[] {
  return lines.slice(1, 5);
}

describe('panel box alignment by display width', () => {
  it('keeps all four box rows at exactly the panel width for an ASCII label (baseline)', () => {
    const state = createInitialPanelState('s', 'r', 'q', 'm');
    addSlice(state, 'researching: plain ascii query', 'researching: plain ascii query');
    const rows = boxRows(render(state, 60));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(visibleWidth(row)).toBe(60);
    expect(rows[0]!.endsWith('┐')).toBe(true);
    expect(rows[1]!.endsWith('│')).toBe(true);
    expect(rows[2]!.endsWith('│')).toBe(true);
    expect(rows[3]!.endsWith('┘')).toBe(true);
  });

  it('keeps the top border aligned for a CJK quick-mode label (regression: .length sizing)', () => {
    const state = createInitialPanelState('s', 'r', 'q', 'm');
    const label = 'researching: 日本の人口動態と経済...';
    addSlice(state, label, label);
    const lines = render(state, 60);
    const rows = boxRows(lines);
    // Pre-fix, the top border was built ~7 cells too wide (7 CJK glyphs measured as
    // 1 cell each), then clamped by the final truncate — losing the '┐' corner and
    // desyncing it from the body rows.
    for (const row of rows) expect(visibleWidth(row)).toBe(60);
    expect(rows[0]!.endsWith('┐')).toBe(true);
    expect(rows[3]!.endsWith('┘')).toBe(true);
    expect(LONE_SURROGATE.test(lines.join('\n'))).toBe(false);
  });

  it('keeps a CJK status row centered without overflowing the column', () => {
    const state = createInitialPanelState('s', 'r', 'q', 'm');
    addSlice(state, '1', '1');
    updateSliceStatus(state, '1', '検索中の状態テキスト');
    const rows = boxRows(render(state, 40));
    for (const row of rows) expect(visibleWidth(row)).toBe(40);
    expect(rows[1]!.endsWith('│')).toBe(true);
  });

  it('never emits a lone surrogate in the tight-space branch (emoji label, narrow column)', () => {
    const state = createInitialPanelState('s', 'r', 'q', 'm');
    const label = '🚀🔭🌌 space research';
    addSlice(state, label, label);
    // Narrow width forces the w < totalLabelWidth branch, which previously took
    // labelStr[0] — the lone HIGH surrogate of the rocket emoji.
    const lines = render(state, 7);
    expect(LONE_SURROGATE.test(lines.join('\n'))).toBe(false);
    for (const row of boxRows(lines)) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(7);
    }
  });

  it('stays aligned with multiple columns (CJK researcher next to eval box)', () => {
    const state = createInitialPanelState('s', 'r', 'q', 'm');
    addSlice(state, 'researching: 中文查询测试', 'researching: 中文查询测试');
    addSlice(state, 'eval', 'eval');
    const rows = boxRows(render(state, 60));
    for (const row of rows) expect(visibleWidth(row)).toBe(60);
  });
});

describe('_centerPadToWidth', () => {
  it('centers by display width, not code units', () => {
    const out = _centerPadToWidth('你好', 11); // vw 4, length 2
    expect(visibleWidth(out)).toBe(11);
    expect(out.startsWith('   ')).toBe(true); // floor((11-4)/2) = 3
    expect(out.endsWith('    ')).toBe(true); // 11-4-3 = 4
  });

  it('matches the code-unit math for plain ASCII', () => {
    const out = _centerPadToWidth('abc', 10);
    expect(out).toBe('abc'.padStart(Math.floor((10 + 3) / 2)).padEnd(10));
  });

  it('never pads negatively when the content is wider than the column', () => {
    const out = _centerPadToWidth('wide-content', 4);
    expect(out).toBe('wide-content');
  });
});
