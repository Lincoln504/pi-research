# Terminal Ghost Characters Issue - Root Cause Analysis

## Summary

When reloading the pi-research extension, users experience "ghost characters" like `r4;1:3u`, `9;5u`, etc. appearing in their shell prompt. This document provides a deep analysis of the root causes and proposed fixes.

## What's Happening

The ghost characters are the **terminal's response to the Kitty Keyboard Protocol query**. When a modern terminal (Kitty, WezTerm, etc.) receives the query `\x1b[?u`, it responds with a capabilities string like `\x1b[?4;1;3u`. If the application that sent the query doesn't consume this response before returning control to the shell, the shell sees these characters as user input and prints them.

## Root Causes

### Root Cause #1: Kitty Keyboard Protocol Query Race Condition

**Location**: `@mariozechner/pi-tui/dist/terminal.js` (lines 107-148)

When the TUI starts, it queries the terminal for Kitty keyboard protocol support:

```javascript
queryAndEnableKittyProtocol() {
    this.setupStdinBuffer();
    process.stdin.on("data", this.stdinDataHandler);
    process.stdout.write("\x1b[?u");  // <- Query terminal
    setTimeout(() => {
        if (!this._kittyProtocolActive && !this._modifyOtherKeysActive) {
            process.stdout.write("\x1b[>4;2m");
            this._modifyOtherKeysActive = true;
        }
    }, 150);
}
```

The terminal responds with something like `\x1b[?4;1;3u`. The `StdinBuffer` in `setupStdinBuffer()` is supposed to detect and consume this response:

```javascript
const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;
this.stdinBuffer.on("data", (sequence) => {
    if (!this._kittyProtocolActive) {
        const match = sequence.match(kittyResponsePattern);
        if (match) {
            this._kittyProtocolActive = true;
            setKittyProtocolActive(true);
            process.stdout.write("\x1b[>7u");
            return; // Don't forward protocol response to TUI
        }
    }
    if (this.inputHandler) {
        this.inputHandler(sequence);
    }
});
```

**The Problem**: When the extension is reloaded, the TUI is stopped and restarted very quickly. During this restart window, the terminal's response may arrive when:
1. The old TUI has already called `stop()` and removed its stdin handlers
2. The new TUI hasn't yet set up its stdin buffer

The response sits in the stdin buffer and gets consumed by the shell when control returns.

### Root Cause #2: Widget Lifecycle During Reload

**Location**: `src/tool.ts` (lines 221-245)

The cleanup function removes widgets and panels:

```javascript
cleanup = () => {
    if (cleanup === null) return;
    cleanup = null;

    if (waveTimer) {
      clearInterval(waveTimer);
      waveTimer = null;
    }

    if (unsubOrder) unsubOrder();
    if (unsubInput) { unsubInput(); unsubInput = null; }
    endResearchSession(piSessionId, researchId);
    cleanupSharedLinks(researchId);
    const activePanels = getPiActivePanels(piSessionId);
    if (activePanels.length === 0) {
      ctx.ui.setWidget(masterWidgetId, undefined);  // <- Remove widget
      if (typeof (ctx.ui as any).setWorkingVisible === 'function') {
        (ctx.ui as any).setWorkingVisible(true);
      }
    } else {
      refreshAllSessions(piSessionId);
    }

    logger.info('[research] cleanup completed', { piSessionId, researchId });
};
```

When `setWidget(id, undefined)` is called, the widget is removed. However, this doesn't necessarily trigger terminal cleanup if there are other widgets or TUI components still active.

**The Problem**: The TUI might still be running in the background while the extension is being reloaded. The terminal state (including Kitty protocol) remains active, and no cleanup is performed before the new extension instance starts.

### Root Cause #3: Extension Reload Doesn't Trigger Terminal Cleanup

**Location**: pi-coding-agent extension loading system

When you run `/reload`, pi-coding-agent:
1. Unloads the current extension (calls `shutdownManager.runCleanup()`)
2. Clears extension state
3. Re-imports and loads the extension

However, the TUI system is managed separately by the pi-coding-agent core. The extension's widget cleanup doesn't trigger full TUI terminal cleanup unless the TUI is being completely shut down.

**The Problem**: If the TUI was already running (e.g., for another widget or feature), the reload doesn't stop and restart the TUI. The Kitty protocol remains active, and the new extension instance queries the terminal again, potentially causing a race condition.

### Root Cause #4: Incomplete Input Consumption in Tool Handler

**Location**: `src/tool.ts` (lines 272-277)

The tool's input handler only checks for specific escape sequences:

```javascript
unsubInput = ctx.ui.onTerminalInput((data: string) => {
    if (data !== '\x1b' && data !== '\x03') return undefined;
    abortAllSessions(piSessionId);
    return { consume: true };
});
```

**The Problem**: If a Kitty protocol response arrives while this handler is active, it doesn't match the check (`data !== '\x1b'`), so `return undefined` is called. This means the data is NOT consumed, and it's left in the input buffer. When the tool finishes and the cleanup runs, this unconsumed data leaks to the shell.

## Why the Characters Look Like `r4;1:3u`

The `\x1b[` sequence (CSI - Control Sequence Introducer) is often interpreted by the shell as a cursor movement command:

- `\x1b[` followed by numbers might move the cursor up/left
- This can partially consume the sequence, leaving only `4;1:3u` as printable text
- The `r` prefix might be from the shell's own escape sequence handling or from an incompletely processed `\x1b`

## Terminal Cleanup Sequence

When properly cleaned up, the terminal reset sequence is:

```javascript
// From terminal.js stop()
process.stdout.write("\x1b[<u");  // Disable Kitty keyboard protocol
this._kittyProtocolActive = false;
setKittyProtocolActive(false);
process.stdout.write("\x1b[>4;0m");  // Disable modifyOtherKeys mode
process.stdout.write("\x1b[?2004l");  // Disable bracketed paste mode
```

If this cleanup doesn't happen before the terminal responds to a new query, the response will be in the new protocol format (extended key reporting) and leak to the shell.

## Proposed Fixes

### Fix #1: Drain Terminal Input on Cleanup (Recommended)

**File**: `src/tool.ts`

In the cleanup function, before any other cleanup, drain the terminal input buffer:

```typescript
cleanup = () => {
  if (cleanup === null) return;
  cleanup = null;

  // NEW: Drain terminal input to consume any pending protocol responses
  // This prevents Kitty protocol responses from leaking to the shell
  if (typeof (ctx.ui as any).tui?.terminal?.drainInput === 'function') {
    (ctx.ui as any).tui.terminal.drainInput(100, 20);
  }

  if (waveTimer) {
    clearInterval(waveTimer);
    waveTimer = null;
  }

  if (unsubOrder) unsubOrder();
  if (unsubInput) { unsubInput(); unsubInput = null; }
  // ... rest of cleanup
};
```

### Fix #2: Improve Input Handler to Consume All Escape Sequences

**File**: `src/tool.ts`

Make the input handler consume all escape sequences, not just specific ones:

```typescript
unsubInput = ctx.ui.onTerminalInput((data: string) => {
  // Check for specific cancel keys
  if (data === '\x1b' || data === '\x03') {
    abortAllSessions(piSessionId);
    return { consume: true };
  }

  // NEW: Consume any escape sequences (CSI, OSC, APC, etc.) to prevent leaks
  // CSI: \x1b[ ... (most common, includes Kitty responses)
  // OSC: \x1b] ... (e.g., title sequences)
  // APC: \x1b_ ... (application commands)
  if (data.startsWith('\x1b')) {
    return { consume: true };
  }

  return undefined;
});
```

### Fix #3: Disable Kitty Protocol During Tool Execution

**File**: `src/tool.ts`

Disable the Kitty protocol at the start of tool execution and re-enable it at the end (if needed):

```typescript
// At start of execute(), before any TUI setup
const originalKittyActive = (ctx.ui as any).tui?.terminal?.kittyProtocolActive ?? false;
if (originalKittyActive) {
  // Disable temporarily to prevent protocol queries during tool execution
  (ctx.ui as any).tui?.terminal.write?.("\x1b[<u");
  (ctx.ui as any).tui.terminal._kittyProtocolActive = false;
}

// In cleanup, restore original state if needed
cleanup = () => {
  // ... existing cleanup ...

  // Restore Kitty protocol if it was active before
  if (originalKittyActive && (ctx.ui as any).tui?.terminal) {
    (ctx.ui as any).tui.terminal.write?.("\x1b[>7u");
    (ctx.ui as any).tui.terminal._kittyProtocolActive = true;
  }
};
```

### Fix #4: Add Terminal State Cleanup in Extension Shutdown

**File**: `~/.pi/agent/extensions/pi-research/src/index.ts`

Register a cleanup task to reset terminal state on extension unload:

```typescript
export default function (pi: ExtensionAPI) {
  // ... existing setup ...

  // Register terminal cleanup on extension shutdown
  let kittyProtocolWasActive = false;

  shutdownManager.register(() => {
    // Reset terminal to safe state
    process.stdout.write("\x1b[<u");     // Disable Kitty protocol
    process.stdout.write("\x1b[>4;0m");  // Disable modifyOtherKeys
    process.stdout.write("\x1b[?2004l"); // Disable bracketed paste
    process.stdout.write("\x1b[?25h");   // Show cursor
  });

  // ... rest of extension
}
```

### Fix #5: Core Fix in pi-tui (Upstream)

The most robust fix would be in pi-tui itself to handle this race condition:

**File**: `@mariozechner/pi-tui/dist/terminal.js`

Add a "grace period" after `stop()` to drain any late-arriving responses:

```javascript
stop() {
    if (this.clearProgressInterval()) {
      process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
    }
    // Disable bracketed paste mode
    process.stdout.write("\x1b[?2004l");
    // Disable Kitty keyboard protocol if not already done by drainInput()
    if (this._kittyProtocolActive) {
      process.stdout.write("\x1b[<u");
      this._kittyProtocolActive = false;
      setKittyProtocolActive(false);
    }
    if (this._modifyOtherKeysActive) {
      process.stdout.write("\x1b[>4;0m");
      this._modifyOtherKeysActive = false;
    }

    // NEW: Grace period to drain any late protocol responses
    // This is crucial for reload scenarios where the terminal responds
    // after the TUI has stopped but before the new instance starts
    if (this.stdinDataHandler && this._kittyProtocolActive === false) {
      // Keep the data handler active briefly to consume any late responses
      let drainCount = 0;
      const maxDrains = 50; // 50 sequences max
      const drainInterval = setInterval(() => {
        drainCount++;
        if (drainCount >= maxDrains) {
          clearInterval(drainInterval);
          this.performFullStop();
        }
      }, 5); // Check every 5ms
    } else {
      this.performFullStop();
    }
  }

  performFullStop() {
    // Move the rest of the stop() logic here
    // ...
  }
```

## Immediate Workaround

Until a fix is implemented, users can clear their terminal state manually:

```bash
printf '\033[<u'
```

Or add this to `.bashrc` as an alias:

```bash
alias reset-term="printf '\033[<u'"
```

## Testing the Fix

To verify the fix works:

1. Start pi with pi-research loaded
2. Run a research command
3. Immediately press `/reload` while research is still active or just after it completes
4. Verify that no ghost characters appear in the shell prompt
5. Type normally to confirm the terminal is in a good state

## Impact Analysis

- **Severity**: Medium - affects user experience but doesn't break functionality
- **Frequency**: High - happens on every reload when terminal supports Kitty protocol
- **Affected Users**: Anyone using modern terminals (Kitty, WezTerm, iTerm2, modern xterm, etc.)
- **Root Cause**: Race condition between TUI lifecycle and terminal protocol responses
- **Best Fix**: Combination of Fix #1 (drain input) and Fix #2 (consume all escapes) in pi-research

## References

- Kitty Keyboard Protocol: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
- CSI (Control Sequence Introducer): https://en.wikipedia.org/wiki/ANSI_escape_code#CSI_(Control_Sequence_Introducer)_sequences
- pi-tui terminal implementation: `@mariozechner/pi-tui/dist/terminal.js`