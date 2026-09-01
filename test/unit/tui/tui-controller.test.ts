/**
 * Global TUI Controller — cancel-key policy tests
 *
 * Pins the Ctrl+C contract introduced with the clear-editor-first fix:
 * - Ctrl+C (pi's app.clear) with text in the editor must NOT abort the research
 *   run — pi clears the editor and the run keeps going.
 * - Ctrl+C with an EMPTY editor is an explicit cancel gesture and aborts the run.
 * - Esc (pi's app.interrupt) keeps its panic-cancel role regardless of editor text.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveSessionCount: vi.fn(),
  abortAllSessions: vi.fn(),
  refreshAllSessions: vi.fn(),
  hideMasterWidget: vi.fn(),
}));

vi.mock('../../../src/orchestration/session-state.ts', () => ({
  getActiveSessionCount: mocks.getActiveSessionCount,
  abortAllSessions: mocks.abortAllSessions,
  refreshAllSessions: mocks.refreshAllSessions,
  hideMasterWidget: mocks.hideMasterWidget,
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { initGlobalTuiController, setInteractiveTuiActive, disposeGlobalTuiController } from '../../../src/tui/tui-controller.ts';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

const CTRL_C = '\x03';
const ESC = '\x1b';

describe('Global TUI controller cancel keys', () => {
  let inputHandler: ((data: string) => unknown) | null = null;
  let editorText = '';

  const fakeUi = () => ({
    onTerminalInput: (fn: (data: string) => unknown) => {
      inputHandler = fn;
      return () => { inputHandler = null; };
    },
    getEditorText: () => editorText,
  }) as unknown as ExtensionUIContext;

  beforeEach(() => {
    vi.clearAllMocks();
    editorText = '';
    inputHandler = null;
    mocks.getActiveSessionCount.mockReturnValue(1);
  });

  afterEach(() => {
    setInteractiveTuiActive(false);
    disposeGlobalTuiController();
  });

  it('Ctrl+C with text in the editor does NOT abort the research run', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = 'follow up question';

    inputHandler!(CTRL_C);

    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });

  it('Ctrl+C with an EMPTY editor aborts the active research run', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = '';

    inputHandler!(CTRL_C);

    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
  });

  it('Ctrl+C aborts after the editor was cleared by a previous Ctrl+C (two-step cancel)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');

    // Step 1: text present — clear only.
    editorText = 'draft message';
    inputHandler!(CTRL_C);
    expect(mocks.abortAllSessions).not.toHaveBeenCalled();

    // Step 2: editor now empty — this is the cancel.
    editorText = '';
    inputHandler!(CTRL_C);
    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
  });

  it('Esc aborts regardless of editor text (app.interrupt semantics)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = 'draft message';

    inputHandler!(ESC);

    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
  });

  it('getEditorText throwing is treated as an empty editor (aborts)', () => {
    const ui = {
      onTerminalInput: (fn: (data: string) => unknown) => {
        inputHandler = fn;
        return () => { inputHandler = null; };
      },
      getEditorText: () => { throw new Error('stale ctx'); },
    } as unknown as ExtensionUIContext;
    initGlobalTuiController(ui, 'pi-1');

    inputHandler!(CTRL_C);

    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
  });

  it('cancel keys are ignored while an interactive menu is active', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    setInteractiveTuiActive(true);
    editorText = '';

    inputHandler!(CTRL_C);
    inputHandler!(ESC);

    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });

  it('keys with no active research never trigger an abort', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    mocks.getActiveSessionCount.mockReturnValue(0);
    editorText = '';

    inputHandler!(CTRL_C);
    inputHandler!(ESC);
    inputHandler!('x');

    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });
});
