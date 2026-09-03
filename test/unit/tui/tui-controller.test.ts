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

import { setKittyProtocolActive } from '@earendil-works/pi-tui';

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
// Real Kitty keyboard protocol (flag 2) sequences — what pi's TUI actually
// forwards to extension input listeners. Every physical keypress produces a
// press AND a release event; only the press may drive policy.
const KITTY_CTRL_C_PRESS = '\x1b[99;5u';
const KITTY_CTRL_C_RELEASE = '\x1b[99;5:3u';
const KITTY_CTRL_C_REPEAT = '\x1b[99;5:2u';
const KITTY_ESC_RELEASE = '\x1b[27;1:3u';

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
    // Match pi's runtime: the Kitty protocol (with event types) is active.
    setKittyProtocolActive(true);
  });

  afterEach(() => {
    setInteractiveTuiActive(false);
    disposeGlobalTuiController();
    setKittyProtocolActive(false);
  });

  it('Ctrl+C with text in the editor does NOT abort and falls through (pi clears)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = 'follow up question';

    expect(inputHandler!(CTRL_C)).toBeUndefined();

    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });

  it('Ctrl+C with an EMPTY editor aborts the run AND consumes the key (pi double-press exit must not fire)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = '';

    const result = inputHandler!(CTRL_C) as { consume?: boolean };

    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
    // The whole point of consuming: pi's handleCtrlC is time-based — a second
    // press within 500ms calls shutdown() and kills the entire pi process.
    // The abort gesture must be swallowed before it reaches pi.
    expect(result.consume).toBe(true);
  });

  it('Ctrl+C aborts after the editor was cleared by a previous Ctrl+C (two-step cancel), consuming the aborting press', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');

    // Step 1: text present — clear only, falls through to pi.
    editorText = 'draft message';
    expect(inputHandler!(CTRL_C)).toBeUndefined();
    expect(mocks.abortAllSessions).not.toHaveBeenCalled();

    // Step 2: editor now empty — this is the cancel, and it must be consumed
    // (the user double-pressed to abort the RUN, not to quit pi).
    editorText = '';
    const result = inputHandler!(CTRL_C) as { consume?: boolean };
    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
    expect(result.consume).toBe(true);
  });

  it('Ctrl+C with an empty editor and NO active research falls through (native pi double-press exit keeps working)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    mocks.getActiveSessionCount.mockReturnValue(0);
    editorText = '';

    expect(inputHandler!(CTRL_C)).toBeUndefined();
  });

  it('Esc aborts regardless of editor text (app.interrupt semantics)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = 'draft message';

    inputHandler!(ESC);

    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
  });

  it('getEditorText throwing is treated as an empty editor (aborts and consumes)', () => {
    const ui = {
      onTerminalInput: (fn: (data: string) => unknown) => {
        inputHandler = fn;
        return () => { inputHandler = null; };
      },
      getEditorText: () => { throw new Error('stale ctx'); },
    } as unknown as ExtensionUIContext;
    initGlobalTuiController(ui, 'pi-1');

    const result = inputHandler!(CTRL_C) as { consume?: boolean };

    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
    expect(result.consume).toBe(true);
  });

  it('cancel keys are ignored while an interactive menu is active', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    setInteractiveTuiActive(true);
    editorText = '';

    inputHandler!(CTRL_C);
    inputHandler!(ESC);

    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });

  it('keys with no active research never trigger an abort or consumption', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    mocks.getActiveSessionCount.mockReturnValue(0);
    editorText = '';

    expect(inputHandler!(CTRL_C)).toBeUndefined();
    expect(inputHandler!(ESC)).toBeUndefined();
    expect(inputHandler!('x')).toBeUndefined();

    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });

  it('Kitty RELEASE event after a clearing press does NOT abort (the one-press two-events regression)', () => {
    // The exact 2026-09-03 live failure: press cleared the editor, then the
    // release event 150ms later matched ctrl+c against the now-empty editor
    // and aborted the run. Releases must be dropped before policy runs.
    initGlobalTuiController(fakeUi(), 'pi-1');

    // Press with text → falls through, pi clears (simulated by emptying here).
    editorText = 'draft message';
    expect(inputHandler!(KITTY_CTRL_C_PRESS)).toBeUndefined();
    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
    editorText = ''; // pi's handleCtrlC cleared it synchronously

    // Release 150ms later — even though the editor is NOW empty and a run is
    // active, the release must be dropped, not treated as a second gesture.
    expect(inputHandler!(KITTY_CTRL_C_RELEASE)).toBeUndefined();
    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });

  it('a Kitty ctrl+c RELEASE is dropped even as the very first event (empty editor, active run)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = '';

    expect(inputHandler!(KITTY_CTRL_C_RELEASE)).toBeUndefined();
    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });

  it('a Kitty Esc RELEASE is dropped (esc releases previously masqueraded as real Esc aborts)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = '';

    expect(inputHandler!(KITTY_ESC_RELEASE)).toBeUndefined();
    expect(mocks.abortAllSessions).not.toHaveBeenCalled();
  });

  it('a Kitty ctrl+c PRESS with an empty editor and an active run aborts and consumes (same policy as legacy \x03)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = '';

    const result = inputHandler!(KITTY_CTRL_C_PRESS) as { consume?: boolean };

    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
    expect(result.consume).toBe(true);
  });

  it('a Kitty ctrl+c REPEAT with an empty editor and an active run aborts (held-key intent, like pi receives)', () => {
    initGlobalTuiController(fakeUi(), 'pi-1');
    editorText = '';

    const result = inputHandler!(KITTY_CTRL_C_REPEAT) as { consume?: boolean };

    expect(mocks.abortAllSessions).toHaveBeenCalledWith('pi-1');
    expect(result.consume).toBe(true);
  });
});
