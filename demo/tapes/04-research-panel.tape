Output out/04-research-panel.gif
Set Width 1400
Set Height 900
Set Framerate 24
Source lib/look.tape

# Mock search/scrape so the live TUI (waves, researcher columns, tokens)
# renders with no network. The LLM call is real (needs a configured model key).
Hide
Type "source /home/ldeen/Documents/pi-research/demo/lib/mock-env.sh"
Enter
Type "clear"
Enter
Show
Sleep 400ms

Type "pi"
Enter
Sleep 5s

# Research driven from inside the pi TUI via the /research slash command.
Type "/research the latest developments in WebAssembly"
Sleep 800ms
Enter

# Capture a fixed window of the LIVE panel (waves + columns + tokens) for a
# loopable clip, then abort the run rather than waiting for the full report.
Sleep 28s

Ctrl+C
Sleep 600ms
Ctrl+C
Sleep 800ms
